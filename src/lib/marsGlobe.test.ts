import { expect, test } from "bun:test";
import manifest from "../../datasets/jezero-small/manifest.json";
import { globePoint, regionCenter, globePatchGrid, isInsideGlobePatch, localGlobePoint, localToLatLon, patchCameraAltitude, ROUTE_LIFT_M } from "./marsGlobe";

test("globe aligns north, east and the longitude seam with the Mars Trek texture", () => {
  const axes = [[90, 0, 0, 1, 0], [0, 0, 1, 0, 0], [0, 90, 0, 0, -1], [0, -180, -1, 0, 0]];
  for (const [lat, lon, x, y, z] of axes) {
    globePoint(lat!, lon!).forEach((value, index) => expect(value).toBeCloseTo([x!, y!, z!][index]!, 7));
  }
  expect(Math.hypot(...globePoint(18.47, 77.50, 1.012))).toBeCloseTo(1.012, 7);
});

test("local dataset footprint determines the globe marker", () => {
  const center = regionCenter({ lat_min: 18.45, lat_max: 18.49, lon_east_min: 77.48, lon_east_max: 77.52 });
  expect(center.lat_deg).toBeCloseTo(18.47, 7);
  expect(center.lon_east_deg).toBeCloseTo(77.5, 7);
  expect(regionCenter({ lat_min: 0, lat_max: 0, lon_east_min: 179, lon_east_max: -179 }).lon_east_deg).toBe(180);
});

test("Jezero faces the expected camera direction near 77.5°E", () => {
  const [x, y, z] = globePoint(18.47, 77.5);
  expect(x).toBeGreaterThan(0);
  expect(y).toBeGreaterThan(0);
  expect(z).toBeLessThan(-0.9);
});

test("global patch corners preserve the local raster orientation and georeferencing", () => {
  const geo = manifest.georeference;
  const box = manifest.roi_bbox;
  const northWest = localToLatLon(geo, { x_m: 0, y_m: geo.height * geo.cell_size_y_m });
  const southEast = localToLatLon(geo, { x_m: geo.width * geo.cell_size_x_m, y_m: 0 });
  expect(northWest.lat_deg).toBeCloseTo(box.lat_max, 7);
  expect(northWest.lon_east_deg).toBeCloseTo(box.lon_east_min, 7);
  expect(southEast.lat_deg).toBeCloseTo(box.lat_min, 7);
  expect(southEast.lon_east_deg).toBeCloseTo(box.lon_east_max, 7);
  const patch = globePatchGrid(geo, 1);
  expect(patch.uvs).toEqual([0, 1, 1, 1, 0, 0, 1, 0]);
  expect(patch.positions.slice(0, 3)).toEqual(localGlobePoint(geo, { x_m: 0, y_m: geo.height * geo.cell_size_y_m }));
  expect(patch.positions.slice(-3)).toEqual(localGlobePoint(geo, { x_m: geo.width * geo.cell_size_x_m, y_m: 0 }));
});

test("site fit zoom preserves local scale and widens for a narrow viewport", () => {
  const geo = manifest.georeference;
  expect(patchCameraAltitude(geo, 1, 38) * geo.radius_m).toBeGreaterThan(4000);
  expect(patchCameraAltitude(geo, 0.5, 38)).toBeGreaterThan(patchCameraAltitude(geo, 1, 38));
  expect(isInsideGlobePatch(geo, { x_m: -1, y_m: 100 })).toBe(false);
  expect(isInsideGlobePatch(geo, { x_m: 10, y_m: 100 })).toBe(true);
});

test("route points sit just above the same sphere as the imagery patch", () => {
  const geo = manifest.georeference;
  const p = { x_m: 1200, y_m: 500 };
  expect(Math.hypot(...localGlobePoint(geo, p))).toBeCloseTo(1, 12);
  expect((Math.hypot(...localGlobePoint(geo, p, ROUTE_LIFT_M)) - 1) * geo.radius_m).toBeCloseTo(ROUTE_LIFT_M, 7);
});
