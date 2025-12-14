import { NextResponse } from "next/server";

import { getFullnodeUrl } from "@mysten/sui/client";
import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";

import { bboxIntersects, extractCreatedObjectIdsFromTxPage, parseBboxParam } from "@/lib/suiReports";

export const runtime = "nodejs";
export const maxDuration = 60;

const CACHE_TTL_MS = 15_000;
const cache = new Map<string, { ts: number; value: SearchResponse }>();

type SearchResponse = {
  network: string;
  packageId: string;
  type: string;
  bbox?: [number, number, number, number] | null;
  items: Array<{
    objectId: string;
    digest: string;
    owner?: unknown;
    createdAtMs?: number;
    startDate?: string;
    endDate?: string;
    source?: string;
    variant?: string;
    walrusBlobId?: string;
    reportSha256Hex?: string;
    bboxJson?: string;
    bboxParsed?: [number, number, number, number] | null;
  }>;
  nextCursor?: string | null;
  hasNextPage: boolean;
};

type TxPage = {
  data: Array<{
    digest?: string;
    objectChanges?: unknown;
  }>;
  nextCursor?: string | null;
  hasNextPage?: boolean;
};

function bytesToString(v: unknown): string {
  if (!Array.isArray(v)) return "";
  const u8 = new Uint8Array(v.map((n) => Number(n) & 0xff));
  return new TextDecoder().decode(u8);
}

function getFields(content: unknown) {
  if (typeof content !== "object" || content === null) return null;
  const fields = (content as Record<string, unknown>).fields;
  if (typeof fields !== "object" || fields === null) return null;
  return fields as Record<string, unknown>;
}

function isTooManyRequests(e: unknown) {
  if (typeof e !== "object" || e === null) return false;
  const any = e as { status?: unknown; message?: unknown };
  if (any.status === 429) return true;
  if (typeof any.message === "string" && any.message.includes("429")) return true;
  return false;
}

async function sleep(ms: number) {
  await new Promise((r) => setTimeout(r, ms));
}

export async function GET(req: Request) {
  const url = new URL(req.url);

  const network = (process.env.SUI_NETWORK ?? "testnet") as "testnet" | "mainnet";
  const rpcUrl = process.env.SUI_RPC_URL ?? getFullnodeUrl(network);
  const packageId = process.env.GEOPROOF_PACKAGE_ID ?? "";
  if (!packageId) {
    return NextResponse.json({ error: "Missing GEOPROOF_PACKAGE_ID env var." }, { status: 500 });
  }

  const type = `${packageId}::geoproof_move::ChangeReport`;
  const bbox = parseBboxParam(url.searchParams.get("bbox"));
  const cursor = url.searchParams.get("cursor") || null;
  const limit = (() => {
    const raw = Number(url.searchParams.get("limit") ?? "20");
    if (!Number.isFinite(raw) || raw <= 0) return 20;
    return Math.min(Math.floor(raw), 50);
  })();

  const client = new SuiJsonRpcClient({ url: rpcUrl, network });

  const cacheKey = `${network}|${bbox ? bbox.join(",") : ""}|${cursor ?? ""}|${limit}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return NextResponse.json(cached.value);
  }

  // Sui RPC doesn't expose a "global query objects by type" via this client,
  // so we query transaction blocks that called create_report and extract created objects.
  let txs: TxPage | null = null;
  try {
    // Small retry/backoff to tolerate transient fullnode rate limiting.
    // If it still fails, we surface a friendly message to the UI.
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        txs = (await client.queryTransactionBlocks({
          filter: {
            MoveFunction: {
              package: packageId,
              module: "geoproof_move",
              function: "create_report",
            },
          },
          cursor,
          limit,
          order: "descending",
          options: { showObjectChanges: true },
        })) as unknown as TxPage;
        break;
      } catch (e: unknown) {
        if (isTooManyRequests(e) && attempt < 2) {
          await sleep(250 * (attempt + 1) * (attempt + 1));
          continue;
        }
        throw e;
      }
    }
    if (!txs) throw new Error("Failed to query transactions (no result)");
  } catch (e: unknown) {
    if (isTooManyRequests(e)) {
      return NextResponse.json(
        {
          error: "Sui fullnode RPC is giving us 429 Too Many Requests. Please try again in ~30 seconds.",
        },
        { status: 429 },
      );
    }
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: `Failed to query Sui: ${msg}` }, { status: 502 });
  }

  if (!txs) {
    return NextResponse.json({ error: "Failed to query Sui transactions." }, { status: 502 });
  }

  const createdIds = extractCreatedObjectIdsFromTxPage(txs, { objectTypeIncludes: "ChangeReport" });

  let objs: Awaited<ReturnType<typeof client.multiGetObjects>>;
  try {
    objs = await client.multiGetObjects({
      ids: createdIds.map((x) => x.objectId),
      options: { showContent: true, showOwner: true },
    });
  } catch (e: unknown) {
    if (isTooManyRequests(e)) {
      return NextResponse.json(
        {
          error: "Sui fullnode RPC is giving us 429 Too Many Requests. Please try again in ~30 seconds.",
        },
        { status: 429 },
      );
    }
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: `Failed to fetch report objects: ${msg}` }, { status: 502 });
  }

  const items: SearchResponse["items"] = [];
  for (let i = 0; i < objs.length; i++) {
    const d = objs[i];
    const created = createdIds[i];
    const objectId = d.data?.objectId;
    const digest = created?.digest;
    if (!objectId || !digest) continue;

    const fields = getFields(d.data?.content);
    const bboxJson = fields ? bytesToString(fields["bbox_json"]) : "";
    const createdAtMs = fields && typeof fields["created_at_ms"] === "string" ? Number(fields["created_at_ms"]) : undefined;
    const startDate = fields ? bytesToString(fields["start_date"]) : "";
    const endDate = fields ? bytesToString(fields["end_date"]) : "";
    const source = fields ? bytesToString(fields["source"]) : "";
    const variant = fields ? bytesToString(fields["variant"]) : "";
    const walrusBlobId = fields ? bytesToString(fields["walrus_blob_id"]) : "";
    const reportSha256Hex = fields ? bytesToString(fields["report_sha256_hex"]) : "";

    let bboxParsed: [number, number, number, number] | null = null;
    try {
      const parsed = JSON.parse(bboxJson);
      if (Array.isArray(parsed) && parsed.length === 4 && parsed.every((n) => typeof n === "number" && Number.isFinite(n))) {
        bboxParsed = [parsed[0], parsed[1], parsed[2], parsed[3]];
      }
    } catch {
      // ignore
    }

    if (bbox && bboxParsed && !bboxIntersects(bbox, bboxParsed)) continue;

    items.push({
      objectId,
      digest,
      owner: d.data?.owner,
      createdAtMs,
      startDate: startDate || undefined,
      endDate: endDate || undefined,
      source: source || undefined,
      variant: variant || undefined,
      walrusBlobId: walrusBlobId || undefined,
      reportSha256Hex: reportSha256Hex || undefined,
      bboxJson: bboxJson || undefined,
      bboxParsed,
    });
  }

  const out = {
    network,
    packageId,
    type,
    bbox,
    items,
    nextCursor: txs.nextCursor ?? null,
    hasNextPage: Boolean(txs.hasNextPage),
  } satisfies SearchResponse;

  cache.set(cacheKey, { ts: Date.now(), value: out });
  return NextResponse.json(out);
}
