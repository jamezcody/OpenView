"""Official-source adapters. Positional layouts are versioned and tested."""
import hashlib, json, re, zipfile
from pathlib import Path
from urllib.parse import urljoin, urlencode
from core import Stage, csv_rows, number, dms, norm, clean, NeedsImport, utc

SOURCES={
 'us_uls':{'name':'United States — FCC ULS','country':'US','mode':'automatic','url':'https://www.fcc.gov/uls/transactions/daily-weekly','scope':'Site-based wireless licences; excludes mobile locations and receive-only sites.'},
 'us_lms':{'name':'United States — FCC LMS broadcast','country':'US','mode':'automatic','url':'https://enterpriseefiling.fcc.gov/dataentry/public/tv/lmsDatabase.html','scope':'Broadcast engineering records; application and authorization status retained.'},
 'us_icfs':{'name':'United States — FCC ICFS earth stations','country':'US','mode':'import','url':'https://fccprod.servicenowservices.com/icfs','scope':'Import an exported flat table of earth-station transmitting locations. Legacy IBFS archives are not treated as current ICFS coverage.'},
 'us_els':{'name':'United States — FCC experimental','country':'US','mode':'import','url':'https://apps.fcc.gov/oetcf/els/reports/GenericSearch.cfm','scope':'Import a flat table of experimental transmitter locations. No verified unrestricted bulk download.'},
 'ca_ised':{'name':'Canada — ISED authorizations','country':'CA','mode':'automatic','url':'https://ised-isde.canada.ca/site/spectrum-management-system/en/spectrum-management-system-data/download-sms-data','scope':'TAFL All Services plus terrestrial and satellite spectrum site extracts.'},
 'au_acma':{'name':'Australia — ACMA RRL','country':'AU','mode':'automatic','url':'https://cdn.acma.gov.au/offline-rrl/index.html','scope':'RRL transmit devices joined to sites and licences; excludes mobile classes.'},
 'gb_ofcom':{'name':'United Kingdom — Ofcom WTR','country':'GB','mode':'automatic','url':'https://www.ofcom.org.uk/spectrum/frequencies/spectrum-information-portal','scope':'Published WTR records with transmitting locations. Not a complete cellular or broadcast inventory.'},
 'fr_anfr':{'name':'France — ANFR installations','country':'FR','mode':'automatic','url':'https://www.data.gouv.fr/datasets/donnees-sur-les-installations-radioelectriques-de-plus-de-5-watts-1/','scope':'Radio installations above 5 W; excludes civil aviation, Defence and Interior installations.'},
 'br_anatel':{'name':'Brazil — Anatel licensed stations','country':'BR','mode':'automatic','url':'https://www.gov.br/anatel/pt-br/dados/dados-abertos','scope':'Published licensed-station archive; keeps fixed transmitting entries with coordinates.'},
 'nz_rrf':{'name':'New Zealand — RSM RRF','country':'NZ','mode':'import','url':'https://www.rsm.govt.nz/licensing/how-do-i/use-the-rrf/extract-data-from-the-rrf/extracting-licence-data','scope':'RRF exports require an RSM-approved account and RealMe sign-in. Export each result page, then import CSV files.'},
}
import new_nordic, new_national, new_global
EXTENSIONS={source:module for module in (new_nordic,new_national,new_global) for source in module.SOURCES}
for module in (new_nordic,new_national,new_global):SOURCES.update(module.SOURCES)
ULS_FILES=['l_micro.zip','l_LMpriv.zip','l_LMcomm.zip','l_LMbcast.zip','l_cell.zip','l_coast.zip','l_paging.zip','l_mdsitfs.zip','l_market.zip']
# FCC's HD status codes are source record states, not observations of operation.
# https://wireless.fcc.gov/uls/releases/d992205c.pdf
ULS_STATUSES={'A':'active','C':'inactive','E':'expired','T':'inactive'}
CA_URL='https://www.ic.gc.ca/engineering/SMS_TAFL_Files/'
FR_API='https://www.data.gouv.fr/api/1/datasets/donnees-sur-les-installations-radioelectriques-de-plus-de-5-watts-1/'
AU_URL='https://cdn.acma.gov.au/rrl/spectra_rrl.zip'
GB_URL='https://static.ofcom.org.uk/static/radiolicensing/html/register/WTR.csv'
BR_URL='https://www.anatel.gov.br/dadosabertos/paineis_de_dados/outorga_e_licenciamento/estacoes_licenciadas.zip'

