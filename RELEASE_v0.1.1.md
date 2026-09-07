# OpenView v0.1.1

Version 0.1.1 is the first packaged public-production candidate. It keeps all prepared map functionality while reducing source, dependency, CSS, and repeated-render work.

## User-visible fixes

- National and state park archives now load on both proper HTTP byte-range hosts and hosts that answer a range request with HTTP 200.
- Individual tent/RV markers remain visible while close-view data refreshes and are no longer hidden by terrain depth testing inside 1 km.
- Satellite, street, and topographic modes retain a visible fallback at close zoom when a provider has no native tile at that level.

## Performance and size

- Removed 56 unreachable UI components and one unused mobile hook (222,126 source bytes).
- Removed eight unused direct dependencies and 72 lockfile packages. A clean install fell from 43,719 files / 737.78 MiB to 27,675 files / 574.57 MiB.
- Reduced production CSS from 246,640 bytes to 97,322 bytes.
- Made Cesium asset preparation version-aware and inventory-checked; unchanged runs complete in roughly 80 ms on the release machine.
- Prevented satellite/address toggles from reconstructing complete Cesium data sources.
- Cached repeated radio, cell, and camping SVG marker images.
- Paused the one-second page clock while the page is hidden.
- Added guarded build cleanup and ignored high-churn generated data in the development watcher.

## Reliability and security

- Bounded property request bodies and upstream JSON responses.
- Tightened PMTiles range reads and promptly cancels unused error bodies.
- Added release cache headers for park pointers and immutable versions.
- Removed all sensitive query parameters from public acquisition provenance and refreshed the cell-manifest checksum.
- Added a value-suppressing credential audit. No usable credential was found in source, data, generated output, or existing Git history.
- Hash-verifies and removes Cesium's bundled default Ion token during every production build; OpenView also keeps Ion disabled at runtime.
- Removed the owner-specific Sites project identifier from the public configuration.

## Data packaging

The extracted prepared public tree is 62,585 files / 1,884,686,347 bytes:

| Prepared asset |  Files |         Bytes |
| -------------- | -----: | ------------: |
| Cells          | 44,624 | 1,354,890,539 |
| Camping        | 10,320 |   317,482,952 |
| Radio          |  6,757 |   160,220,395 |
| Coverage       |    484 |    20,596,820 |
| Search         |      3 |    13,131,889 |
| Parks          |      5 |    11,261,048 |

Generated datasets are distributed as a checksum-pinned release archive instead of approximately 62,000 Git objects. Source installs use `npm run data:install`; the Windows setup program retrieves the same archive. A separate Windows x64 archive contains the prebuilt production Worker/client and only Wrangler's lockfile-derived runtime dependency tree, so setup performs no end-user compilation or npm install.

## Verification

- 108 tests passed.
- TypeScript checking, linting, and formatting passed.
- Production build passed.
- Local Worker HTTP smoke checks passed for the application, all six dataset pointers, fallback imagery, and bounded request handling.
- Dataset integrity and credential scans passed.

The approximately 4.87 MB minified Cesium client chunk remains intentionally isolated and cacheable. Replacing Cesium or deeply splitting it is outside this low-risk point release.
