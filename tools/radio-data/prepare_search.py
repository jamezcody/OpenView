"""Build immutable, offline navigation indexes from verified prepared snapshots.

This local-runtime builder streams radio records into SQLite and reuses pinned
park search. It writes only --output and never acquires or modifies source data.
"""
from __future__ import annotations

import argparse
from collections import Counter
import hashlib
import json
import math
from pathlib import Path
import re
import sqlite3
import unicodedata
import uuid
from urllib.parse import urlsplit

import prepare_radio as radio_prep

VERSION = 'openview-search-1.0.0'
MAX_FILE_BYTES = 12_000_000
MAX_ROWS = 100_000
SHORT_SOURCE = {
    'cl_subtel': 'SUBTEL', 'fi_traficom': 'Traficom', 'global_hfcc': 'HFCC',
    'global_osm': 'OpenStreetMap', 'global_ourairports': 'OurAirports',
    'global_satnogs': 'SatNOGS', 'pl_uke': 'UKE',
    'us_uls': 'FCC ULS', 'us_lms': 'FCC LMS',
}
RADIO_KINDS = {'transmitters': 'transmitter', 'receivers': 'receiver', 'candidates': 'radio-candidate'}
CATEGORY_LABELS = {'transmitters': 'Transmitter', 'receivers': 'Receiver', 'candidates': 'Candidate'}


def require(test, message):
    if not test:
        raise ValueError(message)


def encoded(value):
    return json.dumps(value, ensure_ascii=False, allow_nan=False, sort_keys=True, separators=(',', ':')).encode('utf-8') + b'\n'


def digest(data):
    return hashlib.sha256(data).hexdigest()


def read_json(path, maximum=1_048_576, expected=None):
    path = Path(path)
    require(path.stat().st_size <= maximum, f'Input byte cap exceeded: {path.name}')
    raw = path.read_bytes()
    if expected:
        require(len(raw) == expected['bytes'] and digest(raw) == expected['sha256'], f'Input checksum mismatch: {path.name}')
    return json.loads(raw), {'file': path.name, 'bytes': len(raw), 'sha256': digest(raw)}


def clean(value, limit=300):
    if value is None or isinstance(value, (dict, list, bool)):
        return ''
    value = re.sub(r'\s+', ' ', str(value)).strip()
    require(len(value) <= limit, f'Allowlisted field exceeds {limit} characters')
    require(not radio_prep.LOCAL_PATH.search(value), 'A local path reached the search allowlist')
    return value


def fold(value):
    return re.sub(r'\s+', ' ', ''.join(c for c in unicodedata.normalize('NFKD', value) if not unicodedata.combining(c)).lower()).strip()


def search_fold(value):
    """Match browser foldSearch for the persistent substring index."""
    text = ''.join(c for c in unicodedata.normalize('NFKD', value) if not '\u0300' <= c <= '\u036f').lower()
    return re.sub(r'\s+', ' ', ''.join(c if c == '.' or unicodedata.category(c)[0] in ('L', 'N') else ' ' for c in text)).strip()


def terms(values, displayed=()):
    # Visible name/detail/source are searched separately. Keep only additional
    # normalized phrases here, retaining full source IDs and frequency strings.
    known = {fold(clean(v, 1200)) for v in displayed if v}
    result = []
    for value in values:
        value = fold(clean(value, 1200))
        if value and value not in known:
            result.append(value)
            known.add(value)
    text = ' | '.join(result)
    require(len(text) <= 2400, 'Search terms exceed the per-record bound')
    return text


def safe_source_url(value):
    value = clean(value, 1200)
    parts = urlsplit(value)
    require(parts.scheme in ('https', 'http') and bool(parts.hostname) and not parts.username and not parts.password, 'Nonpublic source URL')
    require(radio_prep.safe_url(value) == value, 'Source URL was not already sanitized')
    return value


def finite_position(lat, lon):
    require(not isinstance(lat, bool) and not isinstance(lon, bool) and isinstance(lat, (int, float)) and isinstance(lon, (int, float)), 'Position must be numeric')
    require(math.isfinite(lat) and math.isfinite(lon) and abs(lat) <= 90 and abs(lon) <= 180, 'Position outside WGS84 range')


