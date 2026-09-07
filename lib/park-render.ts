import type { ParkTile } from './park-data';
import { PARK_COLORS, parkTileAddress, type ParkKind } from './park-model';
/** Render source vectors into a display tile. Lines use original boundaries,
 * not clipped polygon edges, so the tile grid never becomes a park outline. */
export function paintParkTile(
  canvas: HTMLCanvasElement,
  tile: ParkTile,
  kind: ParkKind,
  z: number,
  x: number,
  y: number,
  maxZoom: number,
) {
  canvas.width = canvas.height = 256;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Park rendering needs a canvas context.');
  const address = parkTileAddress(z, x, y, maxZoom),
    color = PARK_COLORS[kind];
  const path = (
    rings: { x: number; y: number }[][],
    extent: number,
    close: boolean,
  ) => {
    ctx.beginPath();
    for (const ring of rings) {
      ring.forEach((p, i) => {
        const px = (p.x / extent) * 256 * address.scale - address.dx * 256,
          py = (p.y / extent) * 256 * address.scale - address.dy * 256;
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      });
      if (close) ctx.closePath();
    }
  };
  ctx.fillStyle = color;
  ctx.globalAlpha = 0.13;
  for (const f of tile.polygons) {
    path(f.rings, f.extent, true);
    ctx.fill('evenodd');
  }
  ctx.globalAlpha = 0.9;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  for (const f of tile.lines) {
    path(f.rings, f.extent, false);
    ctx.strokeStyle = '#13202acc';
    ctx.lineWidth = 3.5;
    ctx.stroke();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.8;
    ctx.stroke();
  }
  return canvas;
}
