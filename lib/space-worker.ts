import { makeSatellite, orbitPosition } from './orbits';
import {
  elementEpoch,
  isSpaceObject,
  MAX_ELEMENT_AGE,
  type SpaceObject,
} from './space-data';

let objects: { object: SpaceObject; sat: ReturnType<typeof makeSatellite> }[] =
  [];
type Message =
  | { type: 'init'; objects: SpaceObject[] }
  | { type: 'positions'; time: number; offset: number };
const worker = self as unknown as {
  onmessage: ((event: MessageEvent<Message>) => void) | null;
  postMessage: (data: unknown, transfer: Transferable[]) => void;
};
worker.onmessage = ({ data }) => {
  if (data.type === 'init') {
    objects = data.objects.filter(isSpaceObject).flatMap((object) => {
      try {
        return [{ object, sat: makeSatellite(object) }];
      } catch {
        return [];
      }
    });
    return;
  }
  // Geographic samples are converted to Earth-fixed Cartesian coordinates in
  // the renderer. Two nearby samples allow interpolation without frame-by-frame SGP4.
  const start = data.time + data.offset * 60000;
  const positions = new Float64Array(objects.length * 7);
  positions.fill(NaN);
  for (let i = 0; i < objects.length; i++) {
    const { object, sat } = objects[i];
    positions[i * 7] = object.NORAD_CAT_ID;
    if (Math.abs(start - elementEpoch(object)) > MAX_ELEMENT_AGE) continue;
    const a = orbitPosition(sat, new Date(start));
    const b = orbitPosition(sat, new Date(start + 3000));
    if (a && b)
      positions.set(
        [a.lon, a.lat, a.altitude, b.lon, b.lat, b.altitude],
        i * 7 + 1,
      );
  }
  worker.postMessage({ positions, time: data.time, offset: data.offset }, [
    positions.buffer,
  ]);
};
