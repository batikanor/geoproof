import { NextResponse } from "next/server";

import { SuiClient, getFullnodeUrl } from "@mysten/sui/client";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Secp256k1Keypair } from "@mysten/sui/keypairs/secp256k1";
import { Secp256r1Keypair } from "@mysten/sui/keypairs/secp256r1";

export const runtime = "nodejs";

const SUI_COIN_TYPE = "0x2::sui::SUI";

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

export async function GET() {
  const network = (process.env.SUI_NETWORK ?? "testnet") as "testnet" | "mainnet";
  const url = process.env.SUI_RPC_URL ?? getFullnodeUrl(network);

  try {
    const keypair = getKeypairFromEnv();
    const address = keypair.getPublicKey().toSuiAddress();
    const client = new SuiClient({ url, network });

    const all = await client.getAllBalances({ owner: address });
    const sui = all.find((b) => b.coinType === SUI_COIN_TYPE) ?? { coinType: SUI_COIN_TYPE, totalBalance: "0" };

    // WAL coin type changes across Walrus deployments; don't hardcode package ids.
    // Instead, find any coin type ending with ::wal::WAL.
    const wal =
      all.find((b) => b.coinType.endsWith("::wal::WAL")) ??
      // Fallback (older deployments): some builds used `...::wal::WAL` with different package ids.
      { coinType: "::wal::WAL", totalBalance: "0" };

    return NextResponse.json({
      network,
      address,
      balances: {
        SUI: { total: sui.totalBalance, coinType: sui.coinType },
        WAL: { total: wal.totalBalance, coinType: wal.coinType },
      },
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
