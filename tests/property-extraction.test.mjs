import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  robotsAllows as r,
  extractRecordHtml as extract,
} from '../lib/property-inquiry.mjs';
const address = {
  number: '123',
  street: 'Main Street',
  unit: '',
  city: 'Example City',
  postcode: '12345',
};
const base = { parcelId: '00123-45' };
const doc = (body) => `<!doctype html><html><body>${body}</body></html>`;
const table = (rows) =>
  `<table>${rows.map(([k, v]) => `<tr><th>${k}</th><td>${v}</td></tr>`).join('')}</table>`;
const owners = (html) => Array.from(extract(doc(html), address, base).owners);
const rejects = (html) =>
  assert.throws(() => extract(doc(html), address, base));
test('robots wildcard private disallow', () =>
  assert.equal(
    r('User-agent: *\nDisallow: /private', '/private/record'),
    false,
  ));
test('robots unmatched path allowed', () =>
  assert.equal(r('User-agent: *\nDisallow: /private', '/record'), true));
test('robots empty Disallow preserves group boundary', () =>
  assert.equal(
    r('User-agent: *\nDisallow:\n\nUser-agent: BadBot\nDisallow: /', '/record'),
    true,
  ));
test('robots empty Allow preserves group boundary', () =>
  assert.equal(
    r('User-agent: *\nAllow:\nUser-agent: BadBot\nDisallow: /', '/record'),
    true,
  ));
test('robots named group supersedes wildcard', () =>
  assert.equal(
    r('User-agent: *\nDisallow: /\nUser-agent: OpenView\nAllow: /', '/record'),
    true,
  ));
test('robots same named groups merged', () =>
  assert.equal(
    r(
      'User-agent: OpenView\nDisallow: /x\nUser-agent: OpenView\nDisallow: /y',
      '/y/record',
    ),
    false,
  ));
test('robots equal specificity Allow wins', () =>
  assert.equal(r('User-agent: *\nDisallow: /x\nAllow: /x', '/x'), true));
test('robots longest literal rule wins', () =>
  assert.equal(
    r('User-agent: *\nDisallow: /x*\nAllow: /x/public', '/x/public/record'),
    true,
  ));
test('robots wildcard and terminal marker', () => {
  assert.equal(r('User-agent: *\nDisallow: /*.pdf$', '/a/record.pdf'), false);
  assert.equal(
    r('User-agent: *\nDisallow: /*.pdf$', '/a/record.pdf?view=1'),
    true,
  );
});
test('robots decodes unreserved percent encoding', () =>
  assert.equal(r('User-agent: *\nDisallow: /ab', '/a%62'), false));
test('robots preserves encoded reserved slash', () =>
  assert.equal(r('User-agent: *\nDisallow: /a/b', '/a%2fb'), true));
test('robots ignores empty user agent', () =>
  assert.equal(r('User-agent:\nDisallow: /', '/record'), true));
test('robots oversized input fails closed', () =>
  assert.equal(r('x'.repeat(256001), '/record'), false));
test('labelled exact parcel table', () =>
  assert.deepEqual(
    owners(
      table([
        ['Parcel ID', '00123-45'],
        ['Owner', 'Example Owner A'],
      ]),
    ),
    ['Example Owner A'],
  ));
test('labelled exact account table', () =>
  assert.deepEqual(
    owners(
      table([
        ['Account Number', '0012345'],
        ['Owner Name', 'Example Owner A'],
      ]),
    ),
    ['Example Owner A'],
  ));
test('labelled exact definition list', () =>
  assert.deepEqual(
    owners(
      '<dl><dt>APN:</dt><dd>00123-45</dd><dt>Owner:</dt><dd>Example Owner A</dd></dl>',
    ),
    ['Example Owner A'],
  ));
test('search-result table isolates target row', () =>
  assert.deepEqual(
    owners(
      '<table><tr><th>Parcel ID</th><th>Owner</th></tr><tr><td>00123-45</td><td>Example Owner A</td></tr><tr><td>99999</td><td>Unrelated Owner B</td></tr></table>',
    ),
    ['Example Owner A'],
  ));
test('target mention outside wrong record rejected', () =>
  rejects(
    '<p>Previous search parcel 00123-45</p>' +
      table([
        ['Parcel ID', '99999'],
        ['Owner', 'Unrelated Owner B'],
      ]),
  ));
test('parcel substring rejected', () =>
  rejects(
    table([
      ['Parcel ID', '900123450'],
      ['Owner', 'Unrelated Owner B'],
    ]),
  ));
test('sequential vertical records isolated', () =>
  assert.deepEqual(
    owners(
      table([
        ['Parcel ID', '00123-45'],
        ['Owner', 'Example Owner A'],
        ['Parcel ID', '99999'],
        ['Owner', 'Unrelated Owner B'],
      ]),
    ),
    ['Example Owner A'],
  ));
test('different table owner cannot migrate', () =>
  assert.deepEqual(
    owners(
      table([
        ['Parcel ID', '00123-45'],
        ['Year Built', '1980'],
      ]) +
        table([
          ['Parcel ID', '99999'],
          ['Owner', 'Unrelated Owner B'],
        ]),
    ),
    [],
  ));
