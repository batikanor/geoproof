export type BBox = [number, number, number, number];

export function parseBboxParam(b: string | null): BBox | null {
  if (!b) return null;
  try {
    const parts = b.split(",").map((x) => Number(x.trim()));
    if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return null;
    const [minLng, minLat, maxLng, maxLat] = parts;
    if (minLng >= maxLng || minLat >= maxLat) return null;
    return [minLng, minLat, maxLng, maxLat];
  } catch {
    return null;
  }
}

export function bboxIntersects(a: BBox, b: BBox) {
  const [aMinX, aMinY, aMaxX, aMaxY] = a;
  const [bMinX, bMinY, bMaxX, bMaxY] = b;
  return aMinX <= bMaxX && aMaxX >= bMinX && aMinY <= bMaxY && aMaxY >= bMinY;
}

export function extractCreatedObjectIdsFromTxPage(
  txPage: unknown,
  opts: { objectTypeIncludes: string },
): Array<{ objectId: string; digest: string }> {
  if (typeof txPage !== "object" || txPage === null) return [];
  const data = (txPage as { data?: unknown }).data;
  if (!Array.isArray(data)) return [];

  const out: Array<{ objectId: string; digest: string }> = [];
  for (const tx of data) {
    if (typeof tx !== "object" || tx === null) continue;
    const digest = (tx as { digest?: unknown }).digest;
    const objectChanges = (tx as { objectChanges?: unknown }).objectChanges;
    if (typeof digest !== "string") continue;
    if (!Array.isArray(objectChanges)) continue;
    for (const c of objectChanges) {
      if (typeof c !== "object" || c === null) continue;
      const type = (c as { type?: unknown }).type;
      const objectType = (c as { objectType?: unknown }).objectType;
      const objectId = (c as { objectId?: unknown }).objectId;
      if (type !== "created") continue;
      if (typeof objectId !== "string") continue;
      if (typeof objectType !== "string" || !objectType.includes(opts.objectTypeIncludes)) continue;
      out.push({ objectId, digest });
    }
  }
  return out;
}

export function extractFirstCreatedObjectId(
  objectChanges: unknown,
  opts: { objectTypeIncludes: string },
): string | null {
  if (!Array.isArray(objectChanges)) return null;
  for (const c of objectChanges) {
    if (typeof c !== "object" || c === null) continue;
    const type = (c as { type?: unknown }).type;
    const objectType = (c as { objectType?: unknown }).objectType;
    const objectId = (c as { objectId?: unknown }).objectId;
    if (type !== "created") continue;
    if (typeof objectId !== "string") continue;
    if (typeof objectType !== "string" || !objectType.includes(opts.objectTypeIncludes)) continue;
    return objectId;
  }
  return null;
}

export function ownerToAddress(owner: unknown): string | null {
  if (typeof owner !== "object" || owner === null) return null;
  const o = owner as { AddressOwner?: unknown };
  return typeof o.AddressOwner === "string" ? o.AddressOwner : null;
}
