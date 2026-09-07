'use client';
import { useEffect, useId, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { OSM_STYLE } from '@/lib/osm-model';
import type { OsmPickResult } from '@/lib/osm-pick';

export function OsmFeaturePopup({
  result,
  prepared,
  onClose,
}: {
  result: OsmPickResult & { loading?: boolean; error?: string };
  prepared: string;
  onClose: () => void;
}) {
  const titleId = useId(),
    close = useRef<HTMLButtonElement>(null);
  const [chosen, setChosen] = useState(0);
  const feature = result.features[chosen] || result.features[0];
  useEffect(() => {
    close.current?.focus({ preventScroll: true });
  }, []);
  return (
    <dialog
      open
      className="osm-feature-popup"
      aria-labelledby={titleId}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <div className="osm-popup-heading">
        <h2 id={titleId}>OSM feature information</h2>
        <button
          ref={close}
          type="button"
          aria-label="Close OSM feature information"
          onClick={onClose}
        >
          <X size={18} />
        </button>
      </div>
      {result.loading ? (
        <output>Reading the prepared local map…</output>
      ) : result.error ? (
        <p role="alert">{result.error}</p>
      ) : !feature ? (
        <output>
          {result.limited
            ? 'Detail at this location exceeds the display limit. Try fewer layers or a nearby feature.'
            : 'No enabled OSM feature was found at this point. Zoom closer and click a mapped outline, line or marker.'}
        </output>
      ) : (
        <>
          {result.features.length > 1 && (
            <label>
              Features at this point
              <select
                value={Math.min(chosen, result.features.length - 1)}
                onChange={(event) => setChosen(Number(event.target.value))}
              >
                {result.features.map((item, index) => (
                  <option key={index} value={index}>
                    {item.name} · {OSM_STYLE[item.category].name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <h3>{feature.name}</h3>
          <p>{OSM_STYLE[feature.category].name}</p>
          {feature.sourceId && feature.sourceType && (
            <a
              href={`https://www.openstreetmap.org/${feature.sourceType}/${feature.sourceId}`}
              target="_blank"
              rel="noreferrer"
            >
              OSM {feature.sourceType} {feature.sourceId}
            </a>
          )}
          {!feature.complete && (
            <p className="source-meta">
              Only limited tags are available here. Zoom closer for source tags.
              Older maps need “Update map features & info”; very large tag sets
              are shortened.
            </p>
          )}
          <dl className="osm-tag-list">
            {feature.tags.map(([key, value], index) => (
              <div key={index}>
                <dt>{key}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
          {result.limited && (
            <p className="source-meta">
              Some overlapping features were omitted by the display limits.
            </p>
          )}
        </>
      )}
      <p className="source-meta">
        Source: your local OSM extract, prepared{' '}
        {new Date(prepared).toLocaleDateString()}. Tags describe the downloaded
        snapshot.
      </p>
      <a
        href="https://www.openstreetmap.org/copyright"
        target="_blank"
        rel="noreferrer"
      >
        © OpenStreetMap contributors · ODbL
      </a>
    </dialog>
  );
}
