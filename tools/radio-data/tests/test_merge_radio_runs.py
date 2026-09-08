import hashlib
import json
from pathlib import Path
import shutil
import sqlite3
import unittest
import uuid

from merge_radio_runs import merge
from prepare_radio import digest_file, load_schema, resolve_run

BUILDER = Path(__file__).resolve().parents[1] / 'builder'


class MergeRadioRunsTests(unittest.TestCase):
    def setUp(self):
        self.parent = Path(__file__).parent / 'test-work'
        self.root = self.parent / ('merge-' + uuid.uuid4().hex)
        self.root.mkdir(parents=True)
        self.output = self.root / 'merged'
        self.output.mkdir()
        self.pointer = self.output / 'latest.json'
        self.pointer.write_text('{"existing":"published version stays active"}\n')
        self.old_pointer = self.pointer.read_bytes()
        self.fields, self.tables = load_schema(BUILDER)

    def tearDown(self):
        self.assertTrue(self.root.resolve().is_relative_to(self.parent.resolve()))
        shutil.rmtree(self.root)

    def snapshot(self, name, rows):
        output = self.root / name
        run = output / 'runs' / (name + '-run')
        run.mkdir(parents=True)
        counts = {table: 0 for table in self.tables}
        sources = set()
        db = sqlite3.connect(run / 'dataset.sqlite')
        try:
            for table in self.tables:
                db.execute(f'CREATE TABLE {table} (' + ','.join('"' + field + '" TEXT' for field in self.fields) + ', PRIMARY KEY(record_id))')
            for category, source, source_id, values in rows:
                record = dict.fromkeys(self.fields)
                record.update(record_id=hashlib.sha256((source + '\0' + source_id).encode()).hexdigest(),
                              source=source, source_record_id=source_id, country='US',
                              latitude='40.5', longitude='-74.5', status='unknown',
                              source_file='official.csv', source_url='https://example.org/official.csv',
                              retrieved_at='2026-09-06T12:00:00+00:00', details_json='{}')
                record.update(values)
                db.execute(f'INSERT INTO {category} VALUES (' + ','.join('?' for _ in self.fields) + ')',
                           [record[field] for field in self.fields])
                counts[category] += 1
                sources.add(source)
            db.commit()
        finally:
            db.close()
        report = {'version': '1.1.0', 'run_id': run.name, 'status': 'complete',
                  'active_only': name == 'addition', 'selected_sources': sorted(sources),
                  'counts': counts, 'downloads': [],
                  'sources': [{'id': source, 'status': 'complete', 'coverage': 'Original source coverage.'}
                              for source in sorted(sources)]}
        (run / 'report.json').write_text(json.dumps(report), encoding='utf-8')
        (output / 'latest.json').write_text(json.dumps({'run_directory': str(run), 'status': 'complete'}))
        return output, run

    def records(self, run, category, source=None):
        db = sqlite3.connect(run / 'dataset.sqlite')
        try:
            sql = f'SELECT * FROM {category}' + (' WHERE source=?' if source else '') + ' ORDER BY record_id'
            return db.execute(sql, (source,) if source else ()).fetchall()
        finally:
            db.close()

    def test_disjoint_merge_preserves_baseline_rows_identities_and_files(self):
        baseline, base_run = self.snapshot('baseline', [
            ('transmitters', 'global_ourairports', 'nav-1', {'call_sign': 'NAV', 'license_id': ''}),
            ('candidates', 'global_osm', 'way-2', {'status': 'mapped', 'details_json': '{"tags":{"man_made":"tower"}}'}),
            ('receivers', 'global_satnogs', 'station-3', {'status': 'Offline'}),
        ])
        addition, add_run = self.snapshot('addition', [
            ('transmitters', 'us_uls', '123:1:1:155', {'license_id': '123', 'call_sign': 'WTEST', 'status': 'active'}),
            ('candidates', 'us_uls', '456:1:1:156', {'license_id': '456', 'status': 'unknown'}),
        ])
        unchanged = {path: digest_file(path) for run in (base_run, add_run)
                     for path in (run / 'dataset.sqlite', run / 'report.json')}
        result = merge(BUILDER, baseline, addition, self.output)
        merged_run, published = resolve_run(self.output)
        self.assertEqual(result['counts'], {'transmitters': 2, 'candidates': 2, 'receivers': 1})
        self.assertEqual(published['selected_sources'], ['global_osm', 'global_ourairports', 'global_satnogs', 'us_uls'])
        self.assertEqual(result['status'], 'complete')
        for table in self.tables:
            expected = sorted(self.records(base_run, table) + self.records(add_run, table))
            self.assertEqual(self.records(merged_run, table), expected)
        self.assertEqual(unchanged, {path: digest_file(path) for path in unchanged})
        self.assertEqual({item['database_sha256'] for item in result['input_snapshots']},
                         {unchanged[base_run / 'dataset.sqlite'], unchanged[add_run / 'dataset.sqlite']})
        self.assertNotEqual(self.pointer.read_bytes(), self.old_pointer)

    def test_overlapping_sources_rejected_without_pointer_replacement(self):
        baseline, _ = self.snapshot('baseline', [('transmitters', 'us_uls', 'first', {})])
        addition, _ = self.snapshot('addition', [('transmitters', 'us_uls', 'second', {})])
        with self.assertRaisesRegex(ValueError, 'overlap sources'):
            merge(BUILDER, baseline, addition, self.output)
        self.assertEqual(self.pointer.read_bytes(), self.old_pointer)
        self.assertFalse((self.output / 'runs').exists())

    def test_report_count_mismatch_rejected_without_pointer_replacement(self):
        baseline, base_run = self.snapshot('baseline', [('transmitters', 'global_ourairports', 'nav', {})])
        addition, add_run = self.snapshot('addition', [('transmitters', 'us_uls', 'license', {'license_id': '123'})])
        path = add_run / 'report.json'
        report = json.loads(path.read_text())
        report['counts']['transmitters'] = 2
        path.write_text(json.dumps(report))
        hashes = {run: digest_file(run / 'dataset.sqlite') for run in (base_run, add_run)}
        with self.assertRaisesRegex(ValueError, 'count does not match'):
            merge(BUILDER, baseline, addition, self.output)
        self.assertEqual(self.pointer.read_bytes(), self.old_pointer)
        self.assertEqual(hashes, {run: digest_file(run / 'dataset.sqlite') for run in hashes})
        self.assertFalse(any((self.output / 'runs').glob('*/report.json')))

    def test_recursive_merge_retains_each_sources_original_status_selection_policy(self):
        baseline, _ = self.snapshot('baseline', [('transmitters', 'global_ourairports', 'nav', {})])
        addition, _ = self.snapshot('addition', [('transmitters', 'us_lms', 'application', {'license_id': '000001'})])
        first = self.root / 'first-merge'
        merge(BUILDER, baseline, addition, first)
        uls, uls_run = self.snapshot('uls-addition', [('transmitters', 'us_uls', '123', {'license_id': '123'})])
        source_report = json.loads((uls_run / 'report.json').read_text())
        source_report['active_only'] = True
        (uls_run / 'report.json').write_text(json.dumps(source_report))
        result = merge(BUILDER, first, uls, self.output)
        coverage = {entry['id']: entry['coverage'] for entry in result['sources']}
        active_policy = 'Recognized inactive authorizations excluded; unknown status retained as candidates.'
        original_policy = 'Original all-status snapshot retained.'
        for source in ('us_lms', 'us_uls'):
            self.assertEqual(coverage[source].count(active_policy), 1)
            self.assertNotIn(original_policy, coverage[source])
        self.assertEqual(coverage['global_ourairports'].count(original_policy), 1)
        self.assertNotIn(active_policy, coverage['global_ourairports'])


if __name__ == '__main__':
    unittest.main()
