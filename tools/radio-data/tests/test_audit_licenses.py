import hashlib
import json
from pathlib import Path
import shutil
import sqlite3
import unittest
import uuid
from urllib.parse import urlencode

import audit_licenses as audit
from prepare_radio import digest_file


class AuthorizationAuditTests(unittest.TestCase):
    def setUp(self):
        self.parent = Path(__file__).parent / 'test-work'
        self.root = self.parent / ('license-audit-' + uuid.uuid4().hex)
        self.root.mkdir(parents=True)
        self.database = self.root / 'dataset.sqlite'
        self.rows = []
        db = sqlite3.connect(self.database)
        try:
            for category in audit.TABLES:
                db.execute(f'CREATE TABLE {category} (' + ','.join('"' + column + '" TEXT' for column in audit.COLUMNS) + ')')
        finally:
            db.close()

    def tearDown(self):
        self.assertTrue(self.root.resolve().is_relative_to(self.parent.resolve()))
        shutil.rmtree(self.root)

    def add(self, source, identity, license_id='', details=None, **values):
        row = dict.fromkeys(audit.COLUMNS)
        row.update(source=source, source_record_id=identity, license_id=license_id,
                   record_id=hashlib.sha256((source + '\0' + identity).encode()).hexdigest(),
                   status='active', service='radio', details_json=json.dumps(details or {}),
                   source_url='https://example.org/source', retrieved_at='2026-09-07T12:00:00+00:00')
        row.update(values)
        db = sqlite3.connect(self.database)
        try:
            db.execute('INSERT INTO transmitters VALUES (' + ','.join('?' for _ in audit.COLUMNS) + ')',
                       [row[column] for column in audit.COLUMNS])
            db.commit()
        finally:
            db.close()
        self.rows.append(row)

    def add_uls(self, identity='123:1', identifier='123', **values):
        licensing = {'authority': 'FCC', 'system': 'ULS', 'identifier_kind': 'fcc_uls_unique_system_id',
                     'identifier_label': 'FCC ULS unique system ID', 'identifier': identifier,
                     'record_url': 'https://wireless2.fcc.gov/UlsApp/UlsSearch/license.jsp?licKey=' + identifier}
        self.add('us_uls', identity, identifier, {'licensing': licensing}, **values)

    def test_coverage_distinguishes_typed_legacy_missing_and_redacts_sample_paths(self):
        fixture_password = 'not-a-real-fixture-password'
        fixture_token = 'not-a-real-fixture-token'
        fixture_url = ('https://' + 'fixture-user' + ':' + fixture_password +
                       '@example.invalid/data?' + urlencode({'api_token': fixture_token}))
        self.add_uls(source_url=fixture_url)
        self.add('us_lms', 'application-1:facility-9', '000001', {'application_id': 'application-1', 'facility_id': '9',
                 'licensing': {'authority': 'FCC', 'system': 'LMS', 'identifier_kind': 'fcc_lms_filing_number',
                 'identifier': '000001', 'record_url': 'https://enterpriseefiling.fcc.gov/dataentry/public/tv/draftCopy.html?appKey=application-1&displayType=html'}})
        self.add('fi_traficom', 'legacy-1', 'FI-LICENSE-1', call_sign='C:/private/call-sign')
        self.add('global_ourairports', 'nav-1', status='unknown')
        before = digest_file(self.database)
        result = audit.audit(self.database, samples_per_source=1)
        self.assertEqual(result['result'], 'passed')
        self.assertEqual(result['total_rows'], 4)
        self.assertEqual(result['sources']['us_uls']['identifier_kinds'], {'fcc_uls_unique_system_id': 1})
        self.assertEqual(result['sources']['us_lms']['secondary_identifiers']['facility_id'], 1)
        self.assertEqual(result['sources']['fi_traficom']['identifier_kinds'], {'legacy_unspecified': 1})
        self.assertEqual(result['sources']['global_ourairports']['license_id_missing'], 1)
        self.assertEqual(result['navaid_authorization_check']['result'], 'passed')
        self.assertTrue(all(len(info['samples']) == 1 for info in result['sources'].values()))
        public = json.dumps(result)
        for private in (fixture_password, fixture_token, 'C:/private', str(self.root)):
            self.assertNotIn(private, public)
        self.assertEqual(digest_file(self.database), before)

    def test_fabricated_navaid_links_and_mismatched_fcc_links_fail_audit(self):
        self.add('global_ourairports', 'nav-1', '123', {'licensing': {'authority': 'FCC', 'identifier': '123',
                 'record_url': 'https://wireless2.fcc.gov/UlsApp/UlsSearch/license.jsp?licKey=123'}})
        self.add('us_uls', '456:1', '456', {'licensing': {'authority': 'FCC', 'system': 'ULS',
                 'identifier_kind': 'fcc_uls_unique_system_id', 'identifier': '456',
                 'record_url': 'https://wireless2.fcc.gov/UlsApp/UlsSearch/license.jsp?licKey=999'}})
        result = audit.audit(self.database)
        self.assertEqual(result['result'], 'failed')
        self.assertEqual(result['violations']['fcc_record_link_missing_or_identifier_mismatch'], 1)
        self.assertEqual(result['violations']['navaid_has_unsupported_license_identifier'], 1)
        self.assertEqual(result['navaid_authorization_check']['result'], 'failed')
        self.assertTrue(all(not info['samples'] for info in result['sources'].values()))
        self.assertEqual(len(result['violation_examples']), 2)

    def prepared(self):
        folder = self.root / 'prepared'
        (folder / 'records').mkdir(parents=True)
        (folder / 'nodes').mkdir()
        page = folder / 'records' / 'r-0000.json'
        rows = [{**row, 'category': 'transmitters', 'id': 'transmitters:' + row['record_id'],
                 'details_json': json.loads(row['details_json'])} for row in self.rows]
        page.write_text(json.dumps(rows), encoding='utf-8')
        node = {'id': 'r', 'children': [], 'recordPages': [{'file': 'records/r-0000.json',
                'bytes': page.stat().st_size, 'sha256': digest_file(page)}]}
        (folder / 'nodes' / 'r.json').write_text(json.dumps(node))
        (folder / 'manifest.json').write_text(json.dumps({'version': 'radio-test',
            'counts': {'transmitters': len(rows), 'candidates': 0, 'receivers': 0}}))
        return folder

    def test_prepared_and_sqlite_audits_agree_and_bad_page_checksum_is_rejected(self):
        self.add_uls()
        self.add('global_ourairports', 'nav-1')
        folder = self.prepared()
        database_report, prepared_report = audit.audit(self.database), audit.audit(folder)
        for key in ('result', 'counts', 'sources', 'navaid_authorization_check'):
            self.assertEqual(database_report[key], prepared_report[key])
        page = folder / 'records' / 'r-0000.json'
        original = page.read_bytes()
        page.write_bytes(original.replace(b'nav-1', b'nav-2'))
        with self.assertRaisesRegex(ValueError, 'checksum mismatch'):
            audit.audit(folder)


if __name__ == '__main__':
    unittest.main()