def base(source,identifier,member,url):
    return dict(source=source,country=SOURCES[source]['country'],source_record_id=str(identifier),
                source_file=member,source_url=url,source_crs='unspecified',
                transmission_kind='unknown',location_kind='unknown')
def fingerprint(row):return hashlib.sha256(json.dumps(row,sort_keys=True,ensure_ascii=False).encode()).hexdigest()
def member(path,name):
    with zipfile.ZipFile(path) as z:
        found=[n for n in z.namelist() if Path(n).name.lower()==name.lower()]
        if len(found)!=1:raise ValueError(f'Expected exactly one {name} in {path.name}')
        return found[0]

def parse_uls(ctx,ds,path,url,stage_path):
    st=Stage(stage_path,ctx)
    layouts={'HD':{'id':1,'callsign':4,'status':5,'service':6,'grant':7,'expiry':8,'cancellation':9},
             'EN':{'id':1,'entity_type':5,'operator':7},
             'LO':{'id':1,'type':6,'class':7,'location':8,'address':11,'state':14,'ld':19,'lm':20,'ls':21,'lh':22,'od':23,'om':24,'os':25,'oh':26},
             'AN':{'id':1,'antenna':6,'location':7,'type':9,'height':11,'azimuth':14},
             'FR':{'id':1,'location':6,'antenna':7,'station_class':8,'frequency':10,'upper':11,'power':12,'frequency_id':25,'frequency_number':26}}
    try:
        with zipfile.ZipFile(path) as z: available={Path(n).name.lower() for n in z.namelist()}
        if not {'lo.dat','fr.dat'}<=available:
            ctx.log('No site/frequency tables in '+path.name)
            ds.counts['archives_without_site_frequency_records']+=1
            return
        for table,indices in layouts.items():
            if table.lower()+'.dat' not in available:
                st.db.execute(f'DROP TABLE IF EXISTS "{table}"')
                st.db.execute(f'CREATE TABLE "{table}" ('+','.join('"'+c+'" TEXT' for c in indices)+')')
                continue
            name=member(path,table+'.dat')
            # Read only the stable prefix and retain all actual column positions.
            with zipfile.ZipFile(path) as z:
                first=z.open(name).readline().decode('cp1252').rstrip('\r\n').split('|')
            if first[0] and first[0]!=table:raise ValueError('Unsupported ULS layout: '+name)
            headers=[next((k for k,v in indices.items() if v==i),f'col{i}') for i in range(max(len(first),max(indices.values())+1))]
            st.load(table,path,name,list(indices),delimiter='|',headers=headers)
        st.index('HD',['id']);st.index('EN',['id','entity_type']);st.index('LO',['id','location']);st.index('AN',['id','location','antenna'])
        q='''SELECT f.*,h.callsign,h.status,h.service,h.grant,h.expiry,h.cancellation,e.operator,
             l.type location_type,l.class location_class,l.ld,l.lm,l.ls,l.lh,l.od,l.om,l.os,l.oh,
             a.type antenna_type,a.height,a.azimuth FROM FR f JOIN HD h ON f.id=h.id
             JOIN LO l ON f.id=l.id AND f.location=l.location
             LEFT JOIN EN e ON f.id=e.id AND e.entity_type='L'
             LEFT JOIN AN a ON f.id=a.id AND f.location=a.location AND f.antenna=a.antenna'''
        for r in st.query(q):
            key=':'.join(str(r.get(k) or '') for k in ('id','location','antenna','frequency','upper','frequency_id','frequency_number','station_class'))
            out=base('us_uls',key,Path(path).name,url)
            mobile=r['location_type'] not in ('F','') or r['station_class'].startswith(('MO','ML'))
            identifier=clean(r['id']);status_code=clean(r['status']).upper()
            authorization={'authority':'FCC','system':'ULS','identifier_kind':'fcc_uls_unique_system_id',
                           'identifier_label':'FCC ULS unique system ID','identifier':identifier}
            if identifier:
                authorization['record_url']='https://wireless2.fcc.gov/UlsApp/UlsSearch/license.jsp?'+urlencode({'licKey':identifier})
            out.update(license_id=r['id'],call_sign=r['callsign'],operator=r['operator'],site_id=r['location'],antenna_id=r['antenna'],
                       service=r['service'],status=ULS_STATUSES.get(status_code,status_code),expiration_date=r['expiry'],source_crs='EPSG:4269',
                       latitude=dms(r['ld'],r['lm'],r['ls'],r['lh']),longitude=dms(r['od'],r['om'],r['os'],r['oh']),
                       frequency_mhz=r['frequency'],frequency_upper_mhz=r['upper'],power_value=r['power'],power_unit='W',
                       antenna_height_m=r['height'],azimuth_deg=r['azimuth'],
                       location_kind='mobile' if mobile else ('fixed' if r['location_type']=='F' else 'unknown'),
                       transmission_kind='receive' if r['location_class']=='R' or r['antenna_type']=='R' else 'transmit',
                       details_json={'licensing':authorization,'license_status_code':status_code,
                                     'grant_date':r['grant'],'cancellation_date':r['cancellation']})
            ds.add(out)
    finally:st.close()

