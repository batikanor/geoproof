import { NextResponse } from "next/server";

import { getFullnodeUrl } from "@mysten/sui/client";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Secp256k1Keypair } from "@mysten/sui/keypairs/secp256k1";
import { Secp256r1Keypair } from "@mysten/sui/keypairs/secp256r1";
import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import { Transaction } from "@mysten/sui/transactions";
import { normalizeStructTag, parseStructTag } from "@mysten/sui/utils";
import { walrus } from "@mysten/walrus";
import crypto from "node:crypto";

import { stableStringify } from "@/lib/stableJson";
import { extractFirstCreatedObjectId } from "@/lib/suiReports";

export const runtime = "nodejs";
export const maxDuration = 60;

// Default Walrus testnet ids from Walrus docs:
// https://docs.wal.app/docs/usage/networks#testnet-parameters
const DEFAULT_WALRUS_SYSTEM_OBJECT_ID = "0x6c2547cbbc38025cf3adac45f63cb0a8d12ecf777cdc75a4971612bf97fdf6af";
const DEFAULT_WALRUS_STAKING_POOL_ID = "0xbe46180321c30aab2f8b3501e24048377287fa708018a5b7c2792b35fe339ee3";

type PublishBody = {
  reportDraft: unknown;
  artifacts?: {
    beforeDataUrl?: string | null;
    afterDataUrl?: string | null;
    diffDataUrl?: string | null;
  };
  includeArtifacts?: boolean;
  artifactsMode?: "none" | "diff" | "all";
};

type SuiExecuteResult = {
  digest?: string;
  effects?: { transactionDigest?: string };
  objectChanges?: unknown;
};

