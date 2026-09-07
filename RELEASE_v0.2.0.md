# OpenView v0.2.0

This release brings the space-object, ship-tracking, and local OpenStreetMap updates into a matching Windows installer and runtime package. Earlier release assets are unchanged.

## What's new

- Space-object types have separate satellite/payload and rocket-body controls, searchable identities, detailed catalog/orbit fields, daily persistent caching, and background-worker orbit calculations. Debris and unclassified objects are excluded. Overlays start off.
- Ships support a shared local AISStream collector: a 30-second sample at most every ten minutes, fixed reported coordinates between snapshots, persistent cooldowns, timestamped stale reports, and bounded storage/display counts. Digitraffic remains the regional fallback.
- Optional OSM data supports Geofabrik/planet downloads and your own `.osm.pbf` files, local preparation, independent feature categories, close-up buildings and small features, source-tag popups, and man-made/surveillance symbols. Downloads and map preparation are explicit; personal datasets are never bundled.
- Setup accepts your own masked AISStream key and stores it in Windows Credential Manager. It explains the provider's key requirement and preserves unchecked existing credentials. Credential-boundary regression checks cover the installer and local Node service.
- The prebuilt runtime includes the local data/ship service and pinned WebSocket dependency. Production builds validate both browser-worker asset URLs. Version, release metadata, reproducibility workflow, README, and configuration/source documentation are updated for v0.2.0.

## Install or upgrade

Download `OpenView-Setup-v0.2.0.exe` and verify it against `SHA256SUMS.txt`. Use 64-bit Windows with Node.js 22.13 or newer. Put both v0.2.0 archives beside setup for an offline installation; missing archives are downloaded and checksum-verified. Close any existing OpenView controller before upgrading, keep your installation folder, and click **Install / repair**.

An AISStream API key is **required for AISStream ship coverage only**. Create a personal key at [AISStream Account](https://aisstream.io/account), check **Set AISStream key** in setup/settings, paste it into the masked field, and install/save. Restart the server after changing the key, then enable **Ships** and **Live traffic updates**. OpenView and the Digitraffic regional fallback still work without a key. No personal key is shipped in the release.

The configurable port, direct `.url` browser shortcut, optional desktop launcher, setup auto-close, and previous map fixes are retained. Your OSM library is outside the installation and preserved. See the [README](https://github.com/jamezcody/OpenView/blob/v0.2.0/README.md) for installation steps and requirements.

## Data and limitations

The six prepared datasets are unchanged: 62,193 files, 1,877,583,643 bytes unpacked, 167,170,511 bytes compressed. Optional OSM files/tools require additional storage and preparation time; start with a small region. Full-planet conversion has not been benchmarked. Dense OSM detail may be omitted under documented memory/geometry limits.

AISStream snapshots sample available receiver reports, not a complete global fleet. Space positions are orbital predictions, not observations; upstream availability and catalog age affect coverage. Internet access is needed for online maps, search, feeds, and optional downloads.

## Verification

Validated on 7 September 2026 with Node.js 24.18.0 and .NET SDK 9.0.312:

- All **158 automated tests** passed (140 application/data/ship tests and 18 local OSM tests), plus TypeScript, lint, formatting, and production compilation.
- Both browser workers passed same-origin built-asset validation. Source and generated-output credential audits passed without publishing matched values.
- The Windows runtime was rebuilt with production-only locked dependencies; the installer build verified both archive checksums and passed its executable self-test, including credential boundaries, ports, branding, and owned desktop shortcuts.
- A complete installation into a new temporary acceptance directory passed archive extraction, layout validation, activation, and cleanup. This test deliberately skipped personal settings, credentials, desktop links, and Windows app registration.
- An isolated production localhost check passed the home page, exact icon checksum, both worker script responses, all six dataset pointers, both checksum-verified park archives, local OSM status, concurrent cached ship snapshots, and foreign-origin rejection. The local Worker returned full HTTP 200 park archives, which the existing bounded, checksum-verified client fallback supports.

No personal key or existing OSM library was used for release testing. Ship HTTP checks used synthetic cached reports; live AISStream/CelesTrak queries and a new full OSM conversion were not repeated. The earlier feature-specific integration observations in `SPACE_OBJECTS.md`, `SHIPS.md`, and `OSM_DATA.md` are not claims of a fresh live-feed test. Interactive setup entry and the actual user's credential-vault write were not automated in this release check.

The installer is unsigned. Successful local testing does not establish Authenticode trust or guarantee Smart App Control acceptance on another computer. Windows security settings are not changed, and a browser shortcut does not make the installer/controller trusted.
