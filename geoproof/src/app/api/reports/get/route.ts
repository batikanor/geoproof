import { NextResponse } from "next/server";

import { getFullnodeUrl } from "@mysten/sui/client";
import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(req: Request) {
  const url = new URL(req.url);
  const objectId = url.searchParams.get("objectId");
  if (!objectId) return NextResponse.json({ error: "Missing objectId" }, { status: 400 });

  const network = (process.env.SUI_NETWORK ?? "testnet") as "testnet" | "mainnet";
  const rpcUrl = process.env.SUI_RPC_URL ?? getFullnodeUrl(network);

  const client = new SuiJsonRpcClient({ url: rpcUrl, network });
  const obj = await client.getObject({ id: objectId, options: { showContent: true, showOwner: true, showType: true } });
  return NextResponse.json({ network, object: obj });
}
