'use client';
/* oxlint-disable react/react-compiler -- The React Compiler transform is not installed; search request refs and reset effects intentionally coordinate async UI state. */
/* oxlint-disable jsx-a11y/prefer-tag-over-role, jsx-a11y/no-noninteractive-element-to-interactive-role -- This follows the ARIA combobox/listbox pattern so keyboard focus can remain on the search input while its active result is announced. */
import { useEffect, useMemo, useRef, useState, useDeferredValue } from 'react';
import { Search, X, ArrowUpRight, RefreshCw } from 'lucide-react';
import {
  coordinateResult,
  coverageSearchItems,
  indexSearch,
  searchMatches,
  SEARCH_LABELS,
  type IndexedResult,
  type SearchResult,
} from '@/lib/search-model';
import { coverageManifest } from '@/lib/coverage-model';
import {
  loadSearchFile,
  parseSearchManifest,
  searchJson,
} from '@/lib/search-data';
import { ageLabel } from '@/lib/model';
import { CampingData, campRequest } from '@/lib/camping-data';
export type SearchFeed = {
  id: string;
  name: string;
  detail: string;
  count: number;
  loaded: boolean;
  busy: boolean;
  error?: string;
  disabled: boolean;
  refresh: () => void;
};
export function UnifiedSearch({
  items,
  onSelect,
  feeds,
}: {
  items: SearchResult[];
  onSelect: (r: SearchResult) => void;
  feeds: SearchFeed[];
}) {
  const [query, setQuery] = useState(''),
    [open, setOpen] = useState(false),
    [active, setActive] = useState(-1),
    [limit, setLimit] = useState(60);
  const campingData = useRef<CampingData | null>(null);
  if (!campingData.current) campingData.current = new CampingData();
  const [camping, setCamping] = useState({
    query: '',
    items: [] as SearchResult[],
    total: 0,
    error: '',
    loading: false,
  });
  useEffect(() => {
    const controller = new AbortController();
    if (!open || query.trim().length < 2) {
      setCamping({ query, items: [], total: 0, error: '', loading: false });
      return;
    }
    setCamping({ query, items: [], total: 0, error: '', loading: true });
    const timer = setTimeout(() => {
      void campingData
        .current!.search(query, campRequest(controller.signal))
        .then((result) => {
          if (!controller.signal.aborted)
            setCamping({ query, ...result, error: '', loading: false });
        })
        .catch((e) => {
          if (!controller.signal.aborted)
            setCamping({
              query,
              items: [],
              total: 0,
              error: e.message,
              loading: false,
            });
        });
    }, 350);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, open]);
  useEffect(() => () => campingData.current?.clear(), []);
  const [coverageIndex, setCoverageIndex] = useState<IndexedResult[]>([]),
    [coverageError, setCoverageError] = useState('');
  const [prepared, setPrepared] = useState<
      Partial<Record<'radio' | 'parks', IndexedResult[]>>
    >({}),
    [indexState, setIndexState] = useState({
      loading: false,
      errors: [] as string[],
    }),
    [revision, setRevision] = useState(0),
    [started, setStarted] = useState(false);
  const [online, setOnline] = useState<{
    query: string;
    items: SearchResult[];
    error: string;
    loading: boolean;
  }>({ query: '', items: [], error: '', loading: false });
  const request = useRef<AbortController | null>(null),
    generation = useRef(0),
    container = useRef<HTMLDivElement>(null),
    input = useRef<HTMLInputElement>(null);
  const deferred = useDeferredValue(query),
    currentIndex = useMemo(() => indexSearch(items), [items]);
  useEffect(() => {
    if (open) setStarted(true);
  }, [open]);
  useEffect(() => {
    if (!started) return;
    const controller = new AbortController();
    setCoverageError('');
    void searchJson('/coverage/latest.json', controller.signal, 1024 * 1024)
      .then((raw) => {
        const index = indexSearch(coverageSearchItems(coverageManifest(raw)));
        if (!controller.signal.aborted) setCoverageIndex(index);
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setCoverageError(
            'Cell coverage catalog is unavailable in search. Other results remain available.',
          );
      });
    return () => controller.abort();
  }, [started, revision]);
  useEffect(() => {
    if (!started) return;
    const controller = new AbortController();
    setIndexState({ loading: true, errors: [] });
    void (async () => {
      const m = parseSearchManifest(
        await searchJson(
          `/search/latest.json?reload=${revision}`,
          controller.signal,
          65536,
        ),
      );
      const results = await Promise.allSettled(
        m.files.map(async (f) => {
          const index = await loadSearchFile(m, f, controller.signal);
          if (!controller.signal.aborted)
            setPrepared((p) => ({ ...p, [f.kind]: index }));
        }),
      );
      if (!controller.signal.aborted)
        setIndexState({
          loading: false,
          errors: results.flatMap((r, i) =>
            r.status === 'rejected'
              ? [
                  `${m.files[i].kind === 'radio' ? 'Radio' : 'Park'} search: ${r.reason instanceof Error ? r.reason.message : 'unavailable'}`,
                ]
              : [],
          ),
        });
    })().catch((e) => {
      if (!controller.signal.aborted)
        setIndexState({
          loading: false,
          errors: [
            e instanceof Error ? e.message : 'Prepared search is unavailable.',
          ],
        });
    });
    return () => controller.abort();
  }, [started, revision]);
  useEffect(() => () => request.current?.abort(), []);
  useEffect(() => {
    const outside = (e: PointerEvent) => {
      if (!container.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, []);
  const matches = useMemo(
    () =>
      searchMatches(
        [
          currentIndex,
          prepared.radio || [],
          prepared.parks || [],
          coverageIndex,
        ],
        deferred,
        limit,
      ),
    [currentIndex, prepared, coverageIndex, deferred, limit],
  );
  const coordinate = useMemo(() => coordinateResult(query), [query]);
  const results = useMemo(() => {
    const candidates = [
        ...(coordinate ? [coordinate] : []),
        ...(online.query === query ? online.items : []),
        ...(camping.query === query ? camping.items : []),
        ...(query === deferred ? matches.items : []),
      ],
      seen = new Set<string>();
    return candidates.filter((r) => !seen.has(r.id) && !!seen.add(r.id));
  }, [coordinate, online, camping, query, matches, deferred]);
  useEffect(() => setActive(-1), [results]);
  function change(value: string) {
    request.current?.abort();
    generation.current++;
    setOnline({ query: '', items: [], error: '', loading: false });
    setQuery(value);
    setOpen(true);
    setActive(-1);
    setLimit(60);
  }
  function choose(result: SearchResult) {
    request.current?.abort();
    generation.current++;
    setOnline((s) => ({ ...s, loading: false }));
    setOpen(false);
    setActive(-1);
    onSelect(result);
  }
  async function submit() {
    setOpen(true);
    if (coordinate) {
      choose(coordinate);
      return;
    }
    if (query.trim().length < 3) {
      setOnline({
        query,
        items: [],
        error:
          'Use at least 3 characters for online place/address lookup. Local IDs can be shorter.',
        loading: false,
      });
      return;
    }
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    const token = ++generation.current,
      submitted = query;
    setOnline({ query: submitted, items: [], error: '', loading: true });
    try {
      const raw = await searchJson(
        `/api/search?q=${encodeURIComponent(submitted.trim())}`,
        controller.signal,
        1024 * 1024,
      );
      if (!Array.isArray(raw.items) || raw.items.length > 50)
        throw new Error(raw.error || 'Invalid place search response.');
      if (token === generation.current)
        setOnline({
          query: submitted,
          items: raw.items,
          error: raw.items.length
            ? ''
            : 'No published places or addresses matched. Try including a city or country.',
          loading: false,
        });
    } catch (e) {
      if (!controller.signal.aborted && token === generation.current)
        setOnline({
          query: submitted,
          items: [],
          error:
            e instanceof Error ? e.message : 'Place search is unavailable.',
          loading: false,
        });
    }
  }
  return (
    <div className="search-wrap unified-search" ref={container}>
      <form
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Search size={17} />
        <input
          ref={input}
          type="search"
          aria-label="Search everything"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls={open ? 'unified-search-results' : undefined}
          aria-activedescendant={
            open && active >= 0 && results[active]
              ? `search-option-${active}`
              : undefined
          }
          placeholder="Search places, addresses, objects…"
          value={query}
          maxLength={180}
          onChange={(e) => change(e.target.value)}
          onFocus={() => setOpen(true)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && open && active >= 0 && results[active]) {
              e.preventDefault();
              choose(results[active]);
              return;
            }
            if (e.key === 'Escape') {
              setOpen(false);
              setActive(-1);
            }
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault();
              setOpen(true);
              const next = results.length
                ? Math.max(
                    0,
                    Math.min(
                      results.length - 1,
                      active + (e.key === 'ArrowDown' ? 1 : -1),
                    ),
                  )
                : -1;
              setActive(next);
              document
                .getElementById(`search-option-${next}`)
                ?.scrollIntoView({ block: 'nearest' });
            }
          }}
        />
        {query && (
          <button
            type="button"
            className="clear-search"
            aria-label="Clear search"
            onClick={() => {
              change('');
              input.current?.focus();
            }}
          >
            <X size={15} />
          </button>
        )}
        <button
          className="submit-search"
          type="submit"
          aria-label="Search places and addresses"
          disabled={online.loading}
        >
          {online.loading ? (
            <RefreshCw size={16} className="spinning" />
          ) : (
            <ArrowUpRight size={18} />
          )}
        </button>
      </form>
      {open && (
        <section
          className="unified-results"
          aria-label="Search results and sources"
        >
          <header>
            <span>SEARCH EVERYTHING</span>
            <button aria-label="Close search" onClick={() => setOpen(false)}>
              <X size={17} />
            </button>
          </header>
          <p className="search-help">
            Type to search map records. Press Enter or ↗ for online places and
            addresses. Selecting a result turns on its layer.
          </p>
          <p className="search-summary">
            <output>
              {indexState.loading
                ? 'Loading prepared radio and park search…'
                : `${(prepared.radio?.length || 0).toLocaleString()} radio records · ${(prepared.parks?.length || 0).toLocaleString()} parks`}
              {query && ` · ${matches.total.toLocaleString()} local matches`}
              {online.loading ? ' · Searching places…' : ''}
            </output>
          </p>
          {!!indexState.errors.length && (
            <div className="search-errors">
              {indexState.errors.map((e) => (
                <p key={e}>
                  <output>{e}</output>
                </p>
              ))}
              <button onClick={() => setRevision((n) => n + 1)}>
                Retry prepared search
              </button>
            </div>
          )}
          {query.length >= 2 && (
            <p className={camping.error ? 'search-errors' : 'search-summary'}>
              <output>
                {camping.loading
                  ? 'Searching camping inventory…'
                  : camping.error ||
                    `${camping.total.toLocaleString()} camping matches${camping.total > camping.items.length ? ` · showing ${camping.items.length} within the loading limit; add a name or state to narrow results` : ''}`}
              </output>
            </p>
          )}
          {online.query === query && online.error && (
            <p className="search-errors">
              <output>
                {online.error} Loaded map records remain searchable.
              </output>
            </p>
          )}
          <ul
            id="unified-search-results"
            role="listbox"
            aria-label="Matching map locations"
          >
            {results.map((r, i) => (
              <li
                key={r.id}
                id={`search-option-${i}`}
                role="option"
                aria-selected={i === active}
                onPointerMove={() => setActive(i)}
              >
                <button onClick={() => choose(r)} tabIndex={-1}>
                  <span className={`search-kind kind-${r.kind}`}>
                    {SEARCH_LABELS[r.kind]}
                  </span>
                  <strong>{r.name}</strong>
                  <span className="search-result-detail">{r.detail}</span>
                  <small>
                    {r.source}
                    {r.observedAt
                      ? ` · report/data ${ageLabel(r.observedAt, Date.now())}`
                      : ''}
                  </small>
                  {(r.target.type === 'radio' || r.target.type === 'park') && (
                    <small>
                      {r.lat?.toFixed(4)}, {r.lon?.toFixed(4)} ·{' '}
                      {r.target.type === 'radio'
                        ? r.terms.split(' | ')[0]
                        : r.target.parkId}
                    </small>
                  )}
                  <ArrowUpRight size={15} />
                </button>
              </li>
            ))}
          </ul>
          {query &&
            !results.length &&
            !indexState.loading &&
            !camping.loading &&
            !online.loading && (
              <p className="search-help">
                No loaded records match. Try a name, callsign, registration,
                NORAD/MMSI ID, street address, or coordinates.
              </p>
            )}
          {matches.total > matches.items.length && limit < 500 && (
            <button
              className="search-more"
              onClick={() => setLimit((n) => Math.min(500, n + 60))}
            >
              Show more map results ({matches.total.toLocaleString()} matches)
            </button>
          )}
          {matches.total > 500 && limit === 500 && (
            <p className="search-help">
              Showing the first 500 map matches. Add a city, country, frequency,
              or ID to narrow the search.
            </p>
          )}
          <details className="search-sources">
            <summary>Search coverage & report updates</summary>
            {coverageError && <p className="search-errors">{coverageError}</p>}
            <button
              disabled={indexState.loading}
              onClick={() => setRevision((n) => n + 1)}
            >
              Refresh search catalogs
            </button>
            <p>
              Radio, park and camping catalogs are searched with their layers
              off. Camping searches name, state code, type, source and
              explicitly reported parent name using word prefixes, or a full
              source ID. Unmapped records open details without moving the map.
              Addresses and individual parcels include the last loaded map area.
              Online lookup searches published OpenStreetMap places and
              addresses; it is not every mailable address.
            </p>
            {feeds.map((f) => (
              <div key={f.id}>
                <strong>
                  {f.name} · {f.loaded ? `${f.count} loaded` : 'not loaded'}
                </strong>
                <p>{f.detail}</p>
                <button disabled={f.disabled || f.busy} onClick={f.refresh}>
                  {f.busy
                    ? 'Updating…'
                    : f.loaded
                      ? 'Update reports'
                      : 'Load reports'}
                </button>
                {f.error && <p className="search-errors">{f.error}</p>}
              </div>
            ))}
            <p>
              Unconnected or missing records cannot be found. Motion is
              calculated from the latest available report; data freshness is
              shown in results and details.
            </p>
          </details>
          <footer>
            Place/address search:{' '}
            <a
              href="https://www.openstreetmap.org/copyright"
              target="_blank"
              rel="noreferrer"
            >
              © OpenStreetMap contributors · ODbL
            </a>{' '}
            ·{' '}
            <a
              href="https://github.com/komoot/photon"
              target="_blank"
              rel="noreferrer"
            >
              Photon
            </a>
          </footer>
        </section>
      )}
    </div>
  );
}
