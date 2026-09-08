"""Stream a read-only authorization coverage audit from SQLite or prepared radio assets.

Counts describe imported records, not unique physical towers. Sample verification
checks identifiers and links against fields in the imported rows; it does not
claim to have fetched a live FCC license or prove current station operation.
"""
from __future__ import annotations

import argparse
from collections import Counter
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
import sqlite3
from urllib.parse import parse_qs, urlsplit

from prepare_radio import (DATA_VERSION, DESCRIPTOR_BYTES, NODE_ID, PAGE_BYTES,
                           bounded_json, digest_file, resolve_run, sanitize)

TABLES = ('transmitters', 'candidates', 'receivers')
COLUMNS = ('record_id', 'source', 'source_record_id', 'license_id', 'call_sign',
           'service', 'status', 'source_url', 'retrieved_at', 'details_json')
KINDS = {'us_uls': 'fcc_uls_unique_system_id', 'us_lms': 'fcc_lms_filing_number'}


def text(value):
    return '' if value is None else str(value).strip()


def resolve_input(value):
    path = Path(value).resolve(strict=True)
    if path.is_file():
        if path.suffix.lower() not in ('.sqlite', '.sqlite3', '.db'):
            raise ValueError('Input file must be a normalized SQLite database')
        return 'sqlite', path, {}
    if (path / 'dataset.sqlite').is_file():
        report = bounded_json(path / 'report.json') if (path / 'report.json').exists() else {}
        return 'sqlite', path / 'dataset.sqlite', report
    if (path / 'manifest.json').is_file():
        return 'prepared', path, bounded_json(path / 'manifest.json', DESCRIPTOR_BYTES)
    pointer = bounded_json(path / 'latest.json', 16384)
    if 'run_directory' in pointer:
        run, report = resolve_run(path)
        return 'sqlite', run / 'dataset.sqlite', report
    version = pointer.get('version')
    if not isinstance(version, str) or not DATA_VERSION.fullmatch(version):
        raise ValueError('Unrecognized prepared dataset version')
    folder = (path / 'versions' / version).resolve(strict=True)
    if folder.parent != (path / 'versions').resolve(strict=True):
        raise ValueError('Prepared dataset path escapes its versions directory')
    manifest_path = folder / 'manifest.json'
    if pointer.get('sha256') != digest_file(manifest_path):
        raise ValueError('Prepared manifest checksum does not match active pointer')
    return 'prepared', folder, bounded_json(manifest_path, DESCRIPTOR_BYTES)


def sqlite_rows(path):
    db = sqlite3.connect(path.as_uri() + '?mode=ro', uri=True)
    db.row_factory = sqlite3.Row
    try:
        db.execute('PRAGMA query_only=ON')
        for category in TABLES:
            schema = {row['name'] for row in db.execute(f'PRAGMA table_info({category})')}
            if not set(COLUMNS) <= schema:
                raise ValueError('Database does not contain the normalized builder columns')
            for row in db.execute(f'SELECT {",".join(COLUMNS)} FROM {category}'):
                yield category, dict(row)
    finally:
        db.close()


def prepared_rows(folder):
    pending, visited, pages = ['r'], set(), set()
    while pending:
        node_id = pending.pop()
        if not isinstance(node_id, str) or not NODE_ID.fullmatch(node_id) or node_id in visited:
            raise ValueError('Invalid or repeated prepared node')
        visited.add(node_id)
        node = bounded_json(folder / 'nodes' / (node_id + '.json'), DESCRIPTOR_BYTES)
        if node.get('id') != node_id:
            raise ValueError('Prepared node identity mismatch')
        pending.extend(reversed(node.get('children', [])))
        for descriptor in node.get('recordPages', []):
            relative = descriptor.get('file')
            if not isinstance(relative, str) or not re.fullmatch(r'records/r[0-3]{0,12}-\d{4,}\.json', relative) or relative in pages:
                raise ValueError('Invalid or repeated prepared record page')
            pages.add(relative)
            path = (folder / relative).resolve(strict=True)
            if not path.is_relative_to(folder) or path.stat().st_size != descriptor.get('bytes'):
                raise ValueError('Prepared record page path or size mismatch')
            if digest_file(path) != descriptor.get('sha256'):
                raise ValueError('Prepared record page checksum mismatch')
            rows = bounded_json(path, PAGE_BYTES)
            if not isinstance(rows, list):
                raise ValueError('Prepared record page must contain a list')
            for row in rows:
                category = row.get('category')
                if category not in TABLES:
                    raise ValueError('Unknown prepared record category')
                yield category, row


