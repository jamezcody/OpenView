# OpenView v0.2.2

Radio Sites now includes the FCC ULS and LMS snapshots and explains the identifiers supplied by each source. The Windows packages include the Node.js launcher and the data-folder layout used by the verified local update.

## What's new

- Added 3,528,482 FCC source records. The combined snapshot has 3,551,353 transmitters, 7,718 candidates and 6,190 receivers, preserving all 36,779 original records.
- The **License / authorization** section distinguishes ULS unique system IDs, LMS filing numbers, facility IDs and application IDs. Sources that do not supply license information explain the omission; missing information does not mean a station is unlicensed.
- Complete radio search runs against local SQLite instead of downloading a limited index into the browser. Search results open the matching source record. Map summaries remain bounded, with exact frequency information retained for filtering and inspection.
- Radio and search data live outside the page server's recursively watched assets. The installer uses this layout for new installs and recognizes both earlier and locally updated installations when upgrading.
- The runtime package includes `launch-local.mjs`. Start menu and optional desktop launcher shortcuts use system Node.js, and setup can launch it directly. Existing owned Node shortcuts are recognized. The controller remains available for settings.
- Setup refuses to replace an owned Node installation while its saved server port is occupied. It preserves settings, unchecked existing credentials and the separate OSM library, and restores the previous installation if activation fails.
- Portable offline FCC import, preparation, audit and search tools are included under `tools/radio-data`, with sanitized source provenance and fixture tests.

## Install or upgrade

Download `OpenView-Setup-v0.2.2.exe` and verify it against `SHA256SUMS.txt`. Use 64-bit Windows with Node.js 22.13 or newer. Put both v0.2.2 archives beside setup for an offline installation; missing archives are downloaded and checksum-verified.

Stop OpenView before upgrading. Keep the existing installation folder and select **Install / repair**. Allow about 15 GB for the expanded prepared data and 40 GB of free disk space for installation or upgrade. Optional OSM downloads require additional space. The saved port and provider settings are preserved. Refresh older browser tabs after an upgrade.

The installer/controller remains unsigned. The Node launcher does not change Windows security settings or establish trust for those executables. The previously published v0.2.0 assets are unchanged. See the [README](https://github.com/jamezcody/OpenView/blob/v0.2.2/README.md) for the launcher, AISStream and configuration instructions.

## Data scope

The data package contains all six prepared datasets and the complete local radio search database. Exact file counts, byte counts, archive URLs and SHA-256 digests are in the release manifest and checksum file.

The FCC additions are source records, often separate frequencies, antennas or authorizations at one location, rather than unique towers. All 3,488,629 ULS rows retain their unique system ID. Of 39,853 LMS records, 39,830 have a filing number; the remaining 23 retain their supplied facility and application IDs. No license is inferred by matching nearby sites.

The nine configured ULS archives and the September 7, 2026 LMS dump passed full ZIP CRC and SHA-256 verification. The reused microwave archive records that its exact original retrieval time is unavailable. Status selection, missing fields and the limits of historical reconstruction are documented in [Radio licenses](https://github.com/jamezcody/OpenView/blob/v0.2.2/RADIO_LICENSES.md) and [source provenance](https://github.com/jamezcody/OpenView/blob/v0.2.2/tools/radio-data/provenance-0.2.2.json). Source dates and status do not establish current legal validity or on-air operation.

## Verification

The local update passed the full dataset coverage audit, all 179 application/local OSM tests then present, and checksum verification of all 362,694 installed files. Live installed-app checks covered the home page, favicon, complete map counts, bounded search, ULS/LMS/navigation-aid inspection, blocked SQLite downloads and rejected foreign origins. UI inspection confirmed the new license and filing labels and the source-specific missing-data explanation.

The v0.2.2 production build, both browser-worker asset checks, type checking, lint and formatting passed. All 189 application, local OSM and packaging tests passed, along with 42 offline data-tool fixtures. Release tests cover inventories above 150,000 files, the 6.1 GB SQLite archive entry, runtime file scope, installer layout and limits, Node shortcut ownership and occupied-port upgrade refusal.

Both completed archives passed checksum and content verification. The data archive contains 362,190 files and 14,559,298,243 expanded bytes, compressed to 1,570,958,489 bytes. The published Windows setup passed its self-tests with both real sidecars and a complete temporary installation, including cleanup. That acceptance run did not launch an app instance or change user settings, credentials, shortcuts or registration. The source, prepared data, generated runtime and existing Git history were checked for credentials; synthetic security-test inputs were reviewed separately.

Personal keys, settings, ship snapshots, cached catalogs and user OSM data are not included. Existing feature-specific limitations in `SPACE_OBJECTS.md`, `SHIPS.md` and `OSM_DATA.md` still apply; this release does not claim a fresh live-provider or full-planet OSM test.
