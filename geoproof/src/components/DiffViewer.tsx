"use client";

import { useEffect, useMemo, useRef, useState } from "react";

export type DiffStats = {
  width: number;
  height: number;
  meanDiff: number; // 0..255
  changedPercent: number; // 0..100
};

type BBox = [number, number, number, number];

type Props = {
  beforeUrl: string | null;
  afterUrl: string | null;
  beforeItemBbox?: BBox | null;
  afterItemBbox?: BBox | null;
  selectionBbox?: BBox | null;
  beforeTileUrlTemplate?: string | null;
  afterTileUrlTemplate?: string | null;
  allowMissingTiles?: boolean;
  tileZoom?: number;
  threshold: number; // 0..255
  ignoreClouds?: boolean;
  ignoreDark?: boolean;
  onComputed?: (stats: DiffStats | null) => void;
  onArtifacts?: (artifacts: { beforeDataUrl: string; afterDataUrl: string; diffDataUrl: string }) => void;
};

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Failed to load image: ${url}`));
    img.src = url;
  });
}

function cropRectForBboxes(
  img: HTMLImageElement,
  itemBbox: BBox | null | undefined,
  selectionBbox: BBox | null | undefined,
): { sx: number; sy: number; sw: number; sh: number } {
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  if (!itemBbox || !selectionBbox) return { sx: 0, sy: 0, sw: w, sh: h };

  const [iMinLng, iMinLat, iMaxLng, iMaxLat] = itemBbox;
  const [sMinLng, sMinLat, sMaxLng, sMaxLat] = selectionBbox;

  const denomLng = iMaxLng - iMinLng;
  const denomLat = iMaxLat - iMinLat;
  if (!(denomLng > 0) || !(denomLat > 0)) return { sx: 0, sy: 0, sw: w, sh: h };

  // Map lon/lat bbox to pixel rect. y axis is inverted.
  const x0 = ((sMinLng - iMinLng) / denomLng) * w;
  const x1 = ((sMaxLng - iMinLng) / denomLng) * w;
  const y0 = ((iMaxLat - sMaxLat) / denomLat) * h;
  const y1 = ((iMaxLat - sMinLat) / denomLat) * h;

  const sx = Math.max(0, Math.min(x0, x1));
  const ex = Math.min(w, Math.max(x0, x1));
  const sy = Math.max(0, Math.min(y0, y1));
  const ey = Math.min(h, Math.max(y0, y1));

  const sw = Math.max(1, ex - sx);
  const sh = Math.max(1, ey - sy);
  return { sx, sy, sw, sh };
}

function clampLat(lat: number) {
  // WebMercator limits.
  return Math.max(-85.05112878, Math.min(85.05112878, lat));
}

function lonLatToWorldPx(lon: number, lat: number, z: number) {
  const n = 2 ** z;
  const x = ((lon + 180) / 360) * n * 256;
  const latRad = (clampLat(lat) * Math.PI) / 180;
  const y = ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n * 256;
  return { x, y };
}

function fillTemplate(tpl: string, z: number, x: number, y: number) {
  return tpl.replace("{z}", String(z)).replace("{x}", String(x)).replace("{y}", String(y));
}

function luma(r: number, g: number, b: number) {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function saturation(r: number, g: number, b: number) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max <= 0) return 0;
  return (max - min) / max;
}

function isCloudLike(r: number, g: number, b: number) {
  // Heuristic: bright + low-saturation.
  const y = luma(r, g, b);
  const s = saturation(r, g, b);
  return y >= 210 && s <= 0.18;
}

function isVeryDark(r: number, g: number, b: number) {
  return luma(r, g, b) <= 18;
}

async function loadBboxImageFromTiles(
  tileTpl: string,
  bbox: BBox,
  requestedZoom: number,
  allowMissingTiles: boolean,
  onProgress?: (p: { done: number; total: number; z: number }) => void,
): Promise<{ imageData: ImageData; dataUrl: string; usedZoom: number }>
{
  const [minLng, minLat, maxLng, maxLat] = bbox;

  let z = Math.max(0, Math.min(24, Math.round(requestedZoom)));

  const maxTiles = 36;
  const calc = (zoom: number) => {
    const pMin = lonLatToWorldPx(minLng, maxLat, zoom); // top-left
    const pMax = lonLatToWorldPx(maxLng, minLat, zoom); // bottom-right

    const x0 = Math.floor(pMin.x / 256);
    const y0 = Math.floor(pMin.y / 256);
    const x1 = Math.floor(pMax.x / 256);
    const y1 = Math.floor(pMax.y / 256);
    const tilesX = x1 - x0 + 1;
    const tilesY = y1 - y0 + 1;
    return { pMin, pMax, x0, y0, x1, y1, tilesX, tilesY };
  };

  let lastErr: unknown = null;

  // Retry by zooming out if tile fetches fail (coverage gaps, provider quirks, etc.).
  for (let attempt = 0; attempt < 6; attempt++) {
    let c = calc(z);
    while (z > 0 && c.tilesX * c.tilesY > maxTiles) {
      z -= 1;
      c = calc(z);
    }

    try {
      const mosaicW = c.tilesX * 256;
      const mosaicH = c.tilesY * 256;
      const mosaic = document.createElement("canvas");
      mosaic.width = mosaicW;
      mosaic.height = mosaicH;
      const mctx = mosaic.getContext("2d", { willReadFrequently: true });
      if (!mctx) throw new Error("Canvas not available");

      const total = c.tilesX * c.tilesY;
      let done = 0;
      let missing = 0;
      onProgress?.({ done, total, z });

      // Fetch tiles sequentially (small count; avoids spiky parallelism).
      for (let ty = c.y0; ty <= c.y1; ty++) {
        for (let tx = c.x0; tx <= c.x1; tx++) {
          const url = fillTemplate(tileTpl, z, tx, ty);
          // Prevent hanging forever on slow or stalled tile servers.
          const ctrl = new AbortController();
          const t = setTimeout(() => ctrl.abort(), 10_000);
          let res: Response;
          try {
            res = await fetch(url, { signal: ctrl.signal });
          } finally {
            clearTimeout(t);
          }
          if (res.ok) {
            const blob = await res.blob();
            const bmp = await createImageBitmap(blob);
            mctx.drawImage(bmp, (tx - c.x0) * 256, (ty - c.y0) * 256, 256, 256);
          } else {
            if (!allowMissingTiles) {
              throw new Error(`Tile fetch failed (${res.status}) for ${url}`);
            }
            // Leave this tile transparent; many providers (including Wayback) legitimately have sparse coverage.
            missing += 1;
          }

          done += 1;
          onProgress?.({ done, total, z });
        }
      }

      if (allowMissingTiles) {
        // If most tiles are missing, the mosaic is likely unusable.
        const missingRatio = total > 0 ? missing / total : 1;
        if (missingRatio >= 0.7) {
          throw new Error(`Too many missing tiles (${missing}/${total}) at z=${z}`);
        }
      }

      const sx = c.pMin.x - c.x0 * 256;
      const sy = c.pMin.y - c.y0 * 256;
      const sw = c.pMax.x - c.pMin.x;
      const sh = c.pMax.y - c.pMin.y;

      const maxW = 1024;
      const scale = Math.min(1, maxW / Math.max(sw, 1));
      const outW = Math.max(1, Math.floor(sw * scale));
      const outH = Math.max(1, Math.floor(sh * scale));

      const out = document.createElement("canvas");
      out.width = outW;
      out.height = outH;
      const octx = out.getContext("2d", { willReadFrequently: true });
      if (!octx) throw new Error("Canvas not available");
      octx.drawImage(mosaic, sx, sy, sw, sh, 0, 0, outW, outH);

      const imageData = octx.getImageData(0, 0, outW, outH);
      const dataUrl = out.toDataURL("image/png");
      return { imageData, dataUrl, usedZoom: z };
    } catch (e: unknown) {
      lastErr = e;
      if (z > 0) {
        z -= 1;
        continue;
      }
      break;
    }
  }

  const msg = lastErr instanceof Error ? lastErr.message : String(lastErr);
  throw new Error(msg || "Tile fetch failed");
}

export function DiffViewer({
  beforeUrl,
  afterUrl,
  beforeItemBbox,
  afterItemBbox,
  selectionBbox,
  beforeTileUrlTemplate,
  afterTileUrlTemplate,
  allowMissingTiles = false,
  tileZoom = 16,
  threshold,
  ignoreClouds = true,
  ignoreDark = false,
  onComputed,
  onArtifacts,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const lastProgressAtRef = useRef<number>(0);
  const [state, setState] = useState<{
    key: string;
    diffUrl: string | null;
    beforeCroppedUrl: string | null;
    afterCroppedUrl: string | null;
    error: string | null;
    progress: string | null;
  }>({
    key: "",
    diffUrl: null,
    beforeCroppedUrl: null,
    afterCroppedUrl: null,
    error: null,
    progress: null,
  });

  const key = useMemo(
    () =>
      `${beforeUrl ?? ""}|${afterUrl ?? ""}|${threshold}|${selectionBbox?.join(",") ?? ""}|${
        beforeItemBbox?.join(",") ?? ""
      }|${afterItemBbox?.join(",") ?? ""}|${beforeTileUrlTemplate ?? ""}|${afterTileUrlTemplate ?? ""}|${allowMissingTiles ? 1 : 0}|${tileZoom}|${ignoreClouds ? 1 : 0}|${ignoreDark ? 1 : 0}`,
    [
      beforeUrl,
      afterUrl,
      threshold,
      selectionBbox,
      beforeItemBbox,
      afterItemBbox,
      beforeTileUrlTemplate,
      afterTileUrlTemplate,
      allowMissingTiles,
      tileZoom,
      ignoreClouds,
      ignoreDark,
    ],
  );
  const inputs = useMemo(
    () => ({
      beforeUrl,
      afterUrl,
      threshold,
      key,
      beforeItemBbox,
      afterItemBbox,
      selectionBbox,
      beforeTileUrlTemplate,
      afterTileUrlTemplate,
      allowMissingTiles,
      tileZoom,
      ignoreClouds,
      ignoreDark,
    }),
    [
      beforeUrl,
      afterUrl,
      threshold,
      key,
      beforeItemBbox,
      afterItemBbox,
      selectionBbox,
      beforeTileUrlTemplate,
      afterTileUrlTemplate,
      allowMissingTiles,
      tileZoom,
      ignoreClouds,
      ignoreDark,
    ],
  );

  useEffect(() => {
    let cancelled = false;
    // New inputs: clear previous outputs so the UI doesn't show a stale mask while we recompute.
    onComputed?.(null);
    setState({
      key: inputs.key,
      diffUrl: null,
      beforeCroppedUrl: null,
      afterCroppedUrl: null,
      error: null,
      progress: null,
    });

    async function run() {
      const canUseTiles =
        Boolean(inputs.beforeTileUrlTemplate) &&
        Boolean(inputs.afterTileUrlTemplate) &&
        Boolean(inputs.selectionBbox);

      if (!canUseTiles && (!inputs.beforeUrl || !inputs.afterUrl)) return;
      const canvas = canvasRef.current;
      if (!canvas) return;

      try {
        let a: ImageData | null = null;
        let b: ImageData | null = null;
        let beforeThumbUrl: string | null = null;
        let afterThumbUrl: string | null = null;

        const runPreviewFallback = async () => {
          // Fallback: use Planetary Computer rendered_preview (full granule) and crop by bbox (approx).
          const b0 = inputs.beforeUrl;
          const b1 = inputs.afterUrl;
          if (!b0 || !b1) throw new Error("No preview URLs available for fallback.");
          const [before, after] = await Promise.all([loadImage(b0), loadImage(b1)]);
          if (cancelled) return;

          const cropA = cropRectForBboxes(before, inputs.beforeItemBbox, inputs.selectionBbox);
          const cropB = cropRectForBboxes(after, inputs.afterItemBbox, inputs.selectionBbox);

          const maxW = 640;
          const baseW = Math.min(cropA.sw, cropB.sw);
          const baseH = Math.min(cropA.sh, cropB.sh);
          const scale = Math.min(1, maxW / Math.max(baseW, 1));
          const w = Math.max(1, Math.floor(baseW * scale));
          const h = Math.max(1, Math.floor(baseH * scale));

          canvas.width = w;
          canvas.height = h;
          const tmp = document.createElement("canvas");
          tmp.width = w;
          tmp.height = h;
          const tctx = tmp.getContext("2d", { willReadFrequently: true });
          if (!tctx) throw new Error("Canvas not available");

          tctx.clearRect(0, 0, w, h);
          tctx.drawImage(before, cropA.sx, cropA.sy, cropA.sw, cropA.sh, 0, 0, w, h);
          a = tctx.getImageData(0, 0, w, h);
          beforeThumbUrl = tmp.toDataURL("image/png");

          tctx.clearRect(0, 0, w, h);
          tctx.drawImage(after, cropB.sx, cropB.sy, cropB.sw, cropB.sh, 0, 0, w, h);
          b = tctx.getImageData(0, 0, w, h);
          afterThumbUrl = tmp.toDataURL("image/png");
        };

        if (canUseTiles) {
          const b0 = inputs.beforeTileUrlTemplate;
          const b1 = inputs.afterTileUrlTemplate;
          const bb = inputs.selectionBbox;
          if (!b0 || !b1 || !bb) return;

          try {
            setState((s) => ({ ...s, key: inputs.key, progress: "Preparing tile mosaic…" }));

            const prog = {
              before: { done: 0, total: 0, z: inputs.tileZoom ?? 16 },
              after: { done: 0, total: 0, z: inputs.tileZoom ?? 16 },
            };

            const fmtProg = () => {
              return `Tiles: before ${prog.before.done}/${prog.before.total} (z=${prog.before.z}), after ${prog.after.done}/${prog.after.total} (z=${prog.after.z})`;
            };

            const pushProgress = () => {
              const now = Date.now();
              const beforeDone = prog.before.total > 0 && prog.before.done >= prog.before.total;
              const afterDone = prog.after.total > 0 && prog.after.done >= prog.after.total;
              const done = beforeDone && afterDone;
              if (!done && now - lastProgressAtRef.current < 120) return;
              lastProgressAtRef.current = now;
              setState((s) => ({ ...s, key: inputs.key, progress: fmtProg() }));
            };

            const [ra, rb] = await Promise.all([
              loadBboxImageFromTiles(b0, bb, inputs.tileZoom ?? 16, inputs.allowMissingTiles, (p) => {
                prog.before = p;
                pushProgress();
              }),
              loadBboxImageFromTiles(b1, bb, inputs.tileZoom ?? 16, inputs.allowMissingTiles, (p) => {
                prog.after = p;
                pushProgress();
              }),
            ]);
            if (cancelled) return;
            // Ensure same dimensions.
            const w = Math.min(ra.imageData.width, rb.imageData.width);
            const h = Math.min(ra.imageData.height, rb.imageData.height);
            const ca = document.createElement("canvas");
            ca.width = w;
            ca.height = h;
            const caCtx = ca.getContext("2d", { willReadFrequently: true });
            if (!caCtx) throw new Error("Canvas not available");
            caCtx.putImageData(ra.imageData, 0, 0);
            a = caCtx.getImageData(0, 0, w, h);
            beforeThumbUrl = ra.dataUrl;

            const cb = document.createElement("canvas");
            cb.width = w;
            cb.height = h;
            const cbCtx = cb.getContext("2d", { willReadFrequently: true });
            if (!cbCtx) throw new Error("Canvas not available");
            cbCtx.putImageData(rb.imageData, 0, 0);
            b = cbCtx.getImageData(0, 0, w, h);
            afterThumbUrl = rb.dataUrl;

            canvas.width = w;
            canvas.height = h;
          } catch (e: unknown) {
            // If we have previews, degrade gracefully rather than showing a hard error.
            if (inputs.beforeUrl && inputs.afterUrl) {
              await runPreviewFallback();
            } else {
              throw e;
            }
          }
        } else {
          await runPreviewFallback();
        }

        if (!a || !b || !beforeThumbUrl || !afterThumbUrl) {
          throw new Error("Image load failed");
        }

        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        if (!ctx) return;

        const w = Math.min(a.width, b.width);
        const h = Math.min(a.height, b.height);

        const out = ctx.createImageData(w, h);
        const ad = a.data;
        const bd = b.data;
        const od = out.data;

        let sum = 0;
        let changed = 0;
        let considered = 0;

        const n = w * h;

        for (let i = 0; i < n; i++) {
          const idx = i * 4;
          const ar = ad[idx];
          const ag = ad[idx + 1];
          const ab = ad[idx + 2];
          const br = bd[idx];
          const bg = bd[idx + 1];
          const bb = bd[idx + 2];

          if (
            (inputs.ignoreClouds && (isCloudLike(ar, ag, ab) || isCloudLike(br, bg, bb))) ||
            (inputs.ignoreDark && (isVeryDark(ar, ag, ab) || isVeryDark(br, bg, bb)))
          ) {
            od[idx] = 255;
            od[idx + 1] = 0;
            od[idx + 2] = 0;
            od[idx + 3] = 0;
            continue;
          }

          const dr = Math.abs(ar - br);
          const dg = Math.abs(ag - bg);
          const db = Math.abs(ab - bb);
          const d = (dr + dg + db) / 3;
          sum += d;
          considered += 1;

          const hot = d >= inputs.threshold;
          if (hot) changed += 1;

          // Heatmap: red for change, transparent for stable.
          od[idx] = 255;
          od[idx + 1] = 0;
          od[idx + 2] = 0;
          od[idx + 3] = hot ? Math.min(220, 40 + d) : 0;
        }

        if (considered === 0) {
          throw new Error("All pixels were masked (cloud/dark). Try disabling masking or changing dates.");
        }

        ctx.putImageData(out, 0, 0);

        const stats = {
          width: w,
          height: h,
          meanDiff: sum / considered,
          changedPercent: (changed / considered) * 100,
        } satisfies DiffStats;

        onComputed?.(stats);
        const url = canvas.toDataURL("image/png");
        if (!cancelled) {
          setState({
            key: inputs.key,
            diffUrl: url,
            beforeCroppedUrl: beforeThumbUrl,
            afterCroppedUrl: afterThumbUrl,
            error: null,
            progress: null,
          });
          onArtifacts?.({
            beforeDataUrl: beforeThumbUrl,
            afterDataUrl: afterThumbUrl,
            diffDataUrl: url,
          });
        }
      } catch (e: unknown) {
        if (cancelled) return;
        const msg = e instanceof Error ? e.message : String(e);
        onComputed?.(null);
        setState({
          key: inputs.key,
          diffUrl: null,
          beforeCroppedUrl: null,
          afterCroppedUrl: null,
          error: msg,
          progress: null,
        });
      }
    }

    run();
    return () => {
      cancelled = true;
    };
  }, [inputs, onComputed, onArtifacts]);

  const hasAnySource = Boolean(beforeTileUrlTemplate && afterTileUrlTemplate && selectionBbox) || (Boolean(beforeUrl) && Boolean(afterUrl));
  if (!hasAnySource) return null;

  const diffUrl = state.key === key ? state.diffUrl : null;
  const error = state.key === key ? state.error : null;
  const progress = state.key === key ? state.progress : null;
  const beforeShownUrl = state.key === key ? state.beforeCroppedUrl ?? beforeUrl : beforeUrl;
  const afterShownUrl = state.key === key ? state.afterCroppedUrl ?? afterUrl : afterUrl;

  const tilesOnly = Boolean(beforeTileUrlTemplate && afterTileUrlTemplate && selectionBbox) && !beforeUrl && !afterUrl;

  const placeholder = (
    <div className="flex h-40 w-full items-center justify-center rounded-lg border border-zinc-800 bg-zinc-950 text-xs text-zinc-500">
      Loading…
    </div>
  );

  if (tilesOnly && (!beforeShownUrl || !afterShownUrl)) {
    return (
      <div className="space-y-3">
        <canvas ref={canvasRef} className="hidden" />
        {error ? (
          <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800">{error}</div>
        ) : (
          <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-3 text-sm text-zinc-200">
            <div>Loading tiles…</div>
            {progress ? <div className="mt-1 text-xs text-zinc-500">{progress}</div> : null}
          </div>
        )}

        <div className="grid gap-3 md:grid-cols-3">
          <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-3">
            <div className="mb-2 text-xs font-medium text-zinc-700">Before</div>
            {beforeShownUrl ? (
              <img className="h-auto w-full rounded-lg border border-zinc-100" src={beforeShownUrl} alt="Before" />
            ) : (
              placeholder
            )}
          </div>
          <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-3">
            <div className="mb-2 text-xs font-medium text-zinc-700">After</div>
            {afterShownUrl ? (
              <img className="h-auto w-full rounded-lg border border-zinc-100" src={afterShownUrl} alt="After" />
            ) : (
              placeholder
            )}
          </div>
          <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-3">
            <div className="mb-2 text-xs font-medium text-zinc-700">Change mask</div>
            {placeholder}
          </div>
        </div>
      </div>
    );
  }

  if (!beforeShownUrl || !afterShownUrl) return null;

  return (
    <div className="space-y-3">
      {progress ? <div className="text-xs text-zinc-500">{progress}</div> : null}
      <div className="grid gap-3 md:grid-cols-3">
        <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-3">
          <div className="mb-2 text-xs font-medium text-zinc-300">Before</div>
          <img
            className="h-auto w-full rounded-lg border border-zinc-800"
            src={beforeShownUrl}
            alt="Before preview"
          />
        </div>
        <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-3">
          <div className="mb-2 text-xs font-medium text-zinc-300">After</div>
          <img
            className="h-auto w-full rounded-lg border border-zinc-800"
            src={afterShownUrl}
            alt="After preview"
          />
        </div>
        <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-3">
          <div className="mb-2 text-xs font-medium text-zinc-300">Change mask</div>
          <div className="relative">
            <img
              className="h-auto w-full rounded-lg border border-zinc-800"
              src={afterShownUrl}
              alt="After base"
            />
            {diffUrl ? (
              <img
                className="absolute inset-0 h-full w-full rounded-lg"
                style={{ mixBlendMode: "screen" }}
                src={diffUrl}
                alt="Diff overlay"
              />
            ) : null}
          </div>
        </div>
      </div>

      {error ? (
        <div className="rounded-xl border border-red-900/40 bg-red-950/40 p-3 text-sm text-red-200">
          {error}
        </div>
      ) : null}

      {/* Hidden render canvas used to produce diffUrl */}
      <canvas ref={canvasRef} className="hidden" />
    </div>
  );
}
