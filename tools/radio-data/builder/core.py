"""Download, normalization, provenance and atomic dataset publication."""
from __future__ import annotations
import codecs, csv, hashlib, html, io, json, math, os, re, sqlite3, time, unicodedata, urllib.request, zipfile
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit, parse_qsl, urlencode, quote, quote_plus
import requests
from pyproj import Transformer

VERSION = '1.1.0'
TABLES = ('transmitters','candidates','receivers')
FIELDS = ['record_id','source','country','source_record_id','license_id','call_sign','operator',
          'site_id','antenna_id','service','status','expiration_date','latitude','longitude',
          'source_latitude','source_longitude','source_crs','coordinate_note','frequency_mhz',
          'frequency_upper_mhz','power_value','power_unit','antenna_height_m','azimuth_deg',
          'location_kind','transmission_kind','source_file','source_url','retrieved_at','details_json']
NUMERIC = {'latitude','longitude','source_latitude','source_longitude','frequency_mhz',
           'frequency_upper_mhz','power_value','antenna_height_m','azimuth_deg'}

def utc(): return datetime.now(timezone.utc).isoformat(timespec='seconds')
def norm(s):
    s=unicodedata.normalize('NFKD',str(s or '')).encode('ascii','ignore').decode().lower()
    return re.sub(r'[^a-z0-9]','',s)
def number(s):
    s=str('' if s is None else s).strip().replace('\u00a0','')
    if ',' in s and '.' not in s: s=s.replace(',','.')
    try:
        n=float(s)
        return n if math.isfinite(n) else None
    except (ValueError,TypeError): return None
def dms(d,m,s,hemisphere):
    d,m,s=number(d),number(m),number(s)
    if None in (d,m,s) or d<0 or not 0<=m<60 or not 0<=s<60: return None
    h=str(hemisphere).strip().upper()
    if h not in ('N','S','E','W'): return None
    return (d+m/60+s/3600)*(-1 if h in ('S','W') else 1)
def clean(s):
    s=str(s or '').strip()
    return '' if norm(s) in ('ni','na','null','none','usuarioinformouerrado') or s=='-' else s
def status(s):
    n=norm(s)
    if n in ('a','active','ativo','ativa','live','granted','licensed','current','operational'): return 'active'
    if n in ('expired','vencido','vencida','e'): return 'expired'
    if n in ('cancelled','canceled','c','surrendered','terminated','revoked'): return 'inactive'
    return clean(s) or 'unknown'

class Cancelled(Exception): pass
class NeedsImport(Exception): pass

def redact_url(url):
    """Keep credentials out of exported provenance and logs."""
    parts=urlsplit(url)
    keys={'token','api_key','apikey','key','access_token','api_token','password'}
    query=[(k,'REDACTED' if k.lower() in keys else v) for k,v in parse_qsl(parts.query,keep_blank_values=True)]
    if not any(k.lower() in keys for k,_ in query):return url
    return urlunsplit((parts.scheme,parts.netloc,parts.path,urlencode(query),parts.fragment))

