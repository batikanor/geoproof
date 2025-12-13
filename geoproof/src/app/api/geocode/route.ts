import { NextResponse } from "next/server";

type NominatimResult = {
  display_name?: string;
  lat?: string;
  lon?: string;
  boundingbox?: [string, string, string, string]; // [south, north, west, east]
};

export async function GET(req: Request) {
  const url = new URL(req.url);
  const q = (url.searchParams.get("q") ?? "").trim();
  if (!q) {
    return NextResponse.json({ results: [] });
  }

  // OpenStreetMap Nominatim (for hackathon/demo).
  // Note: for production, consider hosting your own geocoder or using a paid provider.
  const endpoint = new URL("https://nominatim.openstreetmap.org/search");
  endpoint.searchParams.set("format", "json");
  endpoint.searchParams.set("q", q);
  endpoint.searchParams.set("limit", "5");
  endpoint.searchParams.set("addressdetails", "0");

  let json: unknown;
  try {
    const res = await fetch(endpoint.toString(), {
      headers: {
        // Nominatim requires a valid User-Agent.
        "User-Agent": "GeoProof hackathon app",
        Accept: "application/json",
      },
      cache: "no-store",
    });

    if (!res.ok) {
      return NextResponse.json(
        { error: `Geocoder failed: ${res.status} ${res.statusText}` },
        { status: 502 },
      );
    }
    json = (await res.json()) as unknown;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: `Geocoder request error: ${msg}` }, { status: 502 });
  }

  const arr = Array.isArray(json) ? (json as NominatimResult[]) : [];

  const results = arr
    .map((r) => {
      const name = r.display_name ?? "";
      const lat = r.lat ? Number(r.lat) : NaN;
      const lon = r.lon ? Number(r.lon) : NaN;
      if (!name || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;

      let bbox: [number, number, number, number] | null = null;
      // boundingbox is [south, north, west, east]
      if (r.boundingbox && r.boundingbox.length === 4) {
        const south = Number(r.boundingbox[0]);
        const north = Number(r.boundingbox[1]);
        const west = Number(r.boundingbox[2]);
        const east = Number(r.boundingbox[3]);
        if ([south, north, west, east].every(Number.isFinite)) {
          bbox = [west, south, east, north];
        }
      }

      return {
        displayName: name,
        coord: [lon, lat] as [number, number],
        bbox,
      };
    })
    .filter(Boolean);

  return NextResponse.json({ results });
}