def parse_acma(ctx,ds,path,url,stage_path):
    st=Stage(stage_path,ctx)
    try:
        tables={'site':['SITE_ID','LATITUDE','LONGITUDE','NAME','SITE_PRECISION'],
                'licence':['LICENCE_NO','CLIENT_NO','LICENCE_TYPE_NAME','STATUS_TEXT','DATE_OF_EXPIRY'],
                'client':['CLIENT_NO','LICENCEE'],
                'device_details':['SDD_ID','LICENCE_NO','SITE_ID','ANTENNA_ID','DEVICE_TYPE','CLASS_OF_STATION_CODE','FREQUENCY','TRANSMITTER_POWER','TRANSMITTER_POWER_UNIT','HEIGHT','AZIMUTH','CALL_SIGN','SITE_RADIUS','EFL_ID']}
        for name,cols in tables.items():st.load(name,path,member(path,name+'.csv'),cols)
        st.index('site',['SITE_ID']);st.index('licence',['LICENCE_NO']);st.index('client',['CLIENT_NO'])
        for r in st.query('''SELECT d.*,s.LATITUDE,s.LONGITUDE,s.SITE_PRECISION,l.LICENCE_TYPE_NAME,l.STATUS_TEXT,l.DATE_OF_EXPIRY,c.LICENCEE
                     FROM device_details d JOIN site s ON d.SITE_ID=s.SITE_ID
                     LEFT JOIN licence l ON d.LICENCE_NO=l.LICENCE_NO LEFT JOIN client c ON l.CLIENT_NO=c.CLIENT_NO'''):
            out=base('au_acma',r['SDD_ID']+':'+r['EFL_ID'],'device_details.csv',url)
            out.update(license_id=r['LICENCE_NO'],operator=r['LICENCEE'],call_sign=r['CALL_SIGN'],site_id=r['SITE_ID'],antenna_id=r['ANTENNA_ID'],
                       latitude=r['LATITUDE'],longitude=r['LONGITUDE'],service=r['LICENCE_TYPE_NAME'],status=r['STATUS_TEXT'],expiration_date=r['DATE_OF_EXPIRY'],
                       frequency_mhz=(number(r['FREQUENCY']) or 0)/1e6,power_value=r['TRANSMITTER_POWER'],power_unit=r['TRANSMITTER_POWER_UNIT'],
                       antenna_height_m=r['HEIGHT'],azimuth_deg=r['AZIMUTH'],
                       location_kind='mobile' if r['CLASS_OF_STATION_CODE'] in ('ML','MO','MS','MA') or (number(r['SITE_RADIUS']) or 0)>0 else 'fixed',
                       transmission_kind={'T':'transmit','R':'receive'}.get(r['DEVICE_TYPE'],'unknown'),
                       details_json={'site_precision':r['SITE_PRECISION'],'station_class':r['CLASS_OF_STATION_CODE']})
            ds.add(out)
    finally:st.close()

