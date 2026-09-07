import { SHIP_MAX_AGE_MS } from './ship-policy.mjs';

const text = (v, length = 120) =>
  typeof v === 'string'
    ? v
        .replace(/@|\p{Cc}/gu, '')
        .trim()
        .slice(0, length)
    : '';
const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const angle = (v) => (finite(v) && v >= 0 && v < 360 ? v : null);
const positionTypes = new Set([
  'PositionReport',
  'StandardClassBPositionReport',
  'ExtendedClassBPositionReport',
]);
export const SHIP_MESSAGE_TYPES = [
  ...positionTypes,
  'ShipStaticData',
  'StaticDataReport',
];

export function normalizeAisMessage(envelope, receivedAt) {
  if (!envelope || typeof envelope !== 'object') return null;
  const meta = envelope.MetaData;
  const message = envelope.Message?.[envelope.MessageType];
  if (!meta || !message || typeof message !== 'object') return null;
  const id = String(meta.MMSI ?? message.UserID ?? '');
  if (!/^[1-9]\d{8}$/.test(id)) return null;
  const details = { id };
  const name = text(message.Name || meta.ShipName || message.ReportA?.Name, 80);
  if (name) details.name = name;
  if (
    envelope.MessageType === 'ShipStaticData' ||
    envelope.MessageType === 'StaticDataReport'
  ) {
    const destination = text(message.Destination);
    if (destination) details.destination = destination;
    if (finite(message.Type)) details.vesselType = message.Type;
    return { details };
  }
  if (!positionTypes.has(envelope.MessageType) || message.Valid === false)
    return null;
  const lat = message.Latitude,
    lon = message.Longitude;
  if (!finite(lat) || !finite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180)
    return null;
  // The AIS Timestamp is seconds within a minute, NOT an epoch timestamp.
  // AISStream's envelope time is the report's receiver timestamp when present.
  let observedAt = receivedAt;
  const stamp = meta.time_utc;
  if (typeof stamp === 'string') {
    const iso = stamp
      .trim()
      .replace(/\s+\+0000 UTC$/, 'Z')
      .replace(' ', 'T')
      .replace(/(\.\d{3})\d+/, '$1');
    const parsed = Date.parse(iso);
    if (!Number.isFinite(parsed)) return null;
    observedAt = parsed;
  }
  if (
    observedAt < receivedAt - SHIP_MAX_AGE_MS ||
    observedAt > receivedAt + 60000
  )
    return null;
  return {
    details,
    position: {
      id,
      name: name || `MMSI ${id}`,
      lat,
      lon,
      altitude: 8,
      speed:
        finite(message.Sog) && message.Sog >= 0 && message.Sog < 102.3
          ? message.Sog
          : null,
      heading: angle(message.Cog),
      trueHeading: angle(message.TrueHeading),
      observedAt,
      receivedAt,
      timestampBasis: stamp ? 'receiver' : 'received',
      kind: 'ships',
      source: 'AISStream',
      sourceUrl: 'https://aisstream.io/',
    },
  };
}

export function validShip(row, now) {
  return (
    row &&
    row.kind === 'ships' &&
    /^[1-9]\d{8}$/.test(String(row.id)) &&
    finite(row.lat) &&
    Math.abs(row.lat) <= 90 &&
    finite(row.lon) &&
    Math.abs(row.lon) <= 180 &&
    finite(row.observedAt) &&
    row.observedAt >= now - SHIP_MAX_AGE_MS &&
    row.observedAt <= now + 60000
  );
}

export function mergeShips(previous, incoming, now, limit) {
  const records = new Map();
  for (const row of [...previous, ...incoming]) {
    if (!validShip(row, now)) continue;
    const id = String(row.id),
      old = records.get(id);
    if (!old || row.observedAt > old.observedAt)
      records.set(id, { ...old, ...row, id });
  }
  const sorted = [...records.values()].sort(
    (a, b) => b.observedAt - a.observedAt || a.id.localeCompare(b.id),
  );
  return {
    items: sorted.slice(0, limit),
    omitted: Math.max(0, sorted.length - limit),
  };
}
