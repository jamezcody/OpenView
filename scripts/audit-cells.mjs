// Run npm test first to compile the exact application loader into work/tests.
// Then: node --expose-gc scripts/audit-cells.mjs (no upstream/network access).
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { RadioData, RadioInspection } from '../work/tests/lib/radio-data.mjs';
import {
  DEFAULT_RADIO_FILTERS,
  radioDepth,
} from '../work/tests/lib/radio-model.mjs';
const fetcher = async (input) =>
  new Response(await readFile(resolve('public', '.' + String(input))));
const signal = () => new AbortController().signal;
const views = [
  ['world', [-180, -90, 180, 90], 19000000],
  ['continental US', [-125, 24, -66, 50], 3500000],
  ['New York', [-74.04, 40.7, -73.96, 40.78], 12000],
  ['Raleigh', [-78.7, 35.7, -78.5, 35.9], 30000],
  ['Los Angeles', [-118.4, 33.9, -118.1, 34.2], 30000],
  ['Anchorage', [-150.1, 61.1, -149.7, 61.3], 25000],
  ['Honolulu', [-157.95, 21.2, -157.75, 21.4], 20000],
  ['Aleutians across dateline', [175, 50, -175, 55], 300000],
  ['Puerto Rico', [-68, 17, -65, 19], 100000],
  ['Guam', [144.5, 13, 145.1, 13.8], 100000],
];
const metrics = [];
global.gc?.();
const baseline = process.memoryUsage().heapUsed;
const data = new RadioData(fetcher, '/cells'),
  radio = new RadioData(fetcher);
const manifest = await data.manifest(signal()),
  rm = await radio.manifest(signal());
for (const [name, box, height] of views) {
  const [west, south, east, north] = box,
    bounds = { west, south, east, north },
    start = performance.now();
  const result = await data.view(
    manifest,
    bounds,
    radioDepth(height),
    DEFAULT_RADIO_FILTERS,
    signal(),
  );
  const old = await radio.view(
    rm,
    bounds,
    radioDepth(height),
    DEFAULT_RADIO_FILTERS,
    signal(),
  );
  let inspected = 0;
  if (result.markers.length)
    inspected = (
      await new RadioInspection(
        data,
        manifest.version,
        result.markers[0],
        DEFAULT_RADIO_FILTERS,
      ).next(signal())
    ).records.length;
  global.gc?.();
  metrics.push({
    name,
    cellRequests: result.requests,
    cellDecodedBytes: result.bytes,
    cellMarkers: result.markers.length,
    matchingCellRecords: result.markers.reduce((n, p) => n + p.count, 0),
    limited: result.limited,
    inspected,
    radioRequests: old.requests,
    radioDecodedBytes: old.bytes,
    radioMarkers: old.markers.length,
    combinedNodeHeapGrowthBytes: process.memoryUsage().heapUsed - baseline,
    elapsedMs: Math.round(performance.now() - start),
  });
}
const report = {
  version: manifest.version,
  measurement:
    'Application loader with local file fetch and forced Node GC; heap includes both parsed caches, not Cesium/GPU/browser total memory. Bytes are decoded page work including cache hits; requests are cache misses.',
  metrics,
};
await mkdir('work/reports', { recursive: true });
await writeFile(
  'work/reports/cell-runtime-audit.json',
  JSON.stringify(report, null, 2) + '\n',
);
console.log(JSON.stringify(report, null, 2));
