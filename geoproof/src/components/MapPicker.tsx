"use client";

import maplibregl, { type LngLatLike } from "maplibre-gl";
import type { Feature, FeatureCollection, LineString, Point, Polygon } from "geojson";
import { useEffect, useMemo, useRef } from "react";

export type BBox = [number, number, number, number];

export type BaseLayer = "streets" | "satellite";

export type PointMarker = {
  id: string;
  coord: [number, number];
  color?: string;
};

function emptyFeatureCollection<T extends Point | Polygon>(): FeatureCollection<T> {
  return { type: "FeatureCollection", features: [] };
}

function emptyLineCollection(): FeatureCollection<LineString> {
  return { type: "FeatureCollection", features: [] };
}

function bboxToFeatureCollection(bbox: BBox): FeatureCollection<Polygon> {
  const [minLng, minLat, maxLng, maxLat] = bbox;
  return {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: {},
        geometry: {
          type: "Polygon",
          coordinates: [
            [
              [minLng, minLat],
              [maxLng, minLat],
              [maxLng, maxLat],
              [minLng, maxLat],
              [minLng, minLat],
            ],
          ],
        },
      } satisfies Feature<Polygon>,
    ],
  };
}

function pointsToFeatureCollection(points: PointMarker[]): FeatureCollection<Point> {
  return {
    type: "FeatureCollection",
    features: [
      ...points.map(
        (p) =>
          ({
            type: "Feature",
            properties: { id: p.id, color: p.color ?? "#f97316" },
            geometry: { type: "Point", coordinates: p.coord },
          }) satisfies Feature<Point>,
      ),
    ],
  };
}

function lineToFeatureCollection(coords: [number, number][]): FeatureCollection<LineString> {
  if (coords.length < 2) return emptyLineCollection();
  return {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: {},
        geometry: { type: "LineString", coordinates: coords },
      } satisfies Feature<LineString>,
    ],
  };
}

function circleToFeatureCollection(center: [number, number], radiusKm: number, steps = 64): FeatureCollection<Polygon> {
  // Approximate circle on WGS84.
  const [lng, lat] = center;
  const latRad = (lat * Math.PI) / 180;
  const kmPerDegLat = 110.574;
  const kmPerDegLng = 111.320 * Math.cos(latRad);
  const dLat = radiusKm / kmPerDegLat;
  const dLng = kmPerDegLng > 0 ? radiusKm / kmPerDegLng : radiusKm / 111.320;

  const coords: [number, number][] = [];
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * Math.PI * 2;
    coords.push([lng + Math.cos(a) * dLng, lat + Math.sin(a) * dLat]);
  }

  return {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: {},
        geometry: { type: "Polygon", coordinates: [coords] },
      } satisfies Feature<Polygon>,
    ],
  };
}

function rasterStyle(
  name: string,
  tiles: string[],
  attribution: string,
): maplibregl.StyleSpecification {
  return {
    version: 8,
    name,
    sources: {
      base: {
        type: "raster",
        tiles,
        tileSize: 256,
        attribution,
      },
    },
    layers: [
      {
        id: "base",
        type: "raster",
        source: "base",
      },
    ],
  };
}

const STREETS_STYLE = rasterStyle(
  "OSM Streets",
  ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
  "© OpenStreetMap contributors",
);

const SATELLITE_STYLE = rasterStyle(
  "Satellite",
  ["https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"],
  "Tiles © Esri",
);

type Props = {
  baseLayer: BaseLayer;
  onBaseLayerChange: (layer: BaseLayer) => void;
  bbox: BBox | null;
  circle: { center: [number, number]; radiusKm: number } | null;
  points: PointMarker[];
  line: [number, number][];
  onMapClick?: (coord: [number, number]) => void;
  autoFitToBbox?: boolean;
};

