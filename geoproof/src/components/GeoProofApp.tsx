"use client";

import { useCallback, useMemo, useState } from "react";
import { DiffViewer, type DiffStats } from "./DiffViewer";
import { MapPicker, type BBox, type BaseLayer, type PointMarker } from "./MapPicker";
import { PlaceSearch, type PlaceResult } from "./PlaceSearch";

type StacPicked = {
  id: string;
  datetime: string | null;
  cloudCover: number | null;
  previewUrl: string | null;
  bbox: BBox | null;
  tileUrlTemplate?: string | null;
  tileBounds?: BBox | null;
  tileMinZoom?: number | null;
  tileMaxZoom?: number | null;
};

type StacResponse = {
  query: {
    bbox: BBox;
    startDate: string;
    endDate: string;
    collection: string;
    maxCloudOffsetDays: number;
    totalCandidates: number;
  };
  before: StacPicked;
  after: StacPicked;
  beforeClear: StacPicked | null;
  afterClear: StacPicked | null;
  error?: string;
};

type Variant = "closest" | "clearest";

function pickVariant(stac: StacResponse, v: Variant) {
  if (v === "clearest") {
    return {
      before: stac.beforeClear ?? stac.before,
      after: stac.afterClear ?? stac.after,
    };
  }
  return { before: stac.before, after: stac.after };
}

function fmt(dt: string | null) {
  if (!dt) return "—";
  const d = new Date(dt);
  if (Number.isNaN(d.getTime())) return dt;
  return d.toISOString().replace(".000Z", "Z");
}

type SelectionMode = "bbox" | "radius" | "fromTo";

function normalizeBbox(a: [number, number], b: [number, number]): BBox {
  const minLng = Math.min(a[0], b[0]);
  const maxLng = Math.max(a[0], b[0]);
  const minLat = Math.min(a[1], b[1]);
  const maxLat = Math.max(a[1], b[1]);
  return [minLng, minLat, maxLng, maxLat];
}

function bboxFromCenterRadius(center: [number, number], radiusKm: number): BBox {
  const [lng, lat] = center;
  const latRad = (lat * Math.PI) / 180;
  const kmPerDegLat = 110.574;
  const kmPerDegLng = 111.320 * Math.cos(latRad);
  const dLat = radiusKm / kmPerDegLat;
  const dLng = kmPerDegLng > 0 ? radiusKm / kmPerDegLng : radiusKm / 111.320;
  return [lng - dLng, lat - dLat, lng + dLng, lat + dLat];
}

function bboxFromTwoPoints(a: [number, number], b: [number, number], paddingRatio = 0.08): BBox {
  const raw = normalizeBbox(a, b);
  const w = raw[2] - raw[0];
  const h = raw[3] - raw[1];
  const padX = Math.max(0.01, w * paddingRatio);
  const padY = Math.max(0.01, h * paddingRatio);
  return [raw[0] - padX, raw[1] - padY, raw[2] + padX, raw[3] + padY];
}