def parse_france(ctx,ds,path,url,stage_path,reference=None):
    st=Stage(stage_path,ctx)
    try:
        tables={'SUP_SUPPORT':['SUP_ID','STA_NM_ANFR','COR_NB_DG_LAT','COR_NB_MN_LAT','COR_NB_SC_LAT','COR_CD_NS_LAT','COR_NB_DG_LON','COR_NB_MN_LON','COR_NB_SC_LON','COR_CD_EW_LON'],
                'SUP_STATION':['STA_NM_ANFR','ADM_ID','DTE_EN_SERVICE'],
                'SUP_ANTENNE':['STA_NM_ANFR','AER_ID','SUP_ID','AER_NB_ALT_BAS','AER_NB_AZIMUT'],
                'SUP_EMETTEUR':['EMR_ID','EMR_LB_SYSTEME','STA_NM_ANFR','AER_ID'],
                'SUP_BANDE':['STA_NM_ANFR','BAN_ID','EMR_ID','BAN_NB_F_DEB','BAN_NB_F_FIN','BAN_FG_UNITE']}
        for name,cols in tables.items():st.load(name,path,member(path,name+'.txt'),cols,delimiter=';')
        for name,cols in [('SUP_SUPPORT',['SUP_ID','STA_NM_ANFR']),('SUP_STATION',['STA_NM_ANFR']),('SUP_ANTENNE',['STA_NM_ANFR','AER_ID']),('SUP_BANDE',['STA_NM_ANFR','EMR_ID'])]:st.index(name,cols)
        operators={}
        if reference:
            for r,_ in csv_rows(reference,member(reference,'SUP_EXPLOITANT.txt'),';'):operators[r['ADM_ID']]=r['ADM_LB_NOM']
        q='''SELECT e.*,a.SUP_ID,a.AER_NB_ALT_BAS,a.AER_NB_AZIMUT,s.*,t.ADM_ID,t.DTE_EN_SERVICE,
                    b.BAN_ID,b.BAN_NB_F_DEB,b.BAN_NB_F_FIN,b.BAN_FG_UNITE
             FROM SUP_EMETTEUR e JOIN SUP_ANTENNE a ON e.AER_ID=a.AER_ID AND e.STA_NM_ANFR=a.STA_NM_ANFR
             JOIN SUP_SUPPORT s ON a.SUP_ID=s.SUP_ID AND a.STA_NM_ANFR=s.STA_NM_ANFR
             LEFT JOIN SUP_STATION t ON e.STA_NM_ANFR=t.STA_NM_ANFR
             LEFT JOIN SUP_BANDE b ON e.EMR_ID=b.EMR_ID AND e.STA_NM_ANFR=b.STA_NM_ANFR'''
        for r in st.query(q):
            factor={'K':0.001,'M':1,'G':1000}.get(r['BAN_FG_UNITE'])
            out=base('fr_anfr',':'.join(str(r[k] or '') for k in ('STA_NM_ANFR','SUP_ID','AER_ID','EMR_ID','BAN_ID')),'SUP_EMETTEUR.txt',url)
            out.update(license_id=r['STA_NM_ANFR'],site_id=r['SUP_ID'],antenna_id=r['AER_ID'],operator=operators.get(r['ADM_ID'],r['ADM_ID']),
                       service=r['EMR_LB_SYSTEME'],status='in_service_date_recorded' if r['DTE_EN_SERVICE'] else 'unknown',
                       latitude=dms(r['COR_NB_DG_LAT'],r['COR_NB_MN_LAT'],r['COR_NB_SC_LAT'],r['COR_CD_NS_LAT']),
                       longitude=dms(r['COR_NB_DG_LON'],r['COR_NB_MN_LON'],r['COR_NB_SC_LON'],r['COR_CD_EW_LON']),
                       frequency_mhz=(number(r['BAN_NB_F_DEB']) or 0)*factor if factor else None,
                       frequency_upper_mhz=(number(r['BAN_NB_F_FIN']) or 0)*factor if factor else None,
                       antenna_height_m=r['AER_NB_ALT_BAS'],azimuth_deg=r['AER_NB_AZIMUT'],location_kind='fixed',transmission_kind='transmit',
                       details_json={'in_service_date':r['DTE_EN_SERVICE'],'band_unit':r['BAN_FG_UNITE']})
            ds.add(out)
    finally:st.close()

