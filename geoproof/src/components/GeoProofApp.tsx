"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
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
type PrimarySource = "wayback" | "sentinel-2-l2a" | "landsat-c2-l2";

type WaybackPicked = {
  id: number;
  date: string;
  title: string;
  tileUrlTemplate: string;
};

type WaybackOptionsResponse = {
  query: { bbox: BBox; zoom: number; tile: { x: number; y: number; z: number } };
  options: WaybackPicked[];
  suggested: { beforeId: number; afterId: number };
  error?: string;
};

type WaybackState = {
  query: WaybackOptionsResponse["query"];
  options: WaybackPicked[];
  beforeId: number;
  afterId: number;
};

function clampInt(n: number, min: number, max: number) {
  return Math.min(Math.max(Math.round(n), min), max);
}

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
  // Default selection: Flughafen Berlin Brandenburg (BER)
  const [bbox, setBbox] = useState<BBox | null>([13.37, 52.31, 13.63, 52.46]);
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
  const [wayback, setWayback] = useState<WaybackState | null>(null);
  const [waybackLoading, setWaybackLoading] = useState<boolean>(false);
  const [secondaryWarning, setSecondaryWarning] = useState<string | null>(null);

  const [variant, setVariant] = useState<Variant>("clearest");
  const [primarySource, setPrimarySource] = useState<PrimarySource>("wayback");
  const [maxCloudOffsetDays, setMaxCloudOffsetDays] = useState<number>(14);
  const [showSecondary, setShowSecondary] = useState<boolean>(true);
  const [showWayback, setShowWayback] = useState<boolean>(true);

  const [ignoreClouds, setIgnoreClouds] = useState<boolean>(true);
  const [ignoreDark, setIgnoreDark] = useState<boolean>(false);

  const [threshold, setThreshold] = useState<number>(40);

  type Artifacts = { beforeDataUrl: string; afterDataUrl: string; diffDataUrl: string };

  // Persist computed diffs per source/variant so the Publish button doesn't depend on which panel
  // happened to compute last.
  const [waybackStats, setWaybackStats] = useState<DiffStats | null>(null);
  const [waybackArtifacts, setWaybackArtifacts] = useState<Artifacts | null>(null);
  const [s2ClosestStats, setS2ClosestStats] = useState<DiffStats | null>(null);
  const [s2ClosestArtifacts, setS2ClosestArtifacts] = useState<Artifacts | null>(null);
  const [s2ClearestStats, setS2ClearestStats] = useState<DiffStats | null>(null);
  const [s2ClearestArtifacts, setS2ClearestArtifacts] = useState<Artifacts | null>(null);
  const [lsClosestStats, setLsClosestStats] = useState<DiffStats | null>(null);
  const [lsClosestArtifacts, setLsClosestArtifacts] = useState<Artifacts | null>(null);
  const [lsClearestStats, setLsClearestStats] = useState<DiffStats | null>(null);
  const [lsClearestArtifacts, setLsClearestArtifacts] = useState<Artifacts | null>(null);

  const [publishLoading, setPublishLoading] = useState<boolean>(false);
  const [publishError, setPublishError] = useState<string | null>(null);
  const [publishResult, setPublishResult] = useState<unknown | null>(null);
  const [publishDiag, setPublishDiag] = useState<{ missingEnv: string[]; error: string | null } | null>(null);
  const [publishBalance, setPublishBalance] = useState<
    | {
        network: string;
        address: string;
        balances: { SUI: { total: string; coinType?: string }; WAL: { total: string; coinType?: string } };
      }
    | { error: string }
    | null
  >(null);

  type ArtifactsMode = "none" | "diff" | "all";
  const [artifactsMode, setArtifactsMode] = useState<ArtifactsMode>("none");

  type PublishEstimateOk = {
    bytes: { evidenceBundle: number };
    walrus: { cost: { totalCost: string } | null; resolved: { derivedWalType: string | null } };
    wallet: { walBalances: Record<string, string> };
  };
  const [publishEstimate, setPublishEstimate] = useState<PublishEstimateOk | { error: string } | null>(null);

  const [waybackComputeNonce, setWaybackComputeNonce] = useState<number>(0);

  const [tileZoom, setTileZoom] = useState<number>(16);

  const resetComputed = useCallback(() => {
    setWaybackStats(null);
    setWaybackArtifacts(null);
    setS2ClosestStats(null);
    setS2ClosestArtifacts(null);
    setS2ClearestStats(null);
    setS2ClearestArtifacts(null);
    setLsClosestStats(null);
    setLsClosestArtifacts(null);
    setLsClearestStats(null);
    setLsClearestArtifacts(null);
  }, []);

  const resetStacComputed = useCallback(() => {
    setS2ClosestStats(null);
    setS2ClosestArtifacts(null);
    setS2ClearestStats(null);
    setS2ClearestArtifacts(null);
    setLsClosestStats(null);
    setLsClosestArtifacts(null);
    setLsClearestStats(null);
    setLsClearestArtifacts(null);
  }, []);

  // Draft indices for sliders to avoid re-running expensive tile diffs on every drag tick.
  const [wbDraftBeforeIdx, setWbDraftBeforeIdx] = useState<number | null>(null);
  const [wbDraftAfterIdx, setWbDraftAfterIdx] = useState<number | null>(null);

  const waybackPicked = useMemo(() => {
    if (!wayback) return null;
    const before = wayback.options.find((o) => o.id === wayback.beforeId) ?? wayback.options[0];
    const after =
      wayback.options.find((o) => o.id === wayback.afterId) ?? wayback.options[wayback.options.length - 1];
    if (!before || !after) return null;
    return { before, after };
  }, [wayback]);

  const waybackIndices = useMemo(() => {
    if (!wayback) return null;
    const beforeIndex = Math.max(
      0,
      wayback.options.findIndex((o) => o.id === wayback.beforeId),
    );
    const afterIndex = Math.max(
      0,
      wayback.options.findIndex((o) => o.id === wayback.afterId),
    );
    return { beforeIndex, afterIndex, max: Math.max(0, wayback.options.length - 1) };
  }, [wayback]);

  // Keep draft slider positions in sync when we load a new Wayback timeline.
  useEffect(() => {
    if (!wayback) {
      setWbDraftBeforeIdx(null);
      setWbDraftAfterIdx(null);
      return;
    }
    const beforeIdx = Math.max(0, wayback.options.findIndex((o) => o.id === wayback.beforeId));
    const afterIdx = Math.max(0, wayback.options.findIndex((o) => o.id === wayback.afterId));
    setWbDraftBeforeIdx(beforeIdx);
    setWbDraftAfterIdx(afterIdx);
  }, [wayback]);

  // Debounce committing slider changes into the "real" beforeId/afterId.
  useEffect(() => {
    if (!wayback || wbDraftBeforeIdx == null || wbDraftAfterIdx == null) return;
    const t = setTimeout(() => {
      const max = wayback.options.length - 1;
      const beforeIdx = clampInt(wbDraftBeforeIdx, 0, max);
      const afterIdx = clampInt(wbDraftAfterIdx, 0, max);
      const safeBefore = Math.min(beforeIdx, Math.max(0, afterIdx - 1));
      const safeAfter = Math.max(afterIdx, Math.min(max, safeBefore + 1));
      const before = wayback.options[safeBefore];
      const after = wayback.options[safeAfter];
      if (!before || !after) return;

      // IMPORTANT: Don't update Wayback state if ids didn't actually change.
      // Otherwise we create a new `wayback` object every 250ms -> repeated resets -> Publish button flickers.
      if (before.id === wayback.beforeId && after.id === wayback.afterId) return;

      setWayback((prev) => (prev ? { ...prev, beforeId: before.id, afterId: after.id } : prev));
      setStartDate(before.date);
      setEndDate(after.date);

      // Clear only Wayback computed state; DiffViewer will recompute immediately with new templates.
      setWaybackStats(null);
      setWaybackArtifacts(null);
    }, 250);
    return () => clearTimeout(t);
  }, [wayback, wbDraftBeforeIdx, wbDraftAfterIdx]);

  const primary = useMemo(() => {
    if (primarySource === "wayback") return null;
    if (primarySource === "landsat-c2-l2") return stacLandsat ?? stacS2;
    return stacS2;
  }, [primarySource, stacLandsat, stacS2]);

  const primaryPicked = useMemo(() => (primary ? pickVariant(primary, variant) : null), [primary, variant]);

  const effectiveBbox = useMemo(() => {
    if (mode === "bbox") return bbox;
    if (mode === "radius" && centerCoord) return bboxFromCenterRadius(centerCoord, radiusKm);
    if (mode === "fromTo" && fromCoord && toCoord) return bboxFromTwoPoints(fromCoord, toCoord);
    return null;
  }, [mode, bbox, centerCoord, radiusKm, fromCoord, toCoord]);

  // Auto-load Wayback timeline when the bbox changes (debounced), so the timeline feels like a feature.
  useEffect(() => {
    if (!showWayback || !effectiveBbox) {
      setWayback(null);
      setWaybackLoading(false);
      return;
    }

    const ctrl = new AbortController();
    const t = setTimeout(async () => {
      setWaybackLoading(true);
      setWayback(null);
      resetComputed();
      setSecondaryWarning(null);
      setStacS2(null);
      setStacLandsat(null);

      try {
        const res = await fetch("/api/wayback/options", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ bbox: effectiveBbox, zoom: tileZoom, limit: 60 }),
          signal: ctrl.signal,
        });
        const raw = (await res.json()) as unknown;
        if (!res.ok) {
          const msg =
            typeof raw === "object" && raw !== null && typeof (raw as { error?: unknown }).error === "string"
              ? (raw as { error: string }).error
              : `Wayback request failed: ${res.status}`;
          setSecondaryWarning(msg);
          return;
        }

        const data = raw as WaybackOptionsResponse;
        const beforeId = data.suggested?.beforeId ?? data.options?.[0]?.id;
        const afterId = data.suggested?.afterId ?? data.options?.[data.options.length - 1]?.id;
        if (beforeId == null || afterId == null || !Array.isArray(data.options) || data.options.length < 2) {
          setSecondaryWarning("Wayback returned too few unique snapshots for this location.");
          return;
        }

        const before = data.options.find((o) => o.id === beforeId) ?? data.options[0];
        const after = data.options.find((o) => o.id === afterId) ?? data.options[data.options.length - 1];
        setWayback({ query: data.query, options: data.options, beforeId, afterId });
        setStartDate(before.date);
        setEndDate(after.date);
      } catch (e: unknown) {
        if (e instanceof Error && e.name === "AbortError") return;
        const msg = e instanceof Error ? e.message : String(e);
        setSecondaryWarning(`Wayback request error: ${msg}`);
      } finally {
        setWaybackLoading(false);
      }
    }, 350);

    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [showWayback, effectiveBbox, tileZoom, resetComputed]);

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

  const activeComputed = useMemo(() => {
    if (primarySource === "wayback") return { stats: waybackStats, artifacts: waybackArtifacts };
    if (primarySource === "sentinel-2-l2a") {
      return variant === "clearest"
        ? { stats: s2ClearestStats, artifacts: s2ClearestArtifacts }
        : { stats: s2ClosestStats, artifacts: s2ClosestArtifacts };
    }
    // landsat
    return variant === "clearest"
      ? { stats: lsClearestStats, artifacts: lsClearestArtifacts }
      : { stats: lsClosestStats, artifacts: lsClosestArtifacts };
  }, [
    primarySource,
    variant,
    waybackStats,
    waybackArtifacts,
    s2ClosestStats,
    s2ClosestArtifacts,
    s2ClearestStats,
    s2ClearestArtifacts,
    lsClosestStats,
    lsClosestArtifacts,
    lsClearestStats,
    lsClearestArtifacts,
  ]);

  const reportDraft = useMemo(() => {
    const diffStats = activeComputed.stats;
    if (!effectiveBbox || !diffStats) return null;

    if (primarySource === "wayback") {
      if (!wayback || !waybackPicked) return null;
      return {
        type: "GeoProofChangeReportDraft",
        version: 1,
        createdAt: new Date().toISOString(),
        bbox: effectiveBbox,
        window: { startDate, endDate },
        collection: "esri-world-imagery-wayback",
        imagery: {
          sourceRequested: primarySource,
          sourceUsed: "esri-world-imagery-wayback",
          variant: "closest",
          before: waybackPicked.before,
          after: waybackPicked.after,
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
    }

    if (!primary || !primaryPicked) return null;
    return {
      type: "GeoProofChangeReportDraft",
      version: 1,
      createdAt: new Date().toISOString(),
      bbox: effectiveBbox,
      window: { startDate, endDate },
      collection: primary.query.collection,
      imagery: {
        sourceRequested: primarySource,
        sourceUsed: primary.query.collection,
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
  }, [
    activeComputed.stats,
    effectiveBbox,
    primary,
    primaryPicked,
    startDate,
    endDate,
    threshold,
    variant,
    primarySource,
    wayback,
    waybackPicked,
  ]);

  const runSearch = useCallback(async () => {
    setError(null);
    setStacS2(null);
    setStacLandsat(null);
    // Don't wipe Wayback computed diffs; searching STAC shouldn't disable publishing a completed Wayback diff.
    resetStacComputed();
    setPublishError(null);
    setPublishResult(null);
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
      let windowStart = startDate;
      let windowEnd = endDate;

      // Canonical window: derive from selected Wayback snapshots (if available), otherwise use current state.
      if (showWayback && wayback) {
        const before = wayback.options.find((o) => o.id === wayback.beforeId);
        const after = wayback.options.find((o) => o.id === wayback.afterId);
        if (before?.date && after?.date) {
          windowStart = before.date;
          windowEnd = after.date;
        }
      }

      // Keep internal window in sync (used by STAC + report draft).
      setStartDate(windowStart);
      setEndDate(windowEnd);

      // 2) Fetch STAC using the canonical window.
      const s2Promise = fetch("/api/stac/search", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            bbox: effectiveBbox,
            startDate: windowStart,
            endDate: windowEnd,
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
              startDate: windowStart,
              endDate: windowEnd,
              collection: "landsat-c2-l2",
              maxCloudOffsetDays,
            }),
          })
        : null;

      const promises: Promise<Response>[] = [s2Promise];
      if (lsPromise) promises.push(lsPromise);
      const results = await Promise.allSettled(promises);

      const s2 = results[0];
      const ls = lsPromise ? results[1] : null;

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
  }, [
    effectiveBbox,
    mode,
    startDate,
    endDate,
    maxCloudOffsetDays,
    showSecondary,
    showWayback,
    wayback,
    resetStacComputed,
  ]);

  const onMapClick = useCallback(
    (coord: [number, number]) => {
      setError(null);
      setStacS2(null);
      setStacLandsat(null);
      setWayback(null);
      setSecondaryWarning(null);
      resetComputed();
      setPublishError(null);
      setPublishResult(null);

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
    [mode, bboxAnchor, fromCoord, toCoord, resetComputed],
  );

  const doPublish = useCallback(async () => {
    if (!reportDraft) return;
    setPublishError(null);
    setPublishResult(null);
    setPublishLoading(true);
    try {
      const res = await fetch("/api/publish", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          reportDraft,
          artifacts: activeComputed.artifacts ?? undefined,
          artifactsMode,
        }),
      });

      const raw = (await res.json()) as unknown;
      if (!res.ok) {
        const msg =
          typeof raw === "object" && raw !== null && typeof (raw as { error?: unknown }).error === "string"
            ? (raw as { error: string }).error
            : `Publish failed: ${res.status}`;
        setPublishError(msg);
        setPublishResult(raw);
        return;
      }
      setPublishResult(raw);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setPublishError(msg);
    } finally {
      setPublishLoading(false);
    }
  }, [activeComputed.artifacts, reportDraft, artifactsMode]);

  const diffStats = activeComputed.stats;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/publish/diagnose", { method: "GET" });
        const raw = (await res.json()) as unknown;
        if (!res.ok) {
          const msg =
            typeof raw === "object" && raw !== null && "error" in raw && typeof (raw as { error?: unknown }).error === "string"
              ? (raw as { error: string }).error
              : `HTTP ${res.status}`;
          if (!cancelled) setPublishDiag({ missingEnv: [], error: msg });
          return;
        }
        const missingEnv = (() => {
          if (typeof raw !== "object" || raw === null) return [];
          const v = (raw as Record<string, unknown>)["missingEnv"];
          if (!Array.isArray(v)) return [];
          return v.filter((x): x is string => typeof x === "string");
        })();
        if (!cancelled) setPublishDiag({ missingEnv, error: null });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        if (!cancelled) setPublishDiag({ missingEnv: [], error: msg });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/publish/balance", { method: "GET" });
        const raw = (await res.json()) as unknown;
        if (!res.ok) {
          const msg =
            typeof raw === "object" && raw !== null && "error" in raw && typeof (raw as { error?: unknown }).error === "string"
              ? (raw as { error: string }).error
              : `HTTP ${res.status}`;
          if (!cancelled) setPublishBalance({ error: msg });
          return;
        }
        if (!cancelled)
          setPublishBalance(
            raw as {
              network: string;
              address: string;
              balances: { SUI: { total: string; coinType?: string }; WAL: { total: string; coinType?: string } };
            },
          );
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        if (!cancelled) setPublishBalance({ error: msg });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const t = setTimeout(() => {
      (async () => {
        if (!reportDraft) {
          if (!cancelled) setPublishEstimate(null);
          return;
        }
        try {
          const res = await fetch("/api/publish/estimate", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              reportDraft,
              artifacts: activeComputed.artifacts ?? undefined,
              artifactsMode,
            }),
          });
          const raw = (await res.json()) as unknown;
          if (!res.ok) {
            const msg =
              typeof raw === "object" && raw !== null && "error" in raw && typeof (raw as { error?: unknown }).error === "string"
                ? (raw as { error: string }).error
                : `HTTP ${res.status}`;
            if (!cancelled) setPublishEstimate({ error: msg });
            return;
          }
          if (!cancelled) setPublishEstimate(raw as PublishEstimateOk);
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          if (!cancelled) setPublishEstimate({ error: msg });
        }
      })();
    }, 250);

    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [reportDraft, activeComputed.artifacts, artifactsMode]);

  const publishDisabledReasons = useMemo(() => {
    const reasons: string[] = [];
    if (publishLoading) reasons.push("Publish is in progress.");
    if (!effectiveBbox) reasons.push("Select a region (bbox / radius / from→to).");

    if (primarySource === "wayback") {
      if (!showWayback) reasons.push("Wayback is not enabled (toggle ‘Also fetch Wayback’).");
      if (waybackLoading) reasons.push("Wayback timeline is still loading.");
      if (!wayback) reasons.push("Wayback timeline not available for this area yet.");
      if (!waybackPicked) reasons.push("Pick two Wayback snapshots (before + after).");
      if (!waybackStats) {
        reasons.push("Wayback diff stats not computed yet (wait for tiles/diff to finish)." );
        if (waybackArtifacts?.diffDataUrl) {
          reasons.push("A change mask may be visible from a previous run. Click ‘Recompute Wayback diff’ to refresh stats.");
        }
      }
    } else if (primarySource === "sentinel-2-l2a") {
      if (!stacS2) reasons.push("Run ‘Find imagery’ to load Sentinel‑2 imagery.");
      if ((variant === "clearest" ? s2ClearestStats : s2ClosestStats) == null)
        reasons.push(`Sentinel‑2 (${variant}) diff stats not computed yet.`);
    } else {
      if (!showSecondary) reasons.push("Enable ‘Also fetch Landsat’ to use Landsat as primary.");
      if (!stacLandsat) reasons.push("Run ‘Find imagery’ to load Landsat imagery.");
      if ((variant === "clearest" ? lsClearestStats : lsClosestStats) == null)
        reasons.push(`Landsat (${variant}) diff stats not computed yet.`);
    }

    if (publishDiag?.error) reasons.push(`Publish config check failed: ${publishDiag.error}`);
    if (publishDiag?.missingEnv?.length) reasons.push(`Missing server env vars: ${publishDiag.missingEnv.join(", ")}`);

    if (publishEstimate) {
      if ("error" in publishEstimate) {
        reasons.push(`Publish estimate failed: ${publishEstimate.error}`);
      } else {
        const derivedWalType = publishEstimate.walrus.resolved.derivedWalType;
        const totalCost = publishEstimate.walrus.cost?.totalCost ?? null;
        if (derivedWalType && totalCost) {
          const have = publishEstimate.wallet.walBalances[derivedWalType] ?? "0";
          try {
            if (BigInt(have) < BigInt(totalCost)) {
              reasons.push(
                `Insufficient WAL for current Walrus deployment (needs WAL of type ${derivedWalType.slice(0, 10)}...).`,
              );
            }
          } catch {
            // ignore
          }
        }
      }
    }

    return reasons;
  }, [
    publishLoading,
    effectiveBbox,
    primarySource,
    showWayback,
    waybackLoading,
    wayback,
    waybackPicked,
    waybackStats,
    waybackArtifacts,
    stacS2,
    stacLandsat,
    showSecondary,
    variant,
    s2ClearestStats,
    s2ClosestStats,
    lsClearestStats,
    lsClosestStats,
    publishDiag,
    publishEstimate,
  ]);

  return (
    <div className="min-h-screen bg-zinc-950">
      <div className="mx-auto max-w-6xl px-4 py-10">
        <div className="mb-8 flex flex-col gap-2">
          <h1 className="text-2xl font-semibold tracking-tight text-zinc-100">GeoProof</h1>
          <p className="text-sm text-zinc-300">
            Verifiable satellite change reports (MVP). Pick a bounding box, choose a time window, then compute a simple
            pixel-diff change mask.
          </p>
          <p className="text-xs text-zinc-500">
            Qualification rule reminder: build our own project or contribute to RFPs/OSS. Topic hub: https://rebrand.ly/sui-topics
          </p>
        </div>

        <div className="grid gap-6 lg:grid-cols-[380px_1fr]">
          <div className="space-y-4">
            <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
              <div className="mb-3 text-sm font-medium text-zinc-100">1) Select region + time window</div>

              <div className="mb-3">
                <div className="mb-1 text-xs font-medium text-zinc-300">Region selection</div>
                <div className="grid grid-cols-3 gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setError(null);
                      setStacS2(null);
                      setStacLandsat(null);
                      setSecondaryWarning(null);
                            resetComputed();
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
                        ? "border-zinc-100 bg-zinc-100 text-zinc-950"
                        : "border-zinc-800 bg-zinc-900 text-zinc-100 hover:bg-zinc-800"
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
                            resetComputed();
                      setMode("radius");
                      setBboxAnchor(null);
                      setFromCoord(null);
                      setToCoord(null);
                      setFromPlace(null);
                      setToPlace(null);
                    }}
                    className={`h-9 rounded-lg border px-2 text-sm font-medium ${
                      mode === "radius"
                        ? "border-zinc-100 bg-zinc-100 text-zinc-950"
                        : "border-zinc-800 bg-zinc-900 text-zinc-100 hover:bg-zinc-800"
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
                            resetComputed();
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
                        ? "border-zinc-100 bg-zinc-100 text-zinc-950"
                        : "border-zinc-800 bg-zinc-900 text-zinc-100 hover:bg-zinc-800"
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
                            resetComputed();
                    }}
                  />

                  <div>
                    <div className="mb-1 text-xs font-medium text-zinc-300">Radius (km)</div>
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
                        className="w-20 rounded-lg border border-zinc-800 bg-zinc-950 px-2 py-2 text-right font-mono text-xs text-zinc-100"
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
                            resetComputed();
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
                            resetComputed();
                    }}
                  />
                </div>
              ) : null}

              <label className="block text-xs font-medium text-zinc-300">Time window</label>
              <div className="mt-2 rounded-xl border border-zinc-800 bg-zinc-950 p-3">
                <div className="text-xs font-medium text-zinc-100">Time window (Wayback timeline)</div>
                <div className="mt-1 text-xs text-zinc-400">
                  Instead of typing dates, you pick two Wayback snapshots. We use that same window for Sentinel/Landsat
                  too.
                </div>

                {showWayback && wayback && waybackIndices && waybackPicked && wbDraftBeforeIdx != null && wbDraftAfterIdx != null ? (
                  <div className="mt-3 grid gap-3">
                    <div className="grid gap-2">
                      <div className="flex items-center justify-between text-[11px] text-zinc-400">
                        <div>
                          Before: <span className="font-mono text-zinc-200">{waybackPicked.before.date}</span>
                        </div>
                        <div className="font-mono text-zinc-500">
                          {waybackIndices.beforeIndex + 1}/{wayback.options.length}
                        </div>
                      </div>
                      <input
                        type="range"
                        min={0}
                        max={waybackIndices.max}
                        step={1}
                        value={wbDraftBeforeIdx}
                        onChange={(e) => {
                          const idx = clampInt(Number(e.target.value), 0, waybackIndices.max);
                          const safeIdx = Math.min(idx, Math.max(0, wbDraftAfterIdx - 1));
                          setWbDraftBeforeIdx(safeIdx);
                        }}
                        className="w-full"
                      />
                    </div>

                    <div className="grid gap-2">
                      <div className="flex items-center justify-between text-[11px] text-zinc-400">
                        <div>
                          After: <span className="font-mono text-zinc-200">{waybackPicked.after.date}</span>
                        </div>
                        <div className="font-mono text-zinc-500">
                          {waybackIndices.afterIndex + 1}/{wayback.options.length}
                        </div>
                      </div>
                      <input
                        type="range"
                        min={0}
                        max={waybackIndices.max}
                        step={1}
                        value={wbDraftAfterIdx}
                        onChange={(e) => {
                          const idx = clampInt(Number(e.target.value), 0, waybackIndices.max);
                          const safeIdx = Math.max(idx, Math.min(waybackIndices.max, wbDraftBeforeIdx + 1));
                          setWbDraftAfterIdx(safeIdx);
                        }}
                        className="w-full"
                      />
                    </div>

                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        onClick={() => {
                          const first = wayback.options[0];
                          if (!first) return;
                          setWbDraftBeforeIdx(0);
                        }}
                        className="rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 text-[11px] text-zinc-200"
                      >
                        Oldest
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          const last = wayback.options[wayback.options.length - 1];
                          if (!last) return;
                          setWbDraftAfterIdx(wayback.options.length - 1);
                        }}
                        className="rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 text-[11px] text-zinc-200"
                      >
                        Newest
                      </button>
                      <div className="ml-auto text-[11px] text-zinc-500">
                        Window: <span className="font-mono">{startDate}</span> → <span className="font-mono">{endDate}</span>
                      </div>
                    </div>
                  </div>
                ) : waybackLoading ? (
                  <div className="mt-2 text-xs text-zinc-500">Loading Wayback timeline for this area…</div>
                ) : (
                  <div className="mt-2 text-xs text-zinc-500">
                    Wayback timeline will appear here once we have enough unique snapshots for your selected area.
                    Try zooming in (smaller bbox) or increasing output zoom.
                  </div>
                )}
              </div>

              <div className="mt-3 rounded-xl border border-zinc-800 bg-zinc-950 p-3">
                <div className="text-xs font-medium text-zinc-100">Cloud handling + sources</div>
                <div className="mt-2 grid gap-2 text-xs text-zinc-200">
                  <div className="mt-1">
                    <div className="mb-1 text-xs font-medium text-zinc-300">Primary source for report (scaffold)</div>
                    <div className="flex flex-wrap gap-3">
                      <label className="flex items-center gap-2">
                        <input
                          type="radio"
                          name="primarySource"
                          checked={primarySource === "wayback"}
                          onChange={() => {
                            setPrimarySource("wayback");
                          }}
                        />
                        Wayback (cloud-free)
                      </label>
                      <label className="flex items-center gap-2">
                        <input
                          type="radio"
                          name="primarySource"
                          checked={primarySource === "sentinel-2-l2a"}
                          onChange={() => {
                            setPrimarySource("sentinel-2-l2a");
                          }}
                        />
                        Sentinel-2
                      </label>
                      <label className={`flex items-center gap-2 ${showSecondary ? "" : "opacity-50"}`}>
                        <input
                          type="radio"
                          name="primarySource"
                          checked={primarySource === "landsat-c2-l2"}
                          disabled={!showSecondary}
                          onChange={() => {
                            setPrimarySource("landsat-c2-l2");
                          }}
                        />
                        Landsat
                      </label>
                    </div>
                  </div>

                  <div className="mt-1">
                    <div className="mb-1 text-xs font-medium text-zinc-300">Masking for diff</div>
                    <div className="flex flex-wrap gap-3">
                      <label className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          checked={ignoreClouds}
                          onChange={(e) => {
                            setIgnoreClouds(e.target.checked);
                          }}
                        />
                        Ignore cloud-like pixels
                      </label>
                      <label className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          checked={ignoreDark}
                          onChange={(e) => {
                            setIgnoreDark(e.target.checked);
                          }}
                        />
                        Ignore very-dark pixels
                      </label>
                    </div>
                  </div>

                  <label className="flex items-center gap-2">
                    <input
                      type="radio"
                      name="variant"
                      checked={variant === "closest"}
                      disabled={primarySource === "wayback"}
                      onChange={() => {
                        setVariant("closest");
                      }}
                    />
                    Closest to your chosen dates (may be cloudy)
                  </label>
                  <label className="flex items-center gap-2">
                    <input
                      type="radio"
                      name="variant"
                      checked={variant === "clearest"}
                      disabled={primarySource === "wayback"}
                      onChange={() => {
                        setVariant("clearest");
                      }}
                    />
                    Clearest (lowest cloud) within ±{maxCloudOffsetDays} days
                  </label>

                  <div className="mt-1">
                    <div className="mb-1 text-xs font-medium text-zinc-300">Clearest search window (days)</div>
                    <div className="flex items-center gap-3">
                      <input
                        type="range"
                        min={0}
                        max={45}
                        step={1}
                        value={maxCloudOffsetDays}
                        disabled={primarySource === "wayback"}
                        onChange={(e) => setMaxCloudOffsetDays(Number(e.target.value))}
                        className="w-full"
                      />
                      <div className="w-10 text-right font-mono text-xs text-zinc-300">{maxCloudOffsetDays}</div>
                    </div>
                  </div>

                  <label className="mt-1 flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={showWayback}
                      onChange={(e) => {
                        const next = e.target.checked;
                        setShowWayback(next);
                        setWayback(null);
                        if (!next && primarySource === "wayback") {
                          setPrimarySource("sentinel-2-l2a");
                          resetComputed();
                        }
                      }}
                    />
                    Also fetch Wayback (cloud-free imagery)
                  </label>

                  <label className="mt-1 flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={showSecondary}
                      onChange={(e) => {
                        const next = e.target.checked;
                        setShowSecondary(next);
                        if (!next && primarySource === "landsat-c2-l2") {
                          setPrimarySource("sentinel-2-l2a");
                          resetComputed();
                        }
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
                  disabled={loading || (showWayback && (waybackLoading || !wayback))}
                  className="inline-flex h-10 items-center justify-center rounded-lg bg-zinc-100 px-4 text-sm font-medium text-zinc-950 disabled:opacity-50"
                >
                  {loading ? "Searching…" : showWayback && (waybackLoading || !wayback) ? "Loading timeline…" : "Find imagery"}
                </button>
                <button
                  onClick={() => {
                    setError(null);
                    setStacS2(null);
                    setStacLandsat(null);
                    setWayback(null);
                    setSecondaryWarning(null);
                    resetComputed();
                    setPublishError(null);
                    setPublishResult(null);

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
                  className="inline-flex h-10 items-center justify-center rounded-lg border border-zinc-800 bg-zinc-900 px-4 text-sm font-medium text-zinc-100"
                >
                  Clear
                </button>
              </div>

              {effectiveBbox ? (
                <div className="mt-3 text-xs text-zinc-300">
                  <div className="font-medium text-zinc-300">BBox</div>
                  <div className="font-mono">[{effectiveBbox.map((x) => x.toFixed(4)).join(", ")}]</div>
                </div>
              ) : (
                <div className="mt-3 text-xs text-zinc-500">No bbox selected yet.</div>
              )}
            </div>

            <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
              <div className="mb-3 text-sm font-medium text-zinc-100">2) Change mask sensitivity</div>
              <div className="flex items-center gap-3">
                <input
                  type="range"
                  min={0}
                  max={255}
                  value={threshold}
                  onChange={(e) => setThreshold(Number(e.target.value))}
                  className="w-full"
                />
                <div className="w-14 text-right font-mono text-xs text-zinc-300">{threshold}</div>
              </div>
              <div className="mt-2 text-xs text-zinc-500">Higher = fewer pixels considered “changed”.</div>
              {diffStats ? (
                <div className="mt-3 grid grid-cols-2 gap-3 text-xs">
                  <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-2">
                    <div className="text-zinc-500">Mean diff</div>
                    <div className="font-mono text-zinc-100">{diffStats.meanDiff.toFixed(2)}</div>
                  </div>
                  <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-2">
                    <div className="text-zinc-500">Changed</div>
                    <div className="font-mono text-zinc-100">{diffStats.changedPercent.toFixed(2)}%</div>
                  </div>
                </div>
              ) : null}
            </div>

            <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
              <div className="mb-3 text-sm font-medium text-zinc-100">Output quality</div>
              <div className="text-xs text-zinc-300">
                We render before/after using tiled imagery (Planetary Computer or Wayback). Higher zoom = sharper crops
                (and heavier requests).
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
                <div className="w-14 text-right font-mono text-xs text-zinc-300">z={tileZoom}</div>
              </div>
              <div className="mt-2 text-xs text-zinc-500">
                If the bbox is large, we may automatically zoom out to keep tile downloads reasonable.
              </div>
            </div>

            <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
              <div className="mb-2 text-sm font-medium text-zinc-100">3) Publish</div>
              <div className="text-xs text-zinc-300">
                Store an evidence bundle on Walrus and anchor a `ChangeReport` object on Sui testnet.
              </div>

              <div className="mt-3 rounded-lg border border-zinc-800 bg-zinc-950 p-3 text-xs text-zinc-200">
                <div className="font-medium text-zinc-300">Wallet (server)</div>
                {publishBalance == null ? (
                  <div className="mt-1 text-zinc-500">Loading…</div>
                ) : "error" in publishBalance ? (
                  <div className="mt-1 text-red-200">{publishBalance.error}</div>
                ) : (
                  <div className="mt-1 space-y-1 text-zinc-400">
                    <div>
                      Address: <span className="font-mono text-zinc-200">{publishBalance.address}</span>
                    </div>
                    <div>
                      Balances:{" "}
                      <span className="font-mono text-zinc-200">{(Number(publishBalance.balances.SUI.total) / 1e9).toFixed(3)}</span> SUI,
                      <span className="ml-1 font-mono text-zinc-200">{(Number(publishBalance.balances.WAL.total) / 1e9).toFixed(3)}</span> WAL
                    </div>
                    {publishBalance.balances.WAL.coinType ? (
                      <div>
                        WAL type: <span className="font-mono text-zinc-200">{publishBalance.balances.WAL.coinType}</span>
                      </div>
                    ) : null}
                  </div>
                )}
              </div>

              <div className="mt-3 grid gap-2">
                <div className="text-xs font-medium text-zinc-200">Walrus bundle contents</div>
                <select
                  value={artifactsMode}
                  onChange={(e) => setArtifactsMode(e.target.value as "none" | "diff" | "all")}
                  className="h-9 w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 text-xs text-zinc-200"
                >
                  <option value="none">Metadata only (recommended)</option>
                  <option value="diff">Include diff mask only</option>
                  <option value="all">Include before + after + diff images</option>
                </select>
                <div className="text-[11px] leading-4 text-zinc-500">
                  Larger bundles cost more WAL and may fail if your WAL type doesn’t match the configured Walrus deployment.
                </div>

                <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-3 text-xs text-zinc-200">
                  <div className="font-medium text-zinc-300">Estimate</div>
                  {publishEstimate == null ? (
                    <div className="mt-1 text-zinc-500">Waiting for a report draft…</div>
                  ) : "error" in publishEstimate ? (
                    <div className="mt-1 text-red-200">{publishEstimate.error}</div>
                  ) : (
                    <div className="mt-1 space-y-1 text-zinc-400">
                      <div>
                        Bundle size: <span className="font-mono text-zinc-200">{(publishEstimate.bytes.evidenceBundle / 1024).toFixed(1)} KB</span>
                      </div>
                      <div>
                        Expected WAL type: <span className="font-mono text-zinc-200">{publishEstimate.walrus.resolved.derivedWalType ?? "(unknown)"}</span>
                      </div>
                      <div>
                        Est. WAL cost (epochs):{" "}
                        <span className="font-mono text-zinc-200">
                          {publishEstimate.walrus.cost?.totalCost
                            ? (Number(publishEstimate.walrus.cost.totalCost) / 1e9).toFixed(3)
                            : "(unavailable)"}
                        </span>
                      </div>
                    </div>
                  )}
                </div>
              </div>
              <button
                disabled={publishDisabledReasons.length > 0 || publishLoading}
                onClick={doPublish}
                  className="mt-3 inline-flex h-10 w-full items-center justify-center rounded-lg bg-zinc-100 text-sm font-medium text-zinc-950 disabled:opacity-50"
              >
                {publishLoading ? "Publishing…" : "Publish to Walrus + Sui"}
              </button>

              {primarySource === "wayback" ? (
                <button
                  type="button"
                  onClick={() => setWaybackComputeNonce((n) => n + 1)}
                  className="mt-2 inline-flex h-9 w-full items-center justify-center rounded-lg border border-zinc-800 bg-zinc-900 text-xs font-medium text-zinc-200"
                >
                  Recompute Wayback diff
                </button>
              ) : null}

              {publishDisabledReasons.length && !publishLoading ? (
                <div className="mt-3 rounded-lg border border-zinc-800 bg-zinc-950 p-3 text-xs text-zinc-200">
                  <div className="font-medium text-zinc-300">Why is Publish disabled?</div>
                  <ul className="mt-2 list-disc space-y-1 pl-5 text-zinc-400">
                    {publishDisabledReasons.map((r) => (
                      <li key={r}>{r}</li>
                    ))}
                  </ul>
                </div>
              ) : null}

              {publishError ? (
                <div className="mt-3 rounded-lg border border-red-900/40 bg-red-950/40 p-3 text-xs text-red-200">
                  {publishError}
                </div>
              ) : null}

              {publishResult ? (
                <pre className="mt-3 max-h-64 overflow-auto rounded-lg border border-zinc-800 bg-zinc-950 p-3 text-[11px] leading-4 text-zinc-100">
                  {JSON.stringify(publishResult, null, 2)}
                </pre>
              ) : null}

              {reportDraft ? (
                <pre className="mt-3 max-h-64 overflow-auto rounded-lg border border-zinc-800 bg-zinc-950 p-3 text-[11px] leading-4 text-zinc-100">
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
              <div className="rounded-xl border border-red-900/40 bg-red-950/40 p-4 text-sm text-red-200">{error}</div>
            ) : null}

            {secondaryWarning ? (
              <div className="rounded-xl border border-yellow-900/40 bg-yellow-950/40 p-4 text-sm text-yellow-100">
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
                <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-3">
                  <div className="mb-2 text-xs font-medium text-zinc-300">Closest</div>
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
                    ignoreClouds={ignoreClouds}
                    ignoreDark={ignoreDark}
                    onComputed={setS2ClosestStats}
                    onArtifacts={setS2ClosestArtifacts}
                  />
                </div>

                <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-3">
                  <div className="mb-2 text-xs font-medium text-zinc-300">Clearest</div>
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
                    ignoreClouds={ignoreClouds}
                    ignoreDark={ignoreDark}
                    onComputed={setS2ClearestStats}
                    onArtifacts={setS2ClearestArtifacts}
                  />
                </div>
              </div>
            ) : null}

            {showWayback && wayback && effectiveBbox && waybackPicked ? (
              <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
                <div className="flex items-baseline justify-between gap-3">
                  <div className="text-sm font-medium text-zinc-100">Wayback (Esri World Imagery)</div>
                  <div className="text-xs text-zinc-400">Options for this location: {wayback.options.length}</div>
                </div>
                <div className="mt-1 text-xs text-zinc-500">
                  Preselected versions are derived from available Wayback releases and probed at the bbox center tile.
                </div>

                <div className="mt-3 grid gap-3 text-xs text-zinc-200 md:grid-cols-2">
                  <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-3">
                    <div className="mb-1 font-medium text-zinc-100">Before</div>
                    <div className="font-mono text-zinc-200">{waybackPicked.before.date}</div>
                    <div className="mt-1 font-mono text-zinc-500">v{waybackPicked.before.id}</div>
                  </div>
                  <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-3">
                    <div className="mb-1 font-medium text-zinc-100">After</div>
                    <div className="font-mono text-zinc-200">{waybackPicked.after.date}</div>
                    <div className="mt-1 font-mono text-zinc-500">v{waybackPicked.after.id}</div>
                  </div>
                </div>

                <div className="mt-3 rounded-xl border border-zinc-800 bg-zinc-950 p-3">
                  <div className="mb-2 text-xs font-medium text-zinc-300">Wayback diff</div>
                  <DiffViewer
                    beforeUrl={null}
                    afterUrl={null}
                    selectionBbox={effectiveBbox}
                    beforeTileUrlTemplate={waybackPicked.before.tileUrlTemplate}
                    afterTileUrlTemplate={waybackPicked.after.tileUrlTemplate}
                    allowMissingTiles
                    tileZoom={tileZoom}
                    threshold={threshold}
                    ignoreClouds={ignoreClouds}
                    ignoreDark={ignoreDark}
                    computeNonce={waybackComputeNonce}
                    onComputed={setWaybackStats}
                    onArtifacts={setWaybackArtifacts}
                  />
                </div>
              </div>
            ) : null}

            {showSecondary && stacLandsat ? (
              <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
                <div className="flex items-baseline justify-between gap-3">
                  <div className="text-sm font-medium text-zinc-100">Landsat (alternate source)</div>
                  <div className="text-xs text-zinc-400">Candidates scanned: {stacLandsat.query.totalCandidates}</div>
                </div>
                <div className="mt-2 grid gap-4 md:grid-cols-2">
                  <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-3">
                    <div className="mb-2 text-xs font-medium text-zinc-300">Closest</div>
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
                      ignoreClouds={ignoreClouds}
                      ignoreDark={ignoreDark}
                      onComputed={setLsClosestStats}
                      onArtifacts={setLsClosestArtifacts}
                    />
                  </div>

                  <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-3">
                    <div className="mb-2 text-xs font-medium text-zinc-300">Clearest</div>
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
                      ignoreClouds={ignoreClouds}
                      ignoreDark={ignoreDark}
                      onComputed={setLsClearestStats}
                      onArtifacts={setLsClearestArtifacts}
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