def radio_item(record, node):
    category = record['category']
    require(category in RADIO_KINDS and radio_prep.NODE_ID.fullmatch(node), 'Invalid radio locator')
    expected = hashlib.sha256((record['source'] + '\0' + record['source_record_id']).encode()).hexdigest()
    require(record['record_id'] == expected and record['id'] == category + ':' + expected, 'Radio identity differs from source identity')
    finite_position(record['lat'], record['lon'])
    details = record.get('details_json') or {}
    raw = details.get('source_record') or {}
    tags = details.get('tags') or {}
    names = [details.get('name'), details.get('site_name'), raw.get('StationName'), tags.get('name'), tags.get('name:en')]
    meaningful = [clean(v) for v in names if v]
    call = clean(record.get('call_sign'))
    name = meaningful[0] if meaningful else call or clean(record.get('operator')) or clean(record.get('site_id')) or record['source_record_id']
    if call and meaningful and fold(call) not in fold(name):
        name += ' (' + call + ')'
    source = SHORT_SOURCE.get(record['source'], record['source'])
    detail = ' · '.join(v for v in [CATEGORY_LABELS[category], record.get('country'), record.get('service')] if v)
    values = [record.get(k) for k in ('call_sign', 'source_record_id', 'site_id', 'operator', 'license_id', 'service', 'country', 'source', 'status')]
    values += meaningful + [details.get(k) for k in ('associated_airport', 'address', 'locality', 'band')]
    licensing = details.get('licensing') or {}
    values += [licensing.get('identifier'), details.get('application_id'), details.get('facility_id')]
    values += [raw.get('Municipality')] + [tags.get(k) for k in ('operator', 'ref', 'addr:city')]
    if record.get('frequency_mhz') is not None:
        values.append(f"{record['frequency_mhz']:g} MHz")
    if record.get('frequency_upper_mhz') is not None:
        values.append(f"{record['frequency_upper_mhz']:g} MHz")
    # Nominal worksheet bands remain labeled as nominal; no inferred exact RF.
    if details.get('nominal_band_mhz') is not None:
        values.append(f"nominal {details['nominal_band_mhz']:g} MHz")
    return {'id': 'r:' + expected[:24], 'kind': RADIO_KINDS[category], 'name': name,
            'detail': detail, 'terms': terms(values, (name, detail, source)),
            'lat': record['lat'], 'lon': record['lon'], 'height': 2500,
            'source': source, 'sourceUrl': safe_source_url(record['source_url']),
            'target': {'type': 'radio', 'recordId': record['id'], 'node': node, 'category': category}}


def compact_radio(items):
    """Losslessly compact the public item contract, with deterministic dictionaries."""
    sources = sorted({(v['source'], v['sourceUrl']) for v in items})
    details = sorted({v['detail'] for v in items})
    source_index, detail_index = {v: i for i, v in enumerate(sources)}, {v: i for i, v in enumerate(details)}
    codes = {'transmitters': 0, 'receivers': 1, 'candidates': 2}
    rows = [[v['target']['recordId'], v['target']['node'], codes[v['target']['category']], v['name'],
             detail_index[v['detail']], v['terms'], v['lat'], v['lon'], source_index[(v['source'], v['sourceUrl'])]] for v in items]
    return {'schemaVersion': 1, 'encoding': 'radio-tuples-v1',
            'sources': [{'name': name, 'url': url} for name, url in sources], 'details': details, 'items': rows}


def expand_radio(envelope):
    require(envelope['schemaVersion'] == 1 and envelope['encoding'] == 'radio-tuples-v1', 'Unknown radio search encoding')
    categories = ('transmitters', 'receivers', 'candidates')
    output = []
    for row in envelope['items']:
        require(isinstance(row, list) and len(row) == 9, 'Radio tuple must have nine columns')
        record_id, node, code, name, detail_index, text, lat, lon, source_index = row
        require(type(code) is int and 0 <= code < 3, 'Invalid tuple category code')
        require(type(detail_index) is int and 0 <= detail_index < len(envelope['details']), 'Invalid tuple detail index')
        require(type(source_index) is int and 0 <= source_index < len(envelope['sources']), 'Invalid tuple source index')
        require(re.fullmatch(categories[code] + r':[0-9a-f]{64}', record_id) and radio_prep.NODE_ID.fullmatch(node), 'Invalid tuple identity/locator')
        finite_position(lat, lon)
        source = envelope['sources'][source_index]
        output.append({'id': 'r:' + record_id.split(':')[1][:24], 'kind': RADIO_KINDS[categories[code]],
                       'name': name, 'detail': envelope['details'][detail_index], 'terms': text,
                       'lat': lat, 'lon': lon, 'height': 2500, 'source': source['name'], 'sourceUrl': source['url'],
                       'target': {'type': 'radio', 'recordId': record_id, 'node': node, 'category': categories[code]}})
    require(len({v['id'] for v in output}) == len(output), 'Duplicate compact radio identity')
    return output


