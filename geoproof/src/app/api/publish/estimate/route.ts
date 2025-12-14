import { NextResponse } from "next/server";

import { getFullnodeUrl } from "@mysten/sui/client";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Secp256k1Keypair } from "@mysten/sui/keypairs/secp256k1";
import { Secp256r1Keypair } from "@mysten/sui/keypairs/secp256r1";
import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import { normalizeStructTag, parseStructTag } from "@mysten/sui/utils";
import { walrus } from "@mysten/walrus";

import { stableStringify } from "@/lib/stableJson";

export const runtime = "nodejs";
export const maxDuration = 60;

const DEFAULT_WALRUS_SYSTEM_OBJECT_ID = "0x6c2547cbbc38025cf3adac45f63cb0a8d12ecf777cdc75a4971612bf97fdf6af";
const DEFAULT_WALRUS_STAKING_POOL_ID = "0xbe46180321c30aab2f8b3501e24048377287fa708018a5b7c2792b35fe339ee3";

type EstimateBody = {
  reportDraft: unknown;
  artifacts?: {
    beforeDataUrl?: string | null;
    afterDataUrl?: string | null;
    diffDataUrl?: string | null;
  };
  artifactsMode?: "none" | "diff" | "all";
  epochs?: number;
};

function reqEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

function getKeypairFromEnv() {
  const pk = reqEnv("SUI_PRIVATE_KEY").trim();
  const decoded = decodeSuiPrivateKey(pk);

  if (decoded.scheme === "ED25519") return Ed25519Keypair.fromSecretKey(decoded.secretKey);
  if (decoded.scheme === "Secp256k1") return Secp256k1Keypair.fromSecretKey(decoded.secretKey);
  if (decoded.scheme === "Secp256r1") return Secp256r1Keypair.fromSecretKey(decoded.secretKey);

  throw new Error(`Unsupported key scheme: ${decoded.scheme}`);
}

export async function POST(req: Request) {
  let body: EstimateBody;
  try {
    body = (await req.json()) as EstimateBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (!body || typeof body !== "object" || !("reportDraft" in body)) {
    return NextResponse.json({ error: "Expected { reportDraft, artifacts?, artifactsMode?, epochs? }" }, { status: 400 });
  }

  const artifactsMode: "none" | "diff" | "all" = body.artifactsMode ?? "none";
  const epochs = (() => {
    const raw = Number(body.epochs ?? process.env.WALRUS_EPOCHS ?? "3");
    return Number.isFinite(raw) && raw > 0 ? Math.min(Math.floor(raw), 100) : 3;
  })();

  const network = (process.env.SUI_NETWORK ?? "testnet") as "testnet" | "mainnet";
  const url = process.env.SUI_RPC_URL ?? getFullnodeUrl(network);
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

  const reportStable = stableStringify(body.reportDraft);
  const evidenceBundle = {
    kind: "GeoProofEvidenceBundle",
    version: 1,
    createdAt: new Date().toISOString(),
    reportDraft: body.reportDraft,
    reportSha256: "sha256-not-computed-here",
    artifacts:
      artifactsMode === "all"
        ? {
            beforeDataUrl: body.artifacts?.beforeDataUrl ?? null,
            afterDataUrl: body.artifacts?.afterDataUrl ?? null,
            diffDataUrl: body.artifacts?.diffDataUrl ?? null,
          }
        : artifactsMode === "diff"
          ? {
              beforeDataUrl: null,
              afterDataUrl: null,
              diffDataUrl: body.artifacts?.diffDataUrl ?? null,
            }
          : {
              beforeDataUrl: null,
              afterDataUrl: null,
              diffDataUrl: null,
            },
  };

  const evidenceBytes = new TextEncoder().encode(JSON.stringify(evidenceBundle));

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

  // Determine which WAL coin type the configured Walrus deployment expects.
  let derivedWalType: string | null = null;
  let walrusPackageId: string | null = null;
  try {
    const systemObj = await client.getObject({ id: walrusSystemObjectId, options: { showType: true } });
    const systemType =
      typeof systemObj.data?.type === "string" && systemObj.data.type.includes("::") ? systemObj.data.type : null;
    walrusPackageId = systemType ? parseStructTag(systemType).address : null;
    if (walrusPackageId) {
      const mf = await client.core.getMoveFunction({
        packageId: walrusPackageId,
        moduleName: "staking",
        name: "stake_with_pool",
      });
      const toStake = mf.function.parameters?.[1];
      const body = toStake?.body;
      const coinTypeParam =
        body?.$kind === "datatype" && body.datatype.typeParameters?.[0]?.$kind === "datatype"
          ? body.datatype.typeParameters[0]
          : null;
      if (coinTypeParam?.$kind === "datatype") derivedWalType = normalizeStructTag(coinTypeParam.datatype.typeName);
    }
  } catch {
    // ignore
  }

  const owner = keypair.getPublicKey().toSuiAddress();
  const allBalances = await client.getAllBalances({ owner });
  const walBalances = allBalances.filter((b) => b.coinType.endsWith("::wal::WAL"));
  const walByType = Object.fromEntries(walBalances.map((b) => [b.coinType, b.totalBalance]));

  let cost: { storageCost: string; writeCost: string; totalCost: string } | null = null;
  try {
    const c = await client.walrus.storageCost(evidenceBytes.length, epochs);
    cost = {
      storageCost: c.storageCost.toString(),
      writeCost: c.writeCost.toString(),
      totalCost: c.totalCost.toString(),
    };
  } catch {
    // ignore
  }

  return NextResponse.json({
    input: {
      artifactsMode,
      epochs,
    },
    bytes: {
      reportDraftUtf8: new TextEncoder().encode(reportStable).length,
      evidenceBundle: evidenceBytes.length,
    },
    walrus: {
      config: {
        walrusSystemObjectId,
        walrusStakingPoolId,
        uploadRelayHost,
      },
      resolved: {
        walrusPackageId,
        derivedWalType,
      },
      cost,
    },
    wallet: {
      address: owner,
      walBalances: walByType,
    },
  });
}
