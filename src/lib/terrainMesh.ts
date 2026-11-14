// Builds the 3D terrain mesh from the elevation raster.
//
// Every vertex is one raster cell: its height is that cell's value, bit for
// bit, and its position is the cell centre in the local metric frame.
// Nothing is smoothed, averaged or interpolated; a coarser mesh
// simply skips cells. Missing cells become holes.

export interface TerrainMesh {
  /** Vertices per row / per column. */
  cols: number;
  rows: number;
  /** Raster cells between neighbouring vertices. */
  step: number;
  /** Ground distance between neighbouring vertices, metres. */
  spacingX: number;
  spacingY: number;
  /** Per vertex: x east (m), elevation (m), −y north (m). */
  positions: Float32Array;
  uvs: Float32Array;
  /** Triangles, counter-clockwise seen from above. None uses a missing cell. */
  indices: Uint32Array;
  /** Range over the vertices that have data. */
  minElevation: number;
  maxElevation: number;
  missingVertices: number;
}

/** Smallest step whose mesh has at most `maxVertices` vertices. */
export function meshStepFor(width: number, height: number, maxVertices: number): number {
  let step = 1;
  while ((Math.floor((width - 1) / step) + 1) * (Math.floor((height - 1) / step) + 1) > maxVertices) step++;
  return step;
}

/**
 * `elevation` is row-major with row 0 at the north edge and `NaN` for missing
 * cells; `dx` / `dy` are the ground size of one cell in metres.
 */
export function buildTerrainMesh(
  elevation: Float32Array,
  width: number,
  height: number,
  dx: number,
  dy: number,
  step: number,
): TerrainMesh {
  if (elevation.length !== width * height) {
    throw new Error(`elevation has ${elevation.length} cells, expected ${width} x ${height}`);
  }
  if (!Number.isInteger(step) || step < 1) throw new Error(`mesh step must be a positive integer, got ${step}`);

  const cols = Math.floor((width - 1) / step) + 1;
  const rows = Math.floor((height - 1) / step) + 1;
  const positions = new Float32Array(cols * rows * 3);
  const uvs = new Float32Array(cols * rows * 2);
  const missing = new Uint8Array(cols * rows);
  let [minElevation, maxElevation, missingVertices] = [Infinity, -Infinity, 0];

  for (let j = 0; j < rows; j++) {
    const row = j * step;
    for (let i = 0; i < cols; i++) {
      const col = i * step;
      const v = j * cols + i;
      const h = elevation[row * width + col]!;
      positions[v * 3] = (col + 0.5) * dx;
      positions[v * 3 + 1] = h;
      positions[v * 3 + 2] = -(height - row - 0.5) * dy;
      uvs[v * 2] = (col + 0.5) / width;
      uvs[v * 2 + 1] = 1 - (row + 0.5) / height;
      if (Number.isNaN(h)) {
        missing[v] = 1;
        missingVertices++;
      } else {
        if (h < minElevation) minElevation = h;
        if (h > maxElevation) maxElevation = h;
      }
    }
  }
  if (missingVertices === cols * rows) [minElevation, maxElevation] = [Number.NaN, Number.NaN];
  // A missing vertex is drawn by no triangle; it only needs a finite height so
  // the mesh bounds stay finite.
  if (missingVertices > 0) {
    const placeholder = Number.isNaN(minElevation) ? 0 : minElevation;
    for (let v = 0; v < missing.length; v++) if (missing[v]) positions[v * 3 + 1] = placeholder;
  }

  const indices = new Uint32Array((cols - 1) * (rows - 1) * 6);
  let n = 0;
  for (let j = 0; j < rows - 1; j++) {
    for (let i = 0; i < cols - 1; i++) {
      const nw = j * cols + i;
      const [ne, sw, se] = [nw + 1, nw + cols, nw + cols + 1];
      if (!(missing[nw] || missing[sw] || missing[ne])) {
        indices[n++] = nw;
        indices[n++] = sw;
        indices[n++] = ne;
      }
      if (!(missing[ne] || missing[sw] || missing[se])) {
        indices[n++] = ne;
        indices[n++] = sw;
        indices[n++] = se;
      }
    }
  }

  return {
    cols,
    rows,
    step,
    spacingX: step * dx,
    spacingY: step * dy,
    positions,
    uvs,
    indices: n === indices.length ? indices : indices.slice(0, n),
    minElevation,
    maxElevation,
    missingVertices,
  };
}
