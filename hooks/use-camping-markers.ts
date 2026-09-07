'use client';
import { useEffect, type RefObject } from 'react';
import type * as Cesium from 'cesium';
import {
  PAYMENT_COLORS,
  PAYMENT_SYMBOLS,
  type CampMarker,
} from '@/lib/camping-model';

const CAMPING_MARKER_IMAGES = new Map<string, string>();
function campingMarkerImage(
  layer: CampMarker['layer'],
  payment: CampMarker['payment'],
) {
  const key = `${layer}:${payment}`;
  const cached = CAMPING_MARKER_IMAGES.get(key);
  if (cached) return cached;
  const color = PAYMENT_COLORS[payment],
    symbol = PAYMENT_SYMBOLS[payment];
  const shape =
    layer === 'campgrounds'
      ? '<path d="M16 2 30 29H2Z"/>'
      : layer === 'sites'
        ? '<rect x="3" y="3" width="26" height="26" rx="2"/>'
        : '<path d="M16 1 31 16 16 31 1 16Z"/>';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><g fill="${color}" stroke="#13202b" stroke-width="2">${shape}</g><text x="16" y="23" text-anchor="middle" font-family="Arial" font-weight="bold" font-size="15" fill="#13202b">${symbol}</text></svg>`;
  const image = `data:image/svg+xml,${encodeURIComponent(svg)}`;
  CAMPING_MARKER_IMAGES.set(key, image);
  return image;
}

export function useCampingMarkers(
  markers: CampMarker[],
  enabled: boolean,
  ready: number,
  api: RefObject<typeof Cesium | null>,
  viewer: RefObject<Cesium.Viewer | null>,
  report: (message: string) => void,
) {
  useEffect(() => {
    const C = api.current,
      v = viewer.current;
    if (!enabled || !ready || !C || !v) return;
    const source = new C.CustomDataSource('Camping source records');
    const credit = new C.Credit(
      '<a href="https://www.openstreetmap.org/copyright">© OpenStreetMap contributors · ODbL</a> · data source: ridb.recreation.gov · BLM · USGS · USFS',
      true,
    );
    v.creditDisplay.addStaticCredit(credit);
    let disposed = false;
    void v.dataSources
      .add(source)
      .then(() => {
        if (disposed && !v.isDestroyed() && v.dataSources.contains(source))
          v.dataSources.remove(source, true);
      })
      .catch(() => {
        if (!disposed)
          report(
            'Camping map symbols could not be initialized. Reload the prepared layer.',
          );
      });
    for (const m of markers) {
      const color = PAYMENT_COLORS[m.payment],
        symbol = PAYMENT_SYMBOLS[m.payment];
      const shift =
        m.layer === 'campgrounds' ? -9 : m.layer === 'sites' ? 9 : 0;
      source.entities.add({
        id: `camping:${m.id}`,
        properties: { openviewKind: 'camping', openviewId: m.id },
        position: C.Cartesian3.fromDegrees(m.lon, m.lat),
        billboard: {
          image: campingMarkerImage(m.layer, m.payment),
          width: m.cluster ? 30 : 25,
          height: m.cluster ? 30 : 25,
          heightReference: C.HeightReference.CLAMP_TO_GROUND,
          verticalOrigin: C.VerticalOrigin.BOTTOM,
          pixelOffset: new C.Cartesian2(shift, -2),
          // Site records only resolve at close zoom, so a finite cutoff makes
          // terrain hide them precisely when the individual markers appear.
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
        label: {
          text: m.cluster ? `${symbol} ${m.count.toLocaleString()}` : '',
          font: 'bold 13px Arial',
          fillColor: C.Color.fromCssColorString(color),
          outlineColor: C.Color.fromCssColorString('#13202b'),
          outlineWidth: 3,
          style: C.LabelStyle.FILL_AND_OUTLINE,
          heightReference: C.HeightReference.CLAMP_TO_GROUND,
          pixelOffset: new C.Cartesian2(shift, -42),
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      });
    }
    v.scene.requestRender();
    return () => {
      disposed = true;
      if (!v.isDestroyed()) {
        v.creditDisplay.removeStaticCredit(credit);
        if (v.dataSources.contains(source)) v.dataSources.remove(source, true);
        v.scene.requestRender();
      }
    };
  }, [markers, enabled, ready, api, viewer, report]);
}
