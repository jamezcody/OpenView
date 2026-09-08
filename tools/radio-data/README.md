# Radio data rebuild tools

This bundle contains the headless import, merge, preparation, audit and local SQLite search code used for OpenView's September 2026 FCC update. It regenerates the data from **preserved, pinned inputs**. It does not download data or reproduce historical source snapshots from today's live URLs.

The [0.2.2 provenance manifest](provenance-0.2.2.json) records public archive URLs, hashes, byte counts, timestamp availability, source selection and published dataset versions. No raw archives, normalized databases, credentials or machine-specific input paths are included. The original microwave archive's exact acquisition time was not recorded; its preserved bytes were fully revalidated.

## Requirements and offline tests

Use Python 3.12 or newer with SQLite FTS5 and its trigram tokenizer. The tested environment uses Python 3.12.10. The three dependencies below are the existing builder dependencies; GUI and executable-packaging dependencies are omitted. `prepare_radio.py`, merging and auditing use only the standard library. Search also uses the standard library and requires FTS5.

From the repository root, using a Python virtual environment:

```sh
python -m pip install -r tools/radio-data/requirements.txt
python tools/radio-data/run_tests.py
```

The offline fixtures cover FCC field positions, current-version joins, identifier semantics, inactive filtering, complete ZIP verification, additive merging, bounded map pages, sanitization and complete SQLite search identities. A fixture performs the real LMS import with network acquisition explicitly forbidden.

## Required preserved inputs

Prepare an ignored working directory such as `work/radio-rebuild` with:

- `archives/`: all ten exact ZIP files named by `inputs[].archive` in the provenance manifest. Names are local basenames, so the preserved microwave file must be named `l_micro.zip`. Renaming a file does not change its checksum.
- `baseline/runs/20260906-112059-4718b2/dataset.sqlite` and `report.json`: the original completed normalized baseline, containing 30,297 transmitters, 292 candidates and 6,190 receivers. Both original hashes are pinned in the provenance manifest. This baseline is a required input, not part of the source bundle. Fresh imports of mutable source feeds may produce different records.
- `baseline/latest.json`: a portable pointer containing `{"run_directory":"runs/20260906-112059-4718b2","status":"complete"}`. This replaces any copied machine-specific pointer; preserve the original report and database bytes.
- `prepared/parks/latest.json`, `prepared/search/latest.json` and the corresponding `prepared/search/<search-version>/parks.json`: the existing park navigation snapshot. Its park release and the park search file hash must match the provenance manifest. The full existing `parks/` and `search/` directories can be copied from prepared release assets; search rebuilding reads only these three park inputs, not the old radio SQLite database.

Verify the baseline database and original report SHA-256 against `baseline.database_sha256` and `baseline.original_report_sha256` before merging. Builder reports are operator inputs and can contain historical local paths; preparation sanitizes public output. Do not publish the original reports wholesale.

For a different intended FCC snapshot, supply a separate manifest with `schemaVersion: 1` and an `inputs` array. Each input requires `source` (`us_uls` or `us_lms`), a ZIP basename `archive`, `canonical_url`, `size_bytes` and `sha256`. Optional public provenance fields are `resolved_url`, `retrieved_at_utc`, `last_modified` and `reused_existing_file`. Compute trusted hashes from the intended preserved inputs. The importer accepts all nine configured ULS archives together or exactly one LMS archive, and repeats size, SHA-256 and every ZIP member's CRC verification before importing. It makes no network requests.

## Import, merge and audit

The following commands use the pinned 0.2.2 manifest by default. Set `--manifest` explicitly to rebuild another intended snapshot. Each import writes a separate builder output and selects `active_only=True`; the baseline retains its original all-status selection.

