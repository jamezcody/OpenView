import { readBounded } from './bounded-fetch';
import { parseHTML } from 'linkedom';
import directory from './data/property-directory.json';
import {
  adaptersAt,
  addressLabel,
  type AddressPoint,
  type PropertyEvidence,
  type PropertyInquiry,
  type InquiryEvent,
} from './land-model';
import { parcelRequest, normalizeEvidence } from './parcel-service';
import { geometryContains, ringsToGeometry } from './parcel-geometry';
import { cached, FeedError } from './feeds';

export function validateAddress(raw: unknown): AddressPoint {
  const p = raw as AddressPoint;
  if (
    !p ||
    typeof p !== 'object' ||
    !Number.isFinite(p.lat) ||
    !Number.isFinite(p.lon) ||
    Math.abs(p.lat) > 90 ||
    Math.abs(p.lon) > 180
  )
    throw new FeedError('Select a valid mapped address.', 400);
  const text = (x: unknown, max = 250) =>
    typeof x === 'string' ? x.trim().slice(0, max) : '';
  const point: AddressPoint = {
    id: text(p.id),
    lat: p.lat,
    lon: p.lon,
    number: text(p.number, 40),
    street: text(p.street),
    unit: text(p.unit, 60),
    postcode: text(p.postcode, 30),
    city: text(p.city),
    country: text(p.country, 2).toUpperCase(),
    sources: [],
    source:
      p.source === 'Parcel situs'
        ? 'Parcel situs'
        : p.source === 'OpenStreetMap / Photon'
          ? 'OpenStreetMap / Photon'
          : 'Overture Maps',
    sourceId: text(p.sourceId, 60),
    parcelId: text(p.parcelId, 100),
    label: '',
  };
  point.label =
    addressLabel(point) ||
    `Selected location ${point.lat.toFixed(5)}, ${point.lon.toFixed(5)}`;
  return point;
}
export function directoryFor(country: string) {
  const names: Record<string, string[]> = {
    US: ['United States'],
    GB: ['United Kingdom', 'England', 'Wales', 'Scotland', 'Northern Ireland'],
    NZ: ['New Zealand'],
    KR: ['South Korea'],
    CZ: ['Czechia', 'Czech Republic'],
  };
  let labels = names[country];
  if (!labels) {
    try {
      labels = [
        new Intl.DisplayNames(['en'], { type: 'region' }).of(country) ||
          country,
      ];
    } catch {
      labels = [];
    }
  }
  return directory
    .filter((s) =>
      labels!.some((c) => s.country?.toLowerCase().includes(c.toLowerCase())),
    )
    .map((s) => ({
      name: s.source_name,
      url: s.source_url,
      jurisdiction: s.jurisdiction,
      access: s.capability,
      notes: [s.constraints, s.notes].filter(Boolean).join(' '),
    }));
}
export function approvedRecordUrl(value: string, sourceUrl: string) {
  try {
    const url = new URL(value),
      source = new URL(sourceUrl);
    const host = url.hostname.toLowerCase();
    return (
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      !url.port &&
      (host === source.hostname ||
        [
          'realestate.wake.gov',
          'services.wake.gov',
          'taxassessor.maricopa.gov',
          'publicaccess.tcadcentral.org',
        ].includes(host))
    );
  } catch {
    return false;
  }
}
export function robotsAllows(text: string, path: string) {
  if (text.length > 256000 || path.length > 8192) return false;
  type Rule = { allow: boolean; path: string };
  type Group = { agents: string[]; rules: Rule[]; hasRules: boolean };
  const groups: Group[] = [];
  let group: Group | undefined,
    ruleCount = 0;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim(),
      sep = line.indexOf(':');
    if (sep < 0) continue;
    const key = line.slice(0, sep).trim().toLowerCase(),
      value = line.slice(sep + 1).trim();
    if (key === 'user-agent') {
      if (!value) continue;
      // Empty Allow/Disallow still terminates the preceding user-agent list.
      if (!group || group.hasRules) {
        group = { agents: [], rules: [], hasRules: false };
        groups.push(group);
      }
      group.agents.push(value.toLowerCase());
    } else if (group && (key === 'allow' || key === 'disallow')) {
      group.hasRules = true;
      if (value && value.startsWith('/')) {
        if (++ruleCount > 4000) return false;
        group.rules.push({ allow: key === 'allow', path: value });
      }
    }
  }
  const product = 'openview';
  const specificity = (g: Group) =>
    Math.max(
      -1,
      ...g.agents
        .filter((a) => a !== '*' && product.includes(a))
        .map((a) => a.length),
    );
  const bestAgent = Math.max(-1, ...groups.map(specificity));
  const applicable = groups.filter((g) =>
    bestAgent >= 0 ? specificity(g) === bestAgent : g.agents.includes('*'),
  );
  const normalize = (s: string) =>
    Array.from(s)
      .map((c) => (c.codePointAt(0)! > 127 ? encodeURIComponent(c) : c))
      .join('')
      .replace(/%[0-9a-f]{2}/gi, (v) => {
        const char = String.fromCharCode(parseInt(v.slice(1), 16));
        return /^[a-z0-9._~-]$/i.test(char) ? char : v.toUpperCase();
      });
  // Greedy wildcard matching avoids regular-expression backtracking on
  // untrusted robots rules. Only a final $ is an end-of-path marker.
  function matches(raw: string, target: string) {
    const anchored = raw.endsWith('$'),
      pattern = normalize(anchored ? raw.slice(0, -1) : raw);
    let p = 0,
      t = 0,
      star = -1,
      retry = 0;
    while (true) {
      if (p === pattern.length) {
        if (!anchored || t === target.length) return true;
      } else if (pattern[p] === '*') {
        star = p++;
        retry = t;
        continue;
      } else if (t < target.length && pattern[p] === target[t]) {
        p++;
        t++;
        continue;
      }
      if (star >= 0 && retry < target.length) {
        p = star + 1;
        t = ++retry;
        continue;
      }
      return false;
    }
  }
  let best: { allow: boolean; length: number } | undefined;
  const target = normalize(path);
  for (const rule of applicable.flatMap((g) => g.rules)) {
    if (rule.path.length > 8192) return false;
    const length = normalize(rule.path)
      .replace(/\*/g, '')
      .replace(/\$$/, '').length;
    if (
      matches(rule.path, target) &&
      (!best || length > best.length || (length === best.length && rule.allow))
    )
      best = { allow: rule.allow, length };
  }
  return best?.allow ?? true;
}
export function extractRecordHtml(
  html: string,
  address: AddressPoint,
  base: PropertyEvidence,
) {
  if (html.length > 512000)
    throw new Error('Record page exceeded the extraction limit.');
  const { document } = parseHTML(html);
  type Fact = PropertyEvidence['facts'][number];
  type Candidate = { facts: Fact[]; kind: string };
  const candidates: Candidate[] = [];
  const clean = (v: unknown) =>
    (typeof v === 'string' || typeof v === 'number' ? String(v) : '')
      .replace(/\s+/g, ' ')
      .trim();
  const key = (v: string) => v.toLowerCase().replace(/[^a-z0-9]/g, '');
  const identity = (v: string) =>
    v
      .normalize('NFKC')
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '');
  const addressIdentity = (v: string) =>
    identity(v.replace(/\b(?:apartment|apt|suite|ste)\b|#/gi, 'unit '));
  const labelKey = (f: Fact) => key(f.label);
  const idKind = (f: Fact) =>
    /^(?:apn|parcel|parcelid|parcelnumber|parcelno|taxparcelid|taxparcelnumber|propertyid)$/.test(
      labelKey(f),
    )
      ? 'parcel'
      : /^(?:account|accountid|accountnumber|accountno)$/.test(labelKey(f))
        ? 'account'
        : '';
  const addressField = (f: Fact) =>
    /^(?:address|propertyaddress|situsaddress|siteaddress|locationaddress)$/.test(
      labelKey(f),
    );
  const ownerField = (f: Fact) =>
    /^(?:owner|owners|ownername|ownernames|propertyowner|propertyownername|ownership|primaryowner|coowner|coownername|owner[123]|ownername[123])$/.test(
      labelKey(f),
    );
  const allowed = (f: Fact) =>
    idKind(f) ||
    addressField(f) ||
    ownerField(f) ||
    /^(?:taxpayer|taxpayername|assessedvalue|marketvalue|landvalue|buildingvalue|yearbuilt|landuse|zoning|lotsize|legaldescription|saledate|saleprice|city|propertycity|postcode|postalcode|zipcode)$/.test(
      labelKey(f),
    );
  const fact = (label: unknown, value: unknown): Fact | null => {
    const l = clean(label).replace(/:$/, '').trim(),
      v = clean(value);
    const f = { field: l, label: l, value: v };
    return l && l.length <= 90 && v && v.length <= 600 && allowed(f) ? f : null;
  };
  // A table/list may contain sequential records. A changed repeated identifier
  // starts a new record; owner fields never migrate across that boundary.
  function addVertical(facts: Fact[], kind: string) {
    let block: Fact[] = [];
    const flush = () => {
      if (block.length) candidates.push({ facts: block, kind });
      block = [];
    };
    for (const f of facts) {
      const type = idKind(f);
      if (
        type &&
        block.some(
          (old) =>
            idKind(old) === type && identity(old.value) !== identity(f.value),
        )
      )
        flush();
      block.push(f);
    }
    flush();
  }
  const scripts = [
    ...document.querySelectorAll('script[type="application/ld+json"]'),
  ].map((n) => n.textContent || '');
  document
    .querySelectorAll('script,style,noscript,nav,footer')
    .forEach((n) => n.remove());
  for (const table of [...document.querySelectorAll('table')].slice(0, 120)) {
    const rows = [...table.querySelectorAll('tr')].filter(
      (r) => r.closest('table') === table,
    );
    const cells = rows.map((r) =>
      [...r.children].filter((c) => c.tagName === 'TH' || c.tagName === 'TD'),
    );
    const headers = (cells[0] || []).map((c) => clean(c.textContent));
    const headerFacts = headers.map((h) => ({
      field: h,
      label: h,
      value: 'header',
    }));
    const grid =
      headers.length >= 2 &&
      headerFacts.some((f) => idKind(f) || addressField(f)) &&
      headerFacts.every(allowed);
    if (grid) {
      // Search-result tables are one record per row, not one record per table.
      for (const row of cells.slice(1, 501)) {
        if (row.length !== headers.length) continue;
        const facts = row
          .map((c, i) => fact(headers[i], c.textContent))
          .filter((f): f is Fact => !!f);
        if (facts.length) candidates.push({ facts, kind: 'table row' });
      }
    } else {
      const facts: Fact[] = [];
      for (const row of cells.slice(0, 500)) {
        if (row.length < 2 || row.length > 8 || row.length % 2) continue;
        for (let i = 0; i < row.length; i += 2) {
          const f = fact(row[i].textContent, row[i + 1].textContent);
          if (f) facts.push(f);
        }
      }
      addVertical(facts, 'table');
    }
  }
  for (const dl of [...document.querySelectorAll('dl')].slice(0, 120)) {
    const facts: Fact[] = [];
    for (const dt of [...dl.querySelectorAll('dt')]
      .filter((n) => n.closest('dl') === dl)
      .slice(0, 500)) {
      const dd = dt.nextElementSibling;
      if (dd?.tagName !== 'DD') continue;
      const f = fact(dt.textContent, dd.textContent);
      if (f) facts.push(f);
    }
    addVertical(facts, 'definition list');
  }
  // JSON-LD is inspected object by object. Seller, author, publisher and an
  // untyped listing identifier are not property ownership or parcel identity.
  let visited = 0;
  function jsonRecord(raw: unknown) {
    if (!raw || typeof raw !== 'object' || visited++ >= 200) return;
    if (Array.isArray(raw)) {
      raw.forEach(jsonRecord);
      return;
    }
    const data = raw as Record<string, unknown>;
    if (data['@graph']) jsonRecord(data['@graph']);
    if (data.mainEntity) jsonRecord(data.mainEntity);
    const types = (
      Array.isArray(data['@type']) ? data['@type'] : [data['@type']]
    ).map((v: unknown) =>
      (typeof v === 'string' ? v : '').split(/[/#]/).at(-1),
    );
    if (
      !types.some((t) =>
        /^(?:Place|House|Apartment|ApartmentComplex|Residence|SingleFamilyResidence|Accommodation|RealEstateListing|LandParcel|Parcel|Property)$/.test(
          t || '',
        ),
      )
    )
      return;
    const facts: Fact[] = [];
    const push = (label: string, value: unknown) => {
      const f = fact(label, value);
      if (f) facts.push(f);
    };
    for (const [field, label] of [
      ['parcelID', 'Parcel ID'],
      ['parcelId', 'Parcel ID'],
      ['parcelNumber', 'Parcel number'],
      ['apn', 'APN'],
      ['accountNumber', 'Account number'],
    ])
      if (data[field]) push(label, data[field]);
    for (const id of [data.identifier].flat())
      if (id && typeof id === 'object') {
        const record = id as Record<string, unknown>;
        const label = clean(record.propertyID || record.name);
        if (idKind({ field: label, label, value: '' }))
          push(label, record.value);
      }
    if (typeof data.address === 'string')
      push('Property address', data.address);
    else if (data.address && typeof data.address === 'object')
      push(
        'Property address',
        ['streetAddress', 'addressLocality', 'postalCode']
          .map((key) => (data.address as Record<string, unknown>)[key])
          .filter(Boolean)
          .join(', '),
      );
    for (const owner of [data.owner ?? data.ownedBy].flat()) {
      if (typeof owner === 'string') push('Owner', owner);
      else if (
        owner &&
        typeof owner === 'object' &&
        ('name' in owner || 'legalName' in owner)
      )
        push(
          'Owner',
          (owner as Record<string, unknown>).name ||
            (owner as Record<string, unknown>).legalName,
        );
    }
    if (data.yearBuilt) push('Year built', data.yearBuilt);
    if (facts.length)
      candidates.push({ facts, kind: 'JSON-LD property object' });
  }
  for (const script of scripts.slice(0, 20)) {
    if (script.length > 256000) continue;
    try {
      jsonRecord(JSON.parse(script));
    } catch {}
  }
  const expectedId = identity(base.parcelId || '');
  const expectedAddress = addressIdentity(
    [
      [address.number, address.street].filter(Boolean).join(' '),
      address.unit ? `Unit ${address.unit}` : '',
      address.city,
      address.postcode,
    ]
      .filter(Boolean)
      .join(', '),
  );
  function matches(candidate: Candidate) {
    const ids = candidate.facts.filter((f) => idKind(f));
    if (expectedId && ids.some((f) => identity(f.value) === expectedId)) {
      // Different identifier schemes may coexist; reject contradictory values
      // within whichever scheme supplied the exact match.
      return ids.some(
        (f) =>
          identity(f.value) === expectedId &&
          ids
            .filter((g) => idKind(g) === idKind(f))
            .every((g) => identity(g.value) === expectedId),
      );
    }
    // A conflicting explicit identifier defeats an address-only match.
    if (expectedId && ids.length) return false;
    if (expectedAddress.length < 8 || !address.number || !address.street)
      return false;
    return candidate.facts.some(
      (f) => addressField(f) && addressIdentity(f.value) === expectedAddress,
    );
  }
  const matched = candidates.filter(matches);
  if (!matched.length)
    throw new Error(
      'No single public record has a matching labelled parcel identifier or complete selected address. Open the source to verify it.',
    );
  const usableOwner = (value: string) =>
    !/^(?:current (?:co-)?owner|unknown|n\/a|null|owner unavailable|property owner)$/i.test(
      value,
    ) && !/redacted|confidential|withheld/i.test(value);
  const ownerSets = matched.map((c) => [
    ...new Set(
      c.facts
        .filter(ownerField)
        .map((f) => f.value)
        .filter(usableOwner),
    ),
  ]);
  const nonempty = ownerSets
    .filter((s) => s.length)
    .map((s) => s.map(identity).sort().join('|'));
  if (new Set(nonempty).size > 1)
    throw new Error(
      'Several matching record sections state different owners. Open the source to resolve the conflict.',
    );
  const unique = new Map<string, Fact>();
  for (const c of matched)
    for (const f of c.facts) unique.set(`${key(f.label)}:${f.value}`, f);
  const facts = [...unique.values()].slice(0, 40);
  return { facts, owners: [...new Set(ownerSets.flat())].slice(0, 20) };
}
async function boundedHtml(url: string, signal: AbortSignal) {
  const response = await fetch(url, {
    redirect: 'manual',
    headers: {
      'User-Agent': 'OpenView/2.0',
      Accept: 'text/html',
      'Accept-Encoding': 'gzip',
    },
    signal: AbortSignal.any([signal, AbortSignal.timeout(12000)]),
  });
  if (response.status >= 300 && response.status < 400)
    throw new Error(
      'Public record page redirects; follow its source link to continue.',
    );
  if (!response.ok)
    throw new Error(`Public record page returned HTTP ${response.status}.`);
  if (!response.headers.get('content-type')?.includes('text/html'))
    throw new Error('Record link is not a public HTML page.');
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Empty record page.');
  const decoder = new TextDecoder();
  let text = '',
    bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.length;
    if (bytes > 512000) {
      await reader.cancel();
      throw new Error('Record page exceeded the bounded extraction limit.');
    }
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  if (
    /g-recaptcha|h-captcha|cf-chl-|<input[^>]*type=["']password["']/i.test(text)
  )
    throw new Error(
      'This record page requires an interactive or authenticated visit.',
    );
  return text;
}
async function scrapeRecord(
  url: string,
  address: AddressPoint,
  base: PropertyEvidence,
  signal: AbortSignal,
): Promise<PropertyEvidence> {
  if (!approvedRecordUrl(url, base.sourceUrl))
    throw new Error(
      'External record link needs a manual visit; this host is not approved for automated extraction.',
    );
  const target = new URL(url),
    robots = await fetch(new URL('/robots.txt', target), {
      redirect: 'manual',
      headers: { 'User-Agent': 'OpenView/2.0' },
      signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]),
    });
  if (robots.status !== 404) {
    if (!robots.ok)
      throw new Error(
        'The record site did not provide accessible crawling rules.',
      );
    const rules = new TextDecoder().decode(await readBounded(robots, 256000));
    if (
      rules.length > 256000 ||
      !robotsAllows(rules, target.pathname + target.search)
    )
      throw new Error(
        'The record site disallows automated access to this page.',
      );
  }
  const html = await boundedHtml(url, signal),
    extracted = extractRecordHtml(html, address, base);
  return {
    ...base,
    source: base.source + ' · linked public page',
    sourceUrl: url,
    retrievedAt: Date.now(),
    match: 'linked public record',
    ownerNames: extracted.owners,
    ownerRole: 'page-stated owner',
    facts: extracted.facts,
    recordLinks: [],
    notes: [
      'Matched by parcel identifier or address text. Page-stated ownership is separate from registered title.',
    ],
  };
}
export async function runPropertyInquiry(
  address: AddressPoint,
  emit: (event: InquiryEvent) => void,
  signal: AbortSignal,
) {
  const callerSignal = signal;
  signal = AbortSignal.any([signal, AbortSignal.timeout(60000)]);
  const result: PropertyInquiry = {
    address,
    startedAt: Date.now(),
    status: 'running',
    evidence: [],
    checks: [],
    directory: directoryFor(address.country),
  };
  const check = (
    source: string,
    status: string,
    message: string,
    url?: string,
  ) => {
    const value = { source, status, message, url };
    result.checks.push(value);
    emit({ type: 'check', value });
  };
  emit({ type: 'started', value: result });
  const adapters = adaptersAt(address.lat, address.lon).filter(
    () => !address.country || address.country === 'US',
  );
  if (!adapters.length)
    check(
      'Automated property coverage',
      'unsupported',
      'No supported coordinate-based property API is available here. Regional registry links are listed below.',
    );
  for (let i = 0; i < adapters.length && !signal.aborted; i += 3) {
    await Promise.all(
      adapters.slice(i, i + 3).map(async (a) => {
        check(
          a.name,
          'querying',
          'Querying the official parcel service at the selected location.',
          a.sourceUrl,
        );
        try {
          const data = await cached(
            `property-v3-${a.id}-${address.lat.toFixed(7)}-${address.lon.toFixed(7)}`,
            300,
            async () => ({
              fetchedAt: Date.now(),
              response: await parcelRequest(
                a,
                {
                  where: '1=1',
                  geometry: `${address.lon},${address.lat}`,
                  geometryType: 'esriGeometryPoint',
                  spatialRel: 'esriSpatialRelIntersects',
                  inSR: '4326',
                  outSR: '4326',
                  outFields: a.ownerDataOutFields,
                  returnGeometry: 'true',
                  resultRecordCount: '100',
                },
                signal,
              ),
            }),
          );
          if (signal.aborted) return;
          const rows = Array.isArray(data.response.features)
            ? data.response.features
            : [];
          if (data.response.exceededTransferLimit)
            check(
              a.name,
              'partial',
              'This location has more intersecting records than the source returned. Results are partial; use the source to inspect all condominium or overlapping parcel records.',
              a.sourceUrl,
            );
          let found = 0;
          for (const row of rows.slice(0, 100)) {
            const geometry = row.geometry?.rings
              ? ringsToGeometry(row.geometry.rings)
              : null;
            if (
              !geometry ||
              !geometryContains(geometry, address.lon, address.lat)
            )
              continue;
            const evidence = normalizeEvidence(
              row.attributes || {},
              a,
              address.lat,
              address.lon,
            );
            evidence.retrievedAt = data.fetchedAt;
            if (address.unit)
              evidence.notes.push(
                `Unit ${address.unit} has not been independently matched. Multiple units may share this parcel or coordinate.`,
              );
            const sourceNumber =
              evidence.address.match(/^\s*(\d+[a-zA-Z]?)/)?.[1];
            if (
              address.number &&
              sourceNumber &&
              sourceNumber.toLowerCase() !== address.number.toLowerCase()
            )
              evidence.notes.push(
                'Parcel situs number differs from the selected address; this may be a multi-address parcel. Verify the record.',
              );
            result.evidence.push(evidence);
            emit({ type: 'evidence', value: evidence });
            found++;
          }
          check(
            a.name,
            found ? 'matched' : 'empty',
            found
              ? `${found} intersecting parcel record${found === 1 ? '' : 's'} found${data.cached ? ' (cached)' : ''}.`
              : 'No intersecting parcel record returned. This may be a source coverage gap.',
            a.sourceUrl,
          );
        } catch (e) {
          if (!signal.aborted)
            check(
              a.name,
              'failed',
              e instanceof Error ? e.message : 'Source unavailable.',
              a.sourceUrl,
            );
        }
      }),
    );
  }
  let crawled = 0;
  for (const evidence of result.evidence.slice()) {
    for (const url of evidence.recordLinks) {
      if (signal.aborted || crawled >= 2) break;
      crawled++;
      check(
        evidence.source,
        'checking page',
        'Checking the linked public record page.',
        url,
      );
      try {
        const page = await scrapeRecord(url, address, evidence, signal);
        result.evidence.push(page);
        emit({ type: 'evidence', value: page });
        check(
          evidence.source,
          'page extracted',
          'Extracted parcel-matched public page fields.',
          url,
        );
      } catch (e) {
        if (!signal.aborted)
          check(
            evidence.source,
            'manual visit',
            e instanceof Error ? e.message : 'Public page unavailable.',
            url,
          );
      }
    }
  }
  if (callerSignal.aborted) return;
  if (signal.aborted)
    check(
      'Inquiry time limit',
      'partial',
      'The 60-second source-check budget was reached. Partial results are shown; use the source links or try again.',
    );
  result.status = 'complete';
  result.completedAt = Date.now();
  emit({ type: 'complete', value: result });
  return result;
}
