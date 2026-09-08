"""OpenCellID-only map enrichment. No coordinate or physical-country inference."""
import re
from datetime import datetime, timezone

SCOPE = 'U.S. networks — MCC 310–314'
US_MCC = {'310', '311', '312', '313', '314'}
PLMN_RADIOS = {'GSM', 'UMTS', 'LTE', 'NR', '5G'}


def timestamp(value):
    if not isinstance(value, str) or not re.fullmatch(r'\d+', value): return None
    try:
        seconds = int(value)
        return datetime.fromtimestamp(seconds, timezone.utc).isoformat().replace('+00:00', 'Z') if seconds > 0 else None
    except (ValueError, OverflowError, OSError): return None


def enrich_cell(row, reference):
    if row['source'] != 'global_opencellid' or row['category'] != 'candidates':
        raise ValueError('Cell preparation requires an OpenCellID-only candidate run')
    raw = row['details_json']
    for key in ('radio', 'mcc', 'net', 'area', 'cell'):
        if not isinstance(raw.get(key), str) or not raw[key]: raise ValueError('Missing exact cell identity')
    if raw['mcc'] not in US_MCC or any(not re.fullmatch(r'\d+', raw[k]) for k in ('net', 'area', 'cell')):
        raise ValueError('Unexpected MCC or invalid cell identifier')
    if ':'.join(raw[k] for k in ('radio', 'mcc', 'net', 'area', 'cell')) != row['source_record_id']:
        raise ValueError('Cell composite identity differs from source record')
    technology, mcc, net = raw['radio'].upper(), raw['mcc'], raw['net']
    # The authoritative U.S. HNI reference explicitly defines three-digit MNCs.
    # Keep raw net unchanged; normalization applies only to the filter/allocation key.
    mnc = str(int(net)).zfill(3) if technology in PLMN_RADIOS and int(net) <= 999 else None
    network = f'plmn:{mcc}:{mnc}' if mnc else f'{"cdma" if technology == "CDMA" else "unknown"}:{mcc}:{int(net)}'
    allocation = reference['networks'].get(network)
    operator = allocation['name'] if allocation else None
    label = f'{operator} · {mcc}-{mnc}' if operator else f'MCC {mcc} / {"SID" if technology == "CDMA" else "MNC" if mnc else "network code"} {mnc or net}'
    row.update(network=network, service=technology, operator=operator,
        cell={'radio': raw['radio'], 'mcc': mcc, 'net': net, 'area': raw['area'], 'cell': raw['cell'],
              'unit': raw.get('unit'), 'mnc': mnc, 'networkLabel': label,
              'networkKind': 'SID' if technology == 'CDMA' else 'MNC' if mnc else 'unknown',
              'firstSeen': timestamp(raw.get('created')), 'lastSeen': timestamp(raw.get('updated')),
              'samples': raw.get('samples'), 'operatorSource': reference['source'] if operator else None,
              'operatorMappingDate': reference['retrievedAt'] if operator else None})
    return row, label