class Context:
    def __init__(self, output, log=print, cancel=None, refresh=False, options=None):
        self.output=Path(output).resolve(); self.output.mkdir(parents=True,exist_ok=True)
        self.cache=self.output/'cache'; self.cache.mkdir(exist_ok=True)
        self.options=options or {}; self.sensitive_urls={}; self.secrets=set()
        self.log=lambda message:log(self.redact(str(message)))
        self.cancel=cancel; self.refresh=refresh; self.downloads=[]; self.retrieval_times={}
    def redact(self,text):
        text=str(text)
        for raw,safe in self.sensitive_urls.items():text=text.replace(raw,safe)
        for secret in sorted(self.secrets,key=len,reverse=True):
            if secret:
                for encoded in {secret,quote(secret,safe=''),quote_plus(secret)}:text=text.replace(encoded,'REDACTED')
        return text
    def check(self):
        if self.cancel and self.cancel.is_set(): raise Cancelled('Cancelled by user')
    def download(self,url,name=None,alternatives=(),sensitive=False):
        """Cache only completed downloads; preserve a previous file if refresh fails."""
        self.check()
        public_url=self.sensitive_urls.get(url,redact_url(url))
        if sensitive or public_url!=url:
            self.sensitive_urls[url]=public_url
            for key,value in parse_qsl(urlsplit(url).query):
                if key.lower() in {'token','api_key','apikey','key','access_token','api_token','password'} and value:self.secrets.add(value)
        key=hashlib.sha256(url.encode()).hexdigest()[:16]
        dest=self.cache/(key+'-'+(name or 'download.bin'))
        meta=dest.with_suffix(dest.suffix+'.json')
        if dest.exists() and meta.exists() and not self.refresh:
            info=json.loads(meta.read_text(encoding='utf-8'))
            if dest.stat().st_size==info.get('bytes'):
                self.downloads.append({**info,'cache_reused':True})
                self.retrieval_times[public_url]=info['retrieved_at']
                self.log('Using cache: '+dest.name)
                return dest
            self.log('Cached file size changed; downloading a fresh copy')
        errors=[]
        for endpoint in (url,*alternatives):
            self.check(); self.log('Downloading '+endpoint)
            part=dest.with_suffix(dest.suffix+'.part'); digest=hashlib.sha256(); size=0; tick=time.monotonic()
            try:
                if endpoint.startswith('ftp://'):
                    response=urllib.request.urlopen(endpoint,timeout=45)
                    chunks=iter(lambda:response.read(1024*1024),b''); headers={}; final_url=endpoint
                else:
                    response=requests.get(endpoint,stream=True,timeout=(20,60),headers={'User-Agent':'OpenView-TransmitterBuilder/'+VERSION})
                    response.raise_for_status(); headers=dict(response.headers); final_url=response.url
                    chunks=response.iter_content(1024*1024)
                try:
                    with part.open('wb') as f:
                        for chunk in chunks:
                            self.check()
                            if not chunk: continue
                            f.write(chunk); digest.update(chunk); size+=len(chunk)
                            if time.monotonic()-tick>3:
                                self.log(f'  {size/1048576:,.1f} MB downloaded'); tick=time.monotonic()
                    if size==0: raise ValueError('Server returned an empty file')
                    if (name or '').endswith('.zip') and not zipfile.is_zipfile(part):
                        raise ValueError('Server returned a page instead of a ZIP archive')
                    if (name or '').endswith('.gz'):
                        with part.open('rb') as f:magic=f.read(2)
                        if magic!=b'\x1f\x8b':raise ValueError('Server did not return a GZIP archive; check credentials and download quota')
                    if (name or '').endswith('.csv'):
                        with part.open('rb') as f: prefix=f.read(512).lstrip().lower()
                        if prefix.startswith((b'<!doctype',b'<html')): raise ValueError('Server returned HTML instead of CSV')
                    info={'url':public_url,'resolved_url':self.redact(redact_url(final_url)),'retrieved_at':utc(),'bytes':size,
                          'sha256':digest.hexdigest(),'path':str(dest),'last_modified':headers.get('Last-Modified','')}
                    part.replace(dest); meta.write_text(json.dumps(info,indent=2),encoding='utf-8')
                    self.downloads.append(info);self.retrieval_times[public_url]=info['retrieved_at']; return dest
                finally: response.close()
            except Cancelled: raise
            except Exception as e:
                errors.append(self.redact(endpoint+': '+str(e))); self.log('  Download failed: '+str(e))
            finally:
                if part.exists(): part.unlink()
        raise RuntimeError('\n'.join(errors))
    def json(self,url):
        p=self.download(url,'metadata.json'); return json.loads(p.read_text(encoding='utf-8-sig'))