def detail_object(value):
    if isinstance(value, dict):
        return value, True
    if value in (None, ''):
        return {}, True
    try:
        parsed = json.loads(value)
        return (parsed, True) if isinstance(parsed, dict) else ({}, False)
    except (TypeError, ValueError):
        return {}, False


def contains_fcc_license_link(value):
    if isinstance(value, dict):
        return any(contains_fcc_license_link(child) for child in value.values())
    if isinstance(value, list):
        return any(contains_fcc_license_link(child) for child in value)
    if isinstance(value, str):
        lower = value.lower()
        return 'fcc.gov/' in lower and any(marker in lower for marker in ('lickey=', 'appkey=', '/license.jsp'))
    return False


def check_record(category, row, details, valid_details):
    errors = []
    source, identity = row.get('source'), row.get('source_record_id')
    if not isinstance(source, str) or not isinstance(identity, str):
        source, identity = text(source), text(identity)
        errors.append('record_identity_not_text')
    expected = hashlib.sha256((source + '\0' + identity).encode()).hexdigest()
    if not source or not identity or row.get('record_id') != expected:
        errors.append('record_identity_mismatch')
    if row.get('id') and row['id'] != category + ':' + expected:
        errors.append('prepared_identity_mismatch')
    if not valid_details:
        errors.append('invalid_details_json')
    licensing = details.get('licensing') or {}
    if not isinstance(licensing, dict):
        errors.append('invalid_licensing_metadata')
        licensing = {}
    identifier = text(licensing.get('identifier'))
    legacy_identifier = text(row.get('license_id'))
    kind, link = text(licensing.get('identifier_kind')), text(licensing.get('record_url'))
    if identifier and identifier != legacy_identifier:
        errors.append('licensing_identifier_differs_from_record_field')
    if source in KINDS:
        if kind != KINDS[source]:
            errors.append('fcc_identifier_kind_missing_or_incorrect')
        if licensing.get('authority') != 'FCC' or licensing.get('system') != source[3:].upper():
            errors.append('fcc_authority_or_system_missing_or_incorrect')
        if legacy_identifier and not identifier:
            errors.append('fcc_supplied_identifier_not_typed')
        try:
            url = urlsplit(link)
            query = parse_qs(url.query)
            valid = url.scheme == 'https' and not url.username and not url.password
            if source == 'us_uls':
                valid = (not identifier and not link) or (valid and bool(identifier) and url.hostname == 'wireless2.fcc.gov' and url.path == '/UlsApp/UlsSearch/license.jsp' and query.get('licKey') == [identifier])
            else:
                application = text(details.get('application_id'))
                valid = valid and bool(application) and url.hostname == 'enterpriseefiling.fcc.gov' and url.path == '/dataentry/public/tv/draftCopy.html' and query.get('appKey') == [application]
            if not valid:
                errors.append('fcc_record_link_missing_or_identifier_mismatch')
        except ValueError:
            errors.append('fcc_record_link_missing_or_identifier_mismatch')
    if source == 'global_ourairports':
        if legacy_identifier or identifier:
            errors.append('navaid_has_unsupported_license_identifier')
        if text(licensing.get('authority')) or link:
            errors.append('navaid_has_unsupported_licensing_authority_or_link')
        if contains_fcc_license_link(details) or contains_fcc_license_link(row.get('source_url')):
            errors.append('navaid_has_fcc_license_link')
    return errors, licensing


