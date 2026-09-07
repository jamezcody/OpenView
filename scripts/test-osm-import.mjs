// Explicit integration check: downloads Monaco and the pinned processing tools.
import { resolve } from 'node:path';
import { OsmManager } from './local/osm-manager.mjs';
import { pmtilesHeader } from './local/osm-io.mjs';
const manager = new OsmManager(resolve('work/osm-integration'), resolve('.'));
await manager.initialize();
let dataset = manager.state.datasets.find((d) => d.name === 'Monaco');
try {
  if (!dataset) dataset = await manager.addDownload('monaco');
  else if (dataset.status !== 'downloaded' && dataset.status !== 'ready')
    manager.start(dataset.id, 'download');
  if (manager.active) await manager.active.promise;
  if (!['downloaded', 'ready'].includes(dataset.status))
    throw new Error(dataset.message);
  if (dataset.status !== 'ready') {
    manager.start(dataset.id, 'prepare');
    const report = setInterval(
      () => console.log(dataset.status, dataset.message),
      3000,
    );
    try {
      await manager.active.promise;
    } finally {
      clearInterval(report);
    }
  }
  if (dataset.status !== 'ready') throw new Error(dataset.message);
  console.log(
    JSON.stringify({
      dataset: dataset.id,
      sourceBytes: dataset.bytes,
      tileBytes: dataset.tilesBytes,
      ...(await pmtilesHeader(dataset.tilesPath)),
    }),
  );
} finally {
  await manager.close();
}
