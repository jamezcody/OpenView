# Park overlays (local implementation)

In **Views & overlays → Overlays**, enable **National parks** and **State parks** independently. Orange outlines show NPS National Park boundaries; lavender outlines show PAD-US state-park areas. Both have subtle fills and follow the globe's terrain on every basemap. Select a shaded area for designation, states/territories, source dates and original identifiers. Existing address, parcel, radio and traffic selections take priority.

The controls include attribution, coverage notes, sample locations and **Reload park layers**. Reload reads the prepared release; it does not download newer federal data. On mobile, close the explorer to expose the map; park details appear in a scrollable bottom panel. Escape or the close button dismisses details.

## Architecture

The existing React/Vinext application uses CesiumJS. This addition uses the existing `pmtiles`, `@mapbox/vector-tile` and `pbf` dependencies. Two static PMTiles v3 archives contain gzip-compressed vector tiles through zoom 10. A Cesium imagery provider draws visible vectors onto 256px canvases, re-rendering overzoomed vectors to preserve stroke widths. Fills use even/odd rings; outlines use separately clipped original rings, avoiding artificial tile-edge boundaries. Inspection uses detailed prepared polygons, including holes and multipart shapes.

No park data is requested until enabled. Each enabled layer loads its own record index; archive data uses coalesced, SHA-256-verified 64 KiB HTTP ranges, four tile requests at a time, and bounded caches. Disabling aborts work and removes imagery. Missing files, corrupt chunks and failed metadata remain explicit errors. When hosting supports ranges, responses must use HTTP 206 with the correct `Content-Range`. For hosts that return HTTP 200 instead, archives up to 8 MiB use one bounded, full-file download after exact length and SHA-256 verification; larger archives are rejected.

The input subsets total **156.2 MB of GeoJSON**. Prepared archives are **875,251 bytes national / 5,407,405 bytes state**, plus **53,595 / 4,904,521 bytes** of record indexes. Nationwide raw geometry is never loaded into the page. No paid service, account, new npm dependency or backend storage was added.

## Sources and scope

- **NPS:** 63 official National Parks, 70 boundary components. The authoritative live service was edited **17 August 2026**, retrieved **6 September 2026**; the linked catalog release is **22 July 2026**. Exact filtering includes New River Gorge despite its source category and the seven preserve components of combined park/preserve units. Monuments, historic sites, recreation areas, standalone preserves and Wolf Trap are excluded. These are NPS administrative boundaries, not ownership parcels.
- **PAD-US:** version **4.1**, **March 2025 revision**, retrieved **6 September 2026**. Include only `Des_Tp='SP'` with `Mang_Type IN ('STAT','TERR')`, or explicitly unknown management with state/territory ownership. The 6,169 source records include 4,103 state-managed records and 2,066 state-owned records with unknown management. Selected records exist in every state plus Puerto Rico and U.S. Virgin Islands; this does **not** establish complete/current state-park coverage.
- State records retain **Fee (5,988), Other (163), Designation (18)** meanings. Most outlines describe recorded park land holdings, not complete legal administrative perimeters. Popup text states this substitution and unknown management explicitly. Distinct source identities remain distinct even when geometry or names match. Record counts are not unique park counts; underlying contributions vary in age.
- Whole-feature repair restores nested shells/holes before tiling. Each zoom uses topology-preserving simplification. At the most detailed zoom 10, quantization leaves **31 very small state records without a filled polygon**, including **9 without any rendered geometry**. Metadata and exact omission IDs remain in the manifest. All 63 national parks remain represented. Higher zooms do not recover omitted detail; a blank point does not establish that no park exists.
- Boundaries do not establish ownership, public access or survey accuracy. No PAD-US state-park records were selected for American Samoa, Guam or Northern Mariana Islands. NPS includes American Samoa and Virgin Islands National Parks.

Attribute NPS to **National Park Service Land Resources Division** and PAD-US to **U.S. Geological Survey Gap Analysis Project, Protected Areas Database of the United States 4.1**, [doi:10.5066/P96WBCHS](https://doi.org/10.5066/P96WBCHS). Credits appear on the globe and in source/details panels. Complete evidence, endpoints, schemas, attribution and exact filtering SQL are in the parent workspace's `research/parks/README.md`.

## Refresh and verify locally

From the workspace root, follow `research/parks/README.md` to install pinned Python dependencies, acquire verified snapshots and update `build-config.json` source dates. Build to a fresh directory and install only verified derived files:

```powershell
python -m unittest discover -s research/parks -p test_prepare_parks.py
python research/parks/prepare_parks.py --config research/parks/build-config.json --out research/parks/candidate-next
python research/parks/install_parks.py --input research/parks/candidate-next
```

The installer verifies file/chunk checksums, preserves immutable releases and replaces `public/parks/latest.json` only after files are ready. It does not deploy. Archive URLs are `/parks/{release}/{national|state}.pmtiles`; corresponding record indexes sit beside them. Keep previous releases available during a future authorized deployment. Raw downloads and Python dependencies stay outside the app.

Run `npm test`, `npm run typecheck` and `npm run build` from `app`. Review scope assertions in `tests/parks-release.test.ts` when adopting a new source release. Validate desktop/mobile selection and terrain alignment. Restore a saved previous manifest to roll back data.

The installed release is `parks-9962df489f64eb765419`. Its prepared geometry and release pointer are covered by the v0.1.1 application and integrity checks; raw preparation artifacts are intentionally excluded from the production source.
