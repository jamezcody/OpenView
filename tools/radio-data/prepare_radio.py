"""Prepare immutable, bounded radio-site map assets from an existing builder run.

This tool never acquires data and does not modify the executable or source run.
Only Python's standard library is required. Builder schema constants are read
from core.py using AST literal evaluation, without importing its GUI/GIS runtime.
"""
from __future__ import annotations
import argparse, ast, collections, hashlib, json, math, os, re, shutil, sqlite3, sys, tempfile, uuid
from datetime import datetime, timezone
from pathlib import Path, PureWindowsPath
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

VERSION = 'radio-prep-4'
PAGE_BYTES = 256 * 1024
DESCRIPTOR_BYTES = 1024 * 1024
SUMMARY_ROWS = 256
RECORD_ROWS = 64
MAX_DEPTH = 12
LEAF_ROWS = 128
MAX_INPUT_ROW_BYTES = 2 * 1024 * 1024
PUBLIC_SOURCE_FIELDS = ('name', 'country', 'mode', 'url', 'scope', 'license', 'attribution')
PUBLIC_DOWNLOAD_FIELDS = ('url', 'resolved_url', 'retrieved_at', 'bytes', 'sha256', 'last_modified', 'cache_reused')
SECRET_KEYS = {'token','apitoken','apikey','key','accesstoken','refreshtoken','password','passwd','secret','clientsecret','authorization','credentials','credential','cookie','session','sessionid'}
LOCAL_PATH = re.compile(r'(?i)(?:(?<![a-z0-9_])[a-z]:[\\/]|\\\\|file://)')
IDENTIFIER = re.compile(r'^[0-9a-f]{64}$')
NODE_ID = re.compile(r'^r[0-3]{0,12}$')
DATA_VERSION = re.compile(r'^radio-[0-9a-f]{20}$')

def utc():
    return datetime.now(timezone.utc).isoformat(timespec='seconds')

def encoded(value):
    return json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(',', ':')).encode('utf-8')

def digest_file(path):
    digest = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()

def bounded_json(path, limit=8 * 1024 * 1024):
    path = Path(path)
    if path.stat().st_size > limit:
        raise ValueError(f'JSON input exceeds {limit} bytes: {path.name}')
    return json.loads(path.read_text(encoding='utf-8-sig'))

def key_is_secret(key):
    key = re.sub('[^a-z0-9]', '', str(key).lower())
    return key in SECRET_KEYS or key.endswith(('password','secret','apitoken','accesstoken','apikey'))

def safe_url(value):
    try:
        parts = urlsplit(value)
        if parts.scheme.lower() not in ('https','http') or not parts.hostname:
            return '[non-web URL omitted]'
        host = parts.hostname
        if ':' in host:
            host = '[' + host + ']'
        if parts.port:
            host += ':' + str(parts.port)
        query = [(k, '[REDACTED]' if key_is_secret(k) else v) for k,v in parse_qsl(parts.query, keep_blank_values=True)]
        return urlunsplit((parts.scheme.lower(), host, parts.path, urlencode(query), parts.fragment))
    except (TypeError, ValueError):
        return '[invalid URL omitted]'

def sanitize(value, depth=0):
    if depth > 20:
        raise ValueError('Metadata nesting exceeds 20 levels')
    if isinstance(value, dict):
        return {str(k): '[REDACTED]' if key_is_secret(k) else sanitize(v, depth+1)
                for k,v in value.items() if k not in ('import_mapping',)}
    if isinstance(value, list):
        return [sanitize(v, depth+1) for v in value]
    if isinstance(value, str):
        if value.startswith(('https://','http://')):
            return safe_url(value)
        if LOCAL_PATH.search(value) or value.startswith(('/Users/','/home/','/tmp/')):
            return '[local path omitted]'
        # Errors may contain a URL embedded in explanatory text.
        value = re.sub(r'https?://[^\s<>"\']+', lambda m: safe_url(m[0]), value)
        value = re.sub(r'(?i)\bBearer\s+[A-Za-z0-9._~+/=-]+', 'Bearer [REDACTED]', value)
        return value
    if value is None or isinstance(value, (bool,int)):
        return value
    if isinstance(value, float) and math.isfinite(value):
        return value
    raise ValueError('Unsupported or non-finite metadata value')