def text_stream(raw,encoding=None):
    if not hasattr(raw,'peek'): raw=io.BufferedReader(raw)
    sample=raw.peek(65536)
    if not encoding:
        try: codecs.getincrementaldecoder('utf-8-sig')().decode(sample,final=False); encoding='utf-8-sig'
        except UnicodeDecodeError: encoding='cp1252'
    return io.TextIOWrapper(raw,encoding=encoding,errors='replace',newline='')

def csv_rows(path,member=None,delimiter=None,headers=None):
    """Stream a CSV or an archive member. Never extract untrusted ZIP paths."""
    archive=zipfile.ZipFile(path) if member else None
    raw=archive.open(member) if archive else open(path,'rb')
    try:
        with text_stream(raw) as stream:
            first=stream.readline()
            if not first: return
            import itertools
            delim=delimiter or max((',', ';', '\t','|'), key=lambda c:first.count(c))
            reader=csv.reader(itertools.chain([first],stream),delimiter=delim,
                              quoting=csv.QUOTE_NONE if delim=='|' else csv.QUOTE_MINIMAL)
            if headers:
                names=headers
            else:
                names=[h.strip().lstrip('\ufeff') for h in next(reader)]
            for line,row in enumerate(reader,1 if headers else 2):
                if row:
                    if not headers and len(row)>len(names) and any(row[len(names):]):
                        raise ValueError(f'{member or path}, row {line}: unexpected extra columns')
                    yield dict(zip(names,row)),line
    finally:
        if archive: archive.close()

class Stage:
    """Disk-backed joins avoid loading national antenna tables into RAM."""
    def __init__(self,path,ctx):
        self.db=sqlite3.connect(path); self.ctx=ctx
        self.db.execute('PRAGMA journal_mode=OFF'); self.db.execute('PRAGMA synchronous=OFF')
        self.db.set_progress_handler(lambda:1 if ctx.cancel and ctx.cancel.is_set() else 0,10000)
    def load(self,name,path,member,columns,delimiter=None,headers=None):
        # Names here are internal adapter constants, never untrusted SQL.
        self.ctx.log('Reading '+member)
        self.db.execute(f'DROP TABLE IF EXISTS "{name}"')
        self.db.execute(f'CREATE TABLE "{name}" ('+','.join('"'+c+'" TEXT' for c in columns)+')')
        sql=f'INSERT INTO "{name}" VALUES ('+','.join('?' for _ in columns)+')'
        batch=[]; count=0
        for row,line in csv_rows(path,member,delimiter,headers):
            if line<=2 and not set(columns)<=set(row):
                raise ValueError(f'{member}: missing columns {set(columns)-set(row)}')
            batch.append(tuple(row.get(c,'') for c in columns)); count+=1
            if len(batch)>=5000:
                self.ctx.check(); self.db.executemany(sql,batch); batch=[]
        if batch:self.db.executemany(sql,batch)
        self.db.commit(); return count
    def index(self,name,cols):
        self.db.execute(f'CREATE INDEX "idx_{name}_{"_".join(cols)}" ON "{name}" ('+','.join('"'+c+'"' for c in cols)+')')
    def query(self,sql):
        self.db.row_factory=sqlite3.Row
        for row in self.db.execute(sql): yield dict(row)
    def close(self): self.db.close()

