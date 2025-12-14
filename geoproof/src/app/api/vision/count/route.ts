import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 60;

type CountBody = {
  imageDataUrl: string;
  labels: string[];
  threshold?: number; // 0..1
  model?: string;
};

type Det = {
  label: string;
  score: number;
  box: { xmin: number; ymin: number; xmax: number; ymax: number };
};

function dataUrlToBase64(dataUrl: string) {
  const idx = dataUrl.indexOf(",");
  if (idx < 0) return null;
  const meta = dataUrl.slice(0, idx);
  const b64 = dataUrl.slice(idx + 1);
  if (!meta.startsWith("data:image/")) return null;
  if (!b64) return null;
  return b64;
}

function clamp01(v: number) {
  if (!Number.isFinite(v)) return 0.2;
  return Math.max(0, Math.min(1, v));
}

function iou(a: Det["box"], b: Det["box"]) {
  const xA = Math.max(a.xmin, b.xmin);
  const yA = Math.max(a.ymin, b.ymin);
  const xB = Math.min(a.xmax, b.xmax);
  const yB = Math.min(a.ymax, b.ymax);
  const interW = Math.max(0, xB - xA);
  const interH = Math.max(0, yB - yA);
  const inter = interW * interH;
  const areaA = Math.max(0, a.xmax - a.xmin) * Math.max(0, a.ymax - a.ymin);
  const areaB = Math.max(0, b.xmax - b.xmin) * Math.max(0, b.ymax - b.ymin);
  const union = areaA + areaB - inter;
  return union <= 0 ? 0 : inter / union;
}

function nms(dets: Det[], iouThresh = 0.7) {
  const kept: Det[] = [];
  const sorted = [...dets].sort((x, y) => y.score - x.score);
  for (const d of sorted) {
    if (kept.some((k) => iou(k.box, d.box) >= iouThresh)) continue;
    kept.push(d);
  }
  return kept;
}

export async function POST(req: Request) {
  let body: CountBody;
  try {
    body = (await req.json()) as CountBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (!body || typeof body !== "object") return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  if (typeof body.imageDataUrl !== "string" || !body.imageDataUrl.startsWith("data:image/")) {
    return NextResponse.json({ error: "Expected imageDataUrl as a data:image/* data URL" }, { status: 400 });
  }
  if (!Array.isArray(body.labels) || body.labels.length === 0 || body.labels.some((x) => typeof x !== "string" || !x.trim())) {
    return NextResponse.json({ error: "Expected labels: string[]" }, { status: 400 });
  }

  const hfKey = (process.env.HUGGINGFACE_API_KEY ?? "").trim();
  if (!hfKey) {
    return NextResponse.json(
      {
        error:
          "Missing HUGGINGFACE_API_KEY. Add it to geoproof/.env.local to enable object counting (Hugging Face Inference API).",
      },
      { status: 500 },
    );
  }

  const model = (body.model ?? process.env.HF_COUNT_MODEL ?? "google/owlvit-base-patch32").trim();
  if (model === "facebook/sam3" || model.includes("/sam3")) {
    return NextResponse.json(
      {
        error:
          "facebook/sam3 is not currently deployed on Hugging Face serverless Inference API, so this endpoint cannot call it directly.",
        hint: "To use SAM3, run a dedicated Hugging Face Inference Endpoint (or self-host) and then wire GeoProof to that endpoint.",
        source: "https://huggingface.co/facebook/sam3",
      },
      { status: 501 },
    );
  }
  const threshold = clamp01(typeof body.threshold === "number" ? body.threshold : 0.2);
  const b64 = dataUrlToBase64(body.imageDataUrl);
  if (!b64) return NextResponse.json({ error: "Could not parse image data URL" }, { status: 400 });

  // HF Inference API: OWL-ViT-style open-vocabulary detection uses base64 image + candidate_labels.
  // (See HF task docs for object detection request shape; some models accept extra parameters like candidate labels.)
  // https://huggingface.co/docs/inference-providers/en/tasks/object-detection
  // HF Inference API is routed via router.huggingface.co.
  // https://huggingface.co/docs/inference-providers/en/providers/hf-inference
  const res = await fetch(`https://router.huggingface.co/hf-inference/models/${encodeURIComponent(model)}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${hfKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      inputs: b64,
      parameters: { candidate_labels: body.labels.map((x) => x.trim()), threshold },
    }),
  });

  const raw = (await res.json().catch(() => null)) as unknown;
  if (!res.ok) {
    const msg =
      typeof raw === "object" && raw !== null && typeof (raw as { error?: unknown }).error === "string"
        ? (raw as { error: string }).error
        : `HF error: ${res.status} ${res.statusText}`;
    return NextResponse.json(
      {
        error: msg,
        hint: "If you see rate limits, try again in ~30 seconds (or use a paid HF endpoint).",
        model,
      },
      { status: res.status === 429 ? 429 : 502 },
    );
  }

  if (!Array.isArray(raw)) {
    return NextResponse.json({ error: "Unexpected response from Hugging Face", model, raw }, { status: 502 });
  }

  const dets = raw
    .map((d): Det | null => {
      if (typeof d !== "object" || d === null) return null;
      const label = (d as { label?: unknown }).label;
      const score = (d as { score?: unknown }).score;
      const box = (d as { box?: unknown }).box;
      if (typeof label !== "string" || typeof score !== "number") return null;
      if (typeof box !== "object" || box === null) return null;
      const xmin = (box as { xmin?: unknown }).xmin;
      const ymin = (box as { ymin?: unknown }).ymin;
      const xmax = (box as { xmax?: unknown }).xmax;
      const ymax = (box as { ymax?: unknown }).ymax;

      const xminN = typeof xmin === "number" ? xmin : Number.NaN;
      const yminN = typeof ymin === "number" ? ymin : Number.NaN;
      const xmaxN = typeof xmax === "number" ? xmax : Number.NaN;
      const ymaxN = typeof ymax === "number" ? ymax : Number.NaN;
      if (![xminN, yminN, xmaxN, ymaxN].every((n) => Number.isFinite(n))) return null;
      return { label, score, box: { xmin: xminN, ymin: yminN, xmax: xmaxN, ymax: ymaxN } };
    })
    .filter((x): x is Det => Boolean(x));

  const byLabel: Record<string, Det[]> = {};
  for (const d of dets) {
    (byLabel[d.label] ??= []).push(d);
  }

  const counts: Record<string, number> = {};
  const deduped: Record<string, Det[]> = {};
  for (const label of Object.keys(byLabel)) {
    const kept = nms(byLabel[label] ?? [], 0.7);
    deduped[label] = kept;
    counts[label] = kept.length;
  }

  return NextResponse.json({ model, threshold, labels: body.labels, counts, detections: deduped });
}
