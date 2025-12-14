import { NextResponse } from "next/server";

export const runtime = "nodejs";

const REQUIRED = ["SUI_PRIVATE_KEY", "GEOPROOF_PACKAGE_ID"] as const;
const RECOMMENDED = ["SUI_NETWORK", "SUI_RPC_URL", "WALRUS_UPLOAD_RELAY_HOST", "WALRUS_EPOCHS"] as const;

export async function GET() {
  const missing = REQUIRED.filter((k) => !process.env[k] || !String(process.env[k]).trim());
  const present: Record<string, boolean> = {};

  for (const k of [...REQUIRED, ...RECOMMENDED]) {
    present[k] = Boolean(process.env[k] && String(process.env[k]).trim());
  }

  return NextResponse.json({
    ok: missing.length === 0,
    missingEnv: missing,
    presentEnv: present,
    network: process.env.SUI_NETWORK ?? "testnet",
  });
}
