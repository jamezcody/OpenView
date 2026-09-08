# Radio licenses and authorizations

The local radio update adds verified FCC source snapshots and gives the record inspector a source-specific **License / authorization** section. Missing data is explained by source. An empty identifier never establishes that a station is unlicensed.

| Source                                       | Identifier shown                           | Interpretation                                                                                                         |
| -------------------------------------------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| FCC ULS                                      | FCC ULS unique system ID                   | Links to the matching FCC license record; callsign stays separate.                                                     |
| FCC LMS                                      | Filing number, facility ID, application ID | A filing identifies an application, not a station license. Authorization type and source status remain in the details. |
| Finland Traficom                             | License number                             | Retains the source value.                                                                                              |
| Poland UKE                                   | Permit / decision number                   | Retains the source value.                                                                                              |
| OurAirports                                  | Navigation-aid identifier                  | The source does not supply license identifiers. No geographic matching to unrelated FCC records is performed.          |
| HFCC, SatNOGS, OSM, imported SUBTEL workbook | Source-specific missing explanation        | Schedules, receiver catalogs, structures and antenna-location lists do not supply a license field in these imports.    |

## Local snapshot of September 7, 2026

The nine configured FCC ULS archives passed full ZIP CRC checks and SHA-256 verification. The LMS input is the FCC dump dated September 7, 2026. Acquisition times and archive hashes are retained in provenance; the reused September 6 microwave archive explicitly records that its exact acquisition time is unavailable.

| Records                   | Transmitters | Candidates | Receivers |
| ------------------------- | -----------: | ---------: | --------: |
| Preserved source snapshot |       30,297 |        292 |     6,190 |
| FCC ULS addition          |    3,487,911 |        718 |         0 |
| FCC LMS addition          |       33,145 |      6,708 |         0 |
| Combined                  |    3,551,353 |      7,718 |     6,190 |

All 3,488,629 ULS rows have their source unique system ID. Of 39,853 LMS rows, 39,830 have a filing number; all have an application and facility ID. Missing filing numbers remain missing. All original 14,490 OurAirports records and their original identities remain intact.

These are source records, often separate frequencies, antennas or authorizations at one location. They are not unique towers. The ULS import covers the configured archives and excludes recognized inactive records, receiver rows, nonfixed records and records without usable coordinates. Unknown statuses and other qualifying uncertain records are candidates. LMS preserves granted construction/special authorizations as candidates. Existing sources retain their original status selection and dates. A source status or license date does not prove present operation or current legal validity.

## Preparation and runtime

The offline pipeline verifies downloaded inputs, imports each FCC system separately, merges disjoint source snapshots, audits identifier consistency, and prepares checksum-pinned map pages. Map overviews aggregate across frequency only when no frequency filter is applied. Exact frequency filtering continues to use exact summaries and reports its query budget when a view needs narrowing.

The local Node service streams bounded radio JSON pages directly. The complete radio search index stays on disk in SQLite; the browser requests bounded search results. Park search retains its existing prepared data. Production radio and search data live in `dist/prepared`, outside Wrangler's `dist/client` asset directory, so its recursive startup scan and file watcher do not traverse the national dataset. Raw SQLite files are not available through the HTTP server.

Version 0.2.2 bundles this snapshot in its checksum-pinned release data archive and installs the production layout described above. The earlier local patch updates the installed `dist` directory, with the previous directory retained for rollback. It preserves the signed Node launcher shortcut, saved settings, installed dependencies, credentials and downloaded OSM data. The original published v0.2.0 archive manifest remains unchanged; the local patch has separate provenance. Reinstalling the original published release restores that release's original radio snapshot.

## Sources

- [FCC ULS complete download directory](https://data.fcc.gov/download/pub/uls/complete/)
- [FCC LMS public database downloads](https://enterpriseefiling.fcc.gov/dataentry/public/tv/lmsDatabase.html)
- [OurAirports data](https://ourairports.com/data/)

The coverage audit checks every imported row and representative link parameters against the source identifiers. It does not certify current authorization validity. Dataset reuse terms remain those of each publisher; see [Data sources](DATA_SOURCES.md).