def parse_canada(ctx,ds,path,url):
    with zipfile.ZipFile(path) as z:files=[n for n in z.namelist() if n.lower().endswith('.csv')]
    for f in files:
        is_tafl=Path(f).name.upper().startswith('TAFL')
        headers=[str(i) for i in range(1,62)] if is_tafl else None
        for r,line in csv_rows(path,f,',',headers):
            if is_tafl:
                out=base('ca_ised','tafl:'+r['3']+':'+r['1']+':'+fingerprint(r),f,url)
                out.update(license_id=r['48'],call_sign=r['34'],operator=r['55'],site_id=r['39'] or r['32'],antenna_id=r['3'],
                           service=r['49']+':'+r['50'],status={'G':'active','11':'active','-2':'inactive'}.get(r['52'],r['52']),
                           latitude=r['41'],longitude=r['42'],source_crs='EPSG:4326',frequency_mhz=r['2'],power_value=r['16'],power_unit='W',
                           antenna_height_m=r['29'],azimuth_deg=r['30'],transmission_kind={'TX':'transmit','RX':'receive'}.get(r['1'],'unknown'),
                           location_kind='fixed' if r['35'] in ('1','6','8','10','11','13','15','17','18') else 'nonfixed',
                           details_json={'in_service_date':r['53'],'station_type':r['35'],'station_class':r['36']})
            else:
                required={'latitude','longitude','licence_number','tx_frequency','station_type'}
                if not required<=set(r):raise ValueError(f'{f}: unsupported ISED site schema')
                out=base('ca_ised',f+':'+fingerprint(r),f,url)
                out.update(license_id=r['licence_number'],operator=r.get('licensee_name*'),site_id=r.get('record_id'),service=r.get('licence_category*'),
                           latitude=r['latitude'],longitude=r['longitude'],frequency_mhz=r['tx_frequency'],
                           power_value=r.get('tx_power'),power_unit='W',antenna_height_m=r.get('tx_ant_height'),azimuth_deg=r.get('tx_ant_azimuth'),
                           transmission_kind='transmit' if number(r['tx_frequency']) else ('receive' if number(r.get('rx_frequency')) else 'unknown'),
                           location_kind='fixed' if r['station_type'] in ('FX','FB','TC','TF','TX','TN','TZ') else 'unknown',
                           details_json={'upload_date':r.get('upload_date*'),'station_type':r['station_type']})
            ds.add(out)

