# GeoProof — Data sources & official docs

This file tracks the external services and protocols used by GeoProof, with official documentation links.

## Microsoft Planetary Computer

### STAC search (Sentinel‑2 / Landsat)
- **Planetary Computer STAC API quickstart (searching/reading STAC)**
  - https://planetarycomputer.microsoft.com/docs/quickstarts/reading-stac/
- **STAC API endpoint used by this project**
  - `POST https://planetarycomputer.microsoft.com/api/stac/v1/search`

### Tile rendering (high‑res crops)
GeoProof renders bbox crops by downloading XYZ tiles derived from each STAC item.

- **Planetary Computer Data API (overview + usage)**
  - https://planetarycomputer.microsoft.com/docs/quickstarts/using-the-data-api/
- **Planetary Computer Data API docs (interactive OpenAPI)**
  - https://planetarycomputer.microsoft.com/api/data/v1/docs

Notes:
- For Sentinel‑2 we request tiles for the `visual` asset.
- For Landsat we request an RGB tilejson (red/green/blue) with a color formula.

## STAC standard
- **SpatioTemporal Asset Catalog (STAC) specification**
  - https://stacspec.org/

## OpenStreetMap / Nominatim (place search)
GeoProof uses Nominatim for geocoding during interactive place search.

- **Nominatim Usage Policy (rate limits, required headers, prohibited use)**
  - https://operations.osmfoundation.org/policies/nominatim/

## Map rendering
- **MapLibre GL JS** (interactive map)
  - https://maplibre.org/maplibre-gl-js/docs/

## Next.js (API routes / deployment)
- **Route Handlers (App Router API endpoints)**
  - https://nextjs.org/docs/app/building-your-application/routing/route-handlers

## Potential additional source (not yet integrated)

### ArcGIS World Imagery Wayback
If we add a second “visual reference” archive (often cloud‑free), the canonical entry point is the Wayback WMTS capabilities.

- **Wayback WMTS capabilities**
  - https://wayback.maptiles.arcgis.com/arcgis/rest/services/World_Imagery/MapServer/WMTS/1.0.0/WMTSCapabilities.xml
