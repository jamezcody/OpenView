"""Meaningful source identity, compact encoding, navigation, and integrity fixtures."""
import hashlib
import json
import sqlite3
import shutil
import uuid
from contextlib import contextmanager
from pathlib import Path
import unittest

import prepare_search as p


@contextmanager
def workspace_temp():
    parent=Path(__file__).resolve().parent/'tmp'
    folder=parent/uuid.uuid4().hex;folder.mkdir(parents=True)
    try:yield folder
    finally:
        assert folder.resolve().is_relative_to(parent.resolve())
        shutil.rmtree(folder)


def fixture_record(**updates):
    record = {'source': 'global_ourairports', 'source_record_id': '90768', 'category': 'transmitters',
              'lat': -64.23169708251953, 'lon': -56.599998474121094, 'call_sign': 'MBI',
              'operator': None, 'site_id': '90768', 'license_id': 'BC123', 'country': 'AQ',
              'service': 'NDB', 'status': 'unknown', 'frequency_mhz': .345, 'frequency_upper_mhz': None,
              'source_url': 'https://ourairports.com/data/', 'details_json': {'name': 'Marambio', 'associated_airport': 'SAWB'}}
    record.update(updates)
    record['record_id'] = hashlib.sha256((record['source'] + '\0' + record['source_record_id']).encode()).hexdigest()
    record['id'] = record['category'] + ':' + record['record_id']
    return record


class IdentityAndEncoding(unittest.TestCase):
    def test_exact_locator_precision_and_complete_aliases(self):
        record = fixture_record()
        item = p.radio_item(record, 'r012')
        self.assertEqual(item['target']['recordId'], record['id'])
        self.assertEqual(item['target']['node'], 'r012')
        self.assertEqual(item['lat'], record['lat'])
        self.assertEqual(item['lon'], record['lon'])
        self.assertIn('Marambio', item['name'])
        for alias in ('mbi', '90768', 'bc123', 'sawb', '0.345 mhz'):
            self.assertIn(alias, p.fold(item['name'] + ' ' + item['terms']))

    def test_compact_round_trip_and_stable_dictionaries(self):
        records = [p.radio_item(fixture_record(), 'r012'),
                   p.radio_item(fixture_record(category='receivers', source_record_id='receiver-1'), 'r1')]
        encoded = p.compact_radio(records)
        self.assertEqual(p.expand_radio(encoded), records)
        self.assertEqual(encoded['sources'], p.compact_radio(list(reversed(records)))['sources'])
        self.assertEqual(encoded['details'], p.compact_radio(list(reversed(records)))['details'])

    def test_corrupt_tuple_category_and_dictionary_rejected(self):
        for column, value in ((2, 3), (4, -1), (8, 100), (1, '../x'), (6, 91)):
            envelope = p.compact_radio([p.radio_item(fixture_record(), 'r0')])
            envelope['items'][0][column] = value
            with self.assertRaises(ValueError):
                p.expand_radio(envelope)

    def test_identity_mismatch_and_duplicate_rejected(self):
        record = fixture_record()
        record['source_record_id'] = 'different'
        with self.assertRaises(ValueError):
            p.radio_item(record, 'r0')
        item = p.radio_item(fixture_record(), 'r0')
        with self.assertRaises(ValueError):
            p.expand_radio(p.compact_radio([item, item]))

    def test_metadata_allowlist_excludes_arbitrary_details(self):
        rejected_metadata = 'not-a-real-metadata-sentinel'
        record = fixture_record(details_json={'name': 'Allowed', 'password': rejected_metadata,
                                              'unrelated': rejected_metadata, 'source_record': {'Secret': rejected_metadata}})
        self.assertNotIn(rejected_metadata, json.dumps(p.radio_item(record, 'r0')))
        with self.assertRaises(ValueError):
            p.safe_source_url('https://' + ':'.join(('fixture-user', 'not-a-real-fixture-password')) + '@example.invalid/')

    def test_nominal_and_receive_frequency_meanings_retained(self):
        item = p.radio_item(fixture_record(category='receivers', frequency_mhz=144, frequency_upper_mhz=146,
                                          details_json={'name': 'Receiver', 'nominal_band_mhz': 1800}), 'r0')
        self.assertEqual(item['kind'], 'receiver')
        self.assertIn('144 mhz', item['terms'])
        self.assertIn('146 mhz', item['terms'])
        self.assertIn('nominal 1800 mhz', item['terms'])

    def test_source_hash_and_byte_count_fail_closed(self):
        raw = p.encoded({'items': [1]})
        with workspace_temp() as directory:
            file = Path(directory) / 'page.json'
            file.write_bytes(raw)
            valid = {'bytes': len(raw), 'sha256': p.digest(raw)}
            self.assertEqual(p.read_json(file, expected=valid)[0]['items'], [1])
            file.write_bytes(raw.replace(b'1', b'2'))
            with self.assertRaises(ValueError):
                p.read_json(file, expected=valid)
            with self.assertRaises(ValueError):
                p.read_json(file, maximum=1)

    def test_diacritics_normalize_and_full_id_retained(self):
        self.assertEqual(p.fold('  Ålands  RADIO  '), 'alands radio')
        long_id = 'prefix:' + 'a' * 64
        self.assertIn(long_id, p.terms([long_id]))




