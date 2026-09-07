# OpenView

OpenView is an interactive 3D Earth explorer for satellite, street, and topographic maps with parks, campsites, radio sites, estimated cell locations, FCC coverage, addresses, parcels, satellites, aircraft, and ships.

Version 0.1.1 fixes national/state park archive loading on hosts without byte-range support, keeps individual tent/RV sites visible during close-view refreshes, and preserves a usable basemap when a provider has no closer tile. It also reduces unused UI and dependency weight, bounds network reads, and avoids unnecessary map-layer rebuilds.

## Install on Windows

Download `OpenView-Setup-v0.1.1.exe` and `SHA256SUMS.txt` from the [v0.1.1 release](https://github.com/jamezcody/openview-earth/releases/tag/v0.1.1).

The setup executable includes its own .NET runtime, runs per user without elevation, and verifies checksum-pinned Windows x64 runtime and data packages. Put both release archives beside setup for a pre-push or offline install; when a sidecar is absent, setup downloads that exact asset. The installed app uses the system's Node.js runtime. OpenView itself needs no API key. An advanced page can save optional offline data-refresh credentials in Windows Credential Manager for the current Windows user; those credentials are never put in the site, browser, logs, command line, or a plaintext file.

Requirements:

- 64-bit Windows 10 or 11
- Node.js 22.13 or newer
- Internet access only when a release archive is not beside setup
- 5 GB of free disk space recommended (setup keeps a verified backup during upgrades)

The v0.1.1 installer is unsigned because this release does not yet have an Authenticode certificate. Verify its SHA-256 checksum before running it.

## Run from source

```powershell
npm ci
npm run data:install
npm run dev
```

Open [http://localhost:4000/](http://localhost:4000/). The data command downloads the exact release archive, verifies its SHA-256 digest, validates every archive path, and installs the six prepared datasets. Existing local release data is left in place unless `--force` is supplied directly to the script.

Validate and build:

```powershell
npm run security:audit
npm test
npm run typecheck
npm run lint
npm run build
npm start
```

`predev`, `pretest`, and `prebuild` prepare the Cesium runtime assets under ignored `public/cesium`. The production application is not static-only: its API routes require the generated Cloudflare-compatible Worker server.

## Configuration and credentials

OpenView runs without configuration.

| Name                   |   Runtime requirement | Secret | Purpose                                                 |
| ---------------------- | --------------------: | -----: | ------------------------------------------------------- |
| `PHOTON_API_URL`       |              Optional |     No | Override the default HTTPS Photon place-search endpoint |
| `FCC_USERNAME`         | Never used by runtime |     No | Optional offline FCC acquisition account                |
| `FCC_API_TOKEN`        | Never used by runtime |    Yes | Optional offline FCC acquisition                        |
| `OPENCELLID_API_TOKEN` | Never used by runtime |    Yes | Optional offline OpenCellID acquisition                 |

The FCC and OpenCellID acquisition tools are not included in this source release. Viewing or reloading prepared data never uses those credentials. OpenView does not collect GitHub, Cloudflare, property-portal, or map-provider logins. See [CREDENTIALS.md](CREDENTIALS.md) for storage and rotation details.

## Data scope and size

Generated datasets are distributed as a release asset instead of tens of thousands of Git objects. The complete prepared `public` tree for v0.1.1 is 1,884,686,347 bytes across 62,585 files; estimated cell locations account for 1,354,890,539 bytes. The compressed release data package is checksum-pinned by both the installer and `npm run data:install`.

The separate Windows x64 runtime package contains the prebuilt Worker/client output and a lockfile-derived, production-only Wrangler dependency tree. End users therefore do not compile OpenView or install npm packages during setup.

## Reproduce release packages

Use Node.js 24.18.0 on 64-bit Windows. Runtime and data archives use sorted POSIX tar entries, normalized metadata, bounded file/byte counts, and deterministic gzip output. The data command sanitizes public provenance, scans for credentials, runs the full test suite, and then packages the six prepared data roots.

For a post-publication clone, install the pinned data first. When producing the initial local v0.1.1 candidate, skip `npm run data:install` because the release URL does not exist yet; the prepared roots must already be present in the release workspace.

```powershell
npm ci
npm run data:install
npm run build
npm run runtime:build
npm run data:build
./installer/build.ps1
```

`release/release-manifest.json` is the authoritative archive name, URL, checksum, size, and safety-limit record. Generated archives and executables stay ignored under `artifacts/v0.1.1`.

The first v0.1.1 data archive and installer are produced locally and uploaded only after the local production test is approved. The **Reproduce release assets** workflow is deliberately post-publication: it installs the already-published pinned data, rebuilds both archives, requires their names, sizes, and SHA-256 digests to match the checked-in manifest, self-tests both sidecars, and uploads the complete reproducibility artifact. It cannot bootstrap the initial data release and never publishes a GitHub Release automatically.

The datasets have different dates, geographic coverage, accuracy, and reuse terms. Estimated cell coordinates are not a tower census, modeled FCC coverage is not measured service, and parcel/property coverage varies by jurisdiction.

Details:

- [Data sources and attribution](DATA_SOURCES.md)
- [Camping](CAMPING.md)
- [Estimated cell locations](CELL_LOCATIONS.md)
- [Park boundaries](PARK_BOUNDARIES.md)
- [Unified search](UNIFIED_SEARCH.md)
- [v0.1.1 release notes](RELEASE_v0.1.1.md)

## Verification

The prepared v0.1.1 candidate passed 108 automated tests, TypeScript checking, linting, formatting, a production build, a local Worker smoke test, dataset integrity checks, and a credential scan that suppresses matched values from its output.

The generated Worker configuration declares no D1/R2 binding and no runtime secret. A public multi-user deployment should add globally coordinated request limiting and verify hosting asset limits and cache behavior before scaling.

## Security and license

See [SECURITY.md](SECURITY.md) for private vulnerability reporting and the release checklist.

This repository currently has no software license. Public visibility alone does not grant permission to copy, modify, or redistribute the source. Third-party maps and datasets retain their own attribution and use terms.
