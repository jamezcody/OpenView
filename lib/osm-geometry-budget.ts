import { PbfReader } from 'pbf';
import { OSM_LIMITS, OsmTileBudgetError } from './osm-model';

// Count encoded geometry BEFORE Mapbox allocates Point objects. Oversized features
// are skipped individually, so a single complex boundary cannot exhaust memory.
export function osmGeometryCounts(data: ArrayBuffer) {
  const reader = new PbfReader(data),
    layers: Record<string, number[]> = {};
  const endMessage = () => {
    const length = reader.readVarint(),
      end = reader.pos + length;
    if (!Number.isSafeInteger(end) || end > reader.length || length < 0)
      throw new Error('Invalid OSM tile message.');
    return end;
  };
  let totalFeatures = 0;
  while (reader.pos < reader.length) {
    const tag = reader.readVarint();
    if (tag !== 26) {
      reader.skip(tag);
      continue;
    }
    const layerEnd = endMessage();
    let name = '';
    const counts: number[] = [];
    while (reader.pos < layerEnd) {
      const field = reader.readVarint();
      if (field === 10) {
        name = reader.readString();
        continue;
      }
      if (field !== 18) {
        reader.skip(field);
        continue;
      }
      if (++totalFeatures > 30000)
        throw new OsmTileBudgetError(
          'This OSM tile has too many features to display.',
        );
      const featureEnd = endMessage();
      let vertices = 0;
      while (reader.pos < featureEnd) {
        const featureField = reader.readVarint();
        if (featureField !== 34) {
          reader.skip(featureField);
          continue;
        }
        const geometryEnd = endMessage();
        if (geometryEnd > featureEnd)
          throw new Error('Invalid OSM geometry length.');
        while (reader.pos < geometryEnd) {
          const packed = reader.readVarint(),
            command = packed % 8,
            count = Math.floor(packed / 8);
          if (![1, 2, 7].includes(command) || count < 1)
            throw new Error('Invalid OSM geometry command.');
          vertices += count;
          if (vertices > OSM_LIMITS.vertices) {
            reader.pos = geometryEnd;
            break;
          }
          if (command !== 7)
            for (let index = 0; index < count * 2; index++) reader.readVarint();
        }
        if (reader.pos !== geometryEnd)
          throw new Error('Truncated OSM geometry.');
      }
      if (reader.pos !== featureEnd)
        throw new Error('Invalid OSM feature length.');
      counts.push(vertices);
    }
    if (
      reader.pos !== layerEnd ||
      name.length > 100 ||
      Object.keys(layers).length >= 32
    )
      throw new Error('Invalid OSM tile layer.');
    layers[name] = counts;
  }
  return layers;
}
