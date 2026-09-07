# Estimated cell locations

Prepared on **6 September 2026** for the v0.1.1 release. No paid runtime infrastructure is required.

## Use

Enable **Views & overlays → Cell locations**. Expand **Cell location filters and source** for network allocations and GSM/LTE/NR/UMTS filters. Pink circles show estimated cell locations; numbers count matching cell records in geographic groups. Click a marker or use **Browse visible cell groups** to inspect records, then zoom to the group. Inspection pages contain at most 50 records.

Cell locations, existing Radio sites, and FCC Cell coverage have independent toggles, filters, caches, and selection state. Cells work on all three base maps and clamp to terrain. **Reload prepared cell data** checks for a prepared local release; it does not download OpenCellID data. Disabled cells make no automatic data requests. Filters cancel prior work; failed refreshes retain the previous valid dataset. Limit and failure messages must not be interpreted as absence of cellular service.

## Actual source scope

**U.S. networks — MCC 310–314**, not a strictly physical-U.S. inventory. All five authenticated bulk exports downloaded successfully and passed GZIP magic/CRC, CSV schema, identity, coordinate, and SHA-256 checks. The existing Transmitter Builder importer produced 694,839 candidates, with no coordinate rejections and no transmitter/receiver records in this separate run.

| MCC | Imported cell records | Outcome   |
| --- | --------------------: | --------- |
| 310 |               546,809 | Validated |
| 311 |               142,154 | Validated |
| 312 |                   180 | Validated |
| 313 |                 5,443 | Validated |
| 314 |                   253 | Validated |

Acquired around 20:25–20:26 UTC on 2026-09-06. Export `Last-Modified`: 2026-09-06 02:30:06 GMT. Compressed input: **15,091,728 bytes**. Technologies: 545,254 LTE, 136,904 NR, 8,932 UMTS, 3,749 GSM. No CDMA rows occur in this release; the enrichment explicitly handles CDMA SID separately and regression tests cover it. Identifiers remain exact strings, including a synthetic test above JavaScript's safe integer limit.

The [OpenCellID download page](https://opencellid.org/downloads.php) describes exports as recent observations (last 18 months), not complete current coverage. [Its schema](https://wiki.opencellid.org/docs/downloads/database-format) supplies estimated coordinates in degrees, timestamps in Unix seconds, and contributed measurement counts. We retain the builder's unspecified-datum mapping note rather than invent a surveyed CRS. Raw fields remain available. `averageSignal` and `changeable` are deprecated; `range` is never rendered as service coverage. Multiple records can correspond to one mast. Last-seen dates do not prove present operation.

Network labels come from the [official U.S. IMSI administrator HNI directory](https://imsiadmin.com/assignments/hni/), retrieved 2026-09-06 20:27 UTC. Its documented U.S. MNC width is three digits; only the allocation/filter code is padded, while raw `net` stays unchanged. The reference has 433 active allocation labels after excluding 114 returned/reserved/nonassignments. The cell release contains **68 networks**; **11 records** lack a usable assignment and retain selectable raw-code labels. Names identify current code assignees, not mast owners, historical operators, or guaranteed retail/MVNO brands.

Physical country remains unknown for every record; MCC alone is not country evidence. Bounding-box audit found 1,423 Alaska-mainland records, 15 in the eastern Aleutians, 2,590 in Hawaii, 752 in Puerto Rico, 17 in the U.S. Virgin Islands, 35 in Guam, and 1 in the Northern Mariana Islands. These are presence checks, not jurisdiction classification. No records were found in the tested western-Aleutians or American-Samoa boxes. Coordinates outside these regions remain in the dataset, without being silently reassigned or moved.

## Assets, provenance, and costs

The app reuses its geographic quadtree, bounded `RadioData` loader, inspector, and Cesium marker renderer. A second `useRadioSites(..., '/cells')` owns independent state. Cell markers use `cells:` picking identifiers and a separate `CustomDataSource`. Network keys participate in every summary grouping, facet, match, and inspection prune; technology uses `service`. Preparation is `radio-prep-3`; old radio manifests without a network field remain valid.

- Cell release: `/cells/versions/radio-846bf79cebf983f4a4d8/`, activated by `/cells/latest.json`.
- Source builder run: `20260906-162600-a63664`; raw builder output is intentionally excluded from the public production source.
- Existing radio release preserved: `radio-42b565087e93ae452711` with 30,297 transmitters, 292 candidates, 6,190 receivers. Radio pointer SHA-256: `c3d2cbfeba8fd17d05418270e7673b08adf926870a012b72567cdd733ff0d219`.
- Prepared cells: **44,623 files including manifest; 1,354,890,447 bytes (1.26 GiB)**. 14,056 nodes; 10,256 leaves. Largest page: 125,596 bytes. Approximately 4 minutes 10 seconds from staging-directory creation to verified staging activation; local copy and destination verification took 85.16 seconds.
- Whole-globe cell view: 12 page/descriptor requests, 107,590 decoded bytes, 40 markers, all 694,839 records represented, no truncation (manifest requests are separate).
- Sample close views used 28–82 cache-miss requests and 205 KB–1.55 MB decoded cell work. New York reached the 240-marker cap and correctly reported truncation; narrow/filter the view for details. Counts in aggregate nodes cover intersecting geographic cells; they are not exact clipped-viewport totals.
- Existing budgets remain: 6 concurrent node requests, 160 requests/4 MiB per view, 240 markers, 256 KiB pages, 1 MiB descriptors, 8 MiB serialized cache budget per layer. Inspection is bounded to 48 requests/2 MiB per step.
- Combined cell/radio loader audit retained about 6.2–12.8 MB of additional Node heap across ten views after GC. This is a measurement of parsed loader state, **not total browser/Cesium/GPU memory**.

The browser does not fetch nationwide raw data or receive an OpenCellID token. Static files work locally, but the 1.35 GB/44k-file release needs a hosting-capacity review or supported object storage before any future publication. Production build success alone does not establish that the existing hosted service accepts this asset volume. Global free-text search was not expanded to index these 694k cells; use cell filters and map inspection. The prior search sources remain unchanged.

## Attribution and reuse

**© OpenCellID contributors — [OpenCellID](https://opencellid.org/), [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/).** Attribution remains visible on the globe while cells are enabled, in controls, and in record details. The prepared cell data is a derived dataset under the source's CC BY-SA notice; preserve attribution, license, modification/provenance metadata, and applicable ShareAlike terms when redistributing. Allocation enrichment is separately attributed to the IMSI administrator. This is not a relicensing of other project datasets.

## Reproduction, refresh, and rollback

Offline acquisition/preparation tooling and raw downloads are intentionally excluded from this production source release. Maintainers replacing the dataset must keep builder runs, raw-download checksums, acquisition receipts, allocation snapshots, source terms, verification reports, and rollback releases. See [CREDENTIALS.md](CREDENTIALS.md); no browser-side API configuration is required.

## Verification

The data audit reconciles every source row with root network/technology counts and checks regional presence. Preparation verifies installed pages and checksums before activation. Application checks cover source redaction, identities, dates, unknown allocations, CDMA separation, full-path filters, independent cache/pointer failures, prior radio compatibility, failed activation, and rollback.
