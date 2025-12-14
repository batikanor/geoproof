import { NextResponse } from "next/server";

import { getFullnodeUrl } from "@mysten/sui/client";
import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";

export const runtime = "nodejs";
export const maxDuration = 60;

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

function parseBboxParam(b: string | null): [number, number, number, number] | null {
  if (!b) return null;
  try {
    const parts = b.split(",").map((x) => Number(x.trim()));
    if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return null;
    const [minLng, minLat, maxLng, maxLat] = parts;
    if (minLng >= maxLng || minLat >= maxLat) return null;
    return [minLng, minLat, maxLng, maxLat];
  } catch {
    return null;
  }
}

function bboxIntersects(a: [number, number, number, number], b: [number, number, number, number]) {
  const [aMinX, aMinY, aMaxX, aMaxY] = a;
  const [bMinX, bMinY, bMaxX, bMaxY] = b;
  return aMinX <= bMaxX && aMaxX >= bMinX && aMinY <= bMaxY && aMaxY >= bMinY;
}

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

  // Sui RPC doesn't expose a "global query objects by type" via this client,
  // so we query transaction blocks that called create_report and extract created objects.
  const txs = (await client.queryTransactionBlocks({
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

  const createdIds: Array<{ objectId: string; digest: string }> = [];
  for (const tx of txs.data) {
    const digest = tx.digest;
    if (!digest) continue;
    const changes = tx.objectChanges;
    if (!Array.isArray(changes)) continue;
    for (const c of changes) {
      if (typeof c !== "object" || c === null) continue;
      const type = (c as { type?: unknown }).type;
      const objectType = (c as { objectType?: unknown }).objectType;
      const objectId = (c as { objectId?: unknown }).objectId;
      if (type !== "created") continue;
      if (typeof objectId !== "string") continue;
      if (typeof objectType !== "string" || !objectType.includes("ChangeReport")) continue;
      createdIds.push({ objectId, digest });
    }
  }

  const objs = await client.multiGetObjects({
    ids: createdIds.map((x) => x.objectId),
    options: { showContent: true, showOwner: true },
  });

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

  return NextResponse.json({
    network,
    packageId,
    type,
    bbox,
    items,
    nextCursor: txs.nextCursor ?? null,
    hasNextPage: Boolean(txs.hasNextPage),
  } satisfies SearchResponse);
}
