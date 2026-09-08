import test from 'node:test';
import assert from 'node:assert/strict';
import { radioAuthorization } from '../lib/radio-authorization';

const record = {
  source: 'global_ourairports',
  license_id: null,
  details_json: null,
  source_url: 'https://ourairports.com/data/',
};

void test('navigation records explain absent authorization without treating a navaid identifier as a license', () => {
  const navaid = { ...record, call_sign: 'JFK' };
  const result = radioAuthorization(navaid);
  assert.equal(
    result.missingReason,
    'Not included in OurAirports navigation-aid data.',
  );
  assert.deepEqual(result.identifiers, []);
  assert.match(result.note, /does not mean the station is unlicensed/);
  assert.equal(result.sourceUrl, record.source_url);
});

void test('missing authorization explanations distinguish schedules, receivers, structures and location workbooks', () => {
  for (const [source, expected] of [
    ['global_hfcc', /HFCC schedule data/],
    ['global_satnogs', /SatNOGS receiving-station catalog/],
    ['global_osm', /OpenStreetMap structure records/],
    ['cl_subtel', /SUBTEL antenna-location workbook/],
  ] as const) {
    const result = radioAuthorization({ ...record, source });
    assert.match(result.missingReason!, expected);
    assert.deepEqual(result.identifiers, []);
  }
  assert.equal(
    radioAuthorization({ ...record, source: 'unknown-source' }).missingReason,
    'Not provided by this source.',
  );
  const osm = radioAuthorization({
    ...record,
    source: 'global_osm',
    details_json: { license: 'ODbL 1.0', tags: { ref: 'tower-123' } },
  });
  assert.deepEqual(osm.identifiers, []);
  assert.ok(osm.missingReason);
});

void test('older FCC snapshots keep ULS system IDs and LMS filing numbers distinct from other identifiers', () => {
  const uls = radioAuthorization({
    ...record,
    source: 'us_uls',
    license_id: '0012345',
  });
  assert.deepEqual(uls.identifiers, [
    { label: 'FCC ULS unique system ID', value: '0012345' },
  ]);
  const lms = radioAuthorization({
    ...record,
    source: 'us_lms',
    license_id: '0001234567',
    details_json: { facility_id: 4321, application_id: 'app-789' },
  });
  assert.deepEqual(lms.identifiers, [
    { label: 'FCC LMS filing number', value: '0001234567' },
    { label: 'FCC facility ID', value: '4321' },
    { label: 'FCC LMS application ID', value: 'app-789' },
  ]);
  assert.match(lms.note, /not a license number/);
  assert.equal(lms.missingReason, null);
});

void test('new FCC authorization metadata survives without putting an application number in license_id', () => {
  const result = radioAuthorization({
    ...record,
    source: 'us_lms',
    details_json: {
      licensing: {
        identifier: '0004567890',
        identifier_kind: 'fcc_lms_filing_number',
        identifier_label: 'License',
        record_url:
          'https://enterpriseefiling.fcc.gov/dataentry/public/tv/lmsDatabase.html',
      },
      facility_id: '00042',
    },
  });
  assert.deepEqual(result.identifiers, [
    { label: 'FCC LMS filing number', value: '0004567890' },
    { label: 'FCC facility ID', value: '00042' },
  ]);
  assert.match(result.sourceUrl!, /^https:\/\/enterpriseefiling\.fcc\.gov\//);
  assert.equal(result.missingReason, null);
});

void test('a facility ID alone does not fill the license or filing number', () => {
  const result = radioAuthorization({
    ...record,
    source: 'us_lms',
    details_json: { facility_id: '12345' },
  });
  assert.match(result.missingReason!, /filing number not supplied/);
  assert.deepEqual(result.identifiers, [
    { label: 'FCC facility ID', value: '12345' },
  ]);
});

void test('Finland license numbers and Poland permit decisions retain their original values', () => {
  for (const [source, label, license_id] of [
    ['fi_traficom', 'License number', '001-A'],
    ['pl_uke', 'Permit / decision number', 'DEC/2026/0123'],
  ]) {
    const result = radioAuthorization({ ...record, source, license_id });
    assert.deepEqual(result.identifiers, [{ label, value: license_id }]);
    assert.equal(result.missingReason, null);
  }
});

void test('blank or malformed identifiers remain missing and unsafe source URLs are never linked', () => {
  const result = radioAuthorization(
    {
      ...record,
      source: 'us_lms',
      license_id: '   ',
      source_url: 'javascript:alert(1)',
      details_json: {
        licensing: {
          identifier: { value: '123' },
          record_url: 'file:///secret.txt',
        },
        facility_id: ['1234'],
      },
    },
    { url: 'https://www.fcc.gov/' },
  );
  assert.deepEqual(result.identifiers, []);
  assert.ok(result.missingReason);
  assert.equal(result.sourceUrl, 'https://www.fcc.gov/');
  const credentialUrl = new URL('https://example.com/');
  credentialUrl.username = 'not-a-real-user';
  credentialUrl.password = 'not-a-real-password';
  assert.equal(
    radioAuthorization({
      ...record,
      source_url: credentialUrl.href,
    }).sourceUrl,
    undefined,
  );
});
