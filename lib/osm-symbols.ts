export const OSM_MAN_MADE_SYMBOL = {
  size: 40,
  hitRadius: 22,
  surveillance: '#bd75ff',
  other: '#ff555f',
} as const;

export function osmManMadeSymbol(properties: Record<string, unknown>) {
  const kind =
    properties.man_made ??
    (properties.family === 'man_made' ? properties.class : undefined);
  return kind === 'surveillance' ? 'eye' : 'hammer';
}

// Canvas paths keep the symbols sharp and consistently colored on every platform.
export function paintManMadeSymbol(
  ctx: OffscreenCanvasRenderingContext2D,
  x: number,
  y: number,
  symbol: 'eye' | 'hammer',
) {
  ctx.save();
  ctx.translate(x, y);
  ctx.globalAlpha = 1;
  ctx.beginPath();
  ctx.arc(0, 0, OSM_MAN_MADE_SYMBOL.size / 2 - 1, 0, Math.PI * 2);
  ctx.fillStyle = '#10212eee';
  ctx.fill();
  ctx.strokeStyle = '#f4f7ffb3';
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.fillStyle = ctx.strokeStyle =
    symbol === 'eye'
      ? OSM_MAN_MADE_SYMBOL.surveillance
      : OSM_MAN_MADE_SYMBOL.other;
  ctx.lineWidth = 3;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  if (symbol === 'eye') {
    ctx.beginPath();
    ctx.moveTo(-13, 0);
    ctx.bezierCurveTo(-6, -11, 6, -11, 13, 0);
    ctx.bezierCurveTo(6, 11, -6, 11, -13, 0);
    ctx.closePath();
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(0, 0, 4, 0, Math.PI * 2);
    ctx.fill();
  } else {
    // Diagonal handle and a broad hammer head, rather than a font/emoji glyph.
    ctx.beginPath();
    ctx.moveTo(-11, 10);
    ctx.lineTo(2, -3);
    ctx.lineTo(6, 1);
    ctx.lineTo(-7, 14);
    ctx.closePath();
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(-4, -8);
    ctx.lineTo(1, -13);
    ctx.lineTo(13, -1);
    ctx.lineTo(8, 4);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
}
