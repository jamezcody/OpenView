# OpenView

<p><img src="public/OpenView_logo.png" alt="OpenView logo" width="180" /></p>

OpenView is an interactive 3D Earth explorer for satellite, street, and topographic maps with parks, campsites, radio sites, estimated cell locations, FCC coverage, addresses, parcels, satellites, aircraft, and ships.

Version **0.2.0** adds richer space-object details and controls, AISStream ship snapshots, and optional local OpenStreetMap datasets. It preserves configurable ports, desktop shortcuts, automatic setup completion, and the earlier map fixes. See the [v0.2.0 release notes](RELEASE_v0.2.0.md).

- **Space:** separate satellites/payloads and rocket bodies, searchable catalog details, cached daily catalog refreshes, and background-worker orbit calculations.
- **Ships:** one local collector takes a 30-second AISStream sample at most every ten minutes. Points stay at reported coordinates between snapshots. A personal AISStream key is required for this provider; Digitraffic remains the no-key regional fallback. See [Ship snapshots](SHIPS.md).
- **OSM:** download a Geofabrik region or planet file, or import your own `.osm.pbf`; prepare it locally, enable a dataset, and choose feature categories. Buildings and smaller features appear as you zoom in. See [OSM data](OSM_DATA.md).

## Install on Windows

