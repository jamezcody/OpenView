# Optional local OpenStreetMap data

OpenView v0.2.0 includes optional local OSM downloads and imports alongside the space-object and ship improvements. Use the matching v0.2.0 installer and runtime/data archives. Personal OSM datasets and preparation tools are not included in the release assets.

## Use

Start the updated controller, or run `npm run dev` from this source folder. Open **Views & overlays → OpenStreetMap data**.

1. Choose an existing `.osm.pbf` file, or choose **Browse Geofabrik regions**, search by name or ISO code (for example, `Maryland` or `MD`), and select a result in the visible region list. Region names include their geographic hierarchy. A search with no matches disables the size check. The entire planet is available as a separate download-source choice.
2. For a download, check its size first. The panel shows the current compressed byte count, publication date, estimated preparation space, and available disk space. Downloads are explicit and can be paused and resumed.
3. Choose **Prepare map** after the file is registered or its download is verified. Preparation runs in a separate local process and continues when the browser tab is closed. Keep the controller running. Stopping the controller interrupts preparation; preparation restarts from the source on the next attempt. Downloads resume their byte ranges when the upstream representation is unchanged.
4. Enable **Show on map**, then **Go to area**. Search **Find OSM features** or expand the five groups to choose among 36 independent categories. Categories start off on each page load. Only one imported dataset is enabled at a time.
5. Click a visible OSM outline, line or marker to open its source information. Overlapping hits have a feature selector. Close the popup with its close button or Escape. Older prepared maps offer **Update map features & info**, which reuses the existing PBF. Maryland was updated and tested with this action.

File selection registers the original file in place; it does not upload it to a server or copy it into the application. Leave the source available until preparation completes. Removing a supplied dataset preserves that original. Removing a downloaded dataset explicitly deletes its managed download and prepared tiles after confirmation.

## Storage and preparation

The default library is `%LOCALAPPDATA%\OpenViewData\OSM`, separate from both the installed application and `%LOCALAPPDATA%\OpenView` settings. The storage setting selects the folder for newly added datasets. Existing datasets remain in their original folders. Updates and uninstall preserve the OSM library. Remove individual managed datasets through the data panel if they are no longer needed.

PBF is a compressed binary source format, not a display tile format. OpenView does not expand it into XML. It uses checksum-pinned Planetiler 0.10.2 with an OSM-only custom overlay profile. On Windows x64 the first preparation automatically downloads a checksum-verified private Temurin Java 21 runtime; it does not change PATH or install Java system-wide. These two downloads total about 136 MiB. Other operating systems require Java 21+ on PATH.

Node indexes and multipolygon geometry are stored in memory-mapped files. One conversion runs at a time with at most four threads, and its Java heap is limited relative to currently available RAM. The initial free-space check estimates eight times PBF size plus 1 GiB; actual requirements depend on the data. Available RAM below 1.5 GiB prevents starting. These controls do not guarantee that every machine can prepare the planet: a large SSD and sufficient RAM remain necessary. The original converter's errors are shown if a dataset cannot be processed. Partial output is never enabled.

The converter produces a versioned PMTiles overlay with roads/railways, water, land/boundaries, building footprints, place names, and smaller features such as amenities, shops, tourism and entrances. Profile version 2 exposes 36 categories and preserves source tag pairs plus the original OSM element type and ID at native zoom 14. Multiple classification tags remain available for independent filtering. Tagged points and lines such as natural features, barriers, transit stops and entrances are preserved alongside areas. The popup shows tags from the downloaded snapshot, with a link to the original OSM object. It reads the same prepared tile as the renderer, not a live remote lookup. Very large tag sets are shortened in the popup (64 KiB encoded input, up to 256 tags and 4,096 characters per value) and marked incomplete. Older maps and distant tiles show only their available attributes. The original PBF remains intact.

Supported categories cover common mapped physical features; they do not promise every possible OSM tag or relation interpretation. Route relations are not assembled into itineraries, indoor features are plan views without a floor selector, and geometry unavailable in the extract cannot be synthesized. This is not a routing engine, complete offline address search, or OSM database editor. Satellite imagery, terrain and other online OpenView sources remain independent.

## Rendering limits

