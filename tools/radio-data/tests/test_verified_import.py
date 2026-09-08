import hashlib
import json
from pathlib import Path
import shutil
import unittest
from unittest.mock import patch
import uuid
import zipfile

import import_fcc_verified as importer
from test_fcc import lms_archive


class VerifiedImportTests(unittest.TestCase):
    def setUp(self):
        self.parent = Path(__file__).parent / 'tmp'
        self.folder = self.parent / uuid.uuid4().hex
        self.folder.mkdir(parents=True)
        self.archive = self.folder / 'fixture.zip'
        lms_archive(self.archive, [{'id': 'a' * 32}])
        self.info = {'source': 'us_lms', 'archive': self.archive.name,
                     'canonical_url': 'https://enterpriseefiling.fcc.gov/dataentry/fixture.zip',
                     'size_bytes': self.archive.stat().st_size,
                     'sha256': hashlib.sha256(self.archive.read_bytes()).hexdigest()}
        self.manifest = self.folder / 'inputs.json'
        self.save()

    def save(self):
        self.manifest.write_text(json.dumps({'schemaVersion': 1, 'inputs': [self.info]}), encoding='utf-8')

    def tearDown(self):
        assert self.folder.resolve().is_relative_to(self.parent.resolve())
        shutil.rmtree(self.folder)

    def test_preserved_fixture_import_never_downloads(self):
        with patch('core.Context.download', side_effect=AssertionError('Network acquisition attempted')):
            report = importer.build(self.manifest, self.folder, self.folder / 'output', 'us_lms', lambda _: None)
        self.assertEqual(report['status'], 'complete')
        self.assertEqual(report['counts']['transmitters'], 1)
        self.assertTrue(report['active_only'])
        self.assertEqual(report['downloads'][0]['sha256'], self.info['sha256'])
        self.assertIn('unavailable', report['downloads'][0]['retrieved_at'])

    def test_hash_and_directory_traversal_fail_before_import(self):
        self.info['sha256'] = '0' * 64
        self.save()
        with self.assertRaisesRegex(ValueError, 'checksum'):
            importer.verified_archives(self.manifest, self.folder, 'us_lms')
        self.info['archive'] = '../fixture.zip'
        self.save()
        with self.assertRaisesRegex(ValueError, 'basename'):
            importer.verified_archives(self.manifest, self.folder, 'us_lms')

    def test_full_crc_check_rejects_corrupt_member_even_with_matching_file_hash(self):
        with zipfile.ZipFile(self.archive, 'w', compression=zipfile.ZIP_STORED) as archive:
            archive.writestr('fixture.dat', 'ORIGINAL-CONTENT')
        raw = self.archive.read_bytes().replace(b'ORIGINAL-CONTENT', b'CORRUPTEDCONTENT')
        self.archive.write_bytes(raw)
        self.info.update(size_bytes=len(raw), sha256=hashlib.sha256(raw).hexdigest())
        self.save()
        with self.assertRaisesRegex(ValueError, 'CRC'):
            importer.verified_archives(self.manifest, self.folder, 'us_lms')

    def test_missing_configured_uls_archives_are_not_partial_success(self):
        self.info.update(source='us_uls', archive='l_micro.zip')
        self.save()
        with self.assertRaisesRegex(ValueError, 'all nine'):
            importer.verified_archives(self.manifest, self.folder, 'us_uls')
