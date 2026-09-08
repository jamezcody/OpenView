"""Public Traficom, Mastedatabasen and BAKOM location datasets.

Source schemas verified against live regulator exports, September 2026.
Coordination records and antenna sites without a known transmitter service remain
candidates. Nominal mobile bands are retained as bands, not exact frequencies.
"""
from __future__ import annotations

import hashlib
import html
import json
import re
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlencode, urljoin, urlsplit

from core import csv_rows, dms, norm, number

SOURCES = {
    'fi_traficom': {
        'name': 'Finland — Traficom radio and TV', 'country': 'FI', 'mode': 'automatic',
        'url': 'https://tieto.traficom.fi/en/open-data', 'native_extensions': ['.json'],
        'scope': 'Daily radio and TV broadcast licence data, with EUREF-FIN coordinates. Downloads every API page and checks the reported count; excludes other radio services.'},
    'dk_mastedatabasen': {
        'name': 'Denmark — Mastedatabasen', 'country': 'DK', 'mode': 'automatic',
        'url': 'https://www.mastedatabasen.dk/viskort/ContentPages/DataFraDatabasen.aspx?callingapp=mastedb',
        'native_extensions': ['.json'],
        'scope': 'Published existing antenna-site records. Mobile service sites are transmitting records; unspecified services remain candidates. Planned coordinates are withheld by the publisher. Nominal bands stay in details, not exact-frequency columns.'},
    'ch_bakom': {
        'name': 'Switzerland — BAKOM broadcast', 'country': 'CH', 'mode': 'automatic',
        'url': 'https://www.bakom.admin.ch/de/standorte-von-sendeanlagen',
        'native_extensions': ['.zip', '.csv'],
        'scope': 'FM concessions, FM GE84 coordination records, and DAB/DVB broadcast exports; includes correctly labelled foreign sites. Coordination-only entries are candidates. FM snapshots can be older than digital exports. Does not download cellular map data.'},
}

FI_ROOT = 'https://opendata.traficom.fi/api/v13/'
FI_ENDPOINTS = ('Radioasematiedot', 'TVAsematiedot')
DK_ROOT = 'https://mastedatabasen.dk/Master/antenner.json'
DK_LIMIT = 1000000
ITU_COUNTRIES = {'SUI': 'CH', 'AUT': 'AT', 'F': 'FR', 'D': 'DE', 'I': 'IT',
                 'LIE': 'LI', 'SVN': 'SI', 'LUX': 'LU', 'SMR': 'SM', 'DDR': 'DE'}
SWISS_CANTONS = set('AG AI AR BE BL BS FR GE GL GR JU LU NE NW OW SG SH SO SZ TG TI UR VD VS ZG ZH'.split())


def _fingerprint(row):
    return hashlib.sha256(json.dumps(row, ensure_ascii=False, sort_keys=True).encode()).hexdigest()


def _base(source, identifier, path, url):
    return dict(source=source, country=SOURCES[source]['country'], source_record_id=str(identifier),
                source_file=str(path), source_url=url, source_crs='unspecified',
                location_kind='fixed', transmission_kind='unknown')


def compact_dms(value):
    """Traficom DDNMMSS / DDEMMSS, including optional fractional seconds."""
    match = re.fullmatch(r'(\d{1,3})([NSEW])(\d{2})(\d{2}(?:\.\d+)?)', str(value or '').strip().upper())
    if not match:
        return None
    deg, hemisphere, minute, second = match.groups()
    return dms(deg, minute, second, hemisphere)


def swiss_coordinate(value):
    """BAKOM publishes decimal degrees and GE84 degrees/minutes/seconds."""
    decimal = number(value)
    if decimal is not None:
        return decimal
    match = re.fullmatch(r'\s*(\d{1,3})\s*°\s*(\d{1,2})\s*[\'′]\s*(\d{1,2}(?:\.\d+)?)\s*["″]\s*([NSEW])\s*', str(value or ''), re.I)
    return dms(*match.groups()) if match else None


