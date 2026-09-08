"""Import preserved FCC archives after size, SHA-256 and full ZIP CRC checks.

This command never downloads data. The manifest contains public provenance and
archive basenames; --archives supplies the operator's local input directory.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import re
import sys
from urllib.parse import urlsplit
import zipfile

HERE = Path(__file__).resolve().parent


def public_fcc_url(value):
    if not isinstance(value, str):
        raise ValueError('Missing public FCC download URL')
    parts = urlsplit(value)
    if (parts.scheme != 'https' or parts.hostname not in
            {'data.fcc.gov', 'enterpriseefiling.fcc.gov'} or
            parts.username or parts.password or parts.port or parts.query or parts.fragment):
        raise ValueError('Expected an HTTPS FCC archive URL without credentials or query parameters')
    return value


def verified_archives(manifest_path, archives, source):
    manifest_path, archives = Path(manifest_path), Path(archives).resolve(strict=True)
    if manifest_path.stat().st_size > 1024 * 1024:
        raise ValueError('Input manifest exceeds 1 MiB')
    manifest = json.loads(manifest_path.read_text(encoding='utf-8-sig'))
    if manifest.get('schemaVersion') != 1:
        raise ValueError('Unsupported input manifest schema')
    selected = [item for item in manifest['inputs'] if item['source'] == source]
    sys.path.insert(0, str(HERE / 'builder'))
    from adapters import ULS_FILES
    names = [item['archive'] for item in selected]
    if len(names) != len(set(names)) or (source == 'us_uls' and set(names) != set(ULS_FILES)) or (source == 'us_lms' and len(names) != 1):
        raise ValueError('Expected all nine configured ULS archives or one LMS archive, with no duplicates')
    result = []
    for info in selected:
        name = info['archive']
        if not re.fullmatch(r'[A-Za-z0-9_.-]+\.zip', name):
            raise ValueError('Archive must be a ZIP basename without directories')
        path = (archives / name).resolve(strict=True)
        if not path.is_relative_to(archives) or not path.is_file():
            raise ValueError('Archive is outside the selected input directory')
        if type(info['size_bytes']) is not int or info['size_bytes'] <= 0 or path.stat().st_size != info['size_bytes']:
            raise ValueError('FCC archive size differs from the pinned manifest')
        if not isinstance(info['sha256'], str) or not re.fullmatch(r'[0-9a-f]{64}', info['sha256']):
            raise ValueError('Invalid pinned SHA-256')
        public_fcc_url(info['canonical_url'])
        if info.get('resolved_url') is not None:
            public_fcc_url(info['resolved_url'])
        checksum = hashlib.sha256()
        with path.open('rb') as stream:
            for block in iter(lambda: stream.read(1024 * 1024), b''):
                checksum.update(block)
        if checksum.hexdigest() != info['sha256']:
            raise ValueError('FCC archive checksum differs from the pinned manifest')
        with zipfile.ZipFile(path) as archive:
            if archive.testzip() is not None:
                raise ValueError('FCC archive ZIP CRC check failed')
        result.append((path, info))
    if not result:
        raise ValueError('No input archives selected')
    return result


def build(manifest, archives, output, source, log=print):
    if source not in ('us_uls', 'us_lms'):
        raise ValueError('Unsupported FCC source')
    inputs = verified_archives(manifest, archives, source)
    import runner

    def preserved_inputs(ctx, requested_source, local_files=None):
        if requested_source != source:
            raise ValueError('Unexpected source requested')
        for path, info in inputs:
            url = info['canonical_url']
            retrieved = info.get('retrieved_at_utc') or 'Exact acquisition time unavailable in preserved provenance'
            ctx.retrieval_times[url] = retrieved
            ctx.downloads.append({
                'url': url, 'resolved_url': info.get('resolved_url'),
                'retrieved_at': retrieved, 'bytes': info['size_bytes'], 'sha256': info['sha256'],
                'last_modified': info.get('last_modified', ''),
                'cache_reused': info.get('reused_existing_file', False),
            })
            ctx.log(f"Importing {info['archive']} ({info['size_bytes']:,} verified bytes)")
            yield path, url

    previous = runner.acquire
    try:
        runner.acquire = preserved_inputs
        return runner.build(output, selected=[source], active_only=True, log=log)
    finally:
        runner.acquire = previous


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--manifest', type=Path, default=HERE / 'provenance-0.2.2.json')
    parser.add_argument('--archives', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--source', choices=['us_uls', 'us_lms'], required=True)
    args = parser.parse_args()
    result = build(args.manifest, args.archives, args.output, args.source,
                   log=lambda message: print(message, flush=True))
    print(json.dumps({key: result[key] for key in ('run_id', 'status', 'counts')}, indent=2))
    sys.exit(0 if result['status'] == 'complete' else 1)
