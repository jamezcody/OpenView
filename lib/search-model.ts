import { isSpaceObject, SPACE_LABELS } from './space-data';
import type { AddressPoint, LandParcelSnapshot } from './land-model';
import type { OMM, Snapshot, Track } from './model';
import type { RadioCategory } from './radio-model';
import type { ParkKind } from './park-model';
import type { CoverageManifest } from './coverage-model';
import type { CampLayer } from './camping-model';

export type SearchKind =
  | 'camping'
  | 'place'
  | 'address'
  | 'coordinates'
  | 'satellite'
  | 'aircraft'
  | 'ship'
  | 'parcel'
  | 'parcel-source'
  | 'transmitter'
  | 'receiver'
  | 'radio-candidate'
  | 'national-park'
  | 'state-park'
  | 'coverage';
export type SearchTarget =
  | { type: 'camping'; recordId: string; layer: CampLayer; version: string }
  | { type: 'radio'; recordId: string; node: string; category: RadioCategory }
  | { type: 'park'; parkId: string; kind: ParkKind }
  | { type: 'address'; address: AddressPoint }
  | { type: 'parcel'; parcelId: string }
  | { type: 'satellite'; id: string }
  | { type: 'track'; id: string; kind: 'aircraft' | 'ships' }
  | { type: 'coverage'; layerId: string }
  | { type: 'parcel-source' }
  | { type: 'place' };