test('conflicting matching sections rejected', () =>
  rejects(
    table([
      ['Parcel ID', '00123-45'],
      ['Owner', 'Example Owner A'],
    ]) +
      table([
        ['Parcel ID', '00123-45'],
        ['Owner', 'Example Owner B'],
      ]),
  ));
test('explicit owner1 and owner2 in same record retained', () =>
  assert.deepEqual(
    owners(
      table([
        ['Parcel ID', '00123-45'],
        ['Owner 1', 'Example Owner A'],
        ['Owner 2', 'Example Owner B'],
      ]),
    ),
    ['Example Owner A', 'Example Owner B'],
  ));
test('source placeholders never become owner names', () =>
  assert.deepEqual(
    owners(
      table([
        ['Parcel ID', '00123-45'],
        ['Owner', 'Current Owner'],
      ]),
    ),
    [],
  ));
test('address-only exact complete address', () =>
  assert.deepEqual(
    owners(
      table([
        ['Property Address', '123 Main Street, Example City 12345'],
        ['Owner', 'Example Owner A'],
      ]),
    ),
    ['Example Owner A'],
  ));
test('address-only missing known city/postcode rejected', () =>
  rejects(
    table([
      ['Property Address', '123 Main Street'],
      ['Owner', 'Unrelated Owner B'],
    ]),
  ));
test('address prefix rejected', () =>
  rejects(
    table([
      ['Property Address', '123 Main Street Extension, Example City 12345'],
      ['Owner', 'Unrelated Owner B'],
    ]),
  ));
test('address cannot override conflicting parcel id', () =>
  rejects(
    table([
      ['Parcel ID', '99999'],
      ['Property Address', '123 Main Street, Example City 12345'],
      ['Owner', 'Unrelated Owner B'],
    ]),
  ));
test('nested unrelated table isolated', () =>
  assert.deepEqual(
    owners(
      '<table><tr><th>Parcel ID</th><td>00123-45</td></tr><tr><td colspan="2">' +
        table([
          ['Parcel ID', '99999'],
          ['Owner', 'Unrelated Owner B'],
        ]) +
        '</td></tr></table>',
    ),
    [],
  ));
const ld = (value) =>
  `<script type="application/ld+json">${JSON.stringify(value)}</script>`;
test('JSON-LD parcel identity and scoped owner', () =>
  assert.deepEqual(
    owners(
      ld({
        '@type': 'House',
        parcelID: '00123-45',
        ownedBy: { '@type': 'Organization', name: 'Example Owner A' },
      }),
    ),
    ['Example Owner A'],
  ));
test('JSON-LD PropertyValue APN identifier', () =>
  assert.deepEqual(
    owners(
      ld({
        '@type': 'Residence',
        identifier: {
          '@type': 'PropertyValue',
          propertyID: 'APN',
          value: '00123-45',
        },
        owner: 'Example Owner A',
      }),
    ),
    ['Example Owner A'],
  ));
test('JSON-LD untyped identifier cannot establish parcel', () =>
  rejects(
    ld({
      '@type': 'RealEstateListing',
      identifier: '00123-45',
      owner: 'Unrelated Owner B',
    }),
  ));
test('JSON-LD seller is not an owner', () =>
  assert.deepEqual(
    owners(
      ld({
        '@type': 'RealEstateListing',
        parcelID: '00123-45',
        seller: { name: 'Listing seller' },
        author: { name: 'Listing agent' },
      }),
    ),
    [],
  ));
test('JSON-LD graph isolates different property objects', () =>
  assert.deepEqual(
    owners(
      ld({
        '@graph': [
          { '@type': 'House', parcelID: '00123-45', owner: 'Example Owner A' },
          { '@type': 'House', parcelID: '99999', owner: 'Unrelated Owner B' },
        ],
      }),
    ),
    ['Example Owner A'],
  ));
test('JSON-LD PostalAddress exact address identity', () =>
  assert.deepEqual(
    owners(
      ld({
        '@type': 'House',
        address: {
          '@type': 'PostalAddress',
          streetAddress: '123 Main Street',
          addressLocality: 'Example City',
          postalCode: '12345',
        },
        owner: 'Example Owner A',
      }),
    ),
    ['Example Owner A'],
  ));
test('JSON-LD contradictory parcel beats address', () =>
  rejects(
    ld({
      '@type': 'House',
      parcelID: '99999',
      address: {
        streetAddress: '123 Main Street',
        addressLocality: 'Example City',
        postalCode: '12345',
      },
      owner: 'Unrelated Owner B',
    }),
  ));
test('selected unit is required for address-only identity', () =>
  assert.throws(() =>
    extract(
      doc(
        table([
          ['Property Address', '123 Main Street, Example City 12345'],
          ['Owner', 'Unrelated Owner B'],
        ]),
      ),
      { ...address, unit: '2' },
      base,
    ),
  ));
