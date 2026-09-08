import collections, hashlib, json, shutil, sqlite3, unittest, uuid
from pathlib import Path
from unittest.mock import patch
from urllib.parse import urlencode
import prepare_radio as prep

BUILDER=Path(__file__).resolve().parents[1]/'builder'
SANITIZER_TOKEN = 'not-a-real-sanitizer-token'
SANITIZER_PASSWORD = 'not-a-real-sanitizer-password'

class PreparationTests(unittest.TestCase):
    def setUp(self):
        self.parent=Path(__file__).parent/'test-work'
        self.root=self.parent/uuid.uuid4().hex
        self.root.mkdir(parents=True)
        self.builder_output=self.root/'builder-output'
        self.run=self.builder_output/'runs'/'test-published-run'
        self.run.mkdir(parents=True)
        self.output=self.root/'prepared'
        self.fields,self.tables=prep.load_schema(BUILDER)
        db=sqlite3.connect(self.run/'dataset.sqlite')
        numeric={'latitude','longitude','source_latitude','source_longitude','frequency_mhz','frequency_upper_mhz','power_value','antenna_height_m','azimuth_deg'}
        for table in self.tables:
            db.execute('CREATE TABLE '+table+' ('+','.join('"'+f+'" '+('REAL' if f in numeric else 'TEXT') for f in self.fields)+')')
        db.close()
        self.counts=collections.Counter()
        (self.builder_output/'latest.json').write_text(json.dumps({'run_directory':str(self.run),'status':'complete'}))

    def tearDown(self):
        self.assertTrue(self.root.resolve().is_relative_to(self.parent.resolve()))
        shutil.rmtree(self.root)

    def add(self,category='transmitters',source='global_ourairports',identity='one',lat=40,lon=-74,**values):
        row={f:None for f in self.fields}
        row.update(source=source,source_record_id=identity,record_id=hashlib.sha256((source+'\0'+identity).encode()).hexdigest(),
                   latitude=lat,longitude=lon,source_latitude=lat,source_longitude=lon,source_crs='unspecified',
                   coordinate_note='Source datum unspecified; degrees retained for approximate mapping',
                   source_file='local.csv',source_url='https://example.org/data',retrieved_at='2026-09-06T15:00:00+00:00',
                   status='unknown',service='navigation',country=None,details_json='{}')
        row.update(values)
        db=sqlite3.connect(self.run/'dataset.sqlite')
        db.execute('INSERT INTO '+category+' VALUES ('+','.join('?' for _ in self.fields)+')',[row[f] for f in self.fields])
        db.commit();db.close()
        self.counts[category]+=1
        self.report()

    def report(self,status='complete'):
        report={'version':'1.1.0','run_id':self.run.name,'status':status,'counts':dict(self.counts),
                'started_at':'2026-09-06T15:00:00+00:00','finished_at':'2026-09-06T15:01:00+00:00',
                'sources':[{'id':'global_ourairports','status':'complete','input_mode':'local import',
                   'files':['C:/private/workspace/data.csv'],'counts':dict(self.counts)}],
                'downloads':[{'url':'https://example.invalid/data?' + urlencode({'api_token':SANITIZER_TOKEN}),'path':'C:/secret/folder/data.csv',
                  'retrieved_at':'2026-09-06T15:00:00+00:00','sha256':'a'*64,'bytes':100}],
                'scope':'Selected test-source records'}
        (self.run/'report.json').write_text(json.dumps(report),encoding='utf-8')

    def prepare(self,**kwargs):
        manifest=prep.prepare(BUILDER,self.builder_output,self.output,**kwargs)
        return self.output/'versions'/manifest['version'],manifest

    def leaf_records(self,folder):
        result=[]
        for path in sorted((folder/'records').glob('*.json')):
            result.extend(prep.bounded_json(path))
        return result

    def test_categories_unknown_values_poles_and_dateline_preserved(self):
        self.add(identity='west',lon=-180,lat=-90)
        self.add(identity='east',lon=180,lat=90,frequency_mhz=100)
        self.add(category='candidates',source='global_osm',identity='structure',status='mapped')
        self.add(category='receivers',source='global_satnogs',identity='rx',status='Offline',frequency_mhz=144,frequency_upper_mhz=146,
                 details_json=json.dumps({'frequency_role':'receiver tuning range, not transmission'}))
        folder,manifest=self.prepare()
        rows=self.leaf_records(folder)
        self.assertEqual(manifest['counts'],{'transmitters':2,'candidates':1,'receivers':1})
        self.assertEqual({(r['lon'],r['lat']) for r in rows},{(-180,-90),(180,90),(-74,40)})
        self.assertIsNone(next(r for r in rows if r['source_record_id']=='west')['frequency_mhz'])
        self.assertEqual(next(r for r in rows if r['category']=='receivers')['status'],'Offline')
        self.assertIn('',manifest['facets']['countries'])
        self.assertEqual(len(manifest['sources']),24)
        self.assertEqual(sum(s['status']=='unselected' for s in manifest['sources']),23)
        self.assertTrue(all(r['id']==r['category']+':'+r['record_id'] for r in rows))

    def test_exact_summary_tuples_and_filtered_counts(self):
        self.add(identity='unknown',frequency_mhz=None)
        self.add(identity='a',frequency_mhz=100,lon=10,lat=10)
        self.add(identity='b',frequency_mhz=100,lon=12,lat=12)
        self.add(identity='range',frequency_mhz=95,frequency_upper_mhz=105,status='scheduled')
        folder,_=self.prepare()
        node=prep.bounded_json(folder/'nodes/r.json')
        groups=[group for page in node['summaryPages'] for group in prep.bounded_json(folder/page['file'])]
        self.assertEqual(sum(g['count'] for g in groups),4)
        frequency100=next(g for g in groups if g['frequency_mhz']==100)
        self.assertEqual((frequency100['count'],frequency100['lat'],frequency100['lon']),(2,11,11))
        overview=[group for page in node['overviewPages'] for group in prep.bounded_json(folder/page['file'])]
        self.assertEqual(sum(g['count'] for g in overview),4)
        self.assertEqual(len(overview),2)
        self.assertTrue(all(g['frequency_mhz'] is None and g['frequency_upper_mhz'] is None for g in overview))
        self.assertEqual(next(g for g in overview if g['status']=='unknown')['count'],3)
        self.assertEqual(sum(g['count'] for g in groups if g['frequency_mhz'] is None),1)
        # Query 101 MHz intersects the explicit 95–105 range only.
        self.assertEqual(sum(g['count'] for g in groups if g['frequency_mhz'] is not None and g['frequency_mhz']<=101<=(g['frequency_upper_mhz'] or g['frequency_mhz'])),1)

    def test_coincident_records_have_bounded_pages_and_keep_identities(self):
        for index in range(130):
            self.add(identity=str(index))
        folder,manifest=self.prepare()
        rows=self.leaf_records(folder)
        self.assertEqual(len({r['id'] for r in rows}),130)
        self.assertEqual(manifest['statistics']['nodes'],13)
        self.assertTrue(all(len(prep.bounded_json(p))<=64 for p in (folder/'records').glob('*.json')))
        self.assertTrue(all(p.stat().st_size<=prep.PAGE_BYTES for p in (folder/'records').glob('*.json')))

    def test_sanitization_omits_credentials_local_paths_and_import_config(self):
        fixture_url = ('https://' + 'fixture-user' + ':' + SANITIZER_PASSWORD +
                       '@example.invalid/data?' + urlencode({'token':SANITIZER_TOKEN,'country':'FI'}))
        self.add(source_file='C:\\private\\raw\\stations.csv',
                 source_url=fixture_url,
                 details_json=json.dumps({'api_token':SANITIZER_TOKEN,'nested':{'password':SANITIZER_PASSWORD,'path':'C:/private/stations.csv'},
                   'import_mapping':{'api_key':SANITIZER_TOKEN},'frequency_note':'Nominal band is not exact frequency'}))
        folder,_=self.prepare()
        text=''.join(p.read_text(encoding='utf-8') for p in folder.rglob('*.json'))
        self.assertNotIn(SANITIZER_TOKEN,text)
        self.assertNotIn(SANITIZER_PASSWORD,text)
        self.assertNotIn('C:/private',text)
        self.assertNotIn('C:/secret',text)
        row=self.leaf_records(folder)[0]
        self.assertEqual(row['source_file'],'stations.csv')
        self.assertNotIn('import_mapping',row['details_json'])
        self.assertEqual(row['details_json']['frequency_note'],'Nominal band is not exact frequency')

    def test_embedded_public_attribution_url_is_preserved_but_local_path_is_redacted(self):
        attribution='© OpenStreetMap contributors — https://www.openstreetmap.org/copyright'
        self.assertEqual(prep.sanitize(attribution),attribution)
        self.assertEqual(prep.sanitize('OurAirports — https://ourairports.com/data/'),'OurAirports — https://ourairports.com/data/')
        self.assertEqual(prep.sanitize('Imported from C:\\private\\raw\\stations.csv'),'[local path omitted]')
        self.assertEqual(prep.sanitize('Imported from C:/private/raw/stations.csv'),'[local path omitted]')
        self.add(category='candidates',source='global_osm')
        _,manifest=self.prepare()
        self.assertEqual(next(s for s in manifest['sources'] if s['id']=='global_osm')['attribution'],attribution)

    def test_failure_and_cancelled_builder_run_preserve_pointer(self):
        self.add()
        old_folder,_=self.prepare()
        pointer=(self.output/'latest.json').read_bytes()
        self.add(identity='new')
        with self.assertRaisesRegex(ValueError,'Injected'):
            self.prepare(fail_after_nodes=1)
        self.assertEqual((self.output/'latest.json').read_bytes(),pointer)
        self.assertTrue(old_folder.exists())
        self.report('cancelled')
        with self.assertRaisesRegex(ValueError,'unfinished'):
            self.prepare()
        self.assertEqual((self.output/'latest.json').read_bytes(),pointer)

    def test_immutable_repeat_activation_and_checksum_verification(self):
        self.add()
        folder,first=self.prepare()
        before=prep.digest_file(folder/'manifest.json')
        _,again=self.prepare()
        self.assertEqual(first['version'],again['version'])
        self.assertEqual(before,prep.digest_file(folder/'manifest.json'))
        self.add(identity='new')
        _,second=self.prepare()
        self.assertNotEqual(first['version'],second['version'])
        prep.activate(self.output,first['version'])
        self.assertEqual(prep.bounded_json(self.output/'latest.json')['version'],first['version'])
        page=next((folder/'records').glob('*.json'))
        page.write_bytes(page.read_bytes()+b' ')
        with self.assertRaisesRegex(ValueError,'byte count|checksum'):
            prep.activate(self.output,first['version'])

    def test_malicious_latest_and_page_paths_rejected(self):
        self.add()
        (self.builder_output/'latest.json').write_text(json.dumps({'status':'complete','run_directory':str(self.root)}))
        with self.assertRaisesRegex(ValueError,'escapes'):
            self.prepare()
        (self.builder_output/'latest.json').write_text(json.dumps({'status':'complete','run_directory':str(self.run)}))
        folder,_=self.prepare()
        node=prep.bounded_json(folder/'nodes/r.json')
        node['recordPages'][0]['file']='../../private.json'
        (folder/'nodes/r.json').write_bytes(prep.encoded(node))
        with self.assertRaisesRegex(ValueError,'Unsafe page'):
            prep.verify_dataset(folder)

    def test_oversized_record_does_not_publish(self):
        self.add(details_json=json.dumps({'annotation':'x'*(prep.PAGE_BYTES+1)}))
        with self.assertRaisesRegex(ValueError,'256 KiB'):
            self.prepare()
        self.assertFalse((self.output/'latest.json').exists())

    def test_descriptor_limits_fail_before_replacing_active_pointer(self):
        self.add()
        _,first=self.prepare()
        pointer=(self.output/'latest.json').read_bytes()
        self.add(identity='changed-input')
        # A small injected cap exercises the exact production writer guard
        # without allocating a synthetic million-row national source.
        with patch.object(prep,'DESCRIPTOR_BYTES',100):
            with self.assertRaisesRegex(ValueError,'descriptor limit'):
                self.prepare()
        self.assertEqual((self.output/'latest.json').read_bytes(),pointer)
        self.assertEqual(prep.bounded_json(self.output/'latest.json')['version'],first['version'])

    def test_verification_rejects_oversized_manifest_and_node(self):
        self.add()
        folder,_=self.prepare()
        manifest_path=folder/'manifest.json'
        manifest_bytes=manifest_path.read_bytes()
        manifest_path.write_bytes(manifest_bytes+b' '*(prep.DESCRIPTOR_BYTES+1))
        with self.assertRaisesRegex(ValueError,'JSON input exceeds'):
            prep.verify_dataset(folder)
        manifest_path.write_bytes(manifest_bytes)
        node_path=folder/'nodes/r.json'
        node_path.write_bytes(node_path.read_bytes()+b' '*(prep.DESCRIPTOR_BYTES+1))
        with self.assertRaisesRegex(ValueError,'JSON input exceeds'):
            prep.verify_dataset(folder)

    def test_verification_requires_directory_and_content_identity(self):
        self.add()
        folder,_=self.prepare()
        path=folder/'manifest.json'
        manifest=prep.bounded_json(path)
        manifest['version']='radio-'+'0'*20
        path.write_bytes(prep.encoded(manifest))
        with self.assertRaisesRegex(ValueError,'directory does not match'):
            prep.verify_dataset(folder)
        manifest['version']=folder.name
        manifest['dbSha256']='0'*64
        path.write_bytes(prep.encoded(manifest))
        with self.assertRaisesRegex(ValueError,'content provenance'):
            prep.verify_dataset(folder)

    def test_report_source_failure_preserved(self):
        self.add()
        path=self.run/'report.json'
        report=prep.bounded_json(path)
        report['status']='partial'
        report['sources'].append({'id':'us_uls','status':'failed','input_mode':'automatic','message':'Source unavailable; no records imported'})
        path.write_text(json.dumps(report))
        _,manifest=self.prepare()
        self.assertEqual(next(s for s in manifest['sources'] if s['id']=='us_uls')['status'],'failed')
        self.assertEqual(manifest['coverage']['status'],'partial')


    def test_cell_networks_technologies_large_identity_and_unknown_allocation(self):
        reference=self.root/'reference.json'
        reference.write_text(json.dumps({'source':'https://imsiadmin.com/assignments/hni/',
            'sourceSha256':'a'*64,'retrievedAt':'2026-09-06T20:00:00Z','mncWidth':3,
            'networks':{'plmn:310:010':{'name':'Test assignee'}}}))
        for i,(radio,net) in enumerate([('LTE','10'),('NR','10'),('LTE','999'),('CDMA','10')]):
            raw={'radio':radio,'mcc':'310','net':net,'area':'001','cell':str(9007199254740993+i),
                 'created':'1700000000','updated':'1800000000','samples':'42','unit':'0',
                 'averageSignal':'0','changeable':'1','range':'100000'}
            self.add(category='candidates',source='global_opencellid',
                identity=':'.join(raw[k] for k in ('radio','mcc','net','area','cell')), details_json=json.dumps(raw))
        folder,m=self.prepare(cell_reference=reference)
        self.assertEqual(m['datasetKind'],'cell-locations')
        self.assertEqual(set(m['facets']['networks']),{'plmn:310:010','plmn:310:999','cdma:310:10'})
        rows=self.leaf_records(folder)
        self.assertTrue(all(r['country'] is None for r in rows))
        nr=next(r for r in rows if r['service']=='NR')
        self.assertEqual(nr['cell']['cell'],'9007199254740994')
        self.assertEqual(nr['cell']['net'],'10')
        self.assertEqual(nr['cell']['mnc'],'010')
        self.assertEqual(nr['cell']['firstSeen'],'2023-11-14T22:13:20Z')
        unknown=next(r for r in rows if r['network']=='plmn:310:999')
        self.assertIsNone(unknown['operator'])
        self.assertIn('MNC 999',m['networkLabels'][unknown['network']])
        cdma=next(r for r in rows if r['service']=='CDMA')
        self.assertIsNone(cdma['cell']['mnc'])
        self.assertEqual(cdma['cell']['networkKind'],'SID')
        self.assertIsNone(cdma['operator'])
        root=prep.bounded_json(folder/'nodes/r.json')
        groups=[g for p in root['summaryPages'] for g in prep.bounded_json(folder/p['file'])]
        actual=collections.Counter({(g['network'],g['service']):g['count'] for g in groups})
        self.assertEqual(actual,collections.Counter((r['network'],r['service']) for r in rows))
        prep.activate(self.output,m['version'])
        # Never replace a live radio root with the OpenCellID-only run.
        with self.assertRaisesRegex(ValueError,'radio'):
            prep.prepare(BUILDER,self.builder_output,self.root/'radio',cell_reference=reference)

    def test_cell_invalid_identity_timestamp_and_other_sources(self):
        from cell_enrichment import enrich_cell, timestamp
        self.assertIsNone(timestamp('NaN'))
        self.assertIsNone(timestamp('999999999999999999999'))
        self.assertIsNone(timestamp('0'))
        with self.assertRaisesRegex(ValueError,'OpenCellID-only'):
            enrich_cell({'source':'global_osm','category':'candidates'}, {'networks':{}})
        with self.assertRaisesRegex(ValueError,'identity'):
            enrich_cell({'source':'global_opencellid','category':'candidates',
                'details_json':{'radio':'LTE','mcc':'310','net':10,'area':'1','cell':'1'}}, {'networks':{}})

if __name__=='__main__':
    unittest.main()