def file_descriptor(path):
    sha = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            sha.update(chunk)
    return {'file': Path(path).name, 'bytes': Path(path).stat().st_size, 'sha256': sha.hexdigest()}


def write_radio_sqlite(path, items, radio_version):
    """Stream every record to disk; FTS and query result memory stay bounded."""
    db = sqlite3.connect(path)
    counts, sources = Counter(), Counter()
    try:
        db.executescript("""
          PRAGMA cache_size=-32768;
          PRAGMA temp_store=FILE;
          CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
          CREATE TABLE records(id TEXT UNIQUE NOT NULL,name TEXT NOT NULL,namefold TEXT NOT NULL,
            identityfold TEXT NOT NULL,textfold TEXT NOT NULL,search_text TEXT NOT NULL,payload TEXT NOT NULL);
          CREATE VIRTUAL TABLE radio_search USING fts5(search_text,content='records',content_rowid='rowid',tokenize='trigram',detail=none);
        """)
        batch = []
        labels = {'transmitter': 'Transmitter transmitters radio tower towers', 'receiver': 'Receiver receivers receiving station',
                  'radio-candidate': 'Uncertain radio site'}
        for item in items:
            item = dict(item, id='radio:' + item['target']['recordId'], release=radio_version)
            namefold, identityfold = search_fold(item['name']), search_fold(item['id'])
            textfold = search_fold(' '.join([item['name'], item['detail'], item['terms'], item['source'], labels[item['kind']]]))
            batch.append((item['id'], item['name'], namefold, identityfold, textfold, textfold + ' ' + identityfold,
                          json.dumps(item, ensure_ascii=False, allow_nan=False, separators=(',', ':'))))
            counts[item['kind']] += 1
            sources[item['source']] += 1
            if len(batch) == 1000:
                db.executemany('INSERT INTO records VALUES(?,?,?,?,?,?,?)', batch);db.commit();batch.clear()
        if batch:db.executemany('INSERT INTO records VALUES(?,?,?,?,?,?,?)', batch)
        count = sum(counts.values())
        db.executemany('INSERT INTO metadata VALUES(?,?)', [('encoding','radio-sqlite-v1'),('radioVersion',radio_version),('count',str(count))])
        db.commit()
        print(json.dumps({'phase':'radio search FTS index','records':count}), flush=True)
        db.execute("INSERT INTO radio_search(radio_search) VALUES('rebuild')")
        db.execute("INSERT INTO radio_search(radio_search) VALUES('optimize')")
        db.commit()
        require(db.execute('SELECT COUNT(*) FROM records').fetchone()[0] == count, 'SQLite search record count mismatch')
        require(db.execute('PRAGMA quick_check').fetchone()[0] == 'ok', 'SQLite search integrity check failed')
        # Check external-content index consistency, not merely table readability.
        db.execute("INSERT INTO radio_search(radio_search,rank) VALUES('integrity-check',1)")
        db.commit()
        return {'count':count,'counts':dict(counts),'sources':dict(sources)}
    finally:
        db.close()


