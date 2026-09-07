// A versioned, OSM-only overlay profile. JSON is also valid YAML 1.2.
// No external basemap/coastline downloads are needed to prepare this profile.
import { OSM_CATEGORIES, OSM_PROFILE_VERSION } from './osm-catalog.mjs';
export const PROFILE_VERSION = OSM_PROFILE_VERSION;
export function osmProfile(sourcePath) {
  const keys = [
    ...new Set(OSM_CATEGORIES.flatMap((category) => category.keys)),
  ];
  // Percent-escape delimiters instead of embedding source tags as HTML or executable text.
  const encode = (expression) =>
    `${expression}.replace('%', '%25').replace('\\n', '%0A').replace('\\r', '%0D').replace('=', '%3D')`;
  const allTags =
    '${ feature.tags.map(k, ' +
    encode('k') +
    " + '=' + " +
    encode('string(feature.tags[k])') +
    ").join('\\n') }";
  const attributes = [
    { key: 'family', type: 'match_key' },
    { key: 'class', type: 'match_value' },
    { key: 'name', tag_value: 'name' },
    ...keys.map((key) => ({ key, tag_value: key })),
    { key: 'ov_id', value: '${ string(feature.id) }', min_zoom: 14 },
    { key: 'ov_type', value: '${ feature.osm_type }', min_zoom: 14 },
    { key: 'ov_tags', value: allTags, min_zoom: 14 },
  ];
  const feature = (geometry, keys, minZoom) => ({
    source: 'osm',
    geometry,
    min_zoom: minZoom,
    include_when: Object.fromEntries(keys.map((key) => [key, '__any__'])),
    attributes,
  });
  return {
    schema_name: 'OpenView OSM',
    version: String(PROFILE_VERSION),
    is_overlay: true,
    attribution: '© OpenStreetMap contributors · ODbL',
    sources: { osm: { type: 'osm', local_path: sourcePath } },
    layers: [
      {
        id: 'roads',
        features: [
          {
            ...feature('any', ['highway', 'railway'], 12),
            min_zoom: {
              default_value: 12,
              overrides: {
                6: { highway: ['motorway', 'trunk'] },
                9: { highway: ['primary', 'secondary'] },
              },
            },
          },
        ],
      },
      {
        id: 'water',
        features: [
          {
            ...feature('polygon', ['water'], 8),
            include_when: {
              natural: 'water',
              water: '__any__',
              waterway: 'riverbank',
            },
          },
          feature('any', ['waterway'], 12),
        ],
      },
      {
        id: 'land',
        features: [
          {
            ...feature(
              'any',
              ['landuse', 'landcover', 'leisure', 'natural', 'boundary'],
              10,
            ),
            exclude_when: { natural: 'water' },
          },
        ],
      },
      {
        id: 'buildings',
        features: [feature('polygon', ['building', 'building:part'], 14)],
      },
      { id: 'places', features: [feature('point', ['place'], 8)] },
      {
        id: 'details',
        features: [
          feature(
            'any',
            OSM_CATEGORIES.filter(
              (category) => category.layer === 'details',
            ).flatMap((category) => category.keys),
            14,
          ),
        ],
      },
    ],
  };
}
export function importArguments(
  jar,
  source,
  output,
  schema,
  temporary,
  memoryMiB,
  threads,
) {
  return [
    `-Xmx${memoryMiB}m`,
    '-jar',
    jar,
    'generate-custom',
    `--schema=${schema}`,
    `--osm-path=${source}`,
    `--output=${output}`,
    `--tmpdir=${temporary}`,
    '--nodemap-type=sparsearray',
    '--nodemap-storage=mmap',
    '--multipolygon-geometry-storage=mmap',
    '--maxzoom=14',
    '--render-maxzoom=14',
    `--threads=${threads}`,
    '--download=false',
  ];
}