export function GeoProofApp() {
  const [baseLayer, setBaseLayer] = useState<BaseLayer>("satellite");
  const [mode, setMode] = useState<SelectionMode>("bbox");

  // Mode: bbox-corners
  const [bbox, setBbox] = useState<BBox | null>([16.9, 51.0, 17.2, 51.2]);
  const [bboxAnchor, setBboxAnchor] = useState<[number, number] | null>(null);

  // Mode: center+radius
  const [centerPlace, setCenterPlace] = useState<PlaceResult | null>(null);
  const [centerCoord, setCenterCoord] = useState<[number, number] | null>(null);
  const [radiusKm, setRadiusKm] = useState<number>(15);

  // Mode: from/to
  const [fromPlace, setFromPlace] = useState<PlaceResult | null>(null);
  const [toPlace, setToPlace] = useState<PlaceResult | null>(null);
  const [fromCoord, setFromCoord] = useState<[number, number] | null>(null);
  const [toCoord, setToCoord] = useState<[number, number] | null>(null);

  const [startDate, setStartDate] = useState<string>("2024-06-01");
  const [endDate, setEndDate] = useState<string>("2024-06-10");

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stacS2, setStacS2] = useState<StacResponse | null>(null);
  const [stacLandsat, setStacLandsat] = useState<StacResponse | null>(null);
  const [secondaryWarning, setSecondaryWarning] = useState<string | null>(null);

  const [variant, setVariant] = useState<Variant>("clearest");
  const [maxCloudOffsetDays, setMaxCloudOffsetDays] = useState<number>(14);
  const [showSecondary, setShowSecondary] = useState<boolean>(true);

  const [threshold, setThreshold] = useState<number>(40);
  const [diffStats, setDiffStats] = useState<DiffStats | null>(null);

  const [tileZoom, setTileZoom] = useState<number>(16);

  const primary = stacS2;
  const primaryPicked = useMemo(() => (primary ? pickVariant(primary, variant) : null), [primary, variant]);

  const effectiveBbox = useMemo(() => {
    if (mode === "bbox") return bbox;
    if (mode === "radius" && centerCoord) return bboxFromCenterRadius(centerCoord, radiusKm);
    if (mode === "fromTo" && fromCoord && toCoord) return bboxFromTwoPoints(fromCoord, toCoord);
    return null;
  }, [mode, bbox, centerCoord, radiusKm, fromCoord, toCoord]);

  const circle = useMemo(() => {
    if (mode !== "radius" || !centerCoord) return null;
    return { center: centerCoord, radiusKm };
  }, [mode, centerCoord, radiusKm]);

  const points = useMemo((): PointMarker[] => {
    const out: PointMarker[] = [];
    if (mode === "bbox" && bboxAnchor) {
      out.push({ id: "bbox-anchor", coord: bboxAnchor, color: "#f97316" });
    }
    if (mode === "radius" && centerCoord) {
      out.push({ id: "center", coord: centerCoord, color: "#f97316" });
    }
    if (mode === "fromTo") {
      if (fromCoord) out.push({ id: "from", coord: fromCoord, color: "#16a34a" });
      if (toCoord) out.push({ id: "to", coord: toCoord, color: "#ef4444" });
    }
    return out;
  }, [mode, bboxAnchor, centerCoord, fromCoord, toCoord]);

  const line = useMemo((): [number, number][] => {
    if (mode !== "fromTo" || !fromCoord || !toCoord) return [];
    return [fromCoord, toCoord];
  }, [mode, fromCoord, toCoord]);

  const reportDraft = useMemo(() => {
    if (!effectiveBbox || !primary || !primaryPicked || !diffStats) return null;
    return {
      type: "GeoProofChangeReportDraft",
      version: 1,
      createdAt: new Date().toISOString(),
      bbox: effectiveBbox,
      window: { startDate, endDate },
      collection: primary.query.collection,
      imagery: {
        variant,
        before: primaryPicked.before,
        after: primaryPicked.after,
      },
      diff: {
        threshold,
        meanDiff: diffStats.meanDiff,
        changedPercent: diffStats.changedPercent,
        width: diffStats.width,
        height: diffStats.height,
      },
      publish: {
        walrus: "TODO",
        sui: "TODO",
      },
    };
  }, [effectiveBbox, primary, primaryPicked, diffStats, startDate, endDate, threshold, variant]);

  const runSearch = useCallback(async () => {
    setError(null);
    setStacS2(null);
    setStacLandsat(null);
    setDiffStats(null);
    setSecondaryWarning(null);

    if (!effectiveBbox) {
      if (mode === "bbox") {
        setError("Pick a bounding box on the map (click two corners).");
      } else if (mode === "radius") {
        setError("Pick a center point (map click or search) and a radius.");
      } else {
        setError("Pick both From and To locations (map clicks or search).");
      }
      return;
    }

    setLoading(true);
    try {
      const s2Promise = fetch("/api/stac/search", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            bbox: effectiveBbox,
            startDate,
            endDate,
            collection: "sentinel-2-l2a",
            maxCloudOffsetDays,
          }),
        });

      const lsPromise = showSecondary
        ? fetch("/api/stac/search", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              bbox: effectiveBbox,
              startDate,
              endDate,
              collection: "landsat-c2-l2",
              maxCloudOffsetDays,
            }),
          })
        : null;

      const results = await Promise.allSettled([s2Promise, ...(lsPromise ? [lsPromise] : [])]);
      const s2 = results[0];
      const ls = results.length > 1 ? results[1] : null;

      if (s2.status !== "fulfilled") {
        setError(`Sentinel-2 request error: ${String(s2.reason)}`);
        return;
      }

      const resS2 = s2.value;
      const rawS2 = (await resS2.json()) as unknown;
      if (!resS2.ok) {
        const msg =
          typeof rawS2 === "object" && rawS2 !== null && typeof (rawS2 as { error?: unknown }).error === "string"
            ? (rawS2 as { error: string }).error
            : `Sentinel-2 request failed: ${resS2.status}`;
        setError(msg);
        return;
      }

      setStacS2(rawS2 as StacResponse);

      if (ls) {
        if (ls.status === "fulfilled") {
          const resLs = ls.value;
          const rawLs = (await resLs.json()) as unknown;
          if (resLs.ok) {
            setStacLandsat(rawLs as StacResponse);
          } else {
            const msg =
              typeof rawLs === "object" && rawLs !== null && typeof (rawLs as { error?: unknown }).error === "string"
                ? (rawLs as { error: string }).error
                : `Landsat request failed: ${resLs.status}`;
            setSecondaryWarning(msg);
          }
        } else {
          setSecondaryWarning(`Landsat request error: ${String(ls.reason)}`);
        }
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, [effectiveBbox, mode, startDate, endDate, maxCloudOffsetDays, showSecondary]);

  const onMapClick = useCallback(
    (coord: [number, number]) => {
      setError(null);
      setStacS2(null);
      setStacLandsat(null);
      setSecondaryWarning(null);
      setDiffStats(null);

      if (mode === "bbox") {
        if (!bboxAnchor) {
          setBboxAnchor(coord);
          return;
        }
        const next = normalizeBbox(bboxAnchor, coord);
        setBbox(next);
        setBboxAnchor(null);
        return;
      }

      if (mode === "radius") {
        setCenterCoord(coord);
        setCenterPlace(null);
        return;
      }

      // from/to
      if (!fromCoord) {
        setFromCoord(coord);
        setFromPlace(null);
        return;
      }
      if (!toCoord) {
        setToCoord(coord);
        setToPlace(null);
      } else {
        // Third click resets.
        setFromCoord(coord);
        setToCoord(null);
        setFromPlace(null);
        setToPlace(null);
      }
    },
    [mode, bboxAnchor, fromCoord, toCoord],
  );

  const inputClassName =
    "w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-900 placeholder:text-zinc-400 focus:border-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-500/20";

  return (
    <div className="min-h-screen bg-zinc-50">
      <div className="mx-auto max-w-6xl px-4 py-10">
        <div className="mb-8 flex flex-col gap-2">
          <h1 className="text-2xl font-semibold tracking-tight text-zinc-900">GeoProof</h1>
          <p className="text-sm text-zinc-600">
            Verifiable satellite change reports (MVP). Pick a bounding box, choose a time window, then compute a simple
            pixel-diff change mask.
          </p>
          <p className="text-xs text-zinc-500">
            Qualification rule reminder: build our own project or contribute to RFPs/OSS. Topic hub: https://rebrand.ly/sui-topics
          </p>
        </div>

        <div className="grid gap-6 lg:grid-cols-[380px_1fr]">
          <div className="space-y-4">
            <div className="rounded-xl border border-zinc-200 bg-white p-4">
              <div className="mb-3 text-sm font-medium text-zinc-900">1) Select region + time window</div>

              <div className="mb-3">
                <div className="mb-1 text-xs font-medium text-zinc-700">Region selection</div>
                <div className="grid grid-cols-3 gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setError(null);
                      setStacS2(null);
                      setStacLandsat(null);
                      setSecondaryWarning(null);
                      setDiffStats(null);
                      setMode("bbox");
                      setBboxAnchor(null);
                      setCenterCoord(null);
                      setCenterPlace(null);
                      setFromCoord(null);
                      setToCoord(null);
                      setFromPlace(null);
                      setToPlace(null);
                    }}
                    className={`h-9 rounded-lg border px-2 text-sm font-medium ${
                      mode === "bbox"
                        ? "border-zinc-900 bg-zinc-900 text-white"
                        : "border-zinc-200 bg-white text-zinc-900 hover:bg-zinc-50"
                    }`}
                  >
                    Box
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setError(null);
                      setStacS2(null);
                      setStacLandsat(null);
                      setSecondaryWarning(null);
                      setDiffStats(null);
                      setMode("radius");
                      setBboxAnchor(null);
                      setFromCoord(null);
                      setToCoord(null);
                      setFromPlace(null);
                      setToPlace(null);
                    }}
                    className={`h-9 rounded-lg border px-2 text-sm font-medium ${
                      mode === "radius"
                        ? "border-zinc-900 bg-zinc-900 text-white"
                        : "border-zinc-200 bg-white text-zinc-900 hover:bg-zinc-50"
                    }`}
                  >
                    Place + radius
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setError(null);
                      setStacS2(null);
                      setStacLandsat(null);
                      setSecondaryWarning(null);
                      setDiffStats(null);
                      setMode("fromTo");
                      setBboxAnchor(null);
                      setCenterCoord(null);
                      setCenterPlace(null);
                      setFromCoord(null);
                      setToCoord(null);
                      setFromPlace(null);
                      setToPlace(null);
                    }}
                    className={`h-9 rounded-lg border px-2 text-sm font-medium ${
                      mode === "fromTo"
                        ? "border-zinc-900 bg-zinc-900 text-white"
                        : "border-zinc-200 bg-white text-zinc-900 hover:bg-zinc-50"
                    }`}
                  >
                    From → To
                  </button>
                </div>
                <div className="mt-2 text-xs text-zinc-500">
                  {mode === "bbox" ? "Click 2 corners on the map." : null}
                  {mode === "radius" ? "Search a place or click the map to set a center." : null}
                  {mode === "fromTo" ? "Pick From and To via search or map clicks." : null}
                </div>
              </div>

              {mode === "radius" ? (
                <div className="mb-3 space-y-3">
                  <PlaceSearch
                    label="Center"
                    placeholder="Search a place (e.g., Wroclaw, Poland)"
                    value={centerPlace}
                    onChange={(p) => {
                      setCenterPlace(p);
                      setCenterCoord(p ? p.coord : null);
                      setStacS2(null);
                      setStacLandsat(null);
                      setSecondaryWarning(null);
                      setDiffStats(null);
                    }}
                  />

                  <div>
                    <div className="mb-1 text-xs font-medium text-zinc-700">Radius (km)</div>
                    <div className="flex items-center gap-3">
                      <input
                        type="range"
                        min={0.05}
                        max={60}
                        step={0.05}
                        value={radiusKm}
                        onChange={(e) => setRadiusKm(Number(e.target.value))}
                        className="w-full"
                      />
                      <input
                        type="number"
                        min={0.01}
                        step={0.01}
                        value={radiusKm}
                        onChange={(e) => {
                          const v = Number(e.target.value);
                          if (Number.isFinite(v)) setRadiusKm(v);
                        }}
                        className="w-20 rounded-lg border border-zinc-200 bg-white px-2 py-2 text-right font-mono text-xs text-zinc-900"
                      />
                    </div>
                    <div className="mt-1 text-xs text-zinc-500">Tip: very small radii work best with higher tile zoom.</div>
                  </div>
                </div>
              ) : null}

              {mode === "fromTo" ? (
                <div className="mb-3 grid gap-3">
                  <PlaceSearch
                    label="From"
                    placeholder="Search start location"
                    value={fromPlace}
                    onChange={(p) => {
                      setFromPlace(p);
                      setFromCoord(p ? p.coord : null);
                      setStacS2(null);
                      setStacLandsat(null);
                      setSecondaryWarning(null);
                      setDiffStats(null);
                    }}
                  />
                  <PlaceSearch
                    label="To"
                    placeholder="Search end location"
                    value={toPlace}
                    onChange={(p) => {
                      setToPlace(p);
                      setToCoord(p ? p.coord : null);
                      setStacS2(null);
                      setStacLandsat(null);
                      setSecondaryWarning(null);
                      setDiffStats(null);
                    }}
                  />
                </div>
              ) : null}

              <label className="block text-xs font-medium text-zinc-700">Time window</label>
              <div className="mt-2 grid grid-cols-2 gap-3">
                <div>
                  <div className="mb-1 text-xs text-zinc-600">Start</div>
                  <input
                    type="date"
                    value={startDate}
                    onChange={(e) => setStartDate(e.target.value)}
                    className={inputClassName}
                  />
                </div>
                <div>
                  <div className="mb-1 text-xs text-zinc-600">End</div>
                  <input
                    type="date"
                    value={endDate}
                    onChange={(e) => setEndDate(e.target.value)}
                    className={inputClassName}
                  />
                </div>
              </div>

              <div className="mt-3 rounded-xl border border-zinc-200 bg-white p-3">
                <div className="text-xs font-medium text-zinc-900">Cloud handling + sources</div>
                <div className="mt-2 grid gap-2 text-xs text-zinc-700">
                  <label className="flex items-center gap-2">
                    <input
                      type="radio"
                      name="variant"
                      checked={variant === "closest"}
                      onChange={() => {
                        setVariant("closest");
                        setDiffStats(null);
                      }}
                    />
                    Closest to your chosen dates (may be cloudy)
                  </label>
                  <label className="flex items-center gap-2">
                    <input
                      type="radio"
                      name="variant"
                      checked={variant === "clearest"}
                      onChange={() => {
                        setVariant("clearest");
                        setDiffStats(null);
                      }}
                    />
                    Clearest (lowest cloud) within ±{maxCloudOffsetDays} days
                  </label>

                  <div className="mt-1">
                    <div className="mb-1 text-xs font-medium text-zinc-700">Clearest search window (days)</div>
                    <div className="flex items-center gap-3">
                      <input
                        type="range"
                        min={0}
                        max={45}
                        step={1}
                        value={maxCloudOffsetDays}
                        onChange={(e) => setMaxCloudOffsetDays(Number(e.target.value))}
                        className="w-full"
                      />
                      <div className="w-10 text-right font-mono text-xs text-zinc-700">{maxCloudOffsetDays}</div>
                    </div>
                  </div>

                  <label className="mt-1 flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={showSecondary}
                      onChange={(e) => {
                        setShowSecondary(e.target.checked);
                        setStacLandsat(null);
                        setSecondaryWarning(null);
                      }}
                    />
                    Also fetch Landsat (alternate source)
                  </label>
                </div>
              </div>

              <div className="mt-3 flex items-center gap-2">
                <button
                  onClick={runSearch}
                  disabled={loading}
                  className="inline-flex h-10 items-center justify-center rounded-lg bg-zinc-900 px-4 text-sm font-medium text-white disabled:opacity-50"
                >
                  {loading ? "Searching…" : "Find imagery"}
                </button>
                <button
                  onClick={() => {
                    setError(null);
                    setStacS2(null);
                    setStacLandsat(null);
                    setSecondaryWarning(null);
                    setDiffStats(null);

                    if (mode === "bbox") {
                      setBbox(null);
                      setBboxAnchor(null);
                      return;
                    }
                    if (mode === "radius") {
                      setCenterCoord(null);
                      setCenterPlace(null);
                      return;
                    }
                    setFromCoord(null);
                    setToCoord(null);
                    setFromPlace(null);
                    setToPlace(null);
                  }}
                  className="inline-flex h-10 items-center justify-center rounded-lg border border-zinc-200 bg-white px-4 text-sm font-medium text-zinc-900"
                >
                  Clear
                </button>
              </div>

              {effectiveBbox ? (
                <div className="mt-3 text-xs text-zinc-600">
                  <div className="font-medium text-zinc-700">BBox</div>
                  <div className="font-mono">[{effectiveBbox.map((x) => x.toFixed(4)).join(", ")}]</div>
                </div>
              ) : (
                <div className="mt-3 text-xs text-zinc-500">No bbox selected yet.</div>
              )}
            </div>

            <div className="rounded-xl border border-zinc-200 bg-white p-4">
              <div className="mb-3 text-sm font-medium text-zinc-900">2) Change mask sensitivity</div>
              <div className="flex items-center gap-3">
                <input
                  type="range"
                  min={0}
                  max={255}
                  value={threshold}
                  onChange={(e) => setThreshold(Number(e.target.value))}
                  className="w-full"
                />
                <div className="w-14 text-right font-mono text-xs text-zinc-700">{threshold}</div>
              </div>
              <div className="mt-2 text-xs text-zinc-500">Higher = fewer pixels considered “changed”.</div>
              {diffStats ? (
                <div className="mt-3 grid grid-cols-2 gap-3 text-xs">
                  <div className="rounded-lg border border-zinc-100 bg-zinc-50 p-2">
                    <div className="text-zinc-500">Mean diff</div>
                    <div className="font-mono text-zinc-900">{diffStats.meanDiff.toFixed(2)}</div>
                  </div>
                  <div className="rounded-lg border border-zinc-100 bg-zinc-50 p-2">
                    <div className="text-zinc-500">Changed</div>
                    <div className="font-mono text-zinc-900">{diffStats.changedPercent.toFixed(2)}%</div>
                  </div>
                </div>
              ) : null}
            </div>

            <div className="rounded-xl border border-zinc-200 bg-white p-4">
              <div className="mb-3 text-sm font-medium text-zinc-900">Output quality</div>
              <div className="text-xs text-zinc-600">
                We render before/after using Planetary Computer Sentinel-2 tiles. Higher zoom = sharper crops (and heavier
                requests).
              </div>
              <div className="mt-3 flex items-center gap-3">
                <input
                  type="range"
                  min={11}
                  max={18}
                  step={1}
                  value={tileZoom}
                  onChange={(e) => setTileZoom(Number(e.target.value))}
                  className="w-full"
                />
                <div className="w-14 text-right font-mono text-xs text-zinc-700">z={tileZoom}</div>
              </div>
              <div className="mt-2 text-xs text-zinc-500">
                If the bbox is large, we may automatically zoom out to keep tile downloads reasonable.
              </div>
            </div>

            <div className="rounded-xl border border-zinc-200 bg-white p-4">
              <div className="mb-2 text-sm font-medium text-zinc-900">3) Publish (scaffold)</div>
              <div className="text-xs text-zinc-600">
                Next step: store evidence bundle on Walrus and anchor a `ChangeReport` on Sui. For now, we produce a
                deterministic draft JSON.
              </div>
              <button
                disabled={!reportDraft}
                className="mt-3 inline-flex h-10 w-full items-center justify-center rounded-lg border border-zinc-200 bg-white text-sm font-medium text-zinc-900 disabled:opacity-50"
              >
                Publish (coming next)
              </button>
              {reportDraft ? (
                <pre className="mt-3 max-h-64 overflow-auto rounded-lg border border-zinc-100 bg-zinc-50 p-3 text-[11px] leading-4 text-zinc-800">
                  {JSON.stringify(reportDraft, null, 2)}
                </pre>
              ) : (
                <div className="mt-3 text-xs text-zinc-500">Run imagery search + diff to generate a draft.</div>
              )}
            </div>
          </div>

          <div className="space-y-4">
            <MapPicker
              baseLayer={baseLayer}
              onBaseLayerChange={setBaseLayer}
              bbox={effectiveBbox}
              circle={circle}
              points={points}
              line={line}
              onMapClick={onMapClick}
            />

            {error ? (
              <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800">{error}</div>
            ) : null}

            {secondaryWarning ? (
              <div className="rounded-xl border border-yellow-200 bg-yellow-50 p-4 text-sm text-yellow-900">
                {secondaryWarning}
              </div>
            ) : null}

            {stacS2 ? (
              <div className="rounded-xl border border-zinc-200 bg-white p-4">
                <div className="flex items-baseline justify-between gap-3">
                  <div className="text-sm font-medium text-zinc-900">Sentinel-2 (Planetary Computer)</div>
                  <div className="text-xs text-zinc-500">Candidates scanned: {stacS2.query.totalCandidates}</div>
                </div>
                <div className="mt-2 text-xs text-zinc-500">
                  We show two picks: (1) closest-to-date (may be cloudy) and (2) clearest within ±
                  {stacS2.query.maxCloudOffsetDays} days.
                </div>

                <div className="mt-3 grid gap-3 text-xs text-zinc-700 md:grid-cols-2">
                  <div className="rounded-lg border border-zinc-100 bg-zinc-50 p-3">
                    <div className="mb-2 font-medium text-zinc-900">Closest</div>
                    <div className="grid gap-2 md:grid-cols-2">
                      <div>
                        <div className="text-zinc-500">Before</div>
                        <div className="font-mono">{stacS2.before.id}</div>
                        <div>{fmt(stacS2.before.datetime)}</div>
                        {stacS2.before.cloudCover != null ? <div>Cloud: {stacS2.before.cloudCover}</div> : null}
                      </div>
                      <div>
                        <div className="text-zinc-500">After</div>
                        <div className="font-mono">{stacS2.after.id}</div>
                        <div>{fmt(stacS2.after.datetime)}</div>
                        {stacS2.after.cloudCover != null ? <div>Cloud: {stacS2.after.cloudCover}</div> : null}
                      </div>
                    </div>
                  </div>

                  <div className="rounded-lg border border-zinc-100 bg-zinc-50 p-3">
                    <div className="mb-2 font-medium text-zinc-900">Clearest</div>
                    <div className="grid gap-2 md:grid-cols-2">
                      <div>
                        <div className="text-zinc-500">Before</div>
                        <div className="font-mono">{(stacS2.beforeClear ?? stacS2.before).id}</div>
                        <div>{fmt((stacS2.beforeClear ?? stacS2.before).datetime)}</div>
                        {(stacS2.beforeClear ?? stacS2.before).cloudCover != null ? (
                          <div>Cloud: {(stacS2.beforeClear ?? stacS2.before).cloudCover}</div>
                        ) : null}
                      </div>
                      <div>
                        <div className="text-zinc-500">After</div>
                        <div className="font-mono">{(stacS2.afterClear ?? stacS2.after).id}</div>
                        <div>{fmt((stacS2.afterClear ?? stacS2.after).datetime)}</div>
                        {(stacS2.afterClear ?? stacS2.after).cloudCover != null ? (
                          <div>Cloud: {(stacS2.afterClear ?? stacS2.after).cloudCover}</div>
                        ) : null}
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            ) : null}

            {stacS2 && effectiveBbox ? (
              <div className="grid gap-4 md:grid-cols-2">
                <div className="rounded-xl border border-zinc-200 bg-white p-3">
                  <div className="mb-2 text-xs font-medium text-zinc-700">Closest</div>
                  <DiffViewer
                    beforeUrl={stacS2.before.previewUrl}
                    afterUrl={stacS2.after.previewUrl}
                    selectionBbox={effectiveBbox}
                    beforeItemBbox={stacS2.before.bbox}
                    afterItemBbox={stacS2.after.bbox}
                    beforeTileUrlTemplate={stacS2.before.tileUrlTemplate ?? null}
                    afterTileUrlTemplate={stacS2.after.tileUrlTemplate ?? null}
                    tileZoom={tileZoom}
                    threshold={threshold}
                    onComputed={variant === "closest" ? setDiffStats : undefined}
                  />
                </div>

                <div className="rounded-xl border border-zinc-200 bg-white p-3">
                  <div className="mb-2 text-xs font-medium text-zinc-700">Clearest</div>
                  <DiffViewer
                    beforeUrl={(stacS2.beforeClear ?? stacS2.before).previewUrl}
                    afterUrl={(stacS2.afterClear ?? stacS2.after).previewUrl}
                    selectionBbox={effectiveBbox}
                    beforeItemBbox={(stacS2.beforeClear ?? stacS2.before).bbox}
                    afterItemBbox={(stacS2.afterClear ?? stacS2.after).bbox}
                    beforeTileUrlTemplate={(stacS2.beforeClear ?? stacS2.before).tileUrlTemplate ?? null}
                    afterTileUrlTemplate={(stacS2.afterClear ?? stacS2.after).tileUrlTemplate ?? null}
                    tileZoom={tileZoom}
                    threshold={threshold}
                    onComputed={variant === "clearest" ? setDiffStats : undefined}
                  />
                </div>
              </div>
            ) : null}

            {showSecondary && stacLandsat ? (
              <div className="rounded-xl border border-zinc-200 bg-white p-4">
                <div className="flex items-baseline justify-between gap-3">
                  <div className="text-sm font-medium text-zinc-900">Landsat (alternate source)</div>
                  <div className="text-xs text-zinc-500">Candidates scanned: {stacLandsat.query.totalCandidates}</div>
                </div>
                <div className="mt-2 grid gap-4 md:grid-cols-2">
                  <div className="rounded-xl border border-zinc-200 bg-white p-3">
                    <div className="mb-2 text-xs font-medium text-zinc-700">Closest</div>
                    <DiffViewer
                      beforeUrl={stacLandsat.before.previewUrl}
                      afterUrl={stacLandsat.after.previewUrl}
                      selectionBbox={effectiveBbox}
                      beforeItemBbox={stacLandsat.before.bbox}
                      afterItemBbox={stacLandsat.after.bbox}
                      beforeTileUrlTemplate={stacLandsat.before.tileUrlTemplate ?? null}
                      afterTileUrlTemplate={stacLandsat.after.tileUrlTemplate ?? null}
                      tileZoom={tileZoom}
                      threshold={threshold}
                    />
                  </div>

                  <div className="rounded-xl border border-zinc-200 bg-white p-3">
                    <div className="mb-2 text-xs font-medium text-zinc-700">Clearest</div>
                    <DiffViewer
                      beforeUrl={(stacLandsat.beforeClear ?? stacLandsat.before).previewUrl}
                      afterUrl={(stacLandsat.afterClear ?? stacLandsat.after).previewUrl}
                      selectionBbox={effectiveBbox}
                      beforeItemBbox={(stacLandsat.beforeClear ?? stacLandsat.before).bbox}
                      afterItemBbox={(stacLandsat.afterClear ?? stacLandsat.after).bbox}
                      beforeTileUrlTemplate={(stacLandsat.beforeClear ?? stacLandsat.before).tileUrlTemplate ?? null}
                      afterTileUrlTemplate={(stacLandsat.afterClear ?? stacLandsat.after).tileUrlTemplate ?? null}
                      tileZoom={tileZoom}
                      threshold={threshold}
                    />
                  </div>
                </div>
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