class Dataset:
    def __init__(self,path,ctx,active_only=False):
        self.ctx=ctx; self.active_only=active_only; self.counts=Counter(); self.transforms={}; self.n=0
        self.db=sqlite3.connect(path)
        self.db.execute('PRAGMA journal_mode=DELETE')
        defs=','.join(f'"{f}" '+('REAL' if f in NUMERIC else 'TEXT') for f in FIELDS)
        for t in TABLES:
            self.db.execute(f'CREATE TABLE {t} ({defs}, PRIMARY KEY(record_id))')
        self.sql={t:f'INSERT OR IGNORE INTO {t} VALUES ('+','.join('?' for _ in FIELDS)+')' for t in TABLES}
    def add(self,r):
        self.n+=1
        if self.n%5000==0: self.ctx.check()
        self.counts['input_records']+=1
        lat,lon=number(r.get('latitude')),number(r.get('longitude'))
        if lat is None or lon is None or not -90<=lat<=90 or not -180<=lon<=180 or (lat==lon==0):
            self.counts['excluded_invalid_or_missing_coordinates']+=1; return
        receiver=r.get('transmission_kind')=='receive'
        if receiver and not r.get('retain_receiver'):self.counts['excluded_receivers']+=1; return
        if r.get('location_kind') in ('mobile','area','nonfixed'):self.counts['excluded_nonfixed']+=1; return
        r=dict(r); r['source_latitude']=lat; r['source_longitude']=lon
        crs=r.get('source_crs','unspecified')
        if crs!='unspecified':
            try:
                if crs not in self.transforms:self.transforms[crs]=Transformer.from_crs(crs,'EPSG:4326',always_xy=True)
                lon,lat=self.transforms[crs].transform(lon,lat,errcheck=True)
            except Exception as e:raise ValueError('Coordinate conversion failed: '+str(e))
            note='Transformed to WGS84; source precision retained'
        else:note='Source datum unspecified; degrees retained for approximate mapping'
        r['coordinate_note']='; '.join(filter(None,(r.get('coordinate_note'),note)))
        if not math.isfinite(lat) or not math.isfinite(lon) or not -90<=lat<=90 or not -180<=lon<=180:
            self.counts['excluded_invalid_or_missing_coordinates']+=1;return
        r['latitude']=lat;r['longitude']=lon;r['status']=status(r.get('status'))
        if self.active_only and r['status'] in ('expired','inactive'):
            self.counts['excluded_inactive']+=1;return
        confirmed=r.get('transmission_kind')=='transmit' and r.get('location_kind')=='fixed'
        if self.active_only and r['status']!='active': confirmed=False
        table='receivers' if receiver else ('transmitters' if confirmed else 'candidates')
        for f in ('frequency_mhz','frequency_upper_mhz','power_value','antenna_height_m','azimuth_deg'):
            r[f]=number(r.get(f))
        for f in ('frequency_mhz','frequency_upper_mhz'):
            if r[f] is not None and r[f]<=0:r[f]=None
        r['record_id']=hashlib.sha256((r['source']+'\0'+r['source_record_id']).encode()).hexdigest()
        r['source_url']=self.ctx.redact(redact_url(r.get('source_url','')))
        r.setdefault('retrieved_at',self.ctx.retrieval_times.get(r.get('source_url')) or utc())
        if isinstance(r.get('details_json'),dict): r['details_json']=json.dumps(r['details_json'],ensure_ascii=False)
        cursor=self.db.execute(self.sql[table],tuple(r.get(f) for f in FIELDS))
        self.counts[table if cursor.rowcount else 'duplicate_records']+=1
    def finish(self):
        for t in TABLES:
            self.db.execute(f'CREATE INDEX {t}_location ON {t}(latitude,longitude)')
            self.db.execute(f'CREATE INDEX {t}_source ON {t}(source,country)')
        self.db.commit()
    def export(self,folder):
        for t in TABLES:
            self.ctx.log('Exporting '+t+'.csv')
            with (folder/(t+'.csv')).open('w',encoding='utf-8-sig',newline='') as f:
                writer=csv.writer(f);writer.writerow(FIELDS)
                for i,row in enumerate(self.db.execute(f'SELECT * FROM {t}')):
                    if i%10000==0:self.ctx.check()
                    writer.writerow(row)
        self.ctx.log('Exporting transmitters.geojsonl')
        with (folder/'transmitters.geojsonl').open('w',encoding='utf-8') as f:
            for i,row in enumerate(self.db.execute('SELECT * FROM transmitters')):
                if i%10000==0:self.ctx.check()
                r=dict(zip(FIELDS,row));lat=r.pop('latitude');lon=r.pop('longitude')
                f.write(json.dumps({'type':'Feature','geometry':{'type':'Point','coordinates':[lon,lat]},'properties':r},ensure_ascii=False)+'\n')
    def close(self):self.db.close()