def parse_uk(ctx,ds,path,url):
    for r,line in csv_rows(path):
        if line==2 and not {'Licence Number','Station Type','Frequency (Hz)'}<=set(r):raise ValueError('Unsupported Ofcom WTR CSV columns')
        lat=number(r.get('Latitude(Deg)'));lon=number(r.get('Longitude(Deg)'))
        if lat is None:lat=dms(r.get('SID_LAT_DEG'),r.get('SID_LAT_MIN'),r.get('SID_LAT_SEC'),r.get('SID_LAT_N_S'))
        if lon is None:lon=dms(r.get('SID_LONG_DEG'),r.get('SID_LONG_MIN'),r.get('SID_LONG_SEC'),r.get('SID_LONG_E_W'))
        out=base('gb_ofcom',fingerprint(r),Path(path).name,url)
        out.update(license_id=r['Licence Number'],operator=clean(r.get('Licencee Company')) or ' '.join(clean(r.get(k)) for k in ('Licencee First Name','Licencee Surname')).strip(),
                   site_id=r.get('NGR'),antenna_id=r.get('Antenna Name'),latitude=lat,longitude=lon,
                   frequency_mhz=(number(r['Frequency (Hz)']) or 0)/1e6,service=r.get('Product Description'),status=r.get('Status'),
                   antenna_height_m=r.get('Antenna Height'),azimuth_deg=r.get('Antenna AZIMUTH'),
                   location_kind='fixed' if r['Station Type'] in ('T','R','B') else 'unknown',
                   transmission_kind={'T':'transmit','R':'receive','B':'transmit'}.get(r['Station Type'],'unknown'),
                   details_json={'antenna_erp':r.get('Antenna ERP'),'antenna_erp_unit':r.get('Antenna ERP Unit'),'station_type':r['Station Type']})
        ds.add(out)

def parse_brazil(ctx,ds,path,url):
    with zipfile.ZipFile(path) as z:files=[n for n in z.namelist() if n.lower().endswith('.csv')]
    found=False
    for f in files:
        ctx.log('Reading '+f)
        for row,line in csv_rows(path,f,';'):
            r={norm(k):v for k,v in row.items()}
            if 'latitudegraus' not in r or 'longitudegraus' not in r:
                # MMA and amateur files contain no station coordinates.
                break
            found=True; tx=norm(r.get('direcaodecomunicacao')); kind=norm(r.get('classeestacao'))
            out=base('br_anatel',fingerprint(row),f,url)
            out.update(license_id=r.get('fisteldoservicodaestacao'),site_id=r.get('numerodaestacao'),call_sign=r.get('nomeindicativo'),
                       operator=r.get('nomeentidade'),service=r.get('codigoenomedoservico'),status=r.get('statusdavalidadedaestacao'),expiration_date=r.get('datadevalidadedaestacao'),
                       latitude=r['latitudegraus'],longitude=r['longitudegraus'],frequency_mhz=r.get('frequenciamhz'),power_value=r.get('potenciadotransmissorw'),power_unit='W',
                       antenna_height_m=r.get('alturadaantenam'),azimuth_deg=r.get('azimutegraus'),
                       transmission_kind='receive' if tx=='recepcao' else ('transmit' if tx=='transmissao' or r.get('tipoclasseestacao')=='TX' else 'unknown'),
                       location_kind='mobile' if 'movel' in kind or 'portatil' in norm(r.get('endereco')) else ('fixed' if r.get('tipoclasseestacao') in ('FX','FB','TX','TC','TF','BC','BT') or 'fixa' in kind else 'unknown'))
            ds.add(out)
    if not found:raise ValueError('No supported Anatel station-coordinate tables found')

