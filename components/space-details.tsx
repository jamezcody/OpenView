import { ageLabel, utc } from '@/lib/model';
import {
  elementEpoch,
  OPS_LABELS,
  SPACE_LABELS,
  type SpaceObject,
} from '@/lib/space-data';
import type { orbitPosition } from '@/lib/orbits';

function Row({
  label,
  value,
}: {
  label: string;
  value: string | number | null | undefined;
}) {
  return (
    <div className="detail-row">
      <dt>{label}</dt>
      <dd>{value === '' || value == null ? 'Not supplied' : value}</dd>
    </div>
  );
}
const ELEMENT_LABELS: Record<string, string> = {
  MEAN_MOTION: 'Mean motion (rev/day)',
  ECCENTRICITY: 'Eccentricity',
  INCLINATION: 'Inclination (°)',
  RA_OF_ASC_NODE: 'Ascending node (°)',
  ARG_OF_PERICENTER: 'Argument of pericenter (°)',
  MEAN_ANOMALY: 'Mean anomaly (°)',
  BSTAR: 'B* drag term',
  MEAN_MOTION_DOT: 'Mean-motion derivative',
  MEAN_MOTION_DDOT: 'Second derivative',
  EPHEMERIS_TYPE: 'Ephemeris type',
  CLASSIFICATION_TYPE: 'Classification',
  ELEMENT_SET_NO: 'Element set',
  REV_AT_EPOCH: 'Revolution at epoch',
  OBJECT_ID: 'International designator',
};
const CATALOG_LABELS: Record<string, string> = {
  OBJECT_NAME: 'Catalog name',
  OBJECT_ID: 'International designator',
  NORAD_CAT_ID: 'Catalog ID',
  OBJECT_TYPE: 'Object type code',
  OPS_STATUS_CODE: 'Status code',
  OWNER: 'Owner / country code',
  LAUNCH_DATE: 'Launch date',
  LAUNCH_SITE: 'Launch site code',
  DECAY_DATE: 'Decay date',
  PERIOD: 'Catalog period (min)',
  INCLINATION: 'Catalog inclination (°)',
  APOGEE: 'Apogee (km)',
  PERIGEE: 'Perigee (km)',
  RCS: 'Radar cross section (m²)',
  DATA_STATUS_CODE: 'Data status code',
  ORBIT_CENTER: 'Orbit center',
  ORBIT_TYPE: 'Orbit type code',
};
export function SpaceDetails({
  object,
  position,
  now,
  offset,
}: {
  object: SpaceObject;
  position: ReturnType<typeof orbitPosition>;
  now: number;
  offset: number;
}) {
  const c = object.catalog;
  return (
    <div className="space-details">
      <dl>
        <Row label="Object type" value={SPACE_LABELS[object.objectType]} />
        <Row label="Catalog" value={`NORAD ${object.NORAD_CAT_ID}`} />
        <Row label="Designator" value={c.OBJECT_ID} />
        <Row
          label="Status"
          value={OPS_LABELS[c.OPS_STATUS_CODE] || c.OPS_STATUS_CODE}
        />
        <Row label="Owner / country code" value={c.OWNER} />
        <Row label="Launched" value={c.LAUNCH_DATE} />
        <Row label="Launch site code" value={c.LAUNCH_SITE} />
        <Row
          label="Altitude"
          value={
            position
              ? `${(position.altitude / 1000).toFixed(1)} km`
              : 'Not propagatable'
          }
        />
        <Row
          label="Latitude"
          value={position ? `${position.lat.toFixed(4)}°` : null}
        />
        <Row
          label="Longitude"
          value={position ? `${position.lon.toFixed(4)}°` : null}
        />
        <Row label="Position time" value={utc(now + offset * 60000)} />
        <Row label="Inclination" value={`${object.INCLINATION.toFixed(2)}°`} />
        <Row
          label="Period"
          value={`${(1440 / object.MEAN_MOTION).toFixed(1)} min`}
        />
        <Row
          label="Perigee / apogee"
          value={c.PERIGEE && c.APOGEE ? `${c.PERIGEE} / ${c.APOGEE} km` : null}
        />
        <Row label="Element epoch" value={utc(elementEpoch(object))} />
        <Row label="Elements age" value={ageLabel(elementEpoch(object), now)} />
        <Row label="Metadata retrieved" value={utc(object.catalogFetchedAt)} />
      </dl>
      <details className="space-source-details">
        <summary>All catalog and orbital fields</summary>
        <dl>
          {Object.entries(c).map(([key, value]) => (
            <Row key={key} label={CATALOG_LABELS[key] || key} value={value} />
          ))}
        </dl>
        <dl>
          {Object.entries(object)
            .filter(
              ([key, value]) =>
                !['catalog', 'catalogFetchedAt', 'objectType'].includes(key) &&
                (typeof value === 'string' || typeof value === 'number'),
            )
            .map(([key, value]) => (
              <Row
                key={key}
                label={ELEMENT_LABELS[key] || CATALOG_LABELS[key] || key}
                value={String(value)}
              />
            ))}
        </dl>
      </details>
      <p className="source-meta">
        Orbital source:{' '}
        {typeof object.elementSource === 'string'
          ? object.elementSource
          : 'CelesTrak GP'}
        . Metadata: CelesTrak SATCAT. Catalog status and ownership are source
        records, not live telemetry.
      </p>
      {object.elementSource === 'SatNOGS DB' && (
        <p className="source-meta">
          Backup orbital data from{' '}
          <a href="https://db.satnogs.org/" target="_blank" rel="noreferrer">
            SatNOGS DB
          </a>
          , distributed under{' '}
          <a
            href="https://creativecommons.org/licenses/by-sa/4.0/"
            target="_blank"
            rel="noreferrer"
          >
            CC BY-SA
          </a>
          . TLE fields converted to orbital elements for this view; original
          lines and source are included above.
        </p>
      )}
      <a
        className="source-link"
        target="_blank"
        rel="noreferrer"
        href={`https://celestrak.org/satcat/records.php?CATNR=${object.NORAD_CAT_ID}&FORMAT=JSON`}
      >
        Object source record
      </a>
      <a
        className="source-link"
        target="_blank"
        rel="noreferrer"
        href="https://celestrak.org/satcat/satcat-format.php"
      >
        Catalog fields and code definitions
      </a>
    </div>
  );
}
