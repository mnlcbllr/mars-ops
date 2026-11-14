import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildTerrainMesh, meshStepFor } from "./terrainMesh";

const vertex = (positions: Float32Array, i: number) => Array.from(positions.subarray(i * 3, i * 3 + 3));

describe("buildTerrainMesh", () => {
  // 3 wide x 2 tall, cells of 2 m (east-west) x 3 m (north-south), row 0 = north.
  const elevation = new Float32Array([10, 20, 30, 40, 50, 60]);

  test("places every vertex at its cell centre with the raster's own height", () => {
    const mesh = buildTerrainMesh(elevation, 3, 2, 2, 3, 1);
    expect([mesh.cols, mesh.rows, mesh.spacingX, mesh.spacingY]).toEqual([3, 2, 2, 3]);
    // (x east, elevation, -y north)
    expect(vertex(mesh.positions, 0)).toEqual([1, 10, -4.5]);
    expect(vertex(mesh.positions, 2)).toEqual([5, 30, -4.5]);
    expect(vertex(mesh.positions, 5)).toEqual([5, 60, -1.5]);
    expect([mesh.minElevation, mesh.maxElevation, mesh.missingVertices]).toEqual([10, 60, 0]);
  });

  test("texture coordinates address the same cell centres", () => {
    const mesh = buildTerrainMesh(elevation, 3, 2, 2, 3, 1);
    expect(mesh.uvs[0]).toBeCloseTo(0.5 / 3, 6);
    expect(mesh.uvs[1]).toBeCloseTo(0.75, 6);
    expect(mesh.uvs[10]).toBeCloseTo(2.5 / 3, 6);
    expect(mesh.uvs[11]).toBeCloseTo(0.25, 6);
  });

  test("triangles face up and cover each quad once", () => {
    const mesh = buildTerrainMesh(elevation, 3, 2, 2, 3, 1);
    expect(Array.from(mesh.indices)).toEqual([0, 3, 1, 1, 3, 4, 1, 4, 2, 2, 4, 5]);
    const p = mesh.positions;
    for (let t = 0; t < mesh.indices.length; t += 3) {
      const [a, b, c] = [mesh.indices[t]! * 3, mesh.indices[t + 1]! * 3, mesh.indices[t + 2]! * 3];
      const [ux, uz] = [p[b]! - p[a]!, p[b + 2]! - p[a + 2]!];
      const [vx, vz] = [p[c]! - p[a]!, p[c + 2]! - p[a + 2]!];
      expect(uz * vx - ux * vz).toBeGreaterThan(0); // y component of (b - a) x (c - a)
    }
  });

  test("a missing cell leaves a hole: no triangle uses it and no height is invented", () => {
    const holed = new Float32Array([10, Number.NaN, 30, 40, 50, 60]);
    const mesh = buildTerrainMesh(holed, 3, 2, 2, 3, 1);
    expect(Array.from(mesh.indices)).toEqual([2, 4, 5]);
    expect([mesh.minElevation, mesh.maxElevation, mesh.missingVertices]).toEqual([10, 60, 1]);
    expect(Number.isFinite(mesh.positions[1 * 3 + 1]!)).toBe(true); // placeholder keeps bounds finite
  });

  test("a coarser step takes every n-th cell, never an average", () => {
    const side = 5;
    const ramp = Float32Array.from({ length: side * side }, (_, i) => 100 + i);
    const mesh = buildTerrainMesh(ramp, side, side, 1, 1, 2);
    expect([mesh.cols, mesh.rows, mesh.spacingX, mesh.spacingY]).toEqual([3, 3, 2, 2]);
    // Mesh vertex (1, 1) is raster cell (2, 2): value 100 + 2 * 5 + 2, centre x 2.5, y 2.5.
    expect(vertex(mesh.positions, 4)).toEqual([2.5, 112, -2.5]);
    expect(vertex(mesh.positions, 8)).toEqual([4.5, 124, -0.5]);
  });

  test("rejects a raster whose length does not match its dimensions", () => {
    expect(() => buildTerrainMesh(elevation, 4, 2, 2, 3, 1)).toThrow();
    expect(() => buildTerrainMesh(elevation, 3, 2, 2, 3, 0)).toThrow();
  });
});