function getPath(root: unknown, path: string[]): unknown {
  let cur: unknown = root;
  for (const k of path) {
    if (typeof cur !== "object" || cur === null) return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur;
}

function getString(root: unknown, path: string[]): string {
  const v = getPath(root, path);
  return typeof v === "string" ? v : "";
}

function reqEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

function toBytesUtf8(s: string): number[] {
  return Array.from(new TextEncoder().encode(s));
}

function sha256Hex(bytes: Uint8Array) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function getKeypairFromEnv() {
  const pk = reqEnv("SUI_PRIVATE_KEY").trim();
  const decoded = decodeSuiPrivateKey(pk);

  if (decoded.scheme === "ED25519") {
    return Ed25519Keypair.fromSecretKey(decoded.secretKey);
  }
  if (decoded.scheme === "Secp256k1") {
    return Secp256k1Keypair.fromSecretKey(decoded.secretKey);
  }
  if (decoded.scheme === "Secp256r1") {
    return Secp256r1Keypair.fromSecretKey(decoded.secretKey);
  }

  throw new Error(`Unsupported key scheme: ${decoded.scheme}`);
}

export async function POST(req: Request) {
  let body: PublishBody;
  try {
    body = (await req.json()) as PublishBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (!body || typeof body !== "object" || !("reportDraft" in body)) {
    return NextResponse.json({ error: "Expected { reportDraft, artifacts? }" }, { status: 400 });
  }

  const network = (process.env.SUI_NETWORK ?? "testnet") as "testnet" | "mainnet";
  const url = process.env.SUI_RPC_URL ?? getFullnodeUrl(network);
  const epochs = (() => {
    const raw = Number(process.env.WALRUS_EPOCHS ?? "3");
    return Number.isFinite(raw) && raw > 0 ? Math.min(Math.floor(raw), 100) : 3;
  })();
  const uploadRelayHost = process.env.WALRUS_UPLOAD_RELAY_HOST ?? "https://upload-relay.testnet.walrus.space";
  const walrusSystemObjectId = process.env.WALRUS_SYSTEM_OBJECT_ID ?? DEFAULT_WALRUS_SYSTEM_OBJECT_ID;
  const walrusStakingPoolId = process.env.WALRUS_STAKING_POOL_ID ?? DEFAULT_WALRUS_STAKING_POOL_ID;

  let keypair;
  try {
    keypair = getKeypairFromEnv();
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }

  const packageId = process.env.GEOPROOF_PACKAGE_ID ?? "";
  if (!packageId) {
    return NextResponse.json(
      { error: "Missing GEOPROOF_PACKAGE_ID env var (publish the Move package first)." },
      { status: 500 },
    );
  }

  // Mysten docs recommend using SuiJsonRpcClient (and setting network) for Walrus.
  // https://sdk.mystenlabs.com/walrus
  const client = new SuiJsonRpcClient({ url, network }).$extend(
    walrus({
      packageConfig: {
        systemObjectId: walrusSystemObjectId,
        stakingPoolId: walrusStakingPoolId,
      },
      uploadRelay: {
        host: uploadRelayHost,
        sendTip: { max: 1_000 },
      },
    }),
  );

  const reportStable = stableStringify(body.reportDraft);
  const reportStableBytes = new TextEncoder().encode(reportStable);
  const reportSha256 = sha256Hex(reportStableBytes);

  const evidenceBundle = {
    kind: "GeoProofEvidenceBundle",
    version: 1,
    createdAt: new Date().toISOString(),
    reportSha256,
    reportDraft: body.reportDraft,
    artifacts: (() => {
      const mode: "none" | "diff" | "all" =
        body.artifactsMode ?? (body.includeArtifacts === true ? "all" : "none");

      if (mode === "all") {
        return {
          beforeDataUrl: body.artifacts?.beforeDataUrl ?? null,
          afterDataUrl: body.artifacts?.afterDataUrl ?? null,
          diffDataUrl: body.artifacts?.diffDataUrl ?? null,
        };
      }

      if (mode === "diff") {
        return {
          beforeDataUrl: null,
          afterDataUrl: null,
          diffDataUrl: body.artifacts?.diffDataUrl ?? null,
        };
      }

      return {
        beforeDataUrl: null,
        afterDataUrl: null,
        diffDataUrl: null,
      };
    })(),
  };

  const evidenceBytes = new TextEncoder().encode(JSON.stringify(evidenceBundle));

  let walrusBlobId: string;
  try {
    const res = await client.walrus.writeBlob({
      blob: evidenceBytes,
      deletable: false,
      epochs,
      signer: keypair,
    });
    walrusBlobId = res.blobId;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);

    // Best-effort diagnostics: report which WAL coin type the Walrus config is expecting.
    let walType: string | null = null;
    try {
      const systemObj = await client.getObject({ id: walrusSystemObjectId, options: { showType: true } });
      const systemType =
        typeof systemObj.data?.type === "string" && systemObj.data.type.includes("::") ? systemObj.data.type : null;
      const pkg = systemType ? parseStructTag(systemType).address : null;
      if (pkg) {
        const mf = await client.core.getMoveFunction({ packageId: pkg, moduleName: "staking", name: "stake_with_pool" });
        const toStake = mf.function.parameters?.[1];
        const body = toStake?.body;
        const coinTypeParam =
          body?.$kind === "datatype" && body.datatype.typeParameters?.[0]?.$kind === "datatype"
            ? body.datatype.typeParameters[0]
            : null;
        if (coinTypeParam?.$kind === "datatype") walType = normalizeStructTag(coinTypeParam.datatype.typeName);
      }
    } catch {
      // ignore
    }

    return NextResponse.json(
      {
        error: `Walrus upload failed: ${msg}`,
        hint: "Make sure the Sui address has Testnet SUI + WAL (Walrus) tokens.",
        walrus: {
          config: { walrusSystemObjectId, walrusStakingPoolId, uploadRelayHost, epochs },
          derivedWalType: walType,
        },
      },
      { status: 502 },
    );
  }

  // Extract a few fields for on-chain anchoring.
  const rd = body.reportDraft;
  const createdAtMs = Date.now();
  const bboxJson = (() => {
    const bb = getPath(rd, ["bbox"]);
    return typeof bb !== "undefined" ? JSON.stringify(bb) : "null";
  })();
  const startDate = getString(rd, ["window", "startDate"]);
  const endDate = getString(rd, ["window", "endDate"]);
  const sourceRequested = getString(rd, ["imagery", "sourceRequested"]);
  const variant = getString(rd, ["imagery", "variant"]);

  const tx = new Transaction();
  // Explicitly set sender; otherwise signing can fail with "Missing transaction sender".
  tx.setSender(keypair.getPublicKey().toSuiAddress());
  tx.moveCall({
    target: `${packageId}::geoproof_move::create_report`,
    arguments: [
      tx.pure.u64(createdAtMs),
      tx.pure.vector("u8", toBytesUtf8(bboxJson)),
      tx.pure.vector("u8", toBytesUtf8(startDate)),
      tx.pure.vector("u8", toBytesUtf8(endDate)),
      tx.pure.vector("u8", toBytesUtf8(sourceRequested)),
      tx.pure.vector("u8", toBytesUtf8(variant)),
      tx.pure.vector("u8", toBytesUtf8(walrusBlobId)),
      tx.pure.vector("u8", toBytesUtf8(reportSha256)),
    ],
  });

  // Keep a conservative default gas budget for testnet.
  tx.setGasBudget(50_000_000);

  let digest: string;
  let createdObjectId: string | null = null;
  try {
    const result = (await keypair.signAndExecuteTransaction({
      transaction: tx,
      client,
    })) as unknown as SuiExecuteResult;

    digest = result.digest ?? result.effects?.transactionDigest ?? "";

    createdObjectId = extractFirstCreatedObjectId(result.objectChanges, { objectTypeIncludes: "ChangeReport" });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      {
        error: `Sui anchor failed: ${msg}`,
        walrusBlobId,
        reportSha256,
      },
      { status: 502 },
    );
  }

  return NextResponse.json({
    walrusBlobId,
    reportSha256,
    sui: {
      network,
      digest,
      createdObjectId,
    },
    bytes: {
      evidenceSize: evidenceBytes.length,
    },
  });
}
