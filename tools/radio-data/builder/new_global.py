"""International public-source adapters; receiving and estimated sites retain their roles.

Schemas and live endpoints were checked on 2026-09-06. Reference-only sources
never invoke a downloader. No operator/administration code is geocoded into a
physical country, and paired DME tuning frequencies are not emitted RF values.
"""
import csv
import gzip
import hashlib
import html
import itertools
import json
import re
import zipfile
from datetime import datetime
from pathlib import Path
from urllib.parse import urlencode, urljoin

from core import NeedsImport, csv_rows, dms, number, text_stream


SOURCES = {
    'global_ourairports': {
        'name': 'Worldwide — OurAirports navigation aids', 'country': '', 'mode': 'automatic',
        'url': 'https://ourairports.com/data/', 'native_extensions': ['.csv'],
        'scope': 'Worldwide VOR/NDB/DME/TACAN navigation transmitter records. Associated DME positions are retained separately. DME/TACAN paired VHF tuning frequencies remain in details, not RF frequency. Operating status is unverified.',
        'license': 'Public domain', 'attribution': 'OurAirports — https://ourairports.com/data/'},
    'global_hfcc': {
        'name': 'Worldwide — HFCC shortwave schedules', 'country': '', 'mode': 'automatic',
        'url': 'https://new.hfcc.org/data/', 'native_extensions': ['.zip'],
        'scope': 'Latest published operational-season ZIP, with schedules joined to site.txt coordinates. Scheduled records are not observations of operation. Administration codes remain in details; physical country is unspecified.',
        'options': [{'key': 'season', 'label': 'Season (blank = latest published, e.g. A26)', 'default': ''}],
        'license': 'HFCC public data; copyright retained', 'attribution': 'HFCC — https://new.hfcc.org/data/'},
    'global_opencellid': {
        'name': 'Worldwide — OpenCellID estimated cells', 'country': '', 'mode': 'configured',
        'url': 'https://opencellid.org/downloads/', 'native_extensions': ['.csv', '.gz'],
        'scope': 'Estimated cellular positions go to candidates. Enter your API token and MCC(s), or import native CSV/CSV.GZ. Blank MCC downloads the full file. Exports cover observations from the last 18 months, not all towers. Refresh consumes provider download quota.',
        'options': [{'key': 'api_token', 'label': 'OpenCellID API token', 'default': '', 'secret': True},
                    {'key': 'mcc', 'label': 'MCCs separated by commas (blank = worldwide)', 'default': ''}],
        'license': 'CC BY-SA 4.0',
        'attribution': 'OpenCelliD Project is licensed under a Creative Commons Attribution-ShareAlike 4.0 International License — https://opencellid.org/'},
    'global_osm': {
        'name': 'Worldwide — OpenStreetMap communication structures', 'country': '', 'mode': 'configured',
        'url': 'https://wiki.openstreetmap.org/wiki/Tag:tower:type%3Dcommunication',
        'native_extensions': ['.json'],
        'scope': 'Communication towers/masts within a supplied regional bbox; structures go to candidates. Way/relation positions are bounding-box centers, not surveyed antenna positions. Import Overpass JSON for existing larger extracts. Public queries are capped at 25 square degrees.',
        'options': [{'key': 'bbox', 'label': 'Bounding box: south,west,north,east', 'default': ''}],
        'license': 'ODbL 1.0', 'attribution': '© OpenStreetMap contributors — https://www.openstreetmap.org/copyright'},
    'global_satnogs': {
        'name': 'Worldwide — SatNOGS receiving ground stations', 'country': '', 'mode': 'automatic',
        'url': 'https://network.satnogs.org/', 'native_extensions': ['.json'],
        'scope': 'Participating satellite receiving ground stations, including offline/testing stations. Saved to receivers, not transmitters. Antenna frequency bands describe reception capability.',
        'license': 'CC BY-SA 4.0',
        'attribution': 'SatNOGS Network — https://network.satnogs.org/; https://docs.satnogs.org/projects/satnogs-network/en/stable/api.html'},
    'global_itu': {
        'name': 'Worldwide — ITU BR IFIC / MIFR authorized export', 'country': '', 'mode': 'import',
        'url': 'https://www.itu.int/en/ITU-R/terrestrial/brific/Pages/default.aspx',
        'scope': 'Import an authorized flat CSV export using column mapping. ITU access/subscriptions and redistribution terms apply. Native BR IFIC databases and account login are not automated.'},
    'global_cellmapper': {
        'name': 'Worldwide — CellMapper reference map', 'country': '', 'mode': 'reference',
        'url': 'https://www.cellmapper.net/map',
        'scope': 'Reference link for visual inspection. No bulk download or scraper: a documented permitted open export was not verified. Adds no dataset records.'},
}