def acquire(ctx,source,local_files=None):
    """Return (path, canonical URL) inputs. Local native files override downloads."""
    if local_files:
        yield from [(Path(p),SOURCES[source]['url']) for p in local_files]
        return
    if SOURCES[source]['mode'] in ('import','reference'):raise NeedsImport(SOURCES[source]['scope']+' Open '+SOURCES[source]['url'])
    if source in EXTENSIONS:
        yield from EXTENSIONS[source].acquire(ctx,source)
        return
    if source=='us_uls':
        # Individual archives are yielded so earlier completed services can be retained.
        for name in ULS_FILES:
            url='https://data.fcc.gov/download/pub/uls/complete/'+name
            yield ctx.download(url,name,('ftp://wirelessftp.fcc.gov/pub/uls/complete/'+name,)),url
    elif source=='ca_ised':
        for name in ('TAFL_LTAF.zip','Site_Data_Extract_FX.zip','Site_Data_Extract_ES.zip'):
            url=CA_URL+name;yield ctx.download(url,name),url
    elif source=='fr_anfr':
        resources=ctx.json(FR_API)['resources']
        for suffix in ('etalab-data.zip','etalab-ref.zip'):
            matches=[r for r in resources if r['url'].endswith(suffix)]
            if not matches:raise ValueError('ANFR dataset catalog changed: '+suffix+' absent')
            chosen=max(matches,key=lambda r:r.get('last_modified') or r.get('created_at') or '')
            yield ctx.download(chosen['url'],suffix),chosen['url']
    elif source in ('au_acma','gb_ofcom','br_anatel'):
        url={'au_acma':AU_URL,'gb_ofcom':GB_URL,'br_anatel':BR_URL}[source]
        yield ctx.download(url,url.rsplit('/',1)[1]),url
    elif source=='us_lms':
        page=SOURCES[source]['url']
        text=ctx.download(page,'lms-index.html').read_text(encoding='utf-8')
        matches=re.findall(r'href="([^"]*/[0-9-]+_LMS_Dump.zip)"',text)
        if not matches:raise ValueError('No dated LMS archive found on the FCC download page')
        url=urljoin(page,matches[0])
        yield ctx.download(url,'Current_LMS_Dump.zip'),url

def native_parse(ctx,ds,source,inputs,stage_path):
    if source=='fr_anfr':
        files=list(inputs)
        data=next((p,u) for p,u in files if 'SUP_EMETTEUR.txt' in zipfile.ZipFile(p).namelist())
        ref=next((p for p,u in files if 'SUP_EXPLOITANT.txt' in zipfile.ZipFile(p).namelist()),None)
        parse_france(ctx,ds,*data,stage_path,ref)
    else:
        for p,url in inputs:
            ctx.check()
            if source in EXTENSIONS:EXTENSIONS[source].parse(ctx,ds,source,p,url,stage_path)
            elif source=='us_uls':parse_uls(ctx,ds,p,url,stage_path)
            elif source=='au_acma':parse_acma(ctx,ds,p,url,stage_path)
            elif source=='ca_ised':parse_canada(ctx,ds,p,url)
            elif source=='gb_ofcom':parse_uk(ctx,ds,p,url)
            elif source=='br_anatel':parse_brazil(ctx,ds,p,url)
            elif source=='us_lms':
                from lms import parse_lms
                parse_lms(ctx,ds,p,url,stage_path)
            else:raise NeedsImport('Use a CSV mapping for this source')

def mapped_import(ctx,ds,source,path,mapping):
    """Explicit user mapping, never infer that coordinates prove a transmitter."""
    cols=mapping.get('columns',{})
    if not {'latitude','longitude'}<=set(cols):raise ValueError('Map both latitude and longitude columns')
    for r,line in csv_rows(path,delimiter=mapping.get('delimiter')):
        if line==2 and not set(cols.values())<=set(r):raise ValueError('Mapped columns missing from CSV: '+str(set(cols.values())-set(r)))
        out=base(source,fingerprint(r),Path(path).name,SOURCES[source]['url'])
        out.update({target:r.get(column) for target,column in cols.items()})
        out.update(source_crs=mapping.get('crs','unspecified'),transmission_kind=mapping.get('transmission_kind','unknown'),location_kind=mapping.get('location_kind','unknown'))
        direction_col=mapping.get('direction_column')
        if direction_col:
            direction=norm(r.get(direction_col))
            out['transmission_kind']='transmit' if direction in ('t','tx','transmit','transmitter','transmissao') else ('receive' if direction in ('r','rx','receive','receiver','recepcao') else 'unknown')
        if source=='global_satnogs' and out['transmission_kind']=='receive':out['retain_receiver']=True
        if out.get('frequency_mhz'):
            v=number(out['frequency_mhz']);factor={'Hz':1e-6,'kHz':1e-3,'MHz':1,'GHz':1e3}[mapping.get('frequency_unit','MHz')]
            out['frequency_mhz']=v*factor if v is not None else None
        out['details_json']={'import_mapping':mapping,'import_line':line}
        ds.add(out)
