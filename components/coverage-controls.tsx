'use client';
import { Signal, RefreshCw } from 'lucide-react';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { CellCoverage } from '@/hooks/use-cell-coverage';

export function CoverageControls({
  coverage,
  controls = true,
}: {
  coverage: CellCoverage;
  controls?: boolean;
}) {
  const layer = coverage.manifest?.layers.find(
    (l) => l.id === coverage.layerId,
  );
  const providers = Array.from(
    new Map(
      coverage.manifest?.layers.map((l) => [l.provider.id, l.provider]) ?? [],
    ).values(),
  );
  const criteria =
    coverage.manifest?.layers.filter(
      (l) => l.provider.id === layer?.provider.id,
    ) ?? [];
  const options = criteria.map((l) => ({
    value: l.id,
    label: `${l.technology === 'LTE' ? '4G LTE' : '5G'} · ${l.downloadMbps}/${l.uploadMbps} Mbps`,
  }));
  return (
    <section
      className="radio-controls coverage-controls"
      aria-label="Cell coverage controls"
    >
      <h2>
        Cell coverage <Signal size={17} />
      </h2>
      {controls && (
        <label className="radio-toggle" htmlFor="coverage-visible">
          <span>
            Show reported coverage
            <small>FCC mobile broadband availability</small>
          </span>
          <Switch
            id="coverage-visible"
            aria-label="Show cell coverage"
            checked={coverage.enabled}
            onCheckedChange={coverage.setEnabled}
          />
        </label>
      )}
      {coverage.enabled && layer && (
        <>
          <label className="radio-filter" htmlFor="coverage-carrier">
            <span>Carrier</span>
            <Select
              value={layer.provider.id}
              items={providers.map((p) => ({ value: p.id, label: p.name }))}
              onValueChange={(id) => {
                const next =
                  coverage.manifest?.layers.find(
                    (l) =>
                      l.provider.id === id &&
                      l.technology === layer.technology &&
                      l.downloadMbps === layer.downloadMbps,
                  ) ??
                  coverage.manifest?.layers.find((l) => l.provider.id === id);
                if (next) coverage.setLayerId(next.id);
              }}
            >
              <SelectTrigger
                id="coverage-carrier"
                aria-label="Coverage carrier"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {providers.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
          <label className="radio-filter" htmlFor="coverage-criterion">
            <span>Network and modeled speed</span>
            <Select
              value={layer.id}
              items={options}
              onValueChange={(id) => {
                if (id) coverage.setLayerId(id);
              }}
            >
              <SelectTrigger
                id="coverage-criterion"
                aria-label="Coverage criterion"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {options.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
          <div className="coverage-opacity">
            <label htmlFor="coverage-opacity">
              Opacity · {Math.round(coverage.opacity * 100)}%
            </label>
            <Slider
              id="coverage-opacity"
              aria-label="Coverage opacity"
              min={0}
              max={1}
              step={0.05}
              value={[coverage.opacity]}
              onValueChange={(v) =>
                coverage.setOpacity(Array.isArray(v) ? v[0] : v)
              }
            />
          </div>
          <p className="coverage-legend">
            <span style={{ background: '#40be82' }} /> {layer.provider.name} ·{' '}
            {layer.technology} {layer.downloadMbps}/{layer.uploadMbps} Mbps ·
            Outdoor stationary
          </p>
          <p className="radio-meta">
            FCC data as of {layer.reportingDate}. Reported coverage; actual
            reception may vary.
          </p>
          <p className="radio-meta">
            Imported:{' '}
            {layer.jurisdictions
              .filter((j) => j.status === 'ready')
              .map((j) => j.name)
              .join(', ')}
            . Other areas are unknown.
          </p>
          {coverage.selection && !coverage.centerInBounds && (
            <p className="zoom-note">
              The map center is outside the imported region. Coverage there is
              unknown.
            </p>
          )}
          <details>
            <summary>Coverage scope and source</summary>
            <p>
              <a href={layer.sourceUrl} target="_blank" rel="noreferrer">
                FCC source data
              </a>
            </p>
            {layer.jurisdictions
              .filter((j) => j.status !== 'ready')
              .map((j) => (
                <p key={j.id}>
                  {j.name}: {j.reason}
                </p>
              ))}
            {layer.limits.map((t) => (
              <p key={t}>{t}</p>
            ))}
          </details>
        </>
      )}
      <p>
        <output>
          {!coverage.enabled
            ? 'Off'
            : coverage.loading
              ? 'Loading selected coverage…'
              : coverage.error
                ? coverage.error
                : coverage.tileStatus ||
                  'Coverage enabled for the imported area.'}
        </output>
      </p>
      {coverage.enabled && (
        <Button
          variant="outline"
          size="sm"
          onClick={coverage.refresh}
          disabled={coverage.loading}
        >
          <RefreshCw size={14} /> Reload prepared coverage
        </Button>
      )}
    </section>
  );
}