- Only requested map tiles are read; the browser never reads the source PBF.
- The prepared tiles stop at native zoom 14. More detailed views render clipped portions of those source tiles.
- Buildings appear from equivalent zoom 16; small-feature overlays appear from zoom 17. Roads, water, land and geographic names have earlier thresholds. On Cesium's tilted globe, tile scale depends on ground distance and screen projection, not a fixed camera altitude.
- Click lookup reruns the same bounded painting/geometry rules, uses even/odd polygon holes and a small line/point hit tolerance, and returns up to eight overlapping features. Source strings are displayed as text; only validated OSM element IDs produce links. Stale clicks are discarded, and disabling or changing layers closes the popup.
- An independent worker fetches, decompresses, decodes and paints tiles. At most two tile jobs are in flight, and transferred image bitmaps are closed after use.
- The worker holds at most 32 MiB of decompressed tile bytes. Archive range reads are limited to 2 MiB; decompression output is limited to 4 MiB. Directory caches have separate byte/entry limits.
- Geometry is counted before allocating point objects. Each rendered tile is limited to 6,000 considered features and 75,000 vertices; oversized features are skipped. Icons and labels use a coarse collision grid and per-tile limits of eight symbols and six labels. Cesium manages display canvases/textures separately; the worker cache limit is not a total application or GPU memory guarantee.
- The panel reports when detail has been reduced in a dense area. Some complex features can remain omitted even when zoomed closer.

Imported OSM legend entries exist only while a prepared dataset and its corresponding layers are enabled. Existing online Streets, Photon search and bundled OSM-derived data keep their own attribution.

## Local service and validation

The Windows launcher starts `dist/local/server.mjs`, which hosts the selected localhost port and proxies existing application requests to the Worker on a private ephemeral port. `/local-osm/` is handled by the Node process. Mutations require a per-process proof plus same-origin checks; foreign origins, DNS-rebinding Host values, unrestricted downloads and unbounded archive responses are rejected. The service binds only to `127.0.0.1`. A library lock prevents simultaneous writers. A hosted Worker alone cannot import files from a user's disk; its panel explains that the local app is required.

Run `npm test`, `npm run typecheck`, `npm run lint`, and `npm run build`. The test suite covers zoom gates, cache eviction, geometry-allocation limits, large byte offsets, download resumes/restarts, checksums, interrupted-job recovery, supplied-file preservation, atomic conversion activation and local HTTP access/range checks. `node scripts/test-osm-import.mjs` explicitly downloads Monaco and the pinned tools into the ignored `work/osm-integration` directory to exercise the real converter.

The implementation was exercised with the official Monaco extract and a real generated tile containing roads, buildings, water, land, places and small features. Full-planet preparation has not been benchmarked on this machine, and no crash-free hardware claim is made.

The regional browser was additionally verified against all 555 entries in the live Geofabrik catalog. A browser-driven Maryland download completed with 214,076,363 bytes (204.2 MiB) and provider MD5 `6e80ca48b7afd8e4c43d03a00cd97a77`. Searching `MD` finds Maryland (and Moldova, whose country code is also MD); an unmatched search clears the selection and disables the size check. Representative international size requests encountered upstream HTTP 502 responses/timeouts during testing, so every regional download has not been individually verified.

The following figures describe earlier implementation checks. See [v0.2.0 verification](RELEASE_v0.2.0.md#verification) for current release validation. The installer is still unsigned; Windows Application Control can block execution on other machines, and this release does not change Windows security settings.

The renderer fixes passed 144 automated tests, type checking, lint, and the production build. Production builds now verify that both OSM and space workers use existing same-origin web assets; a `file://` worker address fails the build. OSM worker startup errors remain inside the layer controls instead of replacing the page with an error screen. Oversized tiles are omitted without stopping the renderer or lifting its memory limits. The prepared Maryland dataset was used for browser layer-activation and close-up map checks.

Sources: [OSM planet](https://planet.openstreetmap.org/pbf/), [Geofabrik technical information](https://download.geofabrik.de/technical.html), [Planetiler](https://github.com/onthegomap/planetiler), [Eclipse Temurin](https://adoptium.net/), [OSM attribution](https://www.openstreetmap.org/copyright).

Imported OSM layers start off on every page load, including when a prepared dataset was previously enabled. Choose the desired Imported OSM layers to display them; the saved library and prepared datasets remain available.

The feature controls and popup passed 148 automated tests, including independent category filtering, legacy-map matching, source-tag decoding, popup bounds, line/point hits and polygon holes. A real Monaco conversion retained source tags for 7,388 features in a sampled dense tile. The existing Maryland PBF was rebuilt into a 316,183,722-byte profile-v2 map; clicking the Maryland State House displayed OSM way 50319294 and its original tags.

Man-made features now use 40-pixel symbols: a purple eye for `man_made=surveillance` and a red hammer for other man-made features, with a dark contrast background. Icons and enlarged click targets also work across display-tile edges. Line and area features keep their outlines and receive a symbol at a point on their geometry. Existing prepared files work without conversion. The legend explains both symbols when this category is enabled. The symbol update passed 150 automated tests, type checking and lint.
