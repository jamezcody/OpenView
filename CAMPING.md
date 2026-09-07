# U.S. camping inventory

OpenView v0.1.1 includes three independent prepared camping overlays with payment filters, immutable record/parent details, and bounded unified search. They require no runtime account, API key, or upstream request.

## Use

Open **Views & overlays** and independently enable **Campgrounds and camping locations**, **Individual tent/RV sites**, or **Camping-related lodging and zones**. Payment filters default to all selected:

| Status          | Symbol | Color     |
| --------------- | ------ | --------- |
| Paid            | `$`    | Amber     |
| Unclear         | `?`    | Pale blue |
| Completely free | `F`    | Green     |

Triangles identify campground/location records, squares identify individual/group sites, and diamonds identify supplementary facilities. Marker numbers count source records, including overlaps. Click a group to zoom or a point to inspect it.

Version 0.1.1 keeps existing individual tent/RV markers on screen while a closer view is loading and prevents terrain depth testing from hiding ground-clamped markers inside 1 km. Filters narrow stale markers immediately. Dense or coincident records can remain grouped even near the ground.

Search works while camping layers are off and searches word prefixes in names, state codes, record types, source names, and explicit parent names. Examples include `Wawona CA`, `Denali AK`, `Hosmer Grove`, `ridb_campsite:1`, and `osm:node/571276260`. Full source IDs resolve directly. Results are capped and the interface asks for a narrower query when necessary.

Selecting an unmapped result shows **Location unavailable** without moving the camera. Parent/child navigation remains pinned to the same immutable prepared release. **Reload prepared camping layer** only rereads the installed release; it never performs upstream acquisition or checks live availability.

## Inventory and provenance

The verified snapshot was prepared on 6 September 2026. Raw SQLite, GeoJSON, source archives, receipts, acquisition tooling, and operator logs are intentionally excluded from the production source and release data package.

| Category                                            | Source records |
| --------------------------------------------------- | -------------: |
| Campgrounds, RV parks, camping locations            |         79,603 |
| Individual/group tent and RV sites                  |        191,938 |
| Supplementary lodging, zones and related facilities |          2,993 |
| All searchable records                              |        274,534 |
| Accepted map points                                 |        255,304 |
| Missing/invalid coordinates (not mapped)            |         18,999 |
| Coordinates flagged for review (not mapped)         |            231 |

Only finite coordinates screened inside a generalized U.S. state polygon become markers. That screen is not a survey: coastal points can be flagged, OSM way/relation locations can be bounding-box centers, and BLM polygon locations can be representative interior points. Original coordinate type, screen result, state basis, and source update date remain in record details.

Payment status and source evidence are copied without inference. “Completely free” means the source reported no required fee; it is not a live price guarantee. Missing, conflicting, and conditional evidence remains **Unclear**. Public ownership, nearby records, and parent fees are not used to invent a price.

Coverage is incomplete and overlapping and is not a count of unique physical campsites. Possible duplicates are not merged. Unresolved parent references remain explicit. Commercial directories and live booking availability are outside this snapshot.

| Source        | Attribution / license reference                                                                                                        |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| OpenStreetMap | [© OpenStreetMap contributors, ODbL 1.0](https://www.openstreetmap.org/copyright)                                                      |
| RIDB          | [Recreation.gov RIDB](https://ridb.recreation.gov/), attribution: `data source: ridb.recreation.gov`                                   |
| BLM           | [National Recreation services](https://gis.blm.gov/arcgis/rest/services/recreation/BLM_Natl_Recreation/MapServer)                      |
| USGS          | [National Map campground structures](https://carto.nationalmap.gov/arcgis/rest/services/structures/MapServer/60)                       |
| USFS          | [Recreation sites and subsites](https://apps.fs.usda.gov/arcx/rest/services/EDW/EDW_RecInfraRecreationSites_02/MapServer)              |
| Census        | [2025 generalized state boundaries](https://tigerweb.geo.census.gov/arcgis/rest/services/Generalized_ACS2025/State_County/MapServer/7) |

The combined inventory has no blanket license and no agency endorsement is implied. Preserve each source's attribution and terms when redistributing prepared data.

## Prepared-release behavior

The active release uses compact, checksum-verified JSON pages. It is approximately 317.5 MB uncompressed across 10,320 files. Map/search/detail operations have explicit request, byte, timeout, cache, and entity limits. Obsolete requests abort; stale results are rejected; disabling layers cleans up entities and credits. Errors remain visible and do not turn off unrelated overlays.

Raw acquisition and preparation tooling is deliberately separate from this public production source because it has different dependencies, credentials, source terms, and audit records. A maintainer replacing the snapshot must use a new staging directory, verify every raw and prepared checksum, preserve source-specific evidence, and atomically change the release pointer only after full validation.

## Verification

Application tests cover screened coordinates, dateline/boundary membership, aggregation, payment filters, Alaska/Hawaii/California views, real source IDs, release-pinned details, parent pagination, unavailable locations, safe outbound URLs, integrity failures, cancellation, operation budgets, and cache eviction.

From a source checkout with the release data installed:

```powershell
npm run security:audit
npm test
npm run typecheck
npm run lint
npm run build
```

The complete v0.1.1 suite passes 108 tests. See [DATA_SOURCES.md](DATA_SOURCES.md) for the broader source inventory and [CREDENTIALS.md](CREDENTIALS.md) for the explicit no-runtime-key boundary.
