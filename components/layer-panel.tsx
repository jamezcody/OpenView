'use client';
import type { ReactNode } from 'react';
import { Layers, Info } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { LAYERS, type LayerId } from '@/lib/map-layers';

export type OverlayControl = {
  id: string;
  label: string;
  description: string;
  enabled: boolean;
  change: (value: boolean) => void;
  color: string;
  symbol: 'dot' | 'line' | 'area' | 'triangle' | 'diamond' | 'square' | 'plane';
  status?: string;
  error?: boolean;
};
export const LEGEND = [
  [
    'triangle',
    '#83dfac',
    'Campgrounds / camping locations',
    'Source campground, RV park and camping-location records. Numbers are grouped records, not unique campsites.',
  ],
  [
    'square',
    '#b7c6df',
    'Individual tent/RV sites',
    'Individual or group site records; shown as points only at close zoom.',
  ],
  [
    'diamond',
    '#ffc16d',
    'Supplementary camping records',
    'Lodging, camping zones and related facilities, separate from campsite layers.',
  ],
  [
    'dot',
    '#ffc16d',
    'Camping payment: $ Paid',
    'Explicit required-fee evidence in the snapshot; not current pricing.',
  ],
  [
    'dot',
    '#b7c6df',
    'Camping payment: ? Unclear',
    'Missing, conflicting or conditional fee evidence.',
  ],
  [
    'dot',
    '#83dfac',
    'Camping payment: F Completely free',
    'Source reports no required fee; not a current all-in price guarantee.',
  ],
  [
    'dot',
    '#c3ed97',
    'Space objects',
    'Calculated satellite positions from the last downloaded orbital elements.',
  ],
  [
    'line',
    '#c3ed9799',
    'Orbit path',
    'One predicted revolution of the selected satellite. The time slider affects orbits only.',
  ],
  [
    'plane',
    '#8fceff',
    'Aircraft',
    'Aircraft reports near the last requested map center; short motion estimates between reports.',
  ],
  [
    'diamond',
    '#ffbd86',
    'Ships',
    'AIS vessel reports from the Finnish coast and Baltic region.',
  ],
  [
    'dot',
    '#8edeee',
    'Mapped addresses',
    'Published address points; not a complete postal directory or a guarantee of deliverability.',
  ],
  [
    'line',
    '#ffe39a',
    'U.S. parcel lines',
    'Published state/county property boundaries. A line does not establish ownership.',
  ],
  [
    'triangle',
    '#58d6cd',
    'Transmitter records',
    'Source locations of transmitters. They are not verified unique towers or signal coverage.',
  ],
  [
    'diamond',
    '#ffc16d',
    'Uncertain radio sites',
    'Estimated or candidate transmitter locations.',
  ],
  [
    'square',
    '#bba2ff',
    'Receiving stations',
    'Receiving ground stations, not transmitters. Numbers count grouped source records.',
  ],
  [
    'area',
    '#40be82',
    'Cell coverage',
    'FCC carrier-reported modeled availability for the selected carrier and criteria; not measured reception.',
  ],
  [
    'dot',
    '#f596bf',
    'Estimated cell locations',
    'OpenCellID estimates for U.S. network codes. Numbers count cell records, not towers; markers do not indicate service coverage.',
  ],
  [
    'area',
    '#f0ad72',
    'National parks',
    'NPS administrative boundaries of National Parks, including combined preserves.',
  ],
  [
    'area',
    '#bdb1ff',
    'State parks',
    'PAD-US state-park areas, mostly mapped land holdings; administrative coverage is incomplete.',
  ],
  [
    'dot',
    '#ffffff',
    'Search location',
    'The place or object selected in search. Source locations may be approximate.',
  ],
] as const;

export function Legend() {
  return (
    <details id="map-legend-guide" className="panel-detail legend-guide">
      <summary>
        <Info size={17} />
        Map legend
      </summary>
      <p>
        Colors and shapes identify layers. Outlines and translucent areas follow
        the map surface.
      </p>
      <dl>
        {LEGEND.map(([shape, color, name, meaning]) => (
          <div key={name}>
            <dt>
              <i
                aria-hidden
                className={`map-symbol ${shape}`}
                style={{ color }}
              />
              {name}
            </dt>
            <dd>{meaning}</dd>
          </div>
        ))}
      </dl>
      <p>
        Aircraft dim after one minute and ships after ten minutes. Their motion
        estimates freeze after 60 and 120 seconds respectively. Source data may
        be missing or old; a blank area does not prove absence.
      </p>
      <p>
        Place labels identify geographic names and administrative boundaries.
        Satellite is an imagery mosaic; Streets shows roads and addresses;
        Topographic adds terrain cartography. All three use the same 3D
        elevation.
      </p>
    </details>
  );
}
export function LayerPanel({
  layer,
  setLayer,
  overlays,
  children,
}: {
  layer: LayerId;
  setLayer: (layer: LayerId) => void;
  overlays: OverlayControl[];
  children: ReactNode;
}) {
  return (
    <div className="layer-panel">
      <section className="view-picker" aria-labelledby="map-view-title">
        <div className="section-title">
          <h2 id="map-view-title">Map view</h2>
          <Layers size={18} />
        </div>
        <div className="view-grid">
          {LAYERS.map((l) => (
            <Button
              key={l.id}
              variant="ghost"
              className={`view-choice ${layer === l.id ? 'active' : ''}`}
              aria-pressed={layer === l.id}
              onClick={() => setLayer(l.id)}
            >
              <Layers size={20} />
              {l.name}
            </Button>
          ))}
        </div>
      </section>
      <section className="overlay-picker" aria-labelledby="overlay-title">
        <div className="section-title">
          <h2 id="overlay-title">Overlays</h2>
          <span className="overlay-count">
            {overlays.filter((o) => o.enabled).length} on
          </span>
        </div>
        {overlays.map((o) => {
          const controlId = `overlay-${o.id}`;
          return (
            <div className="overlay-control" key={o.id}>
              <label htmlFor={controlId}>
                <i
                  aria-hidden
                  className={`map-symbol ${o.symbol}`}
                  style={{ color: o.color }}
                />
                <span>
                  <strong>{o.label}</strong>
                  <small>{o.description}</small>
                </span>
                <Switch
                  id={controlId}
                  aria-label={o.label}
                  checked={o.enabled}
                  onCheckedChange={o.change}
                />
              </label>
              {o.enabled && o.status && (
                <p className={o.error ? 'feed-error' : 'source-meta'}>
                  <output>{o.status}</output>
                </p>
              )}
            </div>
          );
        })}
      </section>
      <Legend />
      {children}
    </div>
  );
}