def audit(input_path, samples_per_source=3):
    if not 0 <= samples_per_source <= 20:
        raise ValueError('Sample count must be between 0 and 20 per source')
    mode, path, metadata = resolve_input(input_path)
    report = {
        'schema_version': 1, 'created_at_utc': datetime.now(timezone.utc).isoformat(timespec='seconds'),
        'input_format': mode, 'snapshot_id': metadata.get('run_id') or metadata.get('version'),
        'verification_scope': 'Read-only structural audit of imported rows, typed identifiers, and FCC link parameters. Sample checks do not fetch external license pages or establish present station operation.',
        'interpretation': 'Counts refer to source records across transmitter, candidate, and receiver categories, not unique towers or unique licenses. Legacy untyped identifiers remain unspecified.',
        'counts': Counter(), 'sources': {}, 'violations': Counter(), 'violation_examples': [],
    }
    generator = sqlite_rows(path) if mode == 'sqlite' else prepared_rows(path)
    sample_keys = {}
    for category, row in generator:
        source = text(row.get('source')) or '(missing source)'
        details, valid_details = detail_object(row.get('details_json'))
        errors, licensing = check_record(category, row, details, valid_details)
        report['counts'][category] += 1
        info = report['sources'].setdefault(source, {
            'rows': 0, 'categories': Counter(), 'statuses': Counter(),
            'license_id_present': 0, 'license_id_missing': 0,
            'typed_identifier_present': 0, 'licensing_metadata_present': 0,
            'record_link_present': 0, 'identifier_kinds': Counter(),
            'secondary_identifiers': Counter(), 'violation_counts': Counter(), 'samples': [],
        })
        info['rows'] += 1
        info['categories'][category] += 1
        info['statuses'][text(row.get('status')) or '(unknown)'] += 1
        has_id = bool(text(row.get('license_id')))
        info['license_id_present' if has_id else 'license_id_missing'] += 1
        info['licensing_metadata_present'] += bool(licensing)
        typed = bool(text(licensing.get('identifier_kind')) and text(licensing.get('identifier')))
        info['typed_identifier_present'] += typed
        kind = text(licensing.get('identifier_kind')) or ('legacy_unspecified' if has_id else '(missing)')
        info['identifier_kinds'][kind] += 1
        info['record_link_present'] += bool(text(licensing.get('record_url')))
        for key in ('application_id', 'facility_id'):
            info['secondary_identifiers'][key] += bool(text(details.get(key)))
        info['secondary_identifiers']['call_sign'] += bool(text(row.get('call_sign')))
        info['violation_counts'].update(errors)
        report['violations'].update(errors)
        sample = {key: row.get(key) for key in ('record_id', 'source_record_id', 'license_id', 'call_sign', 'service', 'status', 'source_url', 'retrieved_at')}
        sample.update(category=category, identifier_kind=kind,
                      licensing={key: licensing[key] for key in ('authority', 'system', 'identifier_kind', 'identifier_label', 'identifier', 'record_url') if key in licensing},
                      application_id=details.get('application_id'), facility_id=details.get('facility_id'),
                      structural_checks='passed' if not errors else 'failed', violations=errors)
        if errors and len(report['violation_examples']) < 20:
            report['violation_examples'].append({'source': source, **sample})
        key = text(licensing.get('identifier')) or text(row.get('license_id')) or text(row.get('source_record_id'))
        keys = sample_keys.setdefault(source, set())
        if not errors and key not in keys and len(info['samples']) < samples_per_source:
            keys.add(key)
            info['samples'].append(sample)
    expected = metadata.get('counts')
    if isinstance(expected, dict) and any(report['counts'][category] != expected.get(category, 0) for category in TABLES):
        raise ValueError('Audited row counts do not match the source report or prepared manifest')
    report['counts'] = {category: report['counts'][category] for category in TABLES}
    report['total_rows'] = sum(report['counts'].values())
    for info in report['sources'].values():
        info['license_id_present_percent'] = round(100 * info['license_id_present'] / info['rows'], 4)
        info['typed_identifier_present_percent'] = round(100 * info['typed_identifier_present'] / info['rows'], 4)
    navaid = report['sources'].get('global_ourairports')
    report['navaid_authorization_check'] = {
        'source': 'global_ourairports', 'rows_checked': navaid['rows'] if navaid else 0,
        'result': 'failed' if any(key.startswith('navaid_') for key in report['violations']) else ('passed' if navaid else 'not_present'),
        'meaning': 'OurAirports records must retain no unsupported license identifier, licensing authority, or FCC authorization link.',
    }
    report['result'] = 'passed' if not report['violations'] else 'failed'
    return sanitize(report)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input', type=Path, required=True, help='Builder output, run folder, SQLite file, prepared root, or prepared version folder')
    parser.add_argument('--output', type=Path, required=True, help='Public JSON audit report')
    parser.add_argument('--samples-per-source', type=int, default=3)
    args = parser.parse_args()
    result = audit(args.input, args.samples_per_source)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')
    print(json.dumps({key: result[key] for key in ('result', 'total_rows', 'counts', 'violations', 'navaid_authorization_check')}, indent=2))
    return 0 if result['result'] == 'passed' else 1


if __name__ == '__main__':
    raise SystemExit(main())