def basename(value):
    value = str(value or '').replace('\\', '/')
    return value.rsplit('/', 1)[-1]

def load_schema(builder):
    tree = ast.parse((Path(builder) / 'core.py').read_text(encoding='utf-8-sig'))
    values = {}
    for node in tree.body:
        if isinstance(node, ast.Assign):
            for target in node.targets:
                if isinstance(target, ast.Name) and target.id in ('FIELDS', 'TABLES'):
                    values[target.id] = ast.literal_eval(node.value)
    fields, tables = values.get('FIELDS'), values.get('TABLES')
    if not isinstance(fields, list) or tuple(tables or ()) != ('transmitters','candidates','receivers'):
        raise ValueError('Unsupported builder schema constants')
    if not all(isinstance(f,str) and re.fullmatch(r'[a-z_]+',f) for f in fields):
        raise ValueError('Unsafe builder field name')
    required = {'record_id','source','source_record_id','latitude','longitude','details_json','frequency_mhz','frequency_upper_mhz'}
    if not required <= set(fields):
        raise ValueError('Required normalized builder fields are absent')
    return fields, tuple(tables)

def resolve_run(builder_output):
    output = Path(builder_output).resolve(strict=True)
    pointer = bounded_json(output / 'latest.json', 16384)
    if pointer.get('status') not in ('complete','partial'):
        raise ValueError('Builder latest pointer is not a completed usable export')
    raw = pointer.get('run_directory')
    if not isinstance(raw,str):
        raise ValueError('Builder latest pointer has no run directory')
    run = Path(raw)
    if not run.is_absolute():
        run = output / run
    run = run.resolve(strict=True)
    runs = (output / 'runs').resolve(strict=True)
    if not run.is_relative_to(runs) or run.parent != runs:
        raise ValueError('Builder latest pointer escapes its published runs directory')
    report = bounded_json(run / 'report.json')
    if report.get('status') not in ('complete','partial') or report.get('run_id') != run.name:
        raise ValueError('Builder run is unfinished or its identity does not match')
    return run, report

def public_sources(catalog, report):
    selected = {s['id']:s for s in report.get('sources', [])}
    if not set(selected) <= set(catalog):
        raise ValueError('Run report references unknown source catalog entries')
    result = []
    for source_id, spec in catalog.items():
        source = selected.get(source_id)
        item = {'id':source_id, **{k:sanitize(spec[k]) for k in PUBLIC_SOURCE_FIELDS if k in spec}}
        item.update(status=source.get('status','unknown') if source else 'unselected', counts={})
        if source:
            for key in ('input_mode','coverage','message','counts'):
                if key in source:
                    item[key] = sanitize(source[key])
            if source.get('files'):
                item['files'] = [basename(v) for v in source['files']]
            options = source.get('requested_options', {})
            public_options = {k:sanitize(v) for k,v in options.items() if k in ('bbox','season','mcc')}
            if public_options:
                item['requested_options'] = public_options
        result.append(item)
    return result

def child_bounds(bounds, digit):
    west,south,east,north = bounds
    midx,midy = (west+east)/2,(south+north)/2
    return [midx if digit & 1 else west, midy if digit & 2 else south,
            east if digit & 1 else midx, north if digit & 2 else midy]

def leaf_path(lon, lat, depth=MAX_DEPTH):
    bounds = [-180.0,-90.0,180.0,90.0]
    path = 'r'
    for _ in range(depth):
        digit = int(lon >= (bounds[0]+bounds[2])/2) + 2*int(lat >= (bounds[1]+bounds[3])/2)
        path += str(digit)
        bounds = child_bounds(bounds, digit)
    return path