Download `OpenView-Setup-v0.2.0.exe` and `SHA256SUMS.txt` from the [v0.2.0 release](https://github.com/jamezcody/OpenView/releases/tag/v0.2.0).

The setup executable includes its own .NET runtime, runs per user without elevation, and verifies checksum-pinned Windows x64 runtime and data packages. Put both release archives beside setup for an offline install; when a sidecar is absent, setup downloads that exact asset. The installed app uses the system's Node.js runtime. A key is required only if you want AISStream ship coverage. Setup stores your own key in Windows Credential Manager for the current Windows user, never in the browser, logs, command line, release archives, or a plaintext settings file.

Requirements:

- 64-bit Windows 10 or 11
- Node.js 22.13 or newer
- Internet access for missing installation archives, online maps/search/live feeds, and optional OSM downloads/tools
- 5 GB of free disk space recommended (setup keeps a verified backup during upgrades)
- Optional OSM preparation needs additional disk space and RAM; start with a small region. Preparation downloads checksum-pinned Planetiler and a private Java 21 runtime on Windows. A planet-wide import is not included or benchmarked; see [OSM requirements](OSM_DATA.md).

The v0.2.0 installer is unsigned because this release does not yet have an Authenticode certificate. Verify its SHA-256 checksum before running it. Smart App Control may block the installer/controller; the direct browser shortcut does not remove that separate signing requirement.

1. Install Node.js 22.13 or newer, then download and verify setup.
2. Run setup, choose the installation folder and server port, and optionally select either desktop shortcut.
3. For AISStream coverage, follow the key setup below. Otherwise leave its replacement box unchecked.
4. Click **Install / repair**. Successful setup closes automatically; the launch option opens the controller.
5. In the controller, start OpenView and open the browser. Enable the layers you want; overlays start off.

### Launch an installed copy through Node.js

For an already installed OpenView v0.2.0, `installer/launch-local.mjs` starts the
local server through your system Node.js runtime and opens the default browser
after the home page and installed favicon checksum pass readiness checks. It
does not execute the unsigned OpenView controller or change Windows security
settings. Windows can still check Node.js and supporting runtime executables;
this does not establish trust for the unsigned installer.

From a checkout of this repository, run the following in PowerShell. Change
`$ovInstall` if you installed OpenView in a different folder:

```powershell
$ovInstall = Join-Path $env:LOCALAPPDATA 'Programs\OpenView'
Copy-Item -LiteralPath '.\installer\launch-local.mjs' -Destination $ovInstall
& node (Join-Path $ovInstall 'launch-local.mjs')
```

To update the desktop shortcut, run this separately after confirming that the
launcher works. It preserves the old shortcut in the installation folder and
refuses to replace a shortcut that points to another program:

```powershell
$ovNode = (Get-Command node.exe -CommandType Application -ErrorAction Stop).Source
$ovLink = Join-Path ([Environment]::GetFolderPath('Desktop')) 'OpenView.lnk'
$ovShell = New-Object -ComObject WScript.Shell
$ovShortcut = $ovShell.CreateShortcut($ovLink)
if (Test-Path -LiteralPath $ovLink) {
    $ovOriginal = Join-Path $ovInstall 'OpenView.exe'
    if ($ovShortcut.TargetPath -ne $ovOriginal) {
        throw 'The shortcut does not point to this installation; inspect it before replacing it.'
    }
    $ovBackup = Join-Path $ovInstall 'OpenView-original-shortcut.lnk'
    if (-not (Test-Path -LiteralPath $ovBackup)) {
        Copy-Item -LiteralPath $ovLink -Destination $ovBackup
    }
}
$ovShortcut.TargetPath = $ovNode
$ovShortcut.Arguments = '"' + (Join-Path $ovInstall 'launch-local.mjs') + '"'
$ovShortcut.WorkingDirectory = $ovInstall
$ovShortcut.IconLocation = (Join-Path $ovInstall 'OpenView.exe') + ',0'
$ovShortcut.Description = 'OpenView in your browser; Ctrl+C in its console stops the server.'
$ovShortcut.WindowStyle = 7
$ovShortcut.Save()
```

The launcher uses the saved port and Photon URL from
`%LOCALAPPDATA%\OpenView\config\settings.json`; the default port is `8787`.
Saved ship credentials and the existing OSM library continue to use the local
service's normal storage. Startup can take about a minute. Once ready, another
shortcut click opens the running instance. The server console starts minimized;
restore it and press **Ctrl+C** to stop OpenView before upgrading or switching
launchers. Closing the browser leaves the server running.

This launcher has no desktop Start/Stop/Settings window. Use the existing settings
file for port/Photon changes while the service is stopped; AISStream key setup
still uses the existing credential workflow. Setup repair or upgrade may replace
the shortcut with the controller shortcut, so repeat the steps above if needed.
The published v0.2.0 installer and archives do not include this companion launcher.

### Set up the AISStream API key

1. Sign in to [AISStream Account](https://aisstream.io/account) and create your own API key. Keep it private; new keys are shown once.
2. In setup or the controller's **Settings**, check **Set AISStream key** and paste it into the masked **AISStream API key** field.
3. Click **Install / repair** during installation, or **Save configuration** in settings. An unchecked replacement box preserves a previously saved key.
4. Stop and start the OpenView server after changing the key. Enable **Ships** and **Live traffic updates** for automatic snapshots. The first sample can take about 30 seconds.

The key is required for AISStream, not for the rest of OpenView. Without it, ship coverage is limited to Digitraffic's regional feed. Snapshots are sampled reports, not a complete global fleet or continuously moving live positions. See [Ship configuration and limits](SHIPS.md) and [AISStream documentation](https://aisstream.io/documentation).

### Choose the server port

Enter **Server port** before clicking **Install / repair**. The default is `8787`; choosing `8080`, for example, hosts OpenView at `http://127.0.0.1:8080/`. OpenView remains accessible only on this computer.

Setup accepts whole numbers from `1` to `65535`, except ports blocked by web browsers. If the selected port is unavailable, the controller explains how to choose another.

To upgrade from a v0.1.x release, close the OpenView controller, run the downloaded v0.2.0 setup executable, keep the existing installation folder, choose a port, and click **Install / repair**. Existing settings without a port use `8787`; saved credentials are preserved unless their replacement boxes are checked. Your separate OSM library is retained.

To change the port later, open **Settings** in the OpenView controller, edit **Server port**, and click **Save configuration**. Click **Stop**, then **Start** in the controller to apply it. Until the server restarts, **Open browser** continues to use its active port.

The selected port and optional Photon URL are saved in `%LOCALAPPDATA%\OpenView\config\settings.json`.

### Desktop shortcuts and setup completion

Before installing, optionally select **Add OpenView launcher shortcut to the desktop** and/or **Add OpenView browser shortcut to the desktop**. Both are off by default. The launcher shortcut starts the server/controller; the browser shortcut opens your saved port in the default browser and requires the server to be running. The executable stays in the installation folder—desktop links are not separate copies. Unrelated desktop links are preserved.

As of v0.1.4, **OpenView Browser** is a locally created `.url` shortcut, not a link to `OpenView.exe --browser`. Existing OpenView-owned browser links are migrated on upgrade, and saving a new server port updates the owned URL shortcut. Stop/start the server after changing ports. This does not disable Smart App Control or establish trust for the unsigned installer/server; a separate block on those executables still requires a signing solution.

Setup closes automatically on success. If **Launch OpenView after installation** is selected, it opens the controller before closing. Warnings are displayed for acknowledgment; installation failures or cancellation leave setup open.

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

The FCC and OpenCellID acquisition tools are not included in this source release. Viewing or reloading prepared data never uses those credentials. OpenView does not collect GitHub, Cloudflare, property-portal, or map-provider logins. See [CREDENTIALS.md](CREDENTIALS.md) for storage and rotation details.

## Data scope and size

Generated datasets are distributed as a release asset instead of tens of thousands of Git objects. The v0.2.0 data archive retains the six prepared datasets: 62,193 files, 1,877,583,643 uncompressed bytes, and 167,170,511 compressed bytes. Estimated cell locations make up most of the data. The package is checksum-pinned by both the installer and `npm run data:install`.

The separate Windows x64 runtime package contains the prebuilt Worker/client output, local OSM/ship service, and a lockfile-derived, production-only Wrangler/WebSocket dependency tree. End users therefore do not compile OpenView or install npm packages during setup. Personal keys, ship snapshots, cached space catalogs, OSM downloads, and prepared OSM maps are not bundled. The OSM library defaults to `%LOCALAPPDATA%\OpenViewData\OSM` and is preserved across upgrades and uninstall.

## Reproduce release packages

Use Node.js 24.18.0 on 64-bit Windows. Runtime and data archives use sorted POSIX tar entries, normalized metadata, bounded file/byte counts, and deterministic gzip output. The data command sanitizes public provenance, scans for credentials, runs the full test suite, and then packages the six prepared data roots.

For a post-publication clone, install the pinned data first. When producing a release before its download URL exists, skip `npm run data:install`; the prepared roots must already be present in the release workspace.

```powershell
npm ci
npm run data:install
npm run build
npm run runtime:build
npm run data:build
./installer/build.ps1
```

`release/release-manifest.json` is the authoritative archive name, URL, checksum, size, and safety-limit record. Generated archives and executables stay ignored under `artifacts/v0.2.0`.

Release archives and the installer are prepared and checked locally before publication. The **Reproduce release assets** workflow is deliberately post-publication: it installs the already-published pinned data, rebuilds both archives, requires their names, sizes, and SHA-256 digests to match the checked-in manifest, self-tests both sidecars, and uploads the complete reproducibility artifact. It cannot bootstrap the initial data release and never publishes a GitHub Release automatically.

The datasets have different dates, geographic coverage, accuracy, and reuse terms. Estimated cell coordinates are not a tower census, modeled FCC coverage is not measured service, and parcel/property coverage varies by jurisdiction.

Details:

- [Data sources and attribution](DATA_SOURCES.md)
- [Camping](CAMPING.md)
- [Estimated cell locations](CELL_LOCATIONS.md)
- [Park boundaries](PARK_BOUNDARIES.md)
- [Unified search](UNIFIED_SEARCH.md)
- [Space objects](SPACE_OBJECTS.md)
- [Ship snapshots and AISStream setup](SHIPS.md)
- [Local OpenStreetMap data](OSM_DATA.md)
- [v0.2.0 release notes](RELEASE_v0.2.0.md)
- [v0.1.3 release notes](RELEASE_v0.1.3.md)
- [v0.1.4 release notes](RELEASE_v0.1.4.md)
- [v0.1.2 release notes](RELEASE_v0.1.2.md)
- [v0.1.1 release notes](RELEASE_v0.1.1.md)

## Verification

See the [v0.2.0 verification notes](RELEASE_v0.2.0.md#verification) for the current release checks and limits. Tests cover space classification/caching, ship sampling/cooldowns, local OSM safeguards, prepared data, and earlier map behavior. Production builds also verify that both browser workers reference same-origin deployed scripts.

See the [v0.1.2 verification notes](RELEASE_v0.1.2.md#verification) for the configurable-port checks and their scope.

The generated Worker configuration declares no D1/R2 binding and no runtime secret. A public multi-user deployment should add globally coordinated request limiting and verify hosting asset limits and cache behavior before scaling.

## Security and license

See [SECURITY.md](SECURITY.md) for private vulnerability reporting and the release checklist.

This repository currently has no software license. Public visibility alone does not grant permission to copy, modify, or redistribute the source. Third-party maps and datasets retain their own attribution and use terms.
