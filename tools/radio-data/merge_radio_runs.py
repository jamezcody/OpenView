"""Combine disjoint, completed builder snapshots without relabeling their records.

The existing radio snapshot stays byte-for-byte untouched. Sources may only occur
in one input: this is an additive import, never a geographic/license inference.
"""
from __future__ import annotations
import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import sqlite3
import uuid

from prepare_radio import digest_file, load_schema, resolve_run


def merge(builder: Path, baseline: Path, addition: Path, output: Path):
    fields, tables = load_schema(builder)
    snapshots = [resolve_run(baseline), resolve_run(addition)]
    selected = [set(report['selected_sources']) for _, report in snapshots]
    if selected[0] & selected[1]:
        raise ValueError('Input snapshots overlap sources; refusing an implicit replacement')
    original_hashes = [digest_file(run / 'dataset.sqlite') for run, _ in snapshots]
    stamp = datetime.now(timezone.utc).strftime('%Y%m%d-%H%M%S')
    run_id = f'{stamp}-merged-{uuid.uuid4().hex[:6]}'
    folder = output.resolve() / 'runs' / run_id
    folder.mkdir(parents=True, exist_ok=False)
    db_path = folder / 'dataset.sqlite'
    sources = []
    report = {
        'version': snapshots[1][1]['version'], 'run_id': run_id,
        'started_at': datetime.now(timezone.utc).isoformat(timespec='seconds'),
        'status': 'running', 'selected_sources': sorted(selected[0] | selected[1]),
        'active_only': None, 'sources': sources, 'downloads': [],
        'scope': 'Additive source snapshots. Original source dates and identifiers retained; no proximity joins or inferred authorizations. FCC additions exclude recognized inactive authorizations; baseline records retain their original status selection.',
        'input_snapshots': [],
    }
    db = sqlite3.connect(db_path)
    try:
        baseline_db = sqlite3.connect((snapshots[0][0] / 'dataset.sqlite').as_uri() + '?mode=ro', uri=True)
        try:
            baseline_db.backup(db)
        finally:
            baseline_db.close()
        columns = ','.join(f'"{field}"' for field in fields)
        for index, (run, source_report) in enumerate(snapshots):
            source_db = sqlite3.connect((run / 'dataset.sqlite').as_uri() + '?mode=ro', uri=True)
            try:
                for table in tables:
                    schema = [row[1] for row in source_db.execute(f'PRAGMA table_info({table})')]
                    if schema != fields:
                        raise ValueError('Builder schemas differ')
                    count = source_db.execute(f'SELECT count(*) FROM {table}').fetchone()[0]
                    if count != source_report.get('counts', {}).get(table, 0):
                        raise ValueError('Source snapshot count does not match its report')
                    unexpected = {row[0] for row in source_db.execute(f'SELECT DISTINCT source FROM {table}')} - selected[index]
                    if unexpected:
                        raise ValueError('Snapshot contains unreported sources')
                    if index:
                        insert = f'INSERT INTO {table} ({columns}) VALUES ({",".join("?" for _ in fields)})'
                        db.executemany(insert, source_db.execute(f'SELECT {columns} FROM {table}'))
                for entry in source_report['sources']:
                    entry = dict(entry)
                    selection = source_report.get('active_only')
                    # A recursive merge has no single status-selection policy.
                    # Each source already carries its original policy in coverage.
                    policy = ('Recognized inactive authorizations excluded; unknown status retained as candidates.'
                              if selection is True else 'Original all-status snapshot retained.'
                              if selection is False else '')
                    entry['coverage'] = ' '.join(filter(None, [entry.get('coverage'), policy, f"Source snapshot: {source_report['run_id']}."]))
                    sources.append(entry)
                report['downloads'].extend(source_report.get('downloads', []))
                report['input_snapshots'].append({
                    'run_id': source_report['run_id'], 'database_sha256': original_hashes[index],
                    'report_sha256': digest_file(run / 'report.json'),
                    'active_only': source_report.get('active_only'),
                })
            finally:
                source_db.close()
        db.commit()
        report['counts'] = {table: db.execute(f'SELECT count(*) FROM {table}').fetchone()[0] for table in tables}
        for table in tables:
            expected = sum(item.get('counts', {}).get(table, 0) for _, item in snapshots)
            if report['counts'][table] != expected:
                raise ValueError('Merged totals do not reconcile')
        if db.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
            raise ValueError('Merged SQLite integrity check failed')
    finally:
        db.close()
    if original_hashes != [digest_file(run / 'dataset.sqlite') for run, _ in snapshots]:
        raise ValueError('Source snapshot changed during merge')
    report['status'] = 'complete' if all(entry['status'] in ('complete', 'reference_only') for entry in sources) else 'partial'
    catalog = json.loads((builder / 'sources.json').read_text(encoding='utf-8-sig'))
    # The catalog is a list in the builder; preparation validates its full form.
    catalog_ids = set(catalog) if isinstance(catalog, dict) else {entry['id'] for entry in catalog}
    report['unselected_sources'] = sorted(catalog_ids - set(report['selected_sources']))
    report['finished_at'] = datetime.now(timezone.utc).isoformat(timespec='seconds')
    (folder / 'report.json').write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding='utf-8')
    pointer = output.resolve() / 'latest.json'
    temporary = pointer.with_suffix('.json.tmp')
    temporary.write_text(json.dumps({'run_directory': str(folder), 'status': report['status']}, indent=2), encoding='utf-8')
    temporary.replace(pointer)
    return report


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('builder', 'baseline', 'addition', 'output'):
        parser.add_argument('--' + name, type=Path, required=True)
    args = parser.parse_args()
    result = merge(args.builder, args.baseline, args.addition, args.output)
    print(json.dumps({'run_id': result['run_id'], 'status': result['status'], 'counts': result['counts']}, indent=2))