def normalized_record(raw, category, fields, catalog):
    source = raw['source']
    if source not in catalog or not IDENTIFIER.fullmatch(raw['record_id'] or ''):
        raise ValueError('Unknown source or malformed record identity')
    if not isinstance(raw['source_record_id'],str):
        raise ValueError('Missing source record identity')
    identity = hashlib.sha256((source+'\0'+raw['source_record_id']).encode()).hexdigest()
    if identity != raw['record_id']:
        raise ValueError('Record identity does not match builder source identity')
    lat,lon = raw['latitude'],raw['longitude']
    if not all(isinstance(v,(int,float)) and math.isfinite(v) for v in (lat,lon)) or not -90<=lat<=90 or not -180<=lon<=180:
        raise ValueError('Invalid normalized record coordinate')
    row = {k:raw[k] for k in fields}
    row['source_file'] = basename(row.get('source_file'))
    details = row.get('details_json')
    if details:
        if len(details.encode('utf-8')) > MAX_INPUT_ROW_BYTES:
            raise ValueError('Input record details exceed 2 MiB')
        details = json.loads(details)
        if not isinstance(details,dict):
            raise ValueError('Record details must be an object')
    row['details_json'] = details or {}
    row = sanitize(row)
    row.update(category=category, id=category+':'+raw['record_id'], lat=lat, lon=lon)
    return row

def write_json(path, value, max_bytes=None):
    body = encoded(value)
    if max_bytes is not None and len(body) > max_bytes:
        raise ValueError(f'{path.name} exceeds the {max_bytes}-byte descriptor limit')
    path.parent.mkdir(parents=True,exist_ok=True)
    path.write_bytes(body)
    return {'file':path.name, 'bytes':len(body), 'sha256':hashlib.sha256(body).hexdigest()}

def write_pages(folder, relative_prefix, records, max_rows, counter):
    pages, page, page_bytes = [], [], 2
    def flush():
        nonlocal page,page_bytes
        if not page:
            return
        rel = f'{relative_prefix}-{len(pages):04d}.json'
        meta = write_json(folder / rel, page)
        meta['file'] = rel.replace('\\','/')
        if meta['bytes'] > PAGE_BYTES:
            raise ValueError('Output page exceeds its byte budget')
        pages.append(meta)
        counter['files'] += 1
        counter['bytes'] += meta['bytes']
        counter['largestPageBytes'] = max(counter['largestPageBytes'],meta['bytes'])
        page,page_bytes = [],2
    for row in records:
        size = len(encoded(row))
        if size+2 > PAGE_BYTES:
            raise ValueError('One record or group exceeds the 256 KiB page limit')
        extra = size + bool(page)
        if len(page) >= max_rows or page_bytes+extra > PAGE_BYTES:
            flush()
            extra = size
        page.append(row)
        page_bytes += extra
    flush()
    return pages

def atomic_pointer(output, version, manifest_hash):
    pointer = {'schemaVersion':1,'version':version,'manifest':f'versions/{version}/manifest.json','sha256':manifest_hash}
    handle, temporary = tempfile.mkstemp(prefix='.latest-', suffix='.tmp', dir=output)
    try:
        with os.fdopen(handle,'wb') as stream:
            stream.write(encoded(pointer))
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, output/'latest.json')
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)

