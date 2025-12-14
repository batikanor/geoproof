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

    const walBalances = all.filter((b) => b.coinType.endsWith("::wal::WAL"));
    const walTotal = walBalances.reduce((acc, b) => acc + BigInt(b.totalBalance), BigInt(0)).toString();
    const walByType = Object.fromEntries(walBalances.map((b) => [b.coinType, b.totalBalance]));

    return NextResponse.json({
      network,
      address,
      balances: {
        SUI: { total: sui.totalBalance, coinType: sui.coinType },
        WAL: {
          total: walTotal,
          coinType: walBalances[0]?.coinType ?? null,
          byType: walByType,
        },
      },
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