class LocalRadioSqlite(unittest.TestCase):
    def test_portable_pipeline_pins_new_map_and_reuses_verified_parks(self):
        from test_prepare_radio import PreparationTests
        fixture = PreparationTests()
        fixture.setUp()
        try:
            public = fixture.root / 'public'
            fixture.output = public / 'radio'
            fixture.add(identity='first')
            fixture.add(identity='second', call_sign='WTEST')
            _, radio = fixture.prepare()
            park_release = 'parks-' + 'a' * 20
            search_version = 'search-' + 'b' * 20
            (public / 'parks').mkdir()
            (public / 'parks/latest.json').write_bytes(p.encoded({'release': park_release}))
            old = public / 'search' / search_version
            old.mkdir(parents=True)
            park_bytes = p.encoded({'schemaVersion': 1, 'items': []})
            (old / 'parks.json').write_bytes(park_bytes)
            descriptor = dict(p.file_descriptor(old / 'parks.json'), kind='parks', count=0)
            old_manifest = {'version': search_version, 'parkRelease': park_release,
                            'radioVersion': 'radio-' + 'c' * 20, 'files': [descriptor]}
            (public / 'search/latest.json').write_bytes(p.encoded(old_manifest))
            output = fixture.root / 'search-candidate'
            result = p.build_local_radio(public, output)
            self.assertEqual(result['radioVersion'], radio['version'])
            self.assertEqual(result['files'][0]['count'], 2)
            self.assertEqual((output / result['version'] / 'parks.json').read_bytes(), park_bytes)
            self.assertEqual(json.loads((public / 'search/latest.json').read_bytes()), old_manifest)
            self.assertFalse((output / 'latest.json').exists())
            db = sqlite3.connect(output / result['version'] / 'radio.sqlite')
            try:
                rows = [json.loads(row[0]) for row in db.execute('SELECT payload FROM records')]
                self.assertTrue(all(row['release'] == radio['version'] for row in rows))
                self.assertTrue(all((fixture.output / 'versions' / radio['version'] / 'nodes' / (row['target']['node'] + '.json')).exists() for row in rows))
            finally:
                db.close()
        finally:
            fixture.tearDown()

    def test_streaming_index_keeps_all_identities_current_nodes_and_aliases(self):
        records = [fixture_record(source_record_id='first', details_json={'name':'Ålands radio','licensing':{'identifier':'0000123456'},'facility_id':'90001'}),
                   fixture_record(source='us_lms',source_record_id='second',license_id='BLH-20010101AAA',details_json={'name':'Other station','application_id':'abcdef123456'})]
        with workspace_temp() as folder:
            path=Path(folder)/'radio.sqlite'
            stats=p.write_radio_sqlite(path,(p.radio_item(record,'r012') for record in records),'radio-'+'a'*20)
            self.assertEqual(stats['count'],2)
            db=sqlite3.connect(path)
            try:
                metadata=dict(db.execute('SELECT key,value FROM metadata'))
                self.assertEqual(metadata['radioVersion'],'radio-'+'a'*20)
                for query in ('alands','0000123456','90001','blh 20010101aaa','abcdef123456'):
                    rows=db.execute('SELECT r.payload FROM radio_search s JOIN records r ON r.rowid=s.rowid WHERE s.search_text LIKE ?',('%'+query+'%',)).fetchall()
                    self.assertEqual(len(rows),1,query)
                    item=json.loads(rows[0][0]);self.assertEqual(item['target']['node'],'r012')
                    self.assertEqual(item['id'],'radio:'+item['target']['recordId'])
            finally:db.close()

    def test_duplicate_records_cannot_silently_reduce_coverage(self):
        with workspace_temp() as folder:
            item=p.radio_item(fixture_record(),'r0')
            with self.assertRaises(sqlite3.IntegrityError):
                p.write_radio_sqlite(Path(folder)/'radio.sqlite',iter([item,item]),'radio-'+'a'*20)


if __name__ == '__main__':
    unittest.main()