def verify_dataset(folder):
    folder = Path(folder).resolve(strict=True)
    manifest = bounded_json(folder/'manifest.json',DESCRIPTOR_BYTES)
    version = manifest.get('version')
    if manifest.get('schemaVersion') != 1 or not isinstance(version,str) or not DATA_VERSION.fullmatch(version):
        raise ValueError('Invalid manifest schema or immutable version')
    if DATA_VERSION.fullmatch(folder.name) and folder.name != version:
        raise ValueError('Version directory does not match its manifest identity')
    required_hashes = ('dbSha256','reportSha256','catalogSha256','schemaSha256')
    if not all(isinstance(manifest.get(k),str) and IDENTIFIER.fullmatch(manifest[k]) for k in required_hashes):
        raise ValueError('Manifest input checksums are invalid')
    identity_fields = [manifest.get('preparationVersion'),*(manifest[k] for k in required_hashes), manifest.get('maxDepth'),manifest.get('leafRecordLimit')]
    if 'enrichmentSha256' in manifest:
        if not IDENTIFIER.fullmatch(manifest['enrichmentSha256']): raise ValueError('Invalid cell enrichment identity')
        identity_fields.append(manifest['enrichmentSha256'])
    expected_identity = hashlib.sha256(encoded(identity_fields)).hexdigest()
    if version != 'radio-'+expected_identity[:20]:
        raise ValueError('Immutable version does not match its content provenance')
    seen = set()
    queue = [('r',[-180,-90,180,90])]
    category_counts = collections.Counter()
    network_counts, root_network_counts = collections.Counter(), collections.Counter()
    expected_total = sum(manifest['counts'].get(t,0) for t in ('transmitters','candidates','receivers'))
    while queue:
        node_id,expected_bounds = queue.pop()
        if not NODE_ID.fullmatch(node_id) or node_id in seen:
            raise ValueError('Unsafe or duplicate node identity')
        seen.add(node_id)
        node_path = (folder/'nodes'/(node_id+'.json')).resolve(strict=True)
        if not node_path.is_relative_to(folder):
            raise ValueError('Node descriptor escapes its version directory')
        node = bounded_json(node_path,DESCRIPTOR_BYTES)
        if node['id'] != node_id or node['bounds'] != expected_bounds:
            raise ValueError('Node bounds or identity mismatch')
        if node.get('children') and node.get('recordPages'):
            raise ValueError('Internal node unexpectedly contains record pages')
        if len(node['children'])>4:
            raise ValueError('Node has more than four children')
        for child in node['children']:
            if child[:-1] != node_id or child[-1] not in '0123':
                raise ValueError('Invalid child node path')
            queue.append((child,child_bounds(expected_bounds,int(child[-1]))))
        summary_count = 0
        coarse_expected, coarse_actual = collections.Counter(), collections.Counter()
        coarse_fields = ('category','source','country','service','status','network')
        for kind in ('summaryPages','overviewPages','recordPages'):
            for page in node.get(kind, []):
                rel = page['file']
                if not isinstance(rel,str) or not re.fullmatch(r'(summary|overview|records)/r[0-3]{0,12}-\d{4,}\.json',rel):
                    raise ValueError('Unsafe page path')
                path = (folder/rel).resolve(strict=True)
                if not path.is_relative_to(folder) or path.stat().st_size != page['bytes'] or page['bytes'] > PAGE_BYTES:
                    raise ValueError('Page byte count or path mismatch')
                if digest_file(path) != page['sha256']:
                    raise ValueError('Page checksum mismatch')
                rows = bounded_json(path,PAGE_BYTES)
                if not isinstance(rows,list) or len(rows) > (RECORD_ROWS if kind=='recordPages' else SUMMARY_ROWS):
                    raise ValueError('Invalid page row count')
                if kind == 'summaryPages':
                    summary_count += sum(r['count'] for r in rows)
                    for row in rows:
                        coarse_expected[tuple(row.get(field) or '' for field in coarse_fields)] += row['count']
                    if node_id == 'r':
                        for row in rows: root_network_counts[row.get('network') or ''] += row['count']
                elif kind == 'overviewPages':
                    for row in rows:
                        if row.get('frequency_mhz') is not None or row.get('frequency_upper_mhz') is not None:
                            raise ValueError('Overview groups must not imply an exact frequency')
                        coarse_actual[tuple(row.get(field) or '' for field in coarse_fields)] += row['count']
                else:
                    category_counts.update(r['category'] for r in rows)
                    network_counts.update(r.get('network') or '' for r in rows)
        if summary_count != node['count']:
            raise ValueError('Node summary counts do not match its record count')
        if 'overviewPages' in node and coarse_actual != coarse_expected:
            raise ValueError('Overview filter tuples differ from exact frequency summaries')
        if node_id=='r' and summary_count != expected_total:
            raise ValueError('Root count does not match manifest')
    if dict(category_counts) != {k:v for k,v in manifest['counts'].items() if v}:
        raise ValueError('Leaf records do not match category totals')
    if network_counts != root_network_counts:
        raise ValueError('Network summary counts differ from leaf records')
    if 'networks' in manifest['facets'] and set(network_counts) != set(manifest['facets']['networks']):
        raise ValueError('Network facets differ from leaf records')
    return manifest

