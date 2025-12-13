import { NextResponse } from "next/server";

type BBox = [number, number, number, number];

type StacSearchBody = {
  bbox: BBox;
  startDate: string; // YYYY-MM-DD
  endDate: string; // YYYY-MM-DD
  limit?: number;
  collection?: "sentinel-2-l2a" | "landsat-c2-l2";
  maxCloudOffsetDays?: number;
};

type StacFeature = {
  id: string;
  bbox?: number[];
  properties?: Record<string, unknown> & { datetime?: string };
  assets?: Record<string, { href?: string }>;
};

type TileJson = {
  tiles?: string[];
  bounds?: number[];
  minzoom?: number;
  maxzoom?: number;
};

function normalizeBbox(bbox: number[] | undefined): BBox | null {
  if (!bbox || bbox.length !== 4) return null;
  const [minLng, minLat, maxLng, maxLat] = bbox;
  if (![minLng, minLat, maxLng, maxLat].every((n) => typeof n === "number" && Number.isFinite(n))) return null;
  return [minLng, minLat, maxLng, maxLat];
}

function parseUtcDateMs(date: string): number {
  // Interpret YYYY-MM-DD as UTC to avoid local timezone surprises.
  return new Date(`${date}T00:00:00Z`).getTime();
}

function datetimeMs(f: StacFeature): number | null {
  const dt = f.properties?.datetime;
  if (!dt) return null;
  const ms = new Date(dt).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function cloudCoverPct(f: StacFeature): number | null {
  const cloud = f.properties?.["eo:cloud_cover"];
  return typeof cloud === "number" && Number.isFinite(cloud) ? cloud : null;
}

function daysBetween(aMs: number, bMs: number) {
  return Math.abs(aMs - bMs) / (24 * 60 * 60 * 1000);
}

function pickClosest(features: StacFeature[], targetMs: number): StacFeature | null {
  let best: StacFeature | null = null;
  let bestDist = Number.POSITIVE_INFINITY;

  for (const f of features) {
    const ms = datetimeMs(f);
    if (ms === null) continue;
    const dist = Math.abs(ms - targetMs);
    if (dist < bestDist) {
      best = f;
      bestDist = dist;
    }
  }

  return best;
}

function pickClearest(
  features: StacFeature[],
  targetMs: number,
  maxOffsetDays: number,
): StacFeature | null {
  const candidates = features
    .map((f) => {
      const ms = datetimeMs(f);
      const cloud = cloudCoverPct(f);
      if (ms === null || cloud === null) return null;
      const dtDays = daysBetween(ms, targetMs);
      return { f, cloud, dtDays };
    })
    .filter((x): x is { f: StacFeature; cloud: number; dtDays: number } => Boolean(x));

  const near = candidates.filter((c) => c.dtDays <= maxOffsetDays);
  const pool = near.length > 0 ? near : candidates;
  if (pool.length === 0) return null;

  pool.sort((a, b) => (a.cloud - b.cloud) || (a.dtDays - b.dtDays));
  return pool[0].f;
}

async function fetchTileInfo(f: StacFeature, collection: "sentinel-2-l2a" | "landsat-c2-l2") {
  const tilejsonHref = f.assets?.tilejson?.href ?? null;

  const url = tilejsonHref
    ? new URL(tilejsonHref)
    : (() => {
        const u = new URL("https://planetarycomputer.microsoft.com/api/data/v1/item/tilejson.json");
        u.searchParams.set("collection", collection);
        u.searchParams.set("item", f.id);
        if (collection === "sentinel-2-l2a") {
          u.searchParams.set("assets", "visual");
          u.searchParams.set("format", "png");
        } else {
          u.searchParams.append("assets", "red");
          u.searchParams.append("assets", "green");
          u.searchParams.append("assets", "blue");
          u.searchParams.set("format", "png");
        }
        return u;
      })();

  try {
    const res = await fetch(url.toString(), { cache: "no-store" });
    if (!res.ok) {
      return {
        tileUrlTemplate: null as string | null,
        tileBounds: null as BBox | null,
        tileMinZoom: null as number | null,
        tileMaxZoom: null as number | null,
      };
    }
    const json = (await res.json()) as TileJson;
    const tileUrlTemplate = Array.isArray(json.tiles) && typeof json.tiles[0] === "string" ? json.tiles[0] : null;
    const tileBounds = normalizeBbox(json.bounds);
    const tileMinZoom = typeof json.minzoom === "number" ? json.minzoom : null;
    const tileMaxZoom = typeof json.maxzoom === "number" ? json.maxzoom : null;
    return { tileUrlTemplate, tileBounds, tileMinZoom, tileMaxZoom };
  } catch {
    return {
      tileUrlTemplate: null as string | null,
      tileBounds: null as BBox | null,
      tileMinZoom: null as number | null,
      tileMaxZoom: null as number | null,
    };
  }
}

export async function POST(req: Request) {
  let body: StacSearchBody;
  try {
    body = (await req.json()) as StacSearchBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (
    !body ||
    !Array.isArray(body.bbox) ||
    body.bbox.length !== 4 ||
    typeof body.startDate !== "string" ||
    typeof body.endDate !== "string"
  ) {
    return NextResponse.json(
      { error: "Expected { bbox: [minLng,minLat,maxLng,maxLat], startDate, endDate, collection? }" },
      { status: 400 },
    );
  }

  const collection: "sentinel-2-l2a" | "landsat-c2-l2" =
    body.collection === "landsat-c2-l2" ? "landsat-c2-l2" : "sentinel-2-l2a";
  const maxCloudOffsetDays =
    typeof body.maxCloudOffsetDays === "number" && Number.isFinite(body.maxCloudOffsetDays)
      ? Math.min(Math.max(body.maxCloudOffsetDays, 0), 90)
      : collection === "landsat-c2-l2"
        ? 30
        : 14;

  const limit = typeof body.limit === "number" ? Math.min(Math.max(body.limit, 1), 200) : 100;
  const startMs = parseUtcDateMs(body.startDate);
  const endMs = parseUtcDateMs(body.endDate);

  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs > endMs) {
    return NextResponse.json({ error: "Invalid date range" }, { status: 400 });
  }

  const stacUrl = "https://planetarycomputer.microsoft.com/api/stac/v1/search";
  const stacBody = {
    collections: [collection],
    bbox: body.bbox,
    datetime: `${body.startDate}T00:00:00Z/${body.endDate}T23:59:59Z`,
    limit,
  };

  let json: unknown;
  try {
    const res = await fetch(stacUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(stacBody),
      // Avoid caching surprises during iteration.
      cache: "no-store",
    });

    if (!res.ok) {
      return NextResponse.json(
        { error: `STAC search failed: ${res.status} ${res.statusText}` },
        { status: 502 },
      );
    }
    json = (await res.json()) as unknown;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: `STAC request error: ${msg}` }, { status: 502 });
  }

  const features =
    typeof json === "object" && json !== null && Array.isArray((json as { features?: unknown }).features)
      ? ((json as { features: unknown[] }).features as StacFeature[])
      : [];
  if (!Array.isArray(features) || features.length === 0) {
    return NextResponse.json(
      { error: "No imagery found for that bbox/time window. Try a larger bbox or longer date range." },
      { status: 404 },
    );
  }

  const before = pickClosest(features, startMs);
  const after = pickClosest(features, endMs);
  const beforeClear = pickClearest(features, startMs, maxCloudOffsetDays);
  const afterClear = pickClearest(features, endMs, maxCloudOffsetDays);

  if (!before || !after) {
    return NextResponse.json(
      { error: "Could not pick before/after imagery from results." },
      { status: 502 },
    );
  }

  const normalizeItem = (f: StacFeature) => {
    const dt = f.properties?.datetime ?? null;
    const cloudCover = cloudCoverPct(f);
    const previewUrl = f.assets?.rendered_preview?.href ?? f.assets?.preview?.href ?? f.assets?.thumbnail?.href ?? null;
    return {
      id: f.id,
      datetime: dt,
      cloudCover,
      previewUrl,
      bbox: normalizeBbox(f.bbox),
    };
  };

  const [beforeTile, afterTile, beforeClearTile, afterClearTile] = await Promise.all([
    fetchTileInfo(before, collection),
    fetchTileInfo(after, collection),
    beforeClear ? fetchTileInfo(beforeClear, collection) : Promise.resolve(null),
    afterClear ? fetchTileInfo(afterClear, collection) : Promise.resolve(null),
  ]);

  return NextResponse.json({
    query: {
      bbox: body.bbox,
      startDate: body.startDate,
      endDate: body.endDate,
      collection,
      maxCloudOffsetDays,
      totalCandidates: features.length,
    },
    before: { ...normalizeItem(before), ...beforeTile },
    after: { ...normalizeItem(after), ...afterTile },
    beforeClear: beforeClear ? { ...normalizeItem(beforeClear), ...(beforeClearTile ?? {}) } : null,
    afterClear: afterClear ? { ...normalizeItem(afterClear), ...(afterClearTile ?? {}) } : null,
  });
}
