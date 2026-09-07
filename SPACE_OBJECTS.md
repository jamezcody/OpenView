# Space objects

OpenView v0.2.0 includes these space-object improvements. Previous release assets remain unchanged; use the matching v0.2.0 installer and runtime package.

## Use

OpenView starts with the satellite map selected and every overlay off, including space objects and orbit paths. Open **Views & overlays → Space object types** to enable a type. Each type has its own switch and loaded count. The Space objects overlay is the master visibility switch; it remembers type preferences but stays off on every new page load. Selecting a search result enables that object's type and locates it.

Click a point or its selected label to open the existing object panel. It shows identity, object type, catalog status, owner/country and launch-site codes, launch date, predicted altitude and coordinates, position time, orbital period, inclination, catalog perigee/apogee, element epoch and metadata retrieval time. **All catalog and orbital fields** expands every supplied scalar source field. Missing fields say “Not supplied.” Links lead to the specific source record and code definitions. Prediction is not a live observation.

The existing selected-orbit path and time slider remain available. Objects more than 14 days from their element epoch at the chosen simulation time are hidden. Loaded/enabled counts can therefore exceed the number of drawable points.

## Sources and exclusions

- Current orbital elements: <https://celestrak.org/pub/TLE/catalog.csv> (OMM field names, numeric catalog IDs).
- Classification and metadata: <https://celestrak.org/pub/satcat.csv>.
- Backup orbital elements: [SatNOGS DB](https://db.satnogs.org/api/tle/), distributed under [CC BY-SA](https://docs.satnogs.org/projects/satnogs-db/en/latest/api.html). Original TLE lines, upstream attribution and update time remain in the details panel. The view converts these to the same orbital fields used by the primary catalog.
- Formats: <https://celestrak.org/NORAD/documentation/gp-data-formats.php> and <https://celestrak.org/satcat/satcat-format.php>.
- Usage policy: <https://celestrak.org/usage-policy.php>.

Join by the full numeric NORAD catalog ID, including six-digit IDs. Only SATCAT `PAY` and `R/B` records on Earth orbit or docked to another cataloged object are eligible. Non-operational payloads remain payloads. Debris, unknown types, unmatched IDs, decayed objects, objects outside Earth orbit and malformed orbital elements are excluded. There is no debris toggle. Eligibility is checked again when restoring saved records, constructing search results, rendering and initializing the propagation worker. A missing classification catalog fails closed.

The two upstream bulk catalogs can contain debris records; those records are discarded before the OpenView response, browser storage, search and visualization. No debris dataset is shipped. Coverage is limited to public objects with usable orbital elements; it is not the entire population of objects in space.

## Refresh and storage

On opening the page, OpenView restores its successful catalog from IndexedDB for search. It requests fresh elements when space objects are enabled and data is missing or due, or through **Data updates → Update orbital data**. When the space overlay is enabled, a visible page checks again when the next refresh or retry deadline arrives; hidden tabs wait until visible. Browser error cooldowns also survive reloads.

Orbital data downloads, backup downloads and retries run at most once every 24 hours. Concurrent requests share one acquisition; both GP and SATCAT are retained for 24 hours. Existing two-hour cache schedules are extended to the daily cadence without downloading fresh data. The server saves metadata, snapshots and absolute retry deadlines in the Workers Cache API, persisted by the local Wrangler/Miniflare runtime in `.wrangler/state`. A lease is saved before upstream requests, so restarting during a download does not start another one. Non-200 responses stop source requests for at least 24 hours, respecting a longer `Retry-After`. Cached failures return the original deadline rather than extending it with each page request.

During a CelesTrak failure, OpenView can use the independent SatNOGS TLE feed, joined to saved SATCAT classifications no more than 14 days old. TLE checksums, full catalog IDs (including Alpha-5), epochs and numeric elements are validated. Backup coverage is smaller and explicitly labeled. A backup refresh retains previously saved objects whose elements remain usable, including rocket bodies absent from the backup. If both sources fail, saved objects remain available. Without saved classifications the backup fails closed; the app reports that no saved catalog is available instead of claiming it kept one.

Responses are bounded to 16 MiB per upstream file. No database service or credentials are required. Cache API persistence is local to this runtime/cache location; a future deployment across multiple instances needs shared scheduled acquisition before scaling upstream traffic.

Orbit calculations run in a module Web Worker. Batched samples every two seconds are interpolated as Earth-fixed Cartesian points by Cesium; SGP4 is not called for every point on every frame. Calculation pauses while the space overlay or browser tab is hidden. Stale samples are invalidated when changing simulation time or returning to the tab. Selection uses one label and does not rebuild the catalog.

## Verification

`npm run typecheck`, the app test suite, and `npm run build` validate the update. `tests/space.test.ts` covers classification joins, non-operational payloads, six-digit IDs, more than the former 150-object limit, CSV quoting, missing values, malformed elements, duplicate epochs, type filtering, debris exclusion in search, concurrent downloads, cache cadence and failure cooldowns.

The HTTP 406 acquisition bug is fixed: the bulk CSV downloader accepts `*/*`, because CelesTrak serves its CSV files as `application/octet-stream`. A header-only live check reproduced 406 with `Accept: text/csv` and returned 200 with `Accept: */*`. A regression test exercises both catalog downloads with the provider's binary MIME type and verifies the classified result. CSV structure and response-size validation still apply. This fix does not remove a separate provider rate limit; the persistent deadline and independent backup handle that condition.

During implementation on 7 September 2026, the retrieved SATCAT contained 19,861 eligible payload records and 2,295 rocket bodies. These are metadata counts, not a claim that all have usable current orbital elements. The current GP bulk download returned a temporary HTTP 403 rate limit, so fresh full-catalog orbital verification could not be completed. No further CelesTrak request was made during its cooldown. The already downloaded SATCAT and a public SatNOGS snapshot were validated and saved to this installation's local cache: 1,220 payloads and 6 rocket bodies, with no debris. These local cached records are not baked into the app or installer.

The production worker was separately exercised with a published Vallado reference orbit, a debris record, an out-of-range simulation time, and 20,000 synthetic test objects. It excluded debris and stale positions, matched the reference altitude range, and generated both samples for all 20,000 objects. This is a worker throughput check, not a browser frame-rate measurement.

The HTTP 403 recovery tests cover fixed deadlines across recreated server instances, longer provider retry hints, preservation of saved objects, backup classification and TLE checksum rejection. Converted backup elements agree with direct TLE propagation within 20 meters in the regression fixture. The local preview also revealed that the RSC transform replaced `import.meta.url` with a server `file:` URL; a Vite `?worker` import now supplies the browser worker URL in development and production.
`npm run typecheck`, `npm run lint`, all 118 tests and the release build passed after the recovery changes. The production worker generated valid positions for all 1,226 verified backup objects. The running page restored the 1,220 payload / 6 rocket-body counts and no longer reported the worker startup error.

The daily cadence also applies to manual refresh buttons and saved snapshots restored after a restart. Local two-second position calculations and smooth interpolation continue between daily downloads. Refreshes run only while the app is open; hidden tabs wait until visible.
