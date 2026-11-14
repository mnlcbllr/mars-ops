import type { BBoxDeg, GridGeoreference, LatLon, LocalPoint } from "./types";

/** North-up equirectangular texture, west edge −180°, matching Three's SphereGeometry UVs. */
export function globePoint(lat: number, lonEast: number, radius = 1): [number, number, number] {
  const latitude = lat * Math.PI / 180;
  const phi = (lonEast + 180) * Math.PI / 180;
  const horizontal = radius * Math.cos(latitude);
  return [-horizontal * Math.cos(phi), radius * Math.sin(latitude), horizontal * Math.sin(phi)];
}

export function regionCenter(bbox: BBoxDeg) {
  const span = (bbox.lon_east_max - bbox.lon_east_min + 360) % 360;
  return {
    lat_deg: (bbox.lat_min + bbox.lat_max) / 2,
    lon_east_deg: (bbox.lon_east_min + span / 2 + 360) % 360,
  };
}

const DEG = Math.PI / 180;
export const PATCH_RADIUS = 1;
export const ROUTE_LIFT_M = 8;

export function localToLatLon(geo: GridGeoreference, p: LocalPoint): LatLon {
  const col = p.x_m / geo.cell_size_x_m;
  const row = geo.height - p.y_m / geo.cell_size_y_m;
  const x = geo.roi_x_min_m + col * geo.map_scale_m_per_px;
  const y = geo.roi_y_max_m - row * geo.map_scale_m_per_px;
  const lon = geo.center_longitude_deg + x / (geo.radius_m * Math.cos(geo.center_latitude_deg * DEG)) / DEG;
  return { lat_deg: y / geo.radius_m / DEG, lon_east_deg: ((lon % 360) + 360) % 360 };
}

export function localGlobePoint(geo: GridGeoreference, p: LocalPoint, liftM = 0) {
  const { lat_deg, lon_east_deg } = localToLatLon(geo, p);
  return globePoint(lat_deg, lon_east_deg, PATCH_RADIUS + liftM / geo.radius_m);
}

export function isInsideGlobePatch(geo: GridGeoreference, p: LocalPoint): boolean {
  return p.x_m >= 0 && p.y_m >= 0 && p.x_m <= geo.width * geo.cell_size_x_m
    && p.y_m <= geo.height * geo.cell_size_y_m;
}

/** Orbit altitude to frame the georeferenced crop, in planet radii. */
export function patchCameraAltitude(geo: GridGeoreference, aspect: number, verticalFov: number): number {
  const halfW = geo.width * geo.cell_size_x_m / 2;
  const halfH = geo.height * geo.cell_size_y_m / 2;
  return Math.max(halfH, halfW / Math.max(aspect, 0.1)) * 1.55 / Math.tan(verticalFov * DEG / 2) / geo.radius_m;
}

/** Local raster footprint bent onto the same globe as the global atlas. */
export function globePatchGrid(geo: GridGeoreference, divisions = 12) {
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const stride = divisions + 1;
  for (let row = 0; row <= divisions; row++) {
    const v = 1 - row / divisions;
    for (let col = 0; col <= divisions; col++) {
      const u = col / divisions;
      positions.push(...localGlobePoint(geo, {
        x_m: u * geo.width * geo.cell_size_x_m,
        y_m: v * geo.height * geo.cell_size_y_m,
      }));
      uvs.push(u, v);
      if (col < divisions && row < divisions) {
        const i = row * stride + col;
        indices.push(i, i + stride, i + 1, i + 1, i + stride, i + stride + 1);
      }
    }
  }
  return { positions, uvs, indices };
}
