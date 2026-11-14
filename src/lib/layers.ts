// Turns numeric rasters into map pixels. Pure functions: the same code feeds
// the 2D canvas and the 3D texture.

/**
 * Elevation ramp: one hue, dark (low) to light (high), so brightness alone
 * carries the order and the map never needs a rainbow.
 */
export const ELEVATION_RAMP: readonly string[] = [
  "#0d366b", "#104281", "#184f95", "#1c5cab", "#256abf", "#2a78d6", "#3987e5",
  "#5598e7", "#6da7ec", "#86b6ef", "#9ec5f4", "#b7d3f6", "#cde2fb",
];

/** Slope above the scenario limit: orange tint, hatched "/". */
export const ABOVE_LIMIT_RGB = [236, 131, 90] as const;
/** No usable elevation or slope: dark veil, light hatching "\". */
export const UNKNOWN_VEIL_RGB = [13, 13, 13] as const;
export const UNKNOWN_HATCH_RGB = [195, 194, 183] as const;

const TINT_ALPHA = 90;
const VEIL_ALPHA = 150;
const HATCH_ALPHA = 230;
const HATCH_PERIOD = 8;
const HATCH_WIDTH = 2;

function hexRgb(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** `size` RGB triples interpolated linearly through evenly spaced `stops`. */
export function rampLut(stops: readonly string[], size = 256): Uint8ClampedArray {
  const colors = stops.map(hexRgb);
  const lut = new Uint8ClampedArray(size * 3);
  for (let i = 0; i < size; i++) {
    const position = (i / (size - 1)) * (colors.length - 1);
    const lower = Math.min(Math.floor(position), colors.length - 2);
    const t = position - lower;
    const [a, b] = [colors[lower]!, colors[lower + 1]!];
    for (let c = 0; c < 3; c++) lut[i * 3 + c] = a[c]! + (b[c]! - a[c]!) * t;
  }
  return lut;
}

/** RGBA for an elevation raster; missing (`NaN`) cells stay transparent. */
export function elevationRgba(
  elevation: Float32Array,
  min: number,
  max: number,
  lut: Uint8ClampedArray,
): Uint8ClampedArray<ArrayBuffer> {
  const last = lut.length / 3 - 1;
  const span = max - min;
  const rgba = new Uint8ClampedArray(elevation.length * 4);
  for (let i = 0; i < elevation.length; i++) {
    const v = elevation[i]!;
    if (Number.isNaN(v)) continue;
    const t = span > 0 ? Math.min(1, Math.max(0, (v - min) / span)) : 0;
    const k = Math.round(t * last) * 3;
    rgba[i * 4] = lut[k]!;
    rgba[i * 4 + 1] = lut[k + 1]!;
    rgba[i * 4 + 2] = lut[k + 2]!;
    rgba[i * 4 + 3] = 255;
  }
  return rgba;
}

export interface HazardImage {
  data: Uint8ClampedArray<ArrayBuffer>;
  width: number;
  height: number;
  /** Planning cells steeper than the limit. */
  aboveLimit: number;
  /** Planning cells with no usable elevation or slope. */
  unknown: number;
}

/**
 * Overlay of the cells a route may not enter, `pxPerCell` pixels per planning
 * cell. The two classes differ in fill and in hatch direction, not only in
 * colour. The rule is the planner's own: unknown if `NaN`, blocked if
 * `slope > maxSlopeDeg`.
 */
export function hazardRgba(
  slope: Float32Array,
  cols: number,
  rows: number,
  maxSlopeDeg: number,
  pxPerCell: number,
): HazardImage {
  const [width, height] = [cols * pxPerCell, rows * pxPerCell];
  const data = new Uint8ClampedArray(width * height * 4);
  let [aboveLimit, unknown] = [0, 0];
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const s = slope[row * cols + col]!;
      const isUnknown = Number.isNaN(s);
      if (!isUnknown && !(s > maxSlopeDeg)) continue;
      if (isUnknown) unknown++;
      else aboveLimit++;
      for (let y = row * pxPerCell; y < (row + 1) * pxPerCell; y++) {
        for (let x = col * pxPerCell; x < (col + 1) * pxPerCell; x++) {
          const phase = isUnknown ? (((x - y) % HATCH_PERIOD) + HATCH_PERIOD) % HATCH_PERIOD : (x + y) % HATCH_PERIOD;
          const onLine = phase < HATCH_WIDTH;
          const rgb = isUnknown ? (onLine ? UNKNOWN_HATCH_RGB : UNKNOWN_VEIL_RGB) : ABOVE_LIMIT_RGB;
          const i = (y * width + x) * 4;
          data[i] = rgb[0];
          data[i + 1] = rgb[1];
          data[i + 2] = rgb[2];
          data[i + 3] = onLine ? HATCH_ALPHA : isUnknown ? VEIL_ALPHA : TINT_ALPHA;
        }
      }
    }
  }
  return { data, width, height, aboveLimit, unknown };
}