describe("meshStepFor", () => {
  test("is the finest step that fits the vertex budget", () => {
    expect(meshStepFor(2048, 2048, 1024 * 1024)).toBe(2);
    expect(meshStepFor(1024, 1024, 1024 * 1024)).toBe(1);
    expect(meshStepFor(2049, 2049, 1024 * 1024)).toBe(3); // step 2 would give 1025 x 1025
  });
});

// The 3D view's accuracy claim, checked against the packaged NASA product:
// `validation_samples.json` holds elevations read straight from the original
// HiRISE .IMG by byte offset, independently of this code.
describe("mesh built from the packaged HiRISE DTM", () => {
  const dir = join(import.meta.dir, "../../datasets/jezero-small");
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  const samples = JSON.parse(readFileSync(join(dir, "validation_samples.json"), "utf8"));
  const { width, height, cell_size_x_m: dx, cell_size_y_m: dy } = manifest.georeference;
  const file = readFileSync(join(dir, "elevation.bin"));
  const elevation = new Float32Array(file.buffer, file.byteOffset, file.byteLength / 4);

  test("at full resolution every vertex height is the source product's value", () => {
    const mesh = buildTerrainMesh(elevation, width, height, dx, dy, 1);
    expect(samples.source_product_id).toBe("DTEEC_023524_1985_023379_1985_U01");
    expect(samples.samples.length).toBeGreaterThanOrEqual(64);
    for (const s of samples.samples) {
      const got = mesh.positions[(s.row * mesh.cols + s.col) * 3 + 1];
      expect(got).toBe(Math.fround(s.elevation_m));
    }
    expect(mesh.minElevation).toBe(samples.region_min_m);
    expect(mesh.maxElevation).toBe(samples.region_max_m);
    expect(mesh.missingVertices).toBe(samples.region_nodata_cells);
    expect(mesh.indices.length).toBe((width - 1) * (height - 1) * 6);
  });

  test("the displayed mesh uses only real DTM cells, at the stated spacing", () => {
    const step = meshStepFor(width, height, 1024 * 1024);
    const mesh = buildTerrainMesh(elevation, width, height, dx, dy, step);
    expect(step).toBe(2);
    expect([mesh.cols, mesh.rows]).toEqual([1024, 1024]);
    expect(mesh.spacingX).toBeCloseTo(2 * dx, 12);
    expect(mesh.spacingY).toBeCloseTo(2 * dy, 12);
    for (let row = 0; row < mesh.rows; row++) {
      for (let col = 0; col < mesh.cols; col++) {
        const got = mesh.positions[(row * mesh.cols + col) * 3 + 1];
        if (got !== elevation[row * step * width + col * step]) {
          throw new Error(`vertex (${col}, ${row}) is not the DTM cell value`);
        }
      }
    }
    // Source samples that fall on displayed posts are reproduced exactly.
    const onPosts = samples.samples.filter((s: { col: number; row: number }) => s.col % step === 0 && s.row % step === 0);
    expect(onPosts.length).toBeGreaterThan(0);
    for (const s of onPosts) {
      expect(mesh.positions[((s.row / step) * mesh.cols + s.col / step) * 3 + 1]).toBe(Math.fround(s.elevation_m));
    }
    // Skipping cells can only narrow the range, never widen it.
    expect(mesh.minElevation).toBeGreaterThanOrEqual(samples.region_min_m);
    expect(mesh.maxElevation).toBeLessThanOrEqual(samples.region_max_m);
    console.log(
      `step ${step}: mesh range ${mesh.minElevation} .. ${mesh.maxElevation} m; ` +
        `full DTM ${samples.region_min_m} .. ${samples.region_max_m} m; on-post source samples ${onPosts.length}`,
    );
  });
});