def prepare(builder, builder_output, output, fail_after_nodes=None, cell_reference=None):
    builder,output = Path(builder).resolve(strict=True),Path(output).resolve()
    run,report = resolve_run(builder_output)
    fields,tables = load_schema(builder)
    catalog = bounded_json(builder/'sources.json')
    db_path = (run/'dataset.sqlite').resolve(strict=True)
    if db_path.parent != run:
        raise ValueError('Dataset database escapes the published run')
    db_hash,report_hash = digest_file(db_path),digest_file(run/'report.json')
    catalog_hash = digest_file(builder/'sources.json')
    schema_hash = hashlib.sha256(encoded([fields,tables])).hexdigest()
    reference = bounded_json(cell_reference) if cell_reference else None
    enrichment_hash = digest_file(cell_reference) if cell_reference else None
    if reference and (reference.get('mncWidth') != 3 or reference.get('source') != 'https://imsiadmin.com/assignments/hni/' or not isinstance(reference.get('networks'),dict)):
        raise ValueError('Unsupported cell network reference')
    if reference and output.name == 'radio': raise ValueError('Cell data must use a separate asset root; never replace /radio')
    identity_fields = [VERSION,db_hash,report_hash,catalog_hash,schema_hash,MAX_DEPTH,LEAF_ROWS]
    if enrichment_hash: identity_fields.append(enrichment_hash)
    identity = hashlib.sha256(encoded(identity_fields)).hexdigest()
    version = 'radio-'+identity[:20]
    output.mkdir(parents=True,exist_ok=True)
    (output/'versions').mkdir(exist_ok=True)
    final = output/'versions'/version
    if final.exists():
        manifest = verify_dataset(final)
        if manifest['dbSha256'] != db_hash or manifest['reportSha256'] != report_hash:
            raise ValueError('Existing immutable version has conflicting provenance')
        atomic_pointer(output,version,digest_file(final/'manifest.json'))
        return manifest
    # Explicit workspace creation inherits its Windows ACL. tempfile.mkdtemp's
    # private ACL can exclude a restricted desktop execution token.
    staging = output/('.preparing-'+uuid.uuid4().hex)
    staging.mkdir()
    scratch_path = staging/'scratch.sqlite'
    scratch = sqlite3.connect(scratch_path)
    source = sqlite3.connect(db_path.as_uri()+'?mode=ro',uri=True)
    source.row_factory = sqlite3.Row
    try:
        scratch.executescript('''PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF;
          CREATE TABLE records (id TEXT PRIMARY KEY,path TEXT,category TEXT,source TEXT,country TEXT,service TEXT,status TEXT,network TEXT,
            frequency_mhz REAL,frequency_upper_mhz REAL,lat REAL,lon REAL,json TEXT);
        ''')
        counts = collections.Counter()
        facets = {k:set() for k in ('sources','countries','services','statuses','networks')}
        network_labels = {}
        for category in tables:
            schema = [r['name'] for r in source.execute(f'PRAGMA table_info({category})')]
            if schema != fields:
                raise ValueError('Published database columns differ from the builder schema')
            batch=[]
            for raw in source.execute(f'SELECT * FROM {category} ORDER BY record_id'):
                row = normalized_record(dict(raw),category,fields,catalog)
                if reference:
                    from cell_enrichment import enrich_cell
                    row, label = enrich_cell(row, reference)
                    network_labels[row['network']] = label
                network = row.get('network') or ''
                countries = row.get('country') or ''
                service,status = row.get('service') or '',row.get('status') or ''
                batch.append((row['id'],leaf_path(row['lon'],row['lat']),category,row['source'],countries,service,status,network,
                              row['frequency_mhz'],row['frequency_upper_mhz'],row['lat'],row['lon'],encoded(row).decode('utf-8')))
                counts[category]+=1
                for facet,value in (('sources',row['source']),('countries',countries),('services',service),('statuses',status),('networks',network)):
                    facets[facet].add(value)
                if len(batch)>=1000:
                    scratch.executemany('INSERT INTO records VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',batch)
                    batch=[]
            if batch:
                scratch.executemany('INSERT INTO records VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',batch)
        for category in tables:
            if counts[category] != report.get('counts',{}).get(category,0):
                raise ValueError('Published database count does not match the source report')
        if not sum(counts.values()):
            raise ValueError('Cannot publish an empty map dataset')
        scratch.execute('CREATE INDEX records_path ON records(path)')
        scratch.commit()
        stats = collections.Counter({'records':sum(counts.values()),'files':0,'bytes':0,'largestPageBytes':0})
        queue = [('r',[-180,-90,180,90])]
        while queue:
            node_id,bounds = queue.pop()
            low,high = node_id,node_id+'\uffff'
            count = scratch.execute('SELECT count(*) FROM records WHERE path>=? AND path<?',(low,high)).fetchone()[0]
            children=[]
            if count > LEAF_ROWS and len(node_id)-1 < MAX_DEPTH:
                for digit in range(4):
                    child = node_id+str(digit)
                    if scratch.execute('SELECT 1 FROM records WHERE path>=? AND path<? LIMIT 1',(child,child+'\uffff')).fetchone():
                        children.append(child)
                        queue.append((child,child_bounds(bounds,digit)))
            def summaries():
                sql = '''SELECT category,source,country,service,status,network,frequency_mhz,frequency_upper_mhz,count(*),avg(lat),avg(lon)
                    FROM records WHERE path>=? AND path<? GROUP BY category,source,country,service,status,network,frequency_mhz,frequency_upper_mhz
                    ORDER BY category,source,country,service,status,network,frequency_mhz,frequency_upper_mhz'''
                keys = ('category','source','country','service','status','network','frequency_mhz','frequency_upper_mhz','count','lat','lon')
                for row in scratch.execute(sql,(low,high)):
                    yield dict(zip(keys,row))
            summary_pages = write_pages(staging,'summary/'+node_id,summaries(),SUMMARY_ROWS,stats)
            def overviews():
                sql = '''SELECT category,source,country,service,status,network,NULL,NULL,count(*),avg(lat),avg(lon)
                    FROM records WHERE path>=? AND path<? GROUP BY category,source,country,service,status,network
                    ORDER BY category,source,country,service,status,network'''
                keys = ('category','source','country','service','status','network','frequency_mhz','frequency_upper_mhz','count','lat','lon')
                for row in scratch.execute(sql,(low,high)):
                    yield dict(zip(keys,row))
            overview_pages = write_pages(staging,'overview/'+node_id,overviews(),SUMMARY_ROWS,stats)
            record_pages=[]
            if not children:
                records=(json.loads(r[0]) for r in scratch.execute('SELECT json FROM records WHERE path>=? AND path<? ORDER BY id',(low,high)))
                record_pages = write_pages(staging,'records/'+node_id,records,RECORD_ROWS,stats)
                stats['leaves']+=1
            else:
                stats['branches']+=1
            node = {'id':node_id,'bounds':bounds,'count':count,'children':children,'summaryPages':summary_pages,'overviewPages':overview_pages,'recordPages':record_pages}
            meta=write_json(staging/'nodes'/(node_id+'.json'),node,DESCRIPTOR_BYTES)
            stats['files']+=1
            stats['bytes']+=meta['bytes']
            stats['nodes']+=1
            if fail_after_nodes is not None and stats['nodes']>=fail_after_nodes:
                raise ValueError('Injected preparation failure before publication')
        sources = public_sources(catalog,report)
        public_report = {'builderVersion':report.get('version'),'runId':report['run_id'],'status':report['status'],
                         'startedAt':report.get('started_at'),'finishedAt':report.get('finished_at'),
                         'scope':sanitize(report.get('scope')),'activeOnly':report.get('active_only',False),
                         'counts':sanitize(report.get('counts',{})), 'sources':sources,
                         'downloads':[{k:sanitize(v) for k,v in entry.items() if k in PUBLIC_DOWNLOAD_FIELDS} for entry in report.get('downloads',[])]}
        manifest = {'schemaVersion':1,'version':version,'createdAt':utc(),'preparationVersion':VERSION,
                    'builderRun':report['run_id'],'builderVersion':report.get('version'),'dbSha256':db_hash,'reportSha256':report_hash,
                    'catalogSha256':catalog_hash,'schemaSha256':schema_hash,
                    'counts':{category:counts[category] for category in tables},'sources':sources,'coverage':public_report,
                    'facets':{key:sorted(values) for key,values in facets.items()},
                    'root':'nodes/r.json','spatialScheme':'geographic-quadtree','bounds':[-180,-90,180,90],
                    'maxDepth':MAX_DEPTH,'leafRecordLimit':LEAF_ROWS,'pageByteLimit':PAGE_BYTES,
                    'summaryPageRowLimit':SUMMARY_ROWS,'recordPageRowLimit':RECORD_ROWS,'statistics':dict(stats),
                    'interpretation':['Counts describe source records, authorizations, antennas, frequencies or components, not unique physical towers.',
                      'An empty area means no matching records in this selected-source snapshot; it does not establish that no transmitters exist.',
                      'A licence, schedule or commissioning date does not prove present operation.',
                      'Receiver frequency ranges describe reception capability. Site locations do not imply cellular coverage or signal strength.']}
        if reference:
            from cell_enrichment import SCOPE
            manifest.update(datasetKind='cell-locations',scope=SCOPE,enrichmentSha256=enrichment_hash,
                networkLabels=network_labels,networkReference={k:reference[k] for k in ('source','sourceSha256','retrievedAt','mncWidth')},
                interpretation=['Estimated cell records, not physical towers or coverage. Multiple cells may share one mast.',
                  'MCC scope identifies U.S. networks; physical country is not inferred.',
                  'Network allocation labels identify current assignees, not mast owners or historical operators.',
                  'Last-seen timestamps and contributed measurement counts do not establish current operation.'])
        scratch.close()
        scratch=None
        scratch_path.unlink()
        write_json(staging/'manifest.json',manifest,DESCRIPTOR_BYTES)
        verify_dataset(staging)
        # Recheck source integrity before publication. A concurrent builder/user mutation
        # cannot silently publish assets labelled with the old checksum.
        if digest_file(db_path)!=db_hash or digest_file(run/'report.json')!=report_hash:
            raise ValueError('Published builder inputs changed during preparation')
        if cell_reference and digest_file(cell_reference)!=enrichment_hash:
            raise ValueError('Cell allocation reference changed during preparation')
        os.replace(staging,final)
        atomic_pointer(output,version,digest_file(final/'manifest.json'))
        return manifest
    finally:
        source.close()
        if scratch is not None:
            scratch.close()
        if staging.exists():
            if staging.parent.resolve()!=output or not staging.name.startswith('.preparing-'):
                raise RuntimeError('Refusing cleanup outside the output staging directory')
            shutil.rmtree(staging)