def _odata_pages(ctx, endpoint, page_size=1000):
    """Count-checked, ordered pagination, including unexpected smaller pages."""
    root = FI_ROOT + endpoint
    skip = 0
    expected = None
    seen_ids = set()
    seen_urls = set()
    next_url = None
    while True:
        ctx.check()
        url = next_url or root + '?' + urlencode({'$count': 'true', '$top': page_size, '$orderby': 'ID', '$skip': skip})
        if url in seen_urls:
            raise ValueError('Traficom returned a pagination loop')
        seen_urls.add(url)
        path = ctx.download(url, endpoint + '.json')
        data = json.loads(path.read_text(encoding='utf-8-sig'))
        rows = data.get('value')
        if not isinstance(rows, list):
            raise ValueError('Traficom response has no value array')
        count = data.get('@odata.count')
        if expected is None:
            if not isinstance(count, int) or count < 0:
                raise ValueError('Traficom omitted the requested count; cannot verify completeness')
            expected = count
        elif count is not None and count != expected:
            raise ValueError('Traficom data changed during pagination; refresh and retry')
        ids = [r.get('ID') for r in rows]
        if None in ids or len(set(ids)) != len(ids) or seen_ids.intersection(ids):
            raise ValueError('Traficom returned duplicate or missing IDs during pagination')
        seen_ids.update(ids)
        if len(seen_ids) > expected or (not rows and len(seen_ids) < expected):
            raise ValueError('Traficom response count does not match downloaded records')
        yield path, url
        if len(seen_ids) == expected:
            return
        skip += len(rows)
        link = data.get('@odata.nextLink')
        next_url = urljoin(url, link) if link else None
        if next_url and urlsplit(next_url).netloc != urlsplit(FI_ROOT).netloc:
            raise ValueError('Traficom pagination changed host unexpectedly')


def _bakom_links(page):
    links = []
    for href in re.findall(r'href\s*=\s*["\']([^"\']+)["\']', page, re.I):
        url = urljoin(SOURCES['ch_bakom']['url'], html.unescape(href))
        name = urlsplit(url).path.rsplit('/', 1)[-1].lower()
        if name.endswith('.zip') and (('ukw' in name and 'koordination' in name) or ('tdab' in name and 'dvbt' in name)):
            if url not in links:
                links.append(url)
    if not any('ukw' in u.lower() for u in links) or not any('tdab' in u.lower() for u in links):
        raise ValueError('BAKOM page no longer links both FM and digital broadcast archives')
    return links


def acquire(ctx, source):
    if source == 'fi_traficom':
        for endpoint in FI_ENDPOINTS:
            yield from _odata_pages(ctx, endpoint)
    elif source == 'dk_mastedatabasen':
        url = DK_ROOT + '?' + urlencode({'maxantal': DK_LIMIT})
        path = ctx.download(url, 'mastedatabasen.json')
        rows = json.loads(path.read_text(encoding='utf-8-sig'))
        if not isinstance(rows, list) or not rows:
            raise ValueError('Mastedatabasen returned no antenna-site list')
        if len(rows) >= DK_LIMIT:
            raise ValueError('Mastedatabasen reached the requested record limit; refusing a truncated export')
        ctx.log(f'Mastedatabasen returned {len(rows):,} antenna records (requested maximum {DK_LIMIT:,})')
        yield path, url
    elif source == 'ch_bakom':
        page = ctx.download(SOURCES[source]['url'], 'bakom-index.html').read_text(encoding='utf-8-sig')
        for url in _bakom_links(page):
            ctx.check()
            yield ctx.download(url, urlsplit(url).path.rsplit('/', 1)[-1]), url
    else:
        raise ValueError('Unsupported source: ' + source)


def _license_status(row):
    today = datetime.now(timezone.utc).date().isoformat()
    end = str(row.get('EndingDate') or '')[:10]
    start = str(row.get('StartingDate') or '')[:10]
    if re.fullmatch(r'\d{4}-\d{2}-\d{2}', end) and end < today:
        return 'expired'
    if re.fullmatch(r'\d{4}-\d{2}-\d{2}', start) and start > today:
        return 'planned'
    return 'active' if end else 'licensed'


def _parse_finland(ctx, ds, path, url):
    data = json.loads(path.read_text(encoding='utf-8-sig'))
    rows = data.get('value')
    if not isinstance(rows, list):
        raise ValueError('Traficom import needs a native OData JSON response')
    kind = 'tv' if 'tvasematiedot' in (url + str(data.get('@odata.context', ''))).lower() else 'radio'
    for i, row in enumerate(rows):
        if i % 1000 == 0:
            ctx.check()
        if not {'ID', 'Latitude', 'Longitude', 'Frequency', 'LicenseNumber'} <= row.keys():
            raise ValueError('Unsupported Traficom broadcast schema')
        out = _base('fi_traficom', kind + ':' + str(row['ID']), path.name, url)
        out.update(latitude=compact_dms(row['Latitude']), longitude=compact_dms(row['Longitude']),
                   source_crs='EPSG:4258', license_id=row['LicenseNumber'], operator=row.get('LicenseOwner'),
                   service='TV broadcast' if kind == 'tv' else 'Radio broadcast', site_id=row.get('StationName'),
                   frequency_mhz=(number(row.get('Frequency')) or 0) / 1e6,
                   frequency_upper_mhz=(number(row.get('FrequencyEnd')) or 0) / 1e6,
                   power_value=row.get('TransmissionPower'), power_unit='W ERP',
                   antenna_height_m=row.get('AntennaHeight'), status=_license_status(row),
                   expiration_date=row.get('EndingDate'), transmission_kind='transmit',
                   details_json={'source_record': row, 'coordinate_datum': 'EUREF-FIN realization of ETRS89',
                                 'status_basis': 'Licence validity; does not establish current on-air operation'})
        ds.add(out)


