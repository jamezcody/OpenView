# OpenView

<p><img src="public/OpenView_logo.png" alt="OpenView logo" width="180" /></p>

OpenView is an interactive 3D Earth explorer for satellite, street, and topographic maps with parks, campsites, radio sites, estimated cell locations, FCC coverage, addresses, parcels, satellites, aircraft, and ships.

Version **0.2.2** adds 3.53 million FCC source records, accurate license and authorization labels, and complete local radio search. It packages the Node.js launcher and keeps national radio data outside the page server's watched assets. See the [v0.2.2 release notes](RELEASE_v0.2.2.md).

- **Radio sites:** FCC ULS and LMS identifiers remain distinct; sources without license information explain what is missing. Full-dataset search uses local SQLite, with bounded map pages and results. See [Radio licenses](RADIO_LICENSES.md).

- **Space:** separate satellites/payloads and rocket bodies, searchable catalog details, cached daily catalog refreshes, and background-worker orbit calculations.
- **Ships:** one local collector takes a 30-second AISStream sample at most every ten minutes. Points stay at reported coordinates between snapshots. A personal AISStream key is required for this provider; Digitraffic remains the no-key regional fallback. See [Ship snapshots](SHIPS.md).
- **OSM:** download a Geofabrik region or planet file, or import your own `.osm.pbf`; prepare it locally, enable a dataset, and choose feature categories. Buildings and smaller features appear as you zoom in. See [OSM data](OSM_DATA.md).

## Install on Windows

