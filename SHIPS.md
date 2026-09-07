# Ship snapshots

OpenView v0.2.0 supports AISStream ship positions alongside the existing Digitraffic regional feed. The local Node server owns one collector shared by all browser tabs. Enable **Ships**, then **Live traffic updates** for automatic collection.

Every collection starts a 30-second, compressed AISStream WebSocket window. The socket closes at the window deadline. Only the completed snapshot is published; individual incoming messages never move markers. The next window may start no sooner than ten minutes after the previous window started, including after a failure. Manual refreshes and other browser tabs read the shared snapshot during this cooldown. Collection runs on demand while Ships is used, and stops when the local server stops; it does not keep running in the background with no viewers. The browser pauses polling when hidden and schedules the next request from the server's next-update time.

Ships use constant Cesium positions. Speed, course, route information and the space-layer time slider do not extrapolate ship coordinates. A new snapshot replaces positions in one React state update. Aircraft retain their existing motion estimates and 15-second refresh cycle.

## Configuration

An API key is required for AISStream coverage. Create your own at [AISStream Account](https://aisstream.io/account). In the installer/controller's credentials section, check **Set AISStream key**, paste it into the masked field, and click **Install / repair** or **Save configuration**. It is stored as the current user's `OpenView/AISStream` Generic Credential in Windows Credential Manager. Unchecked replacement boxes preserve existing keys. Restart the server after changing it. Source users can also run the following and enter the key at the masked prompt:

```powershell
powershell.exe -NoProfile -File scripts/local/ais-credential.ps1 -Action Save
```

The local server reads that credential through a private child-process pipe. Advanced non-Windows/source setups can supply `AISSTREAM_API_KEY` in the Node server environment. The server removes that variable before starting Vite/Wrangler. No key is sent to the Worker or browser, written to snapshot files, or included in release archives. The `.dev.vars.example` remains unchanged because this key is not a Worker binding.

Set `AISSTREAM_ENABLED=false` in the local server environment to use only Digitraffic. Without a key, OpenView also falls back to Digitraffic with an explicit coverage notice. The optional key is personal configuration, never a shared key shipped to users.

## Coverage and limitations

- The collection samples available AISStream receiver coverage worldwide for 30 seconds. It does not promise a complete global snapshot or satellite coverage. A vessel that does not report during that window may be missing or retain an earlier position. AISStream does not replay missed events.
- Class A, standard/extended Class B position reports and vessel static data are handled. Static updates cannot advance a position timestamp. The receiver time in `MetaData.time_utc` is used where present; when missing, the UI labels collector receipt time. AIS seconds-within-minute are never treated as Unix time.
- Vessel records are deduplicated by MMSI, with the newer position winning across providers. The coordinate report's provider and timestamp remain on each vessel. Voyage destination is informational only.
- Earlier positions remain fixed when a new report is unavailable. Markers dim after ten minutes. Reports older than 24 hours are removed when the next snapshot is built.
- Collection stores at most 50,000 positions and displays the 5,000 most recently observed vessels. Overflow is explicitly reported. This first version uses a shared worldwide sampling window, not per-view subscriptions. This keeps map pans and additional users from causing extra provider queries.
- A bounded cache is stored in `ships-snapshot.json` under the local data-service directory (the directory selected by `OPENVIEW_OSM_HOME`, otherwise the existing OpenView OSM data directory). It includes the cooldown to avoid extra connections after restart; no credentials are stored there. The cache is outside packaged assets. Memory is used if persistence is unavailable.
- Provider errors retain earlier reports and wait for the next ten-minute cycle. There is no rapid retry loop. Missing data, fallback and truncation are disclosed in the Ships source panel.

## Packaging and verification

`ws` is pinned in both the development application and Windows runtime packages. `npm run build` copies the collector and credential helper into `dist/local`. v0.2.0 includes the matching collector/runtime and installer. Do not distribute a new installer with an older runtime archive.

Tests cover Class A/B parsing, sentinels, source/receipt timestamps, stale observations, duplicates, atomic snapshot publication, concurrent viewers, cooldown persistence, failure retention, and fixed ship coordinates across arbitrary clock changes. Run the existing test, typecheck, lint, build and credential-audit commands before packaging.

During implementation on 7 September 2026, an authenticated 30-second AISStream window received 4,541 vessels; repeated cache reads preserved every position. A production localhost check served those reports, shared concurrent snapshots, preserved the cooldown and rejected cross-origin requests without opening another provider connection. These were implementation checks, not a guarantee of current upstream coverage.

See [v0.2.0 verification](RELEASE_v0.2.0.md#verification) for release-specific checks. The standard `installer/build.ps1` requires executable self-tests and matching archive checksums before promoting a build. Windows security settings are not changed. The installer remains unsigned and may be blocked on other machines; the `.url` browser shortcut does not establish trust for the controller or credential helper.

Sources: [AISStream documentation](https://aisstream.io/documentation), [Digitraffic AIS](https://www.digitraffic.fi/en/marine-traffic/).
