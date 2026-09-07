import {
  json2satrec,
  propagate,
  eciToGeodetic,
  gstime,
  type SatRec,
} from 'satellite.js';
import type { OMM, Track } from './model';
export function makeSatellite(omm: OMM): SatRec {
  return json2satrec(omm as unknown as Parameters<typeof json2satrec>[0]);
}
export function orbitPosition(sat: SatRec, date: Date) {
  try {
    const result = propagate(sat, date);
    if (!result?.position || typeof result.position === 'boolean') return null;
    const geo = eciToGeodetic(result.position, gstime(date));
    const p = {
      lon: (geo.longitude * 180) / Math.PI,
      lat: (geo.latitude * 180) / Math.PI,
      altitude: geo.height * 1000,
    };
    return Object.values(p).every(Number.isFinite) && p.altitude > 0 ? p : null;
  } catch {
    return null;
  }
}
export function epochTime(omm: OMM) {
  return Date.parse(omm.EPOCH.endsWith('Z') ? omm.EPOCH : omm.EPOCH + 'Z');
}
export function predictedTrack(track: Track, now: number) {
  if (track.kind === 'ships')
    return { lat: track.lat, lon: track.lon, altitude: track.altitude };
  const maxAge = 60;
  const age = Math.min(maxAge, Math.max(0, (now - track.observedAt) / 1000));
  if (track.speed === null || track.heading === null)
    return { lat: track.lat, lon: track.lon, altitude: track.altitude };
  const distance = (track.speed * 0.514444 * age) / 6371008.8;
  const bearing = (track.heading * Math.PI) / 180;
  const lat = (track.lat * Math.PI) / 180,
    lon = (track.lon * Math.PI) / 180;
  const nextLat = Math.asin(
    Math.sin(lat) * Math.cos(distance) +
      Math.cos(lat) * Math.sin(distance) * Math.cos(bearing),
  );
  const nextLon =
    lon +
    Math.atan2(
      Math.sin(bearing) * Math.sin(distance) * Math.cos(lat),
      Math.cos(distance) - Math.sin(lat) * Math.sin(nextLat),
    );
  return {
    lat: (nextLat * 180) / Math.PI,
    lon: (((nextLon * 180) / Math.PI + 540) % 360) - 180,
    altitude: track.altitude,
  };
}