def build_local_radio(public, output):
    public, output = Path(public).resolve(), Path(output).resolve()
    require(not output.is_relative_to(public), 'Build search into a staging folder outside the prepared input root')
    pointer, pointer_info = read_json(public / 'radio/latest.json')
    require(re.fullmatch(r'radio-[0-9a-f]{20}', pointer['version']), 'Unsafe radio version')
    require(pointer['manifest'] == f"versions/{pointer['version']}/manifest.json", 'Unexpected radio manifest path')
    radio_folder = public / 'radio/versions' / pointer['version']
    radio_manifest, radio_info = read_json(radio_folder / 'manifest.json')
    require(radio_info['sha256'] == pointer['sha256'], 'Radio manifest checksum mismatch')
    radio_prep.verify_dataset(radio_folder)

    # The park snapshot is unchanged. Reuse its already verified navigation
    # artifact rather than regenerating coordinates or carrying old radio locators.
    old_search, old_info = read_json(public / 'search/latest.json')
    park_manifest, park_info = read_json(public / 'parks/latest.json')
    require(re.fullmatch(r'search-[0-9a-f]{20}', old_search['version']), 'Unsafe search version')
    require(old_search['parkRelease'] == park_manifest['release'], 'Park search snapshot is stale')
    park_file = next(f for f in old_search['files'] if f['kind'] == 'parks')
    require(park_file['file'] == 'parks.json', 'Unsafe park search path')
    park_path = public / 'search' / old_search['version'] / park_file['file']
    parks, park_search_info = read_json(park_path, MAX_FILE_BYTES, park_file)
    require(parks['schemaVersion'] == 1 and len(parks['items']) == park_file['count'], 'Park search count mismatch')
    pages, source_counts = [], Counter()
    def records():
        for path in sorted((radio_folder / 'nodes').glob('*.json')):
            node, _ = read_json(path)
            for descriptor in node['recordPages']:
                rows, info = read_json(radio_folder / descriptor['file'], 262144, descriptor)
                pages.append([descriptor['file'],info['sha256']])
                for record in rows:
                    source_counts[record['source']] += 1
                    yield radio_item(record,node['id'])

    output.mkdir(parents=True,exist_ok=True)
    temp = output / ('radio-' + uuid.uuid4().hex + '.sqlite')
    try:
        stats = write_radio_sqlite(temp,records(),radio_manifest['version'])
        require(stats['count'] == sum(radio_manifest['counts'].values()), 'Radio search coverage differs from snapshot')
        radio_file = dict(file_descriptor(temp),kind='radio',file='radio.sqlite',encoding='radio-sqlite-v1',count=stats['count'])
        require(radio_file['bytes'] <= 8 * 1024**3, 'Radio SQLite artifact exceeds 8 GiB local disk budget')
        provenance = {'builder':VERSION,'builderSha256':digest(Path(__file__).read_bytes()),'mode':'local-sqlite',
                      'radioVersion':radio_manifest['version'],'radioPointer':pointer_info,'radioManifest':radio_info,
                      'radioRecordPageHashesSha256':digest(encoded(pages)),
                      'parkRelease':park_manifest['release'],'parkManifest':park_info,'parkSearch':park_search_info}
        version = 'search-' + digest(encoded(provenance))[:20]
        manifest = {'schemaVersion':2,'version':version,'createdAt':radio_manifest['createdAt'],
                    'radioVersion':radio_manifest['version'],'parkRelease':park_manifest['release'],
                    'files':[radio_file,dict(park_file)],
                    'stats':{'counts':stats['counts'],'radioPagesVerified':len(pages),'sourceCounts':dict(source_counts),
                             'limits':{'radioQueryResults':500,'radioQueryResponseBytes':2*1024**2,'sqliteCacheKiB':32768}},
                    'limitations':['Radio search requires the local OpenView runtime; the browser never downloads the SQLite database.',
                                   'Search is complete for the pinned prepared snapshots; records are not unique physical towers or proof of operation.']}
        folder = output / version;folder.mkdir(parents=True,exist_ok=True)
        target = folder / 'radio.sqlite'
        require(not target.exists() or file_descriptor(target) == {k:radio_file[k] for k in ('file','bytes','sha256')}, 'Immutable SQLite search output differs')
        if not target.exists():temp.replace(target)
        (folder/'parks.json').write_bytes(park_path.read_bytes())
        manifest_data=encoded(manifest)
        require(not (folder/'manifest.json').exists() or (folder/'manifest.json').read_bytes() == manifest_data,'Immutable search manifest differs')
        (folder/'manifest.json').write_bytes(manifest_data)
        (output/(version+'-integrity.json')).write_bytes(encoded({'result':'passed','version':version,'provenance':provenance,
                                                                'files':manifest['files'],'stats':manifest['stats'],'manifestSha256':digest(manifest_data)}))
        print(json.dumps({'phase':'complete','candidate':str(folder),'version':version,'files':manifest['files'],'stats':manifest['stats']}),flush=True)
        return manifest
    finally:
        if temp.exists():temp.unlink()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--public', type=Path, required=True, help='Prepared input root containing radio, parks and previous search')
    parser.add_argument('--output', type=Path, required=True, help='Separate staging directory for the new search release')
    args = parser.parse_args()
    build_local_radio(args.public, args.output)