export function MapPicker({
  baseLayer,
  onBaseLayerChange,
  bbox,
  circle,
  points,
  line,
  onMapClick,
  autoFitToBbox = true,
}: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);

  const dataRef = useRef<{
    bbox: BBox | null;
    circle: { center: [number, number]; radiusKm: number } | null;
    points: PointMarker[];
    line: [number, number][];
  }>({ bbox: null, circle: null, points: [], line: [] });
  const fittedRef = useRef<string>("");

  useEffect(() => {
    dataRef.current = { bbox, circle, points, line };
  }, [bbox, circle, points, line]);

  const style = useMemo(() => {
    return baseLayer === "satellite" ? SATELLITE_STYLE : STREETS_STYLE;
  }, [baseLayer]);

  function ensureOverlays(map: maplibregl.Map) {
    // Sources
    if (!map.getSource("bbox")) {
      map.addSource("bbox", { type: "geojson", data: emptyFeatureCollection<Polygon>() });
    }
    if (!map.getSource("circle")) {
      map.addSource("circle", { type: "geojson", data: emptyFeatureCollection<Polygon>() });
    }
    if (!map.getSource("points")) {
      map.addSource("points", { type: "geojson", data: emptyFeatureCollection<Point>() });
    }
    if (!map.getSource("line")) {
      map.addSource("line", { type: "geojson", data: emptyLineCollection() });
    }

    // Layers (skip if already present)
    if (!map.getLayer("circle-fill")) {
      map.addLayer({
        id: "circle-fill",
        type: "fill",
        source: "circle",
        paint: { "fill-color": "#f97316", "fill-opacity": 0.08 },
      });
    }
    if (!map.getLayer("circle-outline")) {
      map.addLayer({
        id: "circle-outline",
        type: "line",
        source: "circle",
        paint: { "line-color": "#f97316", "line-width": 2 },
      });
    }

    if (!map.getLayer("bbox-fill")) {
      map.addLayer({
        id: "bbox-fill",
        type: "fill",
        source: "bbox",
        paint: { "fill-color": "#2563eb", "fill-opacity": 0.12 },
      });
    }
    if (!map.getLayer("bbox-outline")) {
      map.addLayer({
        id: "bbox-outline",
        type: "line",
        source: "bbox",
        paint: { "line-color": "#2563eb", "line-width": 2 },
      });
    }

    if (!map.getLayer("line-path")) {
      map.addLayer({
        id: "line-path",
        type: "line",
        source: "line",
        paint: { "line-color": "#0f172a", "line-width": 2, "line-opacity": 0.7 },
      });
    }

    if (!map.getLayer("points-dot")) {
      map.addLayer({
        id: "points-dot",
        type: "circle",
        source: "points",
        paint: {
          "circle-radius": 6,
          "circle-color": ["get", "color"],
          "circle-stroke-width": 2,
          "circle-stroke-color": "#ffffff",
        },
      });
    }
  }

  function updateOverlays(map: maplibregl.Map) {
    const d = dataRef.current;

    const bboxSrc = map.getSource("bbox") as maplibregl.GeoJSONSource | undefined;
    bboxSrc?.setData(d.bbox ? bboxToFeatureCollection(d.bbox) : emptyFeatureCollection<Polygon>());

    const circleSrc = map.getSource("circle") as maplibregl.GeoJSONSource | undefined;
    circleSrc?.setData(
      d.circle ? circleToFeatureCollection(d.circle.center, d.circle.radiusKm) : emptyFeatureCollection<Polygon>(),
    );

    const pointsSrc = map.getSource("points") as maplibregl.GeoJSONSource | undefined;
    pointsSrc?.setData(pointsToFeatureCollection(d.points));

    const lineSrc = map.getSource("line") as maplibregl.GeoJSONSource | undefined;
    lineSrc?.setData(lineToFeatureCollection(d.line));
  }

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    const map = new maplibregl.Map({
      container: containerRef.current,
      style,
      center: [19.0, 52.2] as LngLatLike,
      zoom: 5,
    });
    mapRef.current = map;

    map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "top-right");

    const sync = () => {
      try {
        ensureOverlays(map);
        updateOverlays(map);
      } catch {
        // If style is mid-transition, MapLibre can throw; we'll retry on next style event.
      }
    };

    map.on("load", () => {
      sync();
    });
    map.on("styledata", () => {
      sync();
    });

    map.on("click", (e) => {
      onMapClick?.([e.lngLat.lng, e.lngLat.lat]);
    });

    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, [onMapClick, style]);

  // Switch basemap.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    map.setStyle(style);
  }, [style]);

  // Keep overlays in sync.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    try {
      ensureOverlays(map);
      updateOverlays(map);
    } catch {
      // ignore during style transition
    }
  }, [bbox, circle, points, line]);

  // Auto-fit bbox.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !autoFitToBbox || !bbox) return;
    const key = bbox.map((x) => x.toFixed(6)).join(",");
    if (fittedRef.current === key) return;
    fittedRef.current = key;
    map.fitBounds(
      [
        [bbox[0], bbox[1]],
        [bbox[2], bbox[3]],
      ],
      { padding: 40, duration: 500 },
    );
  }, [bbox, autoFitToBbox]);

  return (
    <div className="relative h-[520px] w-full overflow-hidden rounded-xl border border-zinc-200 bg-zinc-50">
      <div ref={containerRef} className="h-full w-full" />

      <div className="absolute left-3 top-3 rounded-lg border border-zinc-200 bg-white/90 p-1 text-xs text-zinc-700 shadow">
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => onBaseLayerChange("streets")}
            className={`rounded-md px-2 py-1 ${
              baseLayer === "streets" ? "bg-zinc-900 text-white" : "text-zinc-700 hover:bg-zinc-100"
            }`}
          >
            Streets
          </button>
          <button
            type="button"
            onClick={() => onBaseLayerChange("satellite")}
            className={`rounded-md px-2 py-1 ${
              baseLayer === "satellite" ? "bg-zinc-900 text-white" : "text-zinc-700 hover:bg-zinc-100"
            }`}
          >
            Satellite
          </button>
        </div>
      </div>
    </div>
  );
}