```sh
python tools/radio-data/import_fcc_verified.py --archives work/radio-rebuild/archives --source us_lms --output work/radio-rebuild/lms
python tools/radio-data/import_fcc_verified.py --archives work/radio-rebuild/archives --source us_uls --output work/radio-rebuild/uls
python tools/radio-data/merge_radio_runs.py --builder tools/radio-data/builder --baseline work/radio-rebuild/baseline --addition work/radio-rebuild/lms --output work/radio-rebuild/base-lms
python tools/radio-data/merge_radio_runs.py --builder tools/radio-data/builder --baseline work/radio-rebuild/base-lms --addition work/radio-rebuild/uls --output work/radio-rebuild/combined
python tools/radio-data/audit_licenses.py --input work/radio-rebuild/combined --output work/radio-rebuild/license-audit.json
```

Merging rejects overlapping sources and count/schema mismatches. It preserves original rows and source identities; it does not infer licensing by geographic proximity. The pinned inputs produce 3,551,353 transmitters, 7,718 candidates and 6,190 receivers, or 3,565,261 source records. Records can describe different antennas, frequencies or authorizations at the same site and are not counts of unique towers.

ULS `license_id` retains the FCC unique system ID; call sign is separate. LMS `license_id` retains the filing number, which is an application identifier rather than a license number. Typed metadata lives in `details_json.licensing`. Unknown and qualifying uncertain records remain candidates. Missing identifiers remain missing. [Radio licenses and authorizations](../../RADIO_LICENSES.md) explains the displayed fields and coverage limits.

## Prepare the map and complete local search

```sh
python tools/radio-data/prepare_radio.py prepare --builder tools/radio-data/builder --builder-output work/radio-rebuild/combined --output work/radio-rebuild/prepared/radio
```

Read the new `radio-...` version from that command's output, then use it in both commands below. Activation verifies every page and changes only the staging `latest.json` pointer.

```sh
python tools/radio-data/prepare_radio.py verify --version-directory work/radio-rebuild/prepared/radio/versions/RADIO_VERSION
python tools/radio-data/prepare_radio.py activate --output work/radio-rebuild/prepared/radio --version RADIO_VERSION
python tools/radio-data/audit_licenses.py --input work/radio-rebuild/prepared/radio --output work/radio-rebuild/prepared-license-audit.json
python tools/radio-data/prepare_search.py --public work/radio-rebuild/prepared --output work/radio-rebuild/search-candidate
```

Search verifies the new map snapshot, streams all radio records into SQLite with current node locators, and reuses the checksum-verified park navigation file. This bundle deliberately excludes the older workflow that regenerated park geometry. SQLite FTS uses disk temporary storage and a 32 MiB page cache; there is no 100,000-row browser index cap in this workflow. The published 0.2.2 radio search database is about 6.1 GB, and the national map produces many files. Allow substantial additional disk space for raw inputs, intermediate databases, staging and build output.

The search command writes a candidate `search-.../` directory and an integrity report without activating it. After reviewing successful counts and audits, copy that version directory into staging `prepared/search/` and copy its `manifest.json` to staging `prepared/search/latest.json`. Keep the version directory name unchanged. The search manifest's `radioVersion` must match staging `radio/latest.json`.

For an application build, install the reviewed staged `radio/` and `search/` directories into the repository's ignored `public/` data tree alongside the matching park assets. The standard build moves radio and search into `dist/prepared/`, outside Wrangler's static asset directory. The local runtime serves bounded map pages and search results; it never serves raw SQLite files. See [Unified search](../../UNIFIED_SEARCH.md) for runtime limits and behavior outside the local service.

## Reproduction limits and maintenance

This is a reproducible transformation workflow for supplied inputs, not a promise of byte-identical new output. Run IDs, timestamps, builder source hashes and reports participate in content versioning; porting this script also changes its builder hash. New runs therefore receive new radio/search versions even when source records agree. Compare preserved identities, source/category counts and audit results, and retain the original prepared artifacts when exact published bytes are required.

The `builder/` directory includes three extension modules because the original adapter registry imports them unconditionally, and `sources.json` is needed to preserve source coverage metadata. The documented entry point imports only the selected FCC system from verified local archives. Other source adapters, GUI code, acquisition helpers and local installation patch scripts are outside this rebuild workflow. Upstream data reuse terms remain those of each publisher; see [Data sources](../../DATA_SOURCES.md).