OURAIRPORTS_URL = 'https://davidmegginson.github.io/ourairports-data/navaids.csv'
SATNOGS_URL = 'https://network.satnogs.org/api/stations/?format=json'
OVERPASS_URL = 'https://overpass-api.de/api/interpreter'
OCID_COLUMNS = ['radio','mcc','net','area','cell','unit','lon','lat','range','samples','changeable','created','updated','averageSignal']


def _base(source, identifier, path, url):
    return {'source': source, 'country': '', 'source_record_id': str(identifier),
            'source_file': Path(path).name, 'source_url': url, 'source_crs': 'unspecified',
            'transmission_kind': 'unknown', 'location_kind': 'unknown'}


def _options(ctx, source):
    return getattr(ctx, 'options', {}).get(source, {})


def _hash(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


def _mhz(value):
    n = number(value)
    return n / 1000 if n is not None else None


def _bbox(value):
    try:
        parts = [float(v.strip()) for v in str(value).split(',')]
        south, west, north, east = parts
    except (ValueError, TypeError):
        raise NeedsImport('Set an OpenStreetMap bbox as south,west,north,east, or import Overpass JSON.')
    if not (-90 <= south < north <= 90 and -180 <= west < east <= 180):
        raise ValueError('Invalid bbox: require south < north and west < east within latitude/longitude limits. Split boxes crossing the date line.')
    if (north - south) * (east - west) > 25:
        raise ValueError('OpenStreetMap public queries are limited to 25 square degrees. Split the region or import an existing Overpass JSON extract.')
    return ','.join(format(v, '.12g') for v in parts)


def _osm_query(value):
    bbox = _bbox(value)
    # Structural tags only: bare masts are not necessarily radio installations.
    selectors = ['nwr["tower:type"="communication"]',
                 'nwr["man_made"="communications_tower"]']
    for service in ('mobile_phone', 'radio', 'television', 'microwave', 'amateur_radio'):
        selectors.append('nwr["man_made"~"^(mast|tower)$"]["communication:' + service + '"="yes"]')
    return '[out:json][timeout:45][bbox:' + bbox + '];(' + ';'.join(selectors) + ';);out center tags;'


def acquire(ctx, source):
    options = _options(ctx, source)
    if source == 'global_ourairports':
        yield ctx.download(OURAIRPORTS_URL, 'navaids.csv'), OURAIRPORTS_URL
    elif source == 'global_satnogs':
        # This endpoint currently returns the full array; paginated variants are supported.
        url = SATNOGS_URL
        seen = set()
        while url:
            if url in seen:
                raise ValueError('SatNOGS pagination repeated a page')
            if not url.startswith('https://network.satnogs.org/api/stations/'):
                raise ValueError('SatNOGS returned an unexpected pagination URL')
            seen.add(url)
            path = ctx.download(url, f'satnogs-stations-{len(seen)}.json')
            payload = json.loads(path.read_text(encoding='utf-8-sig'))
            yield path, url
            url = urljoin(url, payload.get('next')) if isinstance(payload, dict) and payload.get('next') else None
    elif source == 'global_hfcc':
        page = SOURCES[source]['url']
        text = ctx.download(page, 'hfcc-index.html').read_text(encoding='utf-8-sig')
        links = [urljoin(page, html.unescape(x)) for x in re.findall(r'href=[\"\']([^\"\']+allx2\.zip)[\"\']', text, re.I)]
        candidates = {}
        for link in links:
            m = re.search(r'/([ab])(\d{2})allx2\.zip$', link, re.I)
            if m:
                candidates[(int(m[2]), m[1].upper())] = link
        requested = str(options.get('season', '')).strip().upper()
        if requested:
            if not re.fullmatch(r'[AB]\d{2}', requested):
                raise ValueError('HFCC season must be A or B followed by two digits, such as A26')
            key = (int(requested[1:]), requested[0])
            if key not in candidates:
                raise ValueError('Requested HFCC season is not listed as a public operational ZIP: ' + requested)
        elif candidates:
            key = max(candidates, key=lambda k: (2000 + k[0] if k[0] < 90 else 1900 + k[0], k[1]))
        else:
            raise ValueError('HFCC index contains no recognized operational schedule ZIP')
        url = candidates[key]
        yield ctx.download(url, url.rsplit('/', 1)[1]), url
    elif source == 'global_opencellid':
        token = str(options.get('api_token', '')).strip()
        if not token:
            raise NeedsImport('Enter your OpenCellID API token in source options, or import a native CSV/CSV.GZ download from https://opencellid.org/downloads/.')
        mccs = [v.strip() for v in str(options.get('mcc', '')).split(',') if v.strip()]
        if any(not re.fullmatch(r'\d{3}', mcc) for mcc in mccs):
            raise ValueError('OpenCellID MCC must contain three-digit codes separated by commas')
        for mcc in dict.fromkeys(mccs or ['']):
            filename = mcc + '.csv.gz' if mcc else 'cell_towers.csv.gz'
            public_url = 'https://opencellid.org/ocid/downloads?' + urlencode({'type': 'mcc' if mcc else 'full', 'file': filename})
            url = public_url + '&' + urlencode({'token': token})
            ctx.sensitive_urls[url] = public_url
            path = ctx.download(url, filename, sensitive=True)
            # An auth error can arrive with HTTP 200; fail clearly without echoing it.
            with path.open('rb') as f:
                if f.read(2) != b'\x1f\x8b':
                    raise ValueError('OpenCellID did not return a GZIP export. Check your token, MCC availability and download quota, or import a downloaded CSV.')
            if url in ctx.retrieval_times:
                ctx.retrieval_times[public_url] = ctx.retrieval_times[url]
            yield path, public_url
    elif source == 'global_osm':
        query = '?' + urlencode({'data': _osm_query(options.get('bbox', ''))})
        url = OVERPASS_URL + query
        yield ctx.download(url, 'osm-communications.json', ('https://overpass.private.coffee/api/interpreter' + query,)), url
    elif source in ('global_itu', 'global_cellmapper'):
        raise NeedsImport(SOURCES[source]['scope'] + ' Open ' + SOURCES[source]['url'])
    else:
        raise ValueError('Unknown global source: ' + source)


def _ourairports(ctx, ds, path, url):
    required = {'id','ident','name','type','frequency_khz','latitude_deg','longitude_deg','iso_country'}
    for row, line in csv_rows(path):
        if not required <= row.keys():
            raise ValueError('OurAirports navaids CSV missing columns: ' + ', '.join(sorted(required - row.keys())))
        kind = row['type'].upper()
        supported = {'VOR','NDB','DME','TACAN','VOR-DME','NDB-DME','VORTAC'}
        if kind not in supported:
            ds.counts['excluded_unknown_navaid_type'] += 1
            continue
        details = {'name': row['name'], 'associated_airport': row.get('associated_airport'),
                   'elevation_ft_msl': row.get('elevation_ft'), 'usage_type': row.get('usageType'),
                   'power_class': row.get('power'), 'operating_status': 'not provided by source',
                   'dme_channel': row.get('dme_channel'), 'paired_dme_vhf_mhz': _mhz(row.get('dme_frequency_khz')),
                   'country_basis': 'source operating-country code, not a geospatial country lookup'}
        out = _base('global_ourairports', row['id'], path, url)
        out.update(country=row['iso_country'], call_sign=row['ident'], site_id=row['id'],
                   service=kind, latitude=row['latitude_deg'], longitude=row['longitude_deg'],
                   frequency_mhz=None if kind in ('DME','TACAN') else _mhz(row['frequency_khz']),
                   location_kind='fixed', transmission_kind='transmit', status='unknown', details_json=details)
        if kind in ('DME', 'TACAN'):
            details['paired_vhf_tuning_mhz'] = _mhz(row['frequency_khz'])
            details['frequency_note'] = 'Paired VHF tuning frequency is not the emitted DME/TACAN UHF frequency'
        ds.add(out)
        if kind in ('VOR-DME', 'NDB-DME', 'VORTAC'):
            dme_out = dict(out)
            dme_out.update(source_record_id=row['id'] + ':dme', service='DME/TACAN component',
                           latitude=row.get('dme_latitude_deg') or row['latitude_deg'],
                           longitude=row.get('dme_longitude_deg') or row['longitude_deg'], frequency_mhz=None,
                           details_json={**details, 'position_basis': 'DME coordinates when provided; otherwise co-located per source schema',
                                         'frequency_note': 'Paired VHF tuning frequency is not the emitted UHF frequency'})
            ds.add(dme_out)


def _hfcc_coord(value):
    m = re.fullmatch(r'(\d{1,3})([NSEW])(\d{2})', value.strip())
    return dms(m[1], m[3], 0, m[2]) if m else None


def _hfcc_date(value):
    try:
        return datetime.strptime(value, '%d%m%y').date().isoformat()
    except ValueError:
        return ''


def _hfcc(ctx, ds, path, url):
    with zipfile.ZipFile(path) as archive:
        members = {Path(n).name.lower(): n for n in archive.namelist()}
        if 'site.txt' not in members:
            raise ValueError('HFCC ZIP must include its site.txt coordinate reference')
        schedules = [n for n in archive.namelist() if re.fullmatch(r'[ab]\d{2}all\d+\.txt', Path(n).name, re.I)]
        if len(schedules) != 1:
            raise ValueError('Expected exactly one HFCC operational schedule text member')
        sites = {}
        for line in archive.read(members['site.txt']).decode('cp1252').splitlines():
            if not line.strip() or line.startswith(';'):
                continue
            parts = line.split()
            if len(parts) < 5:
                raise ValueError('Unsupported HFCC site reference row')
            code = parts[0]
            entry = {'name': ' '.join(parts[1:-3]), 'administration': parts[-3],
                     'lat': _hfcc_coord(parts[-2]), 'lon': _hfcc_coord(parts[-1])}
            if code in sites and sites[code] != entry:
                raise ValueError('HFCC site code has ambiguous coordinates: ' + code)
            sites[code] = entry
        broadcasters = {}
        if 'broadcas.txt' in members:
            for line in archive.read(members['broadcas.txt']).decode('cp1252').splitlines():
                if line.strip() and not line.startswith(';'):
                    broadcasters[line[:3].strip()] = line[4:].strip()
        found_header = False
        for line in archive.read(schedules[0]).decode('cp1252').splitlines():
            if line.startswith(';FREQ'):
                # Fixed field boundaries come from the supplied standard-format header.
                found_header = all(line[pos:pos+len(label)] == label for pos, label in
                                   ((6,'STRT'),(47,'LOC'),(51,'POWR'),(80,'FDATE'),(113,'ADM'),(117,'BRC')))
            if not line.strip() or line.startswith(';'):
                continue
            if not found_header or len(line) < 130:
                raise ValueError('Unsupported HFCC schedule column layout')
            code = line[47:50].strip()
            site = sites.get(code)
            if not site:
                ds.counts['excluded_hfcc_missing_site_reference'] += 1
                continue
            power = number(line[51:55])
            broadcaster = line[117:120].strip()
            out = _base('global_hfcc', Path(schedules[0]).stem + ':' + _hash(line), schedules[0], url)
            out.update(site_id=code, operator=broadcasters.get(broadcaster, broadcaster),
                       latitude=site['lat'], longitude=site['lon'], frequency_mhz=_mhz(line[:5]),
                       power_value=power, power_unit='kW', azimuth_deg=number(line[56:63]),
                       antenna_id=line[68:71].strip(), service='HF shortwave broadcast',
                       status='scheduled', expiration_date=_hfcc_date(line[87:93]),
                       location_kind='fixed', transmission_kind='transmit',
                       details_json={'site_name': site['name'], 'site_administration_code': site['administration'],
                                     'schedule_administration_code': line[113:116].strip(),
                                     'start_utc': line[6:10], 'stop_utc': line[11:15],
                                     'days': line[72:79], 'start_date': _hfcc_date(line[80:86]),
                                     'end_date': _hfcc_date(line[87:93]), 'language': line[102:112].strip(),
                                     'ciraf_zones': line[16:46].strip(), 'request_id': line[125:130].strip(),
                                     'modulation': line[94:95], 'schedule_file': schedules[0],
                                     'status_note': 'Scheduled, not observed; site coordinates have minute precision'})
            ds.add(out)


def _ocid(ctx, ds, path, url):
    with path.open('rb') as check:
        compressed = check.read(2) == b'\x1f\x8b'
    with (gzip.open(path, 'rb') if compressed else path.open('rb')) as raw:
        with text_stream(raw) as stream:
            reader = csv.reader(stream)
            first = next(reader, None)
            if first is None:
                raise ValueError('OpenCellID export is empty')
            first = [cell.strip() for cell in first]
            has_header = first[0].lower() == 'radio'
            columns = first if has_header else OCID_COLUMNS
            if not set(OCID_COLUMNS) <= set(columns):
                raise ValueError('Unsupported OpenCellID column header')
            for index, values in enumerate(reader if has_header else itertools.chain([first], reader), 1):
                if not values:
                    continue
                if len(values) != len(columns):
                    raise ValueError(f'OpenCellID row {index}: expected {len(columns)} columns, found {len(values)}')
                row = dict(zip(columns, values))
                if not re.fullmatch(r'\d{3}', row['mcc']) or not all(re.fullmatch(r'\d+', row[k]) for k in ('net','area','cell')):
                    raise ValueError(f'OpenCellID row {index}: invalid cell identity')
                identifier = ':'.join(row[k] for k in ('radio','mcc','net','area','cell'))
                out = _base('global_opencellid', identifier, path, url)
                out.update(site_id=identifier, latitude=row['lat'], longitude=row['lon'], service=row['radio'],
                           transmission_kind='transmit', location_kind='estimated', status='observed',
                           details_json={**row, 'coordinate_basis': 'Community-derived estimated cell position',
                                         'license': 'CC BY-SA 4.0', 'attribution': SOURCES['global_opencellid']['attribution']})
                ds.add(out)


def _osm(ctx, ds, path, url):
    payload = json.loads(path.read_text(encoding='utf-8-sig'))
    if not isinstance(payload, dict) or not isinstance(payload.get('elements'), list):
        raise ValueError('Expected an Overpass JSON object containing elements')
    if payload.get('remark'):
        raise ValueError('Overpass reported an incomplete query: ' + str(payload['remark']))
    for element in payload['elements']:
        kind = element.get('type')
        if kind not in ('node', 'way', 'relation'):
            continue
        tags = element.get('tags') or {}
        communication = tags.get('tower:type') == 'communication' or tags.get('man_made') == 'communications_tower'
        communication |= tags.get('man_made') in ('mast','tower') and any(tags.get('communication:' + s) == 'yes' for s in ('mobile_phone','radio','television','microwave','amateur_radio'))
        if not communication:
            ds.counts['excluded_osm_noncommunication_elements'] += 1
            continue
        position = element if kind == 'node' else element.get('center', {})
        identifier = kind + '/' + str(element['id'])
        out = _base('global_osm', identifier, path, url)
        out.update(site_id=identifier, operator=tags.get('operator'), latitude=position.get('lat'), longitude=position.get('lon'),
                   source_crs='EPSG:4326', country=tags.get('addr:country', '').upper(),
                   service='communications structure', transmission_kind='unknown', location_kind='structure',
                   status='mapped', details_json={'tags': tags, 'osm_url': 'https://www.openstreetmap.org/' + identifier,
                                                 'coordinate_basis': 'OSM node' if kind == 'node' else 'Overpass bounding-box center',
                                                 'license': 'ODbL 1.0', 'attribution': SOURCES['global_osm']['attribution']})
        ds.add(out)


def _satnogs(ctx, ds, path, url):
    payload = json.loads(path.read_text(encoding='utf-8-sig'))
    rows = payload.get('results') if isinstance(payload, dict) else payload
    if not isinstance(rows, list):
        raise ValueError('Unsupported SatNOGS stations JSON response')
    for row in rows:
        if not {'id','name','lat','lng'} <= row.keys():
            raise ValueError('SatNOGS station response missing id/name/lat/lng')
        antennas = row.get('antenna') or [{}]
        for index, antenna in enumerate(antennas):
            low, high = number(antenna.get('frequency')), number(antenna.get('frequency_max'))
            out = _base('global_satnogs', str(row['id']) + ':' + str(index), path, url)
            out.update(site_id=str(row['id']), antenna_id=str(index), operator=row.get('owner'),
                       latitude=row['lat'], longitude=row['lng'], location_kind='fixed',
                       transmission_kind='receive', retain_receiver=True,
                       service='satellite reception', status=row.get('status', 'unknown'),
                       frequency_mhz=low/1e6 if low is not None else None,
                       frequency_upper_mhz=high/1e6 if high is not None else None,
                       details_json={'name': row['name'], 'last_seen': row.get('last_seen'),
                                     'testing': row.get('testing'), 'is_connected': row.get('is_connected'),
                                     'is_available': row.get('is_available'), 'altitude_m_msl': row.get('altitude'),
                                     'antenna_type': antenna.get('antenna_type'), 'band': antenna.get('band'),
                                     'station_url': 'https://network.satnogs.org/stations/' + str(row['id']) + '/',
                                     'frequency_role': 'receiver tuning range, not transmission'})
            ds.add(out)


def parse(ctx, ds, source, path, url, stage_path=None):
    parsers = {'global_ourairports': _ourairports, 'global_hfcc': _hfcc,
               'global_opencellid': _ocid, 'global_osm': _osm, 'global_satnogs': _satnogs}
    if source not in parsers:
        raise NeedsImport(SOURCES[source]['scope'])
    parsers[source](ctx, ds, Path(path), url)
