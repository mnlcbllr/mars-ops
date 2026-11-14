import { describe, expect, test } from "bun:test";
import { ELEVATION_RAMP, elevationRgba, hazardRgba, rampLut } from "./layers";

const pixel = (data: Uint8ClampedArray, i: number) => Array.from(data.subarray(i * 4, i * 4 + 4));

describe("rampLut", () => {
  test("starts and ends exactly on the outer stops", () => {
    expect(Array.from(rampLut(["#000000", "#ffffff"], 3))).toEqual([0, 0, 0, 128, 128, 128, 255, 255, 255]);
  });
  test("interpolates linearly between neighbouring stops", () => {
    const lut = rampLut(["#000000", "#ff0000", "#ffffff"], 5);
    expect(Array.from(lut)).toEqual([0, 0, 0, 128, 0, 0, 255, 0, 0, 255, 128, 128, 255, 255, 255]);
  });
  test("the elevation ramp is one hue running dark to light", () => {
    const lut = rampLut(ELEVATION_RAMP, 256);
    expect(Array.from(lut.subarray(0, 3))).toEqual([0x0d, 0x36, 0x6b]);
    expect(Array.from(lut.subarray(255 * 3))).toEqual([0xcd, 0xe2, 0xfb]);
    // Luma never decreases along the ramp, so brighter always means higher.
    const luma = (i: number) => 0.2126 * lut[i * 3]! + 0.7152 * lut[i * 3 + 1]! + 0.0722 * lut[i * 3 + 2]!;
    for (let i = 1; i < 256; i++) expect(luma(i)).toBeGreaterThanOrEqual(luma(i - 1));
  });
});

describe("elevationRgba", () => {
  const gray = rampLut(["#000000", "#ffffff"], 256);
  test("maps the range onto the ramp and leaves missing cells transparent", () => {
    const rgba = elevationRgba(new Float32Array([10, 20, Number.NaN, 15]), 10, 20, gray);
    expect(pixel(rgba, 0)).toEqual([0, 0, 0, 255]);
    expect(pixel(rgba, 1)).toEqual([255, 255, 255, 255]);
    expect(pixel(rgba, 2)).toEqual([0, 0, 0, 0]);
    expect(pixel(rgba, 3)).toEqual([128, 128, 128, 255]);
  });
  test("a flat raster does not divide by zero", () => {
    const rgba = elevationRgba(new Float32Array([7, 7]), 7, 7, gray);
    expect(pixel(rgba, 0)).toEqual([0, 0, 0, 255]);
    expect(pixel(rgba, 1)).toEqual([0, 0, 0, 255]);
  });
});

describe("hazardRgba", () => {
  // 2 x 2 planning cells, 8 px each: [5 deg, 25 deg / unknown, exactly 20 deg], limit 20 deg.
  const slope = new Float32Array([5, 25, Number.NaN, 20]);
  const image = hazardRgba(slope, 2, 2, 20, 8);
  const at = (x: number, y: number) => pixel(image.data, y * image.width + x);

  test("is sized in whole pixels per cell and counts each class", () => {
    expect([image.width, image.height]).toEqual([16, 16]);
    expect([image.aboveLimit, image.unknown]).toEqual([1, 1]);
  });
  test("cells at or below the limit stay fully transparent", () => {
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) expect(at(x, y)[3]).toBe(0);
    // Exactly at the limit is allowed: the rule is slope > limit.
    for (let y = 8; y < 16; y++) for (let x = 8; x < 16; x++) expect(at(x, y)[3]).toBe(0);
  });
  test("above-limit cells are tinted and hatched along one diagonal", () => {
    expect(at(8, 0)).toEqual([236, 131, 90, 230]); // (x + y) % 8 = 0: on a hatch line
    expect(at(9, 0)).toEqual([236, 131, 90, 230]); // (x + y) % 8 = 1: line is 2 px wide
    expect(at(10, 0)).toEqual([236, 131, 90, 90]); // between lines: tint only
    expect(at(15, 1)).toEqual([236, 131, 90, 230]); // (15 + 1) % 8 = 0
  });
  test("unknown cells use a different fill and the opposite diagonal", () => {
    expect(at(0, 8)).toEqual([195, 194, 183, 230]); // (x - y) mod 8 = 0: on a hatch line
    expect(at(2, 8)).toEqual([13, 13, 13, 150]); // (2 - 8) mod 8 = 2: veil only
    expect(at(1, 9)).toEqual([195, 194, 183, 230]); // (1 - 9) mod 8 = 0
    for (let y = 8; y < 16; y++) for (let x = 0; x < 8; x++) expect(at(x, y)[3]).toBeGreaterThan(0);
  });
});
