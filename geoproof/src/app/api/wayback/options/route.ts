import { NextResponse } from "next/server";
import crypto from "node:crypto";

type BBox = [number, number, number, number];

type Body = {
  bbox: BBox;
  zoom?: number;
  limit?: number;
};

type WaybackOption = {
  id: number;
  date: string; // YYYY-MM-DD
  title: string;
  tileUrlTemplate: string;
};

const CAPABILITIES_URL =
  "https://wayback.maptiles.arcgis.com/arcgis/rest/services/World_Imagery/MapServer/WMTS/1.0.0/WMTSCapabilities.xml";

// Best-effort in-memory cache to avoid flakiness caused by transient tile errors / cold caches.
// NOTE: On serverless this may not persist across invocations, but it still helps locally and on warm lambdas.
const optionsCache = new Map<
  string,
  {
    expiresAt: number;
    value: {
      query: unknown;
      options: WaybackOption[];
      suggested: { beforeId: number; afterId: number };
    };
  }
>();

function centerOfBbox(bbox: BBox) {
  return { lon: (bbox[0] + bbox[2]) / 2, lat: (bbox[1] + bbox[3]) / 2 };
}

function clampLat(lat: number) {
  return Math.max(-85.05112878, Math.min(85.05112878, lat));
}

function lonLatToTile(lon: number, lat: number, z: number) {
  const n = 2 ** z;
  const x = Math.floor(((lon + 180) / 360) * n);
  const latRad = (clampLat(lat) * Math.PI) / 180;
  const y = Math.floor(((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n);
  return { x, y, z };
}

function parseWaybackVersions(xml: string): WaybackOption[] {
  const out: WaybackOption[] = [];
  const layerRe = /<Layer>([\s\S]*?)<\/Layer>/g;
  for (const m of xml.matchAll(layerRe)) {
    const layer = m[1] ?? "";
    const titleMatch = layer.match(/<ows:Title>\s*([^<]+)\s*<\/ows:Title>/);
    const title = titleMatch?.[1]?.trim() ?? "";
    if (!title) continue;

    const dateMatch = title.match(/Wayback\s+(\d{4}-\d{2}-\d{2})/);
    const date = dateMatch?.[1] ?? null;
    if (!date) continue;

    const resMatch = layer.match(/<ResourceURL[^>]*resourceType=\"tile\"[^>]*template=\"([^\"]+)\"/);
    const tpl = resMatch?.[1] ?? "";
    if (!tpl) continue;

    const idMatch = tpl.match(/\/tile\/(\d+)\//);
    const id = idMatch?.[1] ? Number(idMatch[1]) : NaN;
    if (!Number.isFinite(id)) continue;

    out.push({
      id,
      date,
      title,
      tileUrlTemplate: `/api/wayback/tile?v=${id}&z={z}&x={x}&y={y}`,
    });
  }

  // Newest first.
  out.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.id - a.id));
  return out;
}

async function probeTileHash(url: string): Promise<string | null> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 6_000);
  try {
    // Use cache where possible. The underlying tile proxy route emits immutable caching headers.
    // Avoiding `no-store` here reduces flakiness due to cold caches and transient upstream errors.
    const res = await fetch(url, { signal: ctrl.signal, cache: "force-cache" });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    return crypto.createHash("sha256").update(buf).digest("hex");
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

async function probeTileHashWithRetry(url: string, retries = 2): Promise<string | null> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const hash = await probeTileHash(url);
    if (hash) return hash;
    // Small backoff for transient errors / rate limiting.
    if (attempt < retries) {
      await new Promise((r) => setTimeout(r, 200 * (attempt + 1)));
    }
  }
  return null;
}

export async function POST(req: Request) {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (!body || !Array.isArray(body.bbox) || body.bbox.length !== 4) {
    return NextResponse.json({ error: "Expected { bbox: [minLng,minLat,maxLng,maxLat], zoom? }" }, { status: 400 });
  }

  const zoom = typeof body.zoom === "number" && Number.isFinite(body.zoom) ? Math.min(Math.max(Math.round(body.zoom), 0), 23) : 16;
  const limit = typeof body.limit === "number" && Number.isFinite(body.limit) ? Math.min(Math.max(Math.round(body.limit), 5), 120) : 60;

  let xml: string;
  try {
    const res = await fetch(CAPABILITIES_URL, { next: { revalidate: 60 * 60 } });
    if (!res.ok) {
      return NextResponse.json(
        { error: `Wayback capabilities failed: ${res.status} ${res.statusText}` },
        { status: 502 },
      );
    }
    xml = await res.text();
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: `Wayback request error: ${msg}` }, { status: 502 });
  }

  const versions = parseWaybackVersions(xml);
  if (versions.length === 0) {
    return NextResponse.json({ error: "Could not parse Wayback WMTS capabilities." }, { status: 502 });
  }

  const origin = new URL(req.url).origin;
  const { lon, lat } = centerOfBbox(body.bbox);
  const tile = lonLatToTile(lon, lat, zoom);

  const cacheKey = `${zoom}:${tile.x}:${tile.y}:${body.bbox.map((x) => x.toFixed(5)).join(",")}:${limit}`;
  const cached = optionsCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return NextResponse.json(cached.value);
  }

  // Probe from newest backwards and keep only unique-looking tiles (at this location+zoom).
  const available: WaybackOption[] = [];
  const seen = new Set<string>();
  let deduped = 0;
  let failed = 0;
  const startedAt = Date.now();
  // Increase probe window: the first request may be slow due to cold caches.
  const maxProbeMs = 30_000;
  const maxProbes = 180;
  let probed = 0;

  const batchSize = 10;
  for (let i = 0; i < versions.length; i += batchSize) {
    if (available.length >= limit) break;
    if (probed >= maxProbes) break;
    if (Date.now() - startedAt > maxProbeMs) break;

    const batch = versions.slice(i, i + batchSize);
    const results = await Promise.all(
      batch.map(async (v) => {
        const probeUrl = `${origin}/api/wayback/tile?v=${v.id}&z=${tile.z}&x=${tile.x}&y=${tile.y}`;
        const hash = await probeTileHashWithRetry(probeUrl);
        return { v, hash };
      }),
    );

    for (const r of results) {
      if (available.length >= limit) break;
      probed += 1;
      if (r.hash) {
        if (seen.has(r.hash)) {
          deduped += 1;
          continue;
        }
        seen.add(r.hash);
        available.push(r.v);
      } else {
        failed += 1;
      }
      if (probed >= maxProbes) break;
      if (Date.now() - startedAt > maxProbeMs) break;
    }
  }

  if (available.length === 0) {
    return NextResponse.json(
      { error: "No Wayback versions seem to have imagery at this location/zoom." },
      { status: 404 },
    );
  }

  // Oldest first for UI.
  const options = [...available].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id - b.id));

  const payload = {
    query: { bbox: body.bbox, zoom, tile, probed, maxProbeMs, maxProbes, deduped, failed },
    options,
    suggested: {
      beforeId: options[0].id,
      afterId: options[options.length - 1].id,
    },
  };

  // Cache for a short window to avoid flip-flopping results on refresh.
  optionsCache.set(cacheKey, { expiresAt: Date.now() + 5 * 60_000, value: payload });

  return NextResponse.json(payload);
}