def activate(output,version):
    output=Path(output).resolve(strict=True)
    if not DATA_VERSION.fullmatch(version):
        raise ValueError('Invalid dataset version')
    folder=output/'versions'/version
    if folder.resolve(strict=True).parent!=(output/'versions').resolve(strict=True):
        raise ValueError('Version path escapes its immutable directory')
    manifest=verify_dataset(folder)
    if manifest['version']!=version:
        raise ValueError('Version does not match its manifest')
    atomic_pointer(output,version,digest_file(folder/'manifest.json'))
    return manifest

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    commands=parser.add_subparsers(dest='command',required=True)
    command=commands.add_parser('prepare')
    command.add_argument('--builder',type=Path,required=True)
    command.add_argument('--builder-output',type=Path,required=True)
    command.add_argument('--output',type=Path,required=True)
    command.add_argument('--cell-reference',type=Path,help='Enable isolated OpenCellID enrichment with a checksummed HNI reference')
    command=commands.add_parser('activate',help='Activate or roll back to an existing fully verified immutable version')
    command.add_argument('--output',type=Path,required=True)
    command.add_argument('--version',required=True)
    command=commands.add_parser('verify')
    command.add_argument('--version-directory',type=Path,required=True)
    args=parser.parse_args()
    if args.command=='prepare':
        result=prepare(args.builder,args.builder_output,args.output,cell_reference=args.cell_reference)
    elif args.command=='activate':
        result=activate(args.output,args.version)
    else:
        result=verify_dataset(args.version_directory)
    print(json.dumps({'version':result['version'],'counts':result['counts'],'statistics':result['statistics']},indent=2))

if __name__=='__main__':
    try:
        main()
    except (ValueError,OSError,sqlite3.Error) as error:
        print('Preparation failed: '+str(error),file=sys.stderr)
        sys.exit(1)