export type SearchResult = {
  id: string;
  kind: SearchKind;
  name: string;
  detail: string;
  terms: string;
  lat: number | null;
  lon: number | null;
  height: number;
  source: string;
  sourceUrl: string;
  target: SearchTarget;
  observedAt?: number;
  release?: string;
};
export const SEARCH_LABELS: Record<SearchKind, string> = {
  camping: 'Camping record',
  place: 'Place',
  address: 'Address',
  coordinates: 'Coordinates',
  satellite: 'Space object',
  aircraft: 'Aircraft',
  ship: 'Ship',
  parcel: 'Parcel',
  'parcel-source': 'Parcel source',
  transmitter: 'Transmitter',
  receiver: 'Receiver',
  'radio-candidate': 'Uncertain radio site',
  'national-park': 'National park',
  'state-park': 'State park',
  coverage: 'Cell coverage',
};
export function foldSearch(value: string) {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}.]+/gu, ' ')
    .trim();
}
export type IndexedResult = {
  result: SearchResult;
  text: string;
  name: string;
  identity: string;
};
const aliases: Partial<Record<SearchKind, string>> = {
  satellite: 'satellite satellites space orbital',
  aircraft: 'plane planes airplane airplanes flight',
  ship: 'boat boats vessel vessels ships AIS MMSI',
  transmitter: 'transmitters radio tower towers',
  receiver: 'receivers receiving station',
  address: 'addresses street',
  parcel: 'parcels property boundary boundaries',
};
export function indexSearch(items: SearchResult[]): IndexedResult[] {
  return items.map((result) => ({
    result,
    name: foldSearch(result.name),
    identity: foldSearch(result.id),
    text: foldSearch(
      `${result.name} ${result.detail} ${result.terms} ${result.source} ${SEARCH_LABELS[result.kind]} ${aliases[result.kind] || ''}`,
    ),
  }));
}
export function coverageSearchItems(
  manifest: CoverageManifest,
): SearchResult[] {
  return manifest.layers.flatMap((l) =>
    l.regions.flatMap((region) => {
      const jurisdiction = l.jurisdictions.find(
        (j) => j.id === region.id && j.status === 'ready',
      );
      if (!jurisdiction) return [];
      const [w, s, e, n] = region.rectangle;
      return [
        {
          id: `coverage:${l.id}:${region.id}`,
          kind: 'coverage' as const,
          name: `${l.provider.name} ${l.technology} · ${jurisdiction.name}`,
          detail: `${l.downloadMbps}/${l.uploadMbps} Mbps · ${l.reportingDate}`,
          terms: `${l.provider.name} ${jurisdiction.name} cell coverage ${l.technology}`,
          lat: (s + n) / 2,
          lon: (w + e) / 2,
          height: Math.max(40000, (n - s) * 130000),
          source: 'FCC BDC',
          sourceUrl: l.sourceUrl,
          target: { type: 'coverage' as const, layerId: l.id },
          release: manifest.release,
        },
      ];
    }),
  );
}
export function searchMatches(
  indexes: IndexedResult[][],
  query: string,
  limit = 60,
): { items: SearchResult[]; total: number } {
  const q = foldSearch(query),
    words = q.split(' ').filter(Boolean),
    seen = new Set<string>(),
    matches: { item: SearchResult; score: number }[] = [];
  if (!q) return { items: [], total: 0 };
  for (const index of indexes)
    for (const entry of index) {
      if (
        !words.every(
          (w) => entry.text.includes(w) || entry.identity.includes(w),
        ) ||
        seen.has(entry.result.id)
      )
        continue;
      seen.add(entry.result.id);
      const score =
        entry.name === q || entry.identity === q
          ? 100
          : entry.name.startsWith(q)
            ? 80
            : entry.name.includes(q)
              ? 60
              : entry.text.includes(q)
                ? 40
                : 20;
      matches.push({ item: entry.result, score });
    }
  matches.sort(
    (a, b) =>
      b.score - a.score ||
      a.item.name.localeCompare(b.item.name) ||
      a.item.id.localeCompare(b.item.id),
  );
  return {
    items: matches
      .slice(0, Math.max(1, Math.min(500, limit)))
      .map((m) => m.item),
    total: matches.length,
  };
}
export function coordinateResult(query: string): SearchResult | null {
  if (
    !/^\s*[+-]?(?:\d+(?:\.\d*)?|\.\d+)\s*,\s*[+-]?(?:\d+(?:\.\d*)?|\.\d+)\s*$/.test(
      query,
    )
  )
    return null;
  const [lat, lon] = query.split(',').map(Number);
  if (
    !Number.isFinite(lat) ||
    !Number.isFinite(lon) ||
    Math.abs(lat) > 90 ||
    Math.abs(lon) > 180
  )
    return null;
  return {
    id: `coordinates:${lat},${lon}`,
    kind: 'coordinates',
    name: `${lat}, ${lon}`,
    detail: 'Latitude, longitude',
    terms: query,
    lat,
    lon,
    height: 10000,
    source: 'Entered coordinates',
    sourceUrl: '',
    target: { type: 'place' },
  };
}
export function parsePhoton(raw: unknown): SearchResult[] {
  if (
    !raw ||
    typeof raw !== 'object' ||
    !Array.isArray((raw as { features?: unknown }).features)
  )
    throw new Error('Place search returned an invalid response.');
  const features = (raw as { features: unknown[] }).features;
  if (features.length > 50)
    throw new Error('Place search exceeded its result limit.');
  const output: SearchResult[] = [],
    seen = new Set<string>();
  const text = (v: unknown) =>
    typeof v === 'string' ? v.trim().slice(0, 250) : '';
  for (const value of features) {
    const f = value as {
      geometry?: { type?: string; coordinates?: number[] };
      properties?: Record<string, unknown>;
    };
    if (
      !f ||
      f.geometry?.type !== 'Point' ||
      !Array.isArray(f.geometry.coordinates) ||
      !f.properties
    )
      continue;
    const [lon, lat] = f.geometry.coordinates,
      p = f.properties;
    const osmTypeCode = typeof p.osm_type === 'string' ? p.osm_type : '',
      osmId = typeof p.osm_id === 'number' ? p.osm_id : Number.NaN;
    if (
      !Number.isFinite(lat) ||
      !Number.isFinite(lon) ||
      Math.abs(lat) > 90 ||
      Math.abs(lon) > 180 ||
      !['N', 'W', 'R'].includes(osmTypeCode) ||
      !Number.isSafeInteger(osmId) ||
      osmId <= 0
    )
      continue;
    const osmType =
        osmTypeCode === 'N' ? 'node' : osmTypeCode === 'W' ? 'way' : 'relation',
      id = `osm:${osmType}:${osmId}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const number = text(p.housenumber),
      street = text(p.street),
      city = text(p.city),
      country = text(p.countrycode).toUpperCase();
    const address = number && street ? `${number} ${street}` : '',
      name = address || text(p.name) || street || city;
    if (!name) continue;
    const detail = [
      text(p.name) !== name ? text(p.name) : '',
      city,
      text(p.county),
      text(p.state),
      text(p.postcode),
      text(p.country),
    ]
      .filter((s, i, a) => s && s !== name && a.indexOf(s) === i)
      .join(' · ');
    const sourceUrl = `https://www.openstreetmap.org/${osmType}/${osmId}`;
    const a: AddressPoint = {
      id,
      lat,
      lon,
      number,
      street,
      unit: '',
      postcode: text(p.postcode),
      city,
      country,
      label: [name, city, text(p.state)].filter(Boolean).join(', '),
      source: 'OpenStreetMap / Photon',
      sources: [
        { dataset: 'OpenStreetMap via Photon', license: 'ODbL', record_id: id },
      ],
    };
    const extent = Array.isArray(p.extent) ? p.extent : null;
    const span =
      extent && extent.length === 4 && extent.every(Number.isFinite)
        ? Math.max(
            Math.abs(Number(extent[2]) - Number(extent[0])),
            Math.abs(Number(extent[1]) - Number(extent[3])),
          )
        : 0;
    output.push({
      id,
      kind: address ? 'address' : 'place',
      name,
      detail,
      terms: `${name} ${detail}`,
      lat,
      lon,
      height: address
        ? 1500
        : Math.max(3000, Math.min(15000000, span ? span * 120000 : 30000)),
      source: 'OpenStreetMap via Photon · ODbL',
      sourceUrl,
      target: address ? { type: 'address', address: a } : { type: 'place' },
    });
  }
  return output;
}
export function liveSearchItems({
  orbits,
  air,
  sea,
  addresses,
  parcels,
}: {
  orbits: Snapshot<OMM> | null;
  air: Snapshot<Track> | null;
  sea: Snapshot<Track> | null;
  addresses?: AddressPoint[];
  parcels?: LandParcelSnapshot | null;
}): SearchResult[] {
  const out: SearchResult[] = [];
  for (const o of (orbits?.items || []).filter(isSpaceObject))
    out.push({
      id: `satellite:${o.NORAD_CAT_ID}`,
      kind: 'satellite',
      name: o.OBJECT_NAME,
      detail: `${SPACE_LABELS[o.objectType]} · NORAD ${o.NORAD_CAT_ID} · elements ${o.EPOCH}`,
      terms: `${o.NORAD_CAT_ID} ${o.OBJECT_NAME === 'ISS (ZARYA)' ? 'International Space Station ISS' : ''}`,
      lat: 0,
      lon: 0,
      height: 2000000,
      source: orbits!.source,
      sourceUrl: orbits!.sourceUrl,
      target: { type: 'satellite', id: String(o.NORAD_CAT_ID) },
      observedAt: orbits!.fetchedAt,
    });
  for (const snapshot of [air, sea])
    for (const t of snapshot?.items || [])
      out.push({
        id: `${t.kind}:${t.id}`,
        kind: t.kind === 'aircraft' ? 'aircraft' : 'ship',
        name: t.name || t.registration || t.id,
        detail: [t.id, t.registration, t.country].filter(Boolean).join(' · '),
        terms: `${t.id} ${t.registration || ''} ${t.country || ''}`,
        lat: t.lat,
        lon: t.lon,
        height: Math.max(6000, t.altitude + 12000),
        source: t.source || snapshot!.source,
        sourceUrl: t.sourceUrl || snapshot!.sourceUrl,
        target: { type: 'track', id: t.id, kind: t.kind },
        observedAt: t.observedAt,
      });
  for (const a of addresses || [])
    out.push({
      id: `address:${a.id}`,
      kind: 'address',
      name: a.label,
      detail: [a.city, a.postcode, a.country].filter(Boolean).join(' · '),
      terms: `${a.number} ${a.street} ${a.unit} ${a.id}`,
      lat: a.lat,
      lon: a.lon,
      height: 1500,
      source: a.source,
      sourceUrl:
        a.source === 'Overture Maps'
          ? 'https://docs.overturemaps.org/guides/addresses/'
          : '',
      target: { type: 'address', address: a },
    });
  for (const f of parcels?.data.features || []) {
    const p =
      f.geometry.type === 'Polygon'
        ? (f.geometry.coordinates as number[][][])[0]?.[0]
        : (f.geometry.coordinates as number[][][][])[0]?.[0]?.[0];
    if (!p || !p.every(Number.isFinite)) continue;
    out.push({
      id: `parcel:${f.id}`,
      kind: 'parcel',
      name: f.properties.address || `Parcel ${f.properties.id}`,
      detail: `${f.properties.id} · ${f.properties.locality}`,
      terms: `${f.id} ${f.properties.id} ${f.properties.address} ${f.properties.locality}`,
      lat: p[1],
      lon: p[0],
      height: 1500,
      source: f.properties.source,
      sourceUrl: f.properties.sourceUrl,
      target: { type: 'parcel', parcelId: f.id },
    });
  }
  return out;
}
