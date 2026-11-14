// 2D map view maths. Local coordinates are metres, x east and y north; the
// screen has y pointing down, so north is always up.

export interface View {
  /** Local point shown at the viewport centre, metres. */
  cx: number;
  cy: number;
  /** Screen pixels per metre. */
  scale: number;
}

export interface Size {
  width: number;
  height: number;
}

/** The view that shows a whole `extent` (metres) inside `viewport` (pixels). */
export function fitView(extent: Size, viewport: Size, padding = 0): View {
  const scale = Math.min(
    (viewport.width - 2 * padding) / extent.width,
    (viewport.height - 2 * padding) / extent.height,
  );
  return { cx: extent.width / 2, cy: extent.height / 2, scale };
}

export function toScreen(view: View, viewport: Size, x_m: number, y_m: number): [number, number] {
  return [
    (x_m - view.cx) * view.scale + viewport.width / 2,
    (view.cy - y_m) * view.scale + viewport.height / 2,
  ];
}

export function toLocal(view: View, viewport: Size, sx: number, sy: number): [number, number] {
  return [
    (sx - viewport.width / 2) / view.scale + view.cx,
    view.cy - (sy - viewport.height / 2) / view.scale,
  ];
}

/** Zoom by `factor`, keeping the local point under screen point (sx, sy) fixed. */
export function zoomAt(
  view: View,
  viewport: Size,
  sx: number,
  sy: number,
  factor: number,
  minScale: number,
  maxScale: number,
): View {
  const [x, y] = toLocal(view, viewport, sx, sy);
  const scale = Math.min(maxScale, Math.max(minScale, view.scale * factor));
  return {
    cx: x - (sx - viewport.width / 2) / scale,
    cy: y + (sy - viewport.height / 2) / scale,
    scale,
  };
}

/** Longest 1-2-5 × 10ⁿ ground length whose bar is at most `maxPx` wide. */
export function scaleBar(scale: number, maxPx: number): { metres: number; px: number } {
  const limit = maxPx / scale;
  const decade = 10 ** Math.floor(Math.log10(limit));
  const metres = [5, 2, 1].map((m) => m * decade).find((m) => m <= limit * (1 + 1e-12)) ?? decade;
  return { metres, px: metres * scale };
}