Download `OpenView-Setup-v0.2.2.exe` and `SHA256SUMS.txt` from the [v0.2.2 release](https://github.com/jamezcody/OpenView/releases/tag/v0.2.2).

The setup executable includes its own .NET runtime, runs per user without elevation, and verifies checksum-pinned Windows x64 runtime and data packages. Put both release archives beside setup for an offline install; when a sidecar is absent, setup downloads that exact asset. The installed app uses the system's Node.js runtime. A key is required only if you want AISStream ship coverage. Setup stores your own key in Windows Credential Manager for the current Windows user, never in the browser, logs, command line, release archives, or a plaintext settings file.

Requirements:

- 64-bit Windows 10 or 11
- Node.js 22.13 or newer
- Internet access for missing installation archives, online maps/search/live feeds, and optional OSM downloads/tools
- 40 GB of free disk space recommended for installation/upgrade; the expanded prepared data occupies about 15 GB and setup temporarily backs up an existing installation during replacement
- Optional OSM preparation needs additional disk space and RAM; start with a small region. Preparation downloads checksum-pinned Planetiler and a private Java 21 runtime on Windows. A planet-wide import is not included or benchmarked; see [OSM requirements](OSM_DATA.md).

The v0.2.2 installer is unsigned because this release does not yet have an Authenticode certificate. Verify its SHA-256 checksum before running it. Smart App Control may block the installer/controller; the direct browser shortcut does not remove that separate signing requirement.

1. Install Node.js 22.13 or newer, then download and verify setup.
2. Run setup, choose the installation folder and server port, and optionally select either desktop shortcut.
3. For AISStream coverage, follow the key setup below. Otherwise leave its replacement box unchecked.
4. Click **Install / repair**. Successful setup closes automatically; the launch option starts OpenView through system Node.js and opens the browser when ready.
5. Enable the layers you want; overlays start off.

### Launch an installed copy through Node.js

Version 0.2.2 includes `launch-local.mjs` in the installation. The Start menu and optional desktop launcher use the validated system Node.js runtime. The launcher checks the home page and installed favicon before opening your browser, and reuses an already running instance. It does not change Windows security settings or establish trust for the unsigned installer/controller.

You can also run it from PowerShell:

```powershell
$ovInstall = Join-Path $env:LOCALAPPDATA 'Programs\OpenView'
& node (Join-Path $ovInstall 'launch-local.mjs')
```

The launcher uses the saved port and Photon URL in `%LOCALAPPDATA%\OpenView\config\settings.json`, plus the existing Windows credential-vault and OSM storage. The default port is `8787`. Initial startup can take about two minutes. Restore its minimized console and press **Ctrl+C** to stop the server; closing the browser leaves it running. Stop the server before upgrading.

Run the installed `OpenView.exe --launch` to open the controller for Settings and AISStream key configuration where Windows permits it. Its Start/Stop controls manage servers started by that controller; stop a Node-launched server from its console. Running `OpenView.exe` without arguments opens setup. Existing owned Node launcher shortcuts are recognized during repair, upgrade, and uninstall. The previously published v0.2.0 archives remain unchanged.

### Set up the AISStream API key

1. Sign in to [AISStream Account](https://aisstream.io/account) and create your own API key. Keep it private; new keys are shown once.
2. In setup or the controller's **Settings**, check **Set AISStream key** and paste it into the masked **AISStream API key** field.
3. Click **Install / repair** during installation, or **Save configuration** in settings. An unchecked replacement box preserves a previously saved key.
4. Stop and start the OpenView server after changing the key. Enable **Ships** and **Live traffic updates** for automatic snapshots. The first sample can take about 30 seconds.

The key is required for AISStream, not for the rest of OpenView. Without it, ship coverage is limited to Digitraffic's regional feed. Snapshots are sampled reports, not a complete global fleet or continuously moving live positions. See [Ship configuration and limits](SHIPS.md) and [AISStream documentation](https://aisstream.io/documentation).

### Choose the server port

Enter **Server port** before clicking **Install / repair**. The default is `8787`; choosing `8080`, for example, hosts OpenView at `http://127.0.0.1:8080/`. OpenView remains accessible only on this computer.

Setup accepts whole numbers from `1` to `65535`, except ports blocked by web browsers. If the selected port is unavailable, the controller explains how to choose another.

To upgrade from an earlier release, stop OpenView and close its controller/launcher, run the downloaded v0.2.2 setup executable, keep the existing installation folder, choose a port, and click **Install / repair**. Existing settings without a port use `8787`; saved credentials are preserved unless their replacement boxes are checked. Your separate OSM library is retained.

To change the port later, open **Settings** in the OpenView controller, edit **Server port**, and click **Save configuration**. For a Node-launched server, press **Ctrl+C** in its console and relaunch it. For a server started by the controller, click **Stop**, then **Start** there. The server keeps its active port until it restarts.

The selected port and optional Photon URL are saved in `%LOCALAPPDATA%\OpenView\config\settings.json`.

### Desktop shortcuts and setup completion

Before installing, optionally select **Add OpenView launcher shortcut to the desktop** and/or **Add OpenView browser shortcut to the desktop**. Both are off by default. The launcher shortcut starts the server through system Node.js; the browser shortcut opens your saved port in the default browser and requires the server to be running. The executable stays in the installation folder—desktop links are not separate copies. Unrelated desktop links are preserved.

As of v0.1.4, **OpenView Browser** is a locally created `.url` shortcut, not a link to `OpenView.exe --browser`. Existing OpenView-owned browser links are migrated on upgrade, and saving a new server port updates the owned URL shortcut. Stop/start the server after changing ports. This does not disable Smart App Control or establish trust for the unsigned installer/controller; a separate block on those executables still requires a signing solution.

Setup closes automatically on success. If **Launch OpenView after installation** is selected, it starts the Node.js launcher before closing. Warnings are displayed for acknowledgment; installation failures or cancellation leave setup open.

The supplied artwork is stored unchanged at `public/OpenView_logo.png`. `installer/build-icon.ps1` produces the multi-resolution Windows/browser icon. GitHub README branding uses the same PNG. The project repository is now `jamezcody/OpenView`; do not reuse the old `openview-earth` repository name because that would break GitHub's redirects.

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

## Space objects

OpenView opens with the satellite map selected and all overlays off. The space layer uses the existing globe. **Views & overlays → Space object types** has separate switches for **Satellites / payloads** and **Rocket bodies** (off by default). Click a point or search result for catalog identity, launch/status/owner fields, orbital information, predicted coordinates, source times, and all supplied source fields. Debris and unclassified objects are excluded throughout. See [Space objects](SPACE_OBJECTS.md) for data scope, caching, and verification.

## Configuration and credentials

OpenView runs without configuration; AISStream ship coverage requires a personal key.

| Name                   |         Runtime requirement | Secret | Purpose                                                        |
| ---------------------- | --------------------------: | -----: | -------------------------------------------------------------- |
| `PHOTON_API_URL`       |                    Optional |     No | Override the default HTTPS Photon place-search endpoint        |
| `AISSTREAM_API_KEY`    | Required for AISStream only |    Yes | Local ship collector; Windows vault entry `OpenView/AISStream` |
| `FCC_USERNAME`         |       Never used by runtime |     No | Optional offline FCC acquisition account                       |
| `FCC_API_TOKEN`        |       Never used by runtime |    Yes | Optional offline FCC acquisition                               |
| `OPENCELLID_API_TOKEN` |       Never used by runtime |    Yes | Optional offline OpenCellID acquisition                        |

The portable FCC import and preparation tools are in [tools/radio-data](tools/radio-data/README.md). They accept preserved local source archives; the OpenCellID acquisition tools are not included. Viewing or reloading prepared data never uses those credentials. OpenView does not collect GitHub, Cloudflare, property-portal, or map-provider logins. See [CREDENTIALS.md](CREDENTIALS.md) for storage and rotation details.

## Data scope and size

Generated datasets are distributed as a release asset instead of hundreds of thousands of Git objects. The v0.2.2 data archive retains all six prepared datasets and expands radio/search to 3,565,261 radio records. The prepared data occupies about 14.6 GB; exact archive counts, sizes, and SHA-256 digests are in `release/release-manifest.json`. The installer and `npm run data:install` verify that pinned package. These are source records, often multiple frequencies or authorizations at one location, rather than a unique tower count.

The separate Windows x64 runtime package contains the prebuilt Worker/client output, local OSM/ship service, and a lockfile-derived, production-only Wrangler/WebSocket dependency tree. End users therefore do not compile OpenView or install npm packages during setup. Personal keys, ship snapshots, cached space catalogs, OSM downloads, and prepared OSM maps are not bundled. The OSM library defaults to `%LOCALAPPDATA%\OpenViewData\OSM` and is preserved across upgrades and uninstall.

## Reproduce release packages

Use Node.js 24.18.0 on 64-bit Windows. Runtime and data archives use sorted POSIX tar entries, normalized metadata, bounded file/byte counts, and deterministic gzip output. The data command sanitizes public provenance, scans for credentials, runs the data and application tests, and then packages the six prepared data roots.

For a post-publication clone, install the pinned data first. When producing a release before its download URL exists, skip `npm run data:install`; the prepared roots must already be present in the release workspace.

```powershell
npm ci
npm run data:install
npm run build
npm run runtime:build
npm run data:build
./installer/build.ps1
```

`release/release-manifest.json` is the authoritative archive name, URL, checksum, size, and safety-limit record. Generated archives and executables stay ignored under `artifacts/v0.2.2`.

Release archives and the installer are prepared and checked locally before publication. The **Reproduce release assets** workflow is deliberately post-publication: it installs the already-published pinned data, rebuilds both archives, requires their names, sizes, and SHA-256 digests to match the checked-in manifest, self-tests both sidecars, and uploads the complete reproducibility artifact. It cannot bootstrap the initial data release and never publishes a GitHub Release automatically.

The datasets have different dates, geographic coverage, accuracy, and reuse terms. Estimated cell coordinates are not a tower census, modeled FCC coverage is not measured service, and parcel/property coverage varies by jurisdiction.

Details:

- [Data sources and attribution](DATA_SOURCES.md)
- [Radio licenses and local FCC snapshot](RADIO_LICENSES.md)
- [Camping](CAMPING.md)
- [Estimated cell locations](CELL_LOCATIONS.md)
- [Park boundaries](PARK_BOUNDARIES.md)
- [Unified search](UNIFIED_SEARCH.md)
- [Space objects](SPACE_OBJECTS.md)
- [Ship snapshots and AISStream setup](SHIPS.md)
- [Local OpenStreetMap data](OSM_DATA.md)
- [v0.2.2 release notes](RELEASE_v0.2.2.md)
- [v0.2.0 release notes](RELEASE_v0.2.0.md)
- [v0.1.3 release notes](RELEASE_v0.1.3.md)
- [v0.1.4 release notes](RELEASE_v0.1.4.md)
- [v0.1.2 release notes](RELEASE_v0.1.2.md)
- [v0.1.1 release notes](RELEASE_v0.1.1.md)

## Verification

See the [v0.2.2 verification notes](RELEASE_v0.2.2.md#verification) for the current release checks and limits. Tests cover space classification/caching, ship sampling/cooldowns, local OSM safeguards, prepared data, and earlier map behavior. Production builds also verify that both browser workers reference same-origin deployed scripts.

See the [v0.1.2 verification notes](RELEASE_v0.1.2.md#verification) for the configurable-port checks and their scope.

The generated Worker configuration declares no D1/R2 binding and no runtime secret. A public multi-user deployment should add globally coordinated request limiting and verify hosting asset limits and cache behavior before scaling.

## Security and license

See [SECURITY.md](SECURITY.md) for private vulnerability reporting and the release checklist.

This repository currently has no software license. Public visibility alone does not grant permission to copy, modify, or redistribute the source. Third-party maps and datasets retain their own attribution and use terms.