def _parse_denmark(ctx, ds, path, url):
    rows = json.loads(path.read_text(encoding='utf-8-sig'))
    if not isinstance(rows, list):
        raise ValueError('Mastedatabasen import needs a native JSON array')
    for i, row in enumerate(rows):
        if i % 1000 == 0:
            ctx.check()
        if not {'wgs84koordinat', 'unik_station_navn', 'tjenesteart', 'teknologi'} <= row.keys():
            raise ValueError('Unsupported Mastedatabasen antenna schema')
        coord = row.get('wgs84koordinat') or {}
        service = row.get('tjenesteart') or {}
        tech = row.get('teknologi') or {}
        out = _base('dk_mastedatabasen', _fingerprint(row), path.name, url)
        commissioned = row.get('idriftsaettelsesdato') or ''
        date_is_past = bool(re.fullmatch(r'\d{4}-\d{2}-\d{2}', commissioned) and commissioned <= datetime.now(timezone.utc).date().isoformat())
        out.update(latitude=coord.get('bredde'), longitude=coord.get('laengde'), source_crs='EPSG:4326',
                   site_id=row['unik_station_navn'], service=' / '.join(str(v) for v in (service.get('navn'), tech.get('navn')) if v),
                   status='commissioning_date_recorded' if date_is_past else 'unknown',
                   transmission_kind='transmit' if str(service.get('id')) == '2' else 'unknown',
                   details_json={'source_record': row, 'frequency_band_mhz': row.get('frekvensbaand'),
                                 'frequency_note': 'Nominal band; exact carrier frequency is not supplied',
                                 'status_basis': 'Reported commissioning date; not an on-air observation'})
        if (number(row.get('radius_i_meter')) or 0) > 0:
            out['location_kind'] = 'area'
        ds.add(out)


def _parse_switzerland(ctx, ds, path, url):
    if zipfile.is_zipfile(path):
        with zipfile.ZipFile(path) as archive:
            members = [n for n in archive.namelist() if n.lower().endswith('.csv')]
    else:
        members = [None]
    if not members:
        raise ValueError('BAKOM archive has no CSV tables')
    for member in members:
        filename = member or path.name
        ctx.log('Reading ' + filename)
        for row, line in csv_rows(path, member):
            if line % 1000 == 0:
                ctx.check()
            r = {norm(k): v for k, v in row.items()}
            if not {'latitude', 'longitude', 'sitename'} <= r.keys():
                raise ValueError('Unsupported BAKOM broadcast CSV schema: ' + filename)
            coordination = 'ctry' in r and 'coorddate' in r
            digital = 'sfnident' in r
            country_code = r.get('ctry') or r.get('countryid') or r.get('canton') or ''
            country = 'CH' if digital and country_code in SWISS_CANTONS else ITU_COUNTRIES.get(country_code)
            if not country:
                raise ValueError('Unrecognized BAKOM site country/canton: ' + country_code)
            kind = 'ge84' if coordination else ('digital' if digital else 'fm_concession')
            out = _base('ch_bakom', kind + ':' + _fingerprint(row), filename, url)
            power = [number(r.get(k)) for k in ('erphw', 'erpvw')]
            power = [v for v in power if v is not None]
            out.update(country=country, latitude=swiss_coordinate(r['latitude']), longitude=swiss_coordinate(r['longitude']),
                       call_sign=r.get('callsign'), site_id=r.get('code') or r['sitename'],
                       operator=r.get('licensename'), license_id=r.get('sfnident'),
                       service='FM broadcast coordination' if coordination else ('DAB broadcast' if 'block' in r else ('DVB broadcast' if digital else 'FM broadcast')),
                       status='coordinated' if coordination else 'licensed_snapshot',
                       frequency_mhz=r.get('frqassign') or r.get('frequence'),
                       antenna_height_m=r.get('hgtagl') or r.get('agl'),
                       transmission_kind='unknown' if coordination else 'transmit',
                       power_value=max(power) if power else None, power_unit='W ERP (maximum polarization)' if power else None,
                       details_json={'source_record': row, 'record_kind': kind,
                                     'status_note': 'Snapshot or coordination record; does not prove current operation',
                                     'power_note': 'FM ERP fields explicitly in watts; digital ERP values retained raw because the CSV does not label their unit'})
            ds.add(out)


def parse(ctx, ds, source, path, url, stage_path=None):
    path = Path(path)
    {'fi_traficom': _parse_finland, 'dk_mastedatabasen': _parse_denmark,
     'ch_bakom': _parse_switzerland}[source](ctx, ds, path, url)
