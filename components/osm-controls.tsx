'use client';
import { useState } from 'react';
import { Download, FolderOpen } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import {
  OSM_LAYERS,
  OSM_GROUPS,
  OSM_PROFILE_VERSION,
  osmLayerMatches,
  OSM_STYLE,
  osmBytes,
  osmRegionMatches,
  type OsmPreview,
  type OsmRegion,
} from '@/lib/osm-model';
import type { OsmControlsState } from '@/hooks/use-osm';
export function OsmControls({
  osm,
  onShow,
}: {
  osm: OsmControlsState;
  onShow: (bounds: number[]) => void;
}) {
  const [regions, setRegions] = useState<OsmRegion[]>([]),
    [filter, setFilter] = useState('');
  const [featureSearch, setFeatureSearch] = useState('');
  const [source, setSource] = useState('region');
  const [selection, setSelection] = useState(''),
    [preview, setPreview] = useState<OsmPreview | null>(null);
  const [path, setPath] = useState(''),
    [storage, setStorage] = useState(''),
    [removeId, setRemoveId] = useState('');
  const act = (action: string, body: object = {}) => {
    void osm.request(action, body).catch(() => {});
  };
  const busy = osm.pending,
    connected = Boolean(osm.library),
    running = osm.library?.busy;
  const matchingRegions = regions.filter((region) =>
    osmRegionMatches(region, filter),
  );
  return (
    <details className="panel-detail osm-controls">
      <summary>
        <FolderOpen size={17} /> OpenStreetMap data
      </summary>
      <p>
        Download an area or use your own compressed <strong>.osm.pbf</strong>{' '}
        file. Prepare it once, then display nearby map detail as you zoom.
      </p>
      {osm.error && (
        <p className="feed-error" role="alert">
          {osm.error}
        </p>
      )}
      <fieldset disabled={busy || !connected}>
        <legend>Add map data</legend>
        <Button variant="outline" onClick={() => act('pick')}>
          <FolderOpen size={16} /> Choose .osm.pbf file
        </Button>
        <details>
          <summary>Enter a local file path</summary>
          <label>
            Existing .osm.pbf file
            <input
              value={path}
              onChange={(e) => setPath(e.target.value)}
              placeholder="C:\Maps\region.osm.pbf"
            />
          </label>
          <Button
            variant="outline"
            disabled={!path.trim()}
            onClick={() => act('import', { path: path.trim() })}
          >
            Add existing file
          </Button>
          <p className="source-meta">
            The original stays in its current location.
          </p>
        </details>
        <label>
          Download source
          <select
            value={source}
            onChange={(e) => {
              setSource(e.target.value);
              setSelection(e.target.value === 'planet' ? 'planet' : '');
              setPreview(null);
            }}
          >
            <option value="region">Geofabrik regional extract</option>
            <option value="planet">Entire planet — very large download</option>
          </select>
        </label>
        {source === 'region' && (
          <>
            <Button
              variant="outline"
              onClick={() => {
                void osm
                  .request<OsmRegion[]>('regions')
                  .then(setRegions)
                  .catch(() => {});
              }}
            >
              {osm.pendingAction === 'regions'
                ? 'Loading Geofabrik regions…'
                : 'Browse Geofabrik regions'}
            </Button>
            {regions.length > 0 && (
              <>
                <label>
                  Find a region
                  <input
                    value={filter}
                    onChange={(e) => {
                      setFilter(e.target.value);
                      setSelection('');
                      setPreview(null);
                    }}
                    placeholder="Name or code, e.g. Maryland or MD"
                  />
                </label>
                <output className="source-meta">
                  {matchingRegions.length} of {regions.length} regions.{' '}
                  {matchingRegions.length
                    ? 'Select a region below.'
                    : 'No matching regions. Try another name or code.'}
                </output>
                {matchingRegions.length > 0 && (
                  <label>
                    Geofabrik region
                    <select
                      size={6}
                      value={selection}
                      onChange={(e) => {
                        setSelection(e.target.value);
                        setPreview(null);
                      }}
                    >
                      <option value="" disabled>
                        Choose a region
                      </option>
                      {matchingRegions.map((region) => (
                        <option key={region.id} value={region.id}>
                          {region.name}
                          {region.parent ? ` · ${region.parent}` : ''}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
              </>
            )}
          </>
        )}
        <Button
          variant="outline"
          disabled={!selection}
          onClick={() => {
            setPreview(null);
            void osm
              .request<OsmPreview>('inspect', { selection })
              .then(setPreview)
              .catch(() => {});
          }}
        >
          Check download size
        </Button>
        {preview && (
          <div className="osm-preview">
            <strong>{preview.name}</strong>
            <p>
              <strong>{osmBytes(preview.bytes)} compressed PBF</strong> (
              {preview.bytes.toLocaleString()} bytes)
            </p>
            {preview.modified && (
              <p className="source-meta">
                Published {new Date(preview.modified).toLocaleDateString()}
              </p>
            )}
            <p>
              Preparation estimate: {osmBytes(preview.estimatedWorkingBytes)}{' '}
              free disk space. Available: {osmBytes(preview.freeDiskBytes)}.
            </p>
            <p className="source-meta">
              First preparation also downloads a verified converter and private
              Java runtime, about 136 MiB on Windows. Planet preparation can
              take hours and needs substantial memory and SSD space.
            </p>
            <Button
              disabled={
                running ||
                preview.selection !== selection ||
                preview.freeDiskBytes < preview.bytes + 512 * 1024 ** 2
              }
              onClick={() => act('download', { selection })}
            >
              <Download size={16} /> Download {osmBytes(preview.bytes)}
            </Button>
          </div>
        )}
        <details>
          <summary>Data storage folder</summary>
          <p className="source-meta osm-path">{osm.library?.storage}</p>
          <label>
            Folder for new datasets
            <input
              value={storage}
              onChange={(e) => setStorage(e.target.value)}
              placeholder="D:\OpenViewMaps"
            />
          </label>
          <Button
            variant="outline"
            disabled={running || !storage.trim()}
            onClick={() => act('storage', { path: storage.trim() })}
          >
            Use folder
          </Button>
          <p className="source-meta">
            Existing datasets remain where they are. OSM data is kept when
            OpenView is updated or uninstalled.
          </p>
        </details>
      </fieldset>
      {busy && (
        <p>
          <output>
            {osm.pendingAction === 'pick'
              ? 'Choose a file in the Windows dialog…'
              : osm.pendingAction === 'regions'
                ? 'Loading the Geofabrik region catalog…'
                : 'Working…'}
          </output>
        </p>
      )}
      {osm.library?.datasets.map((dataset) => (
        <section className="osm-dataset" key={dataset.id}>
          <h3>{dataset.name}</h3>
          <p className="source-meta">
            {osmBytes(dataset.bytes)} compressed PBF · {dataset.status}
          </p>
          <p className="osm-job">
            <output>{dataset.message}</output>
          </p>
          {dataset.status === 'downloading' && (
            <>
              <progress
                max={dataset.bytes}
                value={dataset.downloadedBytes}
                aria-label={`${dataset.name} download`}
              />
              <p>
                {osmBytes(dataset.downloadedBytes)} / {osmBytes(dataset.bytes)}
              </p>
            </>
          )}
          {dataset.status === 'ready' &&
            (dataset.profileVersion ?? 1) < OSM_PROFILE_VERSION && (
              <p className="source-meta">
                Update this prepared map from the existing PBF for more feature
                types and clickable source tags. No new PBF download is needed.
              </p>
            )}
          <div className="osm-actions">
            {osm.library?.activeId === dataset.id ? (
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => act('stop', { id: dataset.id })}
              >
                {dataset.status === 'downloading'
                  ? 'Pause download'
                  : 'Stop preparation'}
              </Button>
            ) : (
              <>
                {dataset.managedSource && !dataset.sourceReady && (
                  <Button
                    variant="outline"
                    disabled={busy || running}
                    onClick={() => act('resume', { id: dataset.id })}
                  >
                    Resume download
                  </Button>
                )}
                {(dataset.status !== 'ready' ||
                  (dataset.profileVersion ?? 1) < OSM_PROFILE_VERSION) && (
                  <Button
                    disabled={
                      busy ||
                      running ||
                      (dataset.managedSource && !dataset.sourceReady)
                    }
                    onClick={() => act('prepare', { id: dataset.id })}
                  >
                    {dataset.status === 'ready'
                      ? 'Update map features & info'
                      : 'Prepare map'}
                  </Button>
                )}
              </>
            )}
            {dataset.status === 'ready' && (
              <label
                className="toggle-row"
                htmlFor={`osm-enable-${dataset.id}`}
              >
                <span>Show on map</span>
                <Switch
                  id={`osm-enable-${dataset.id}`}
                  aria-label={`Show ${dataset.name} on map`}
                  checked={dataset.enabled}
                  disabled={busy}
                  onCheckedChange={(enabled) =>
                    act('enable', { id: dataset.id, enabled })
                  }
                />
              </label>
            )}
            {dataset.status === 'ready' && dataset.bounds && (
              <Button variant="outline" onClick={() => onShow(dataset.bounds!)}>
                Go to area
              </Button>
            )}
            {osm.library?.activeId !== dataset.id && (
              <Button
                variant="ghost"
                disabled={busy}
                onClick={() => setRemoveId(dataset.id)}
              >
                Remove…
              </Button>
            )}
          </div>
          {removeId === dataset.id && (
            <div className="osm-preview">
              <p>
                Remove this dataset and its prepared map?{' '}
                {dataset.managedSource
                  ? 'The downloaded PBF will also be deleted.'
                  : 'Your original PBF will be kept.'}
              </p>
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => {
                  act('remove', { id: dataset.id });
                  setRemoveId('');
                }}
              >
                Remove dataset
              </Button>
              <Button variant="ghost" onClick={() => setRemoveId('')}>
                Keep dataset
              </Button>
            </div>
          )}
        </section>
      ))}
      {osm.selection && (
        <fieldset>
          <legend>Imported OSM layers</legend>
          <p className="source-meta">
            Choose individual feature categories, then click a mapped feature
            for its source information. Availability depends on the extract and
            zoom.
          </p>
          <label>
            Find OSM features
            <input
              value={featureSearch}
              onChange={(event) => setFeatureSearch(event.target.value)}
              placeholder="Shops, trails, power, addresses…"
            />
          </label>
          <p className="source-meta">
            <output>
              {osm.layers.length} of {OSM_LAYERS.length} categories enabled
            </output>
          </p>
          <Button
            variant="outline"
            disabled={!osm.layers.length}
            onClick={() => osm.setLayers([])}
          >
            Turn all OSM layers off
          </Button>
          {OSM_GROUPS.map((group) => {
            const matching = group.ids.filter((id) =>
              osmLayerMatches(id, featureSearch),
            );
            if (!matching.length) return null;
            return (
              <details
                key={group.name}
                open={featureSearch.trim() ? true : undefined}
                className="osm-feature-group"
              >
                <summary>
                  {group.name} ·{' '}
                  {group.ids.filter((id) => osm.layers.includes(id)).length}/
                  {group.ids.length} on
                </summary>
                <Button
                  variant="ghost"
                  onClick={() => osm.setLayers([...osm.layers, ...matching])}
                >
                  Enable {featureSearch.trim() ? 'matching' : 'group'} features
                </Button>
                <Button
                  variant="ghost"
                  onClick={() =>
                    osm.setLayers(
                      osm.layers.filter((id) => !matching.includes(id)),
                    )
                  }
                >
                  Clear {featureSearch.trim() ? 'matching' : 'group'} features
                </Button>
                {matching.map((layer) => (
                  <label
                    className="toggle-row"
                    key={layer}
                    htmlFor={`osm-layer-${layer}`}
                  >
                    <span>
                      <strong>{OSM_STYLE[layer].name}</strong>
                      <small>{OSM_STYLE[layer].description}</small>
                      <small>
                        From zoom {OSM_STYLE[layer].zoom} ·{' '}
                        {OSM_STYLE[layer].keys.join(', ')}
                      </small>
                    </span>
                    <Switch
                      id={`osm-layer-${layer}`}
                      aria-label={OSM_STYLE[layer].name}
                      checked={osm.layers.includes(layer)}
                      onCheckedChange={(enabled) =>
                        osm.toggleLayer(layer, enabled)
                      }
                    />
                  </label>
                ))}
              </details>
            );
          })}
          {!OSM_LAYERS.some((id) => osmLayerMatches(id, featureSearch)) && (
            <output>
              No matching categories. Try an OSM tag such as shop, power or
              amenity.
            </output>
          )}
          <p className="source-meta">
            <output>{osm.renderStatus}</output>
          </p>
          <p className="source-meta">
            One dataset is displayed at a time. Building detail appears around
            zoom 16; smaller features around zoom 17. Dense areas may show less
            detail.
          </p>
        </fieldset>
      )}
    </details>
  );
}
