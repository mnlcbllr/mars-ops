//! Georeferencing of the packaged grid.
//!
//! The grid keeps the source product's own pixels (no resampling), so its map
//! projection is the product's: PDS `EQUIRECTANGULAR` on a sphere whose radius
//! comes from the product label. Nothing here assumes Earth, WGS84 or a
//! terrestrial radius.

use crate::LocalPoint;
use serde::{Deserialize, Serialize};

/// Planetocentric latitude and positive-east longitude in the 0–360 domain.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct LatLon {
    pub lat_deg: f64,
    pub lon_east_deg: f64,
}

/// Where the packaged grid sits in the source product's projection.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct GridGeoreference {
    /// PDS `MAP_PROJECTION_TYPE`. Only `EQUIRECTANGULAR` is supported.
    pub projection: String,
    /// Sphere radius from the label (`A_AXIS_RADIUS`), metres.
    pub radius_m: f64,
    /// Latitude of true scale (`CENTER_LATITUDE`), degrees.
    pub center_latitude_deg: f64,
    /// `CENTER_LONGITUDE`, degrees east.
    pub center_longitude_deg: f64,
    /// Projected metres per pixel (`MAP_SCALE`); true on the ground only at the centre latitude.
    pub map_scale_m_per_px: f64,
    /// Projected easting of the grid's west edge, metres.
    pub roi_x_min_m: f64,
    /// Projected northing of the grid's north edge, metres.
    pub roi_y_max_m: f64,
    pub width: usize,
    pub height: usize,
    /// Ground size of one cell east–west at the region's latitude, metres.
    pub cell_size_x_m: f64,
    /// Ground size of one cell north–south, metres.
    pub cell_size_y_m: f64,
}

impl GridGeoreference {
    /// Latitude / longitude of a local point.
    pub fn local_to_latlon(&self, p: LocalPoint) -> LatLon {
        let col = p.x_m / self.cell_size_x_m;
        let row = self.height as f64 - p.y_m / self.cell_size_y_m;
        let x = self.roi_x_min_m + col * self.map_scale_m_per_px;
        let y = self.roi_y_max_m - row * self.map_scale_m_per_px;
        let lon = self.center_longitude_deg + (x / self.metres_per_radian_of_longitude()).to_degrees();
        LatLon {
            lat_deg: (y / self.radius_m).to_degrees(),
            lon_east_deg: lon.rem_euclid(360.0),
        }
    }

    /// Local point for a latitude / longitude (may lie outside the grid).
    pub fn latlon_to_local(&self, ll: LatLon) -> LocalPoint {
        // Signed longitude difference from the projection centre, wrapped to ±180°.
        let dlon = (ll.lon_east_deg - self.center_longitude_deg + 180.0).rem_euclid(360.0) - 180.0;
        let x = dlon.to_radians() * self.metres_per_radian_of_longitude();
        let y = ll.lat_deg.to_radians() * self.radius_m;
        let col = (x - self.roi_x_min_m) / self.map_scale_m_per_px;
        let row = (self.roi_y_max_m - y) / self.map_scale_m_per_px;
        LocalPoint {
            x_m: col * self.cell_size_x_m,
            y_m: (self.height as f64 - row) * self.cell_size_y_m,
        }
    }

    /// East–west ground size of a cell implied by the projection at the grid's
    /// centre latitude. Used to check the manifest's `cell_size_x_m`.
    pub fn implied_cell_size_x_m(&self) -> f64 {
        let y_centre = self.roi_y_max_m - 0.5 * self.height as f64 * self.map_scale_m_per_px;
        let lat = y_centre / self.radius_m;
        self.map_scale_m_per_px * lat.cos() / self.center_latitude_deg.to_radians().cos()
    }

    fn metres_per_radian_of_longitude(&self) -> f64 {
        self.radius_m * self.center_latitude_deg.to_radians().cos()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 100 × 50 cell grid whose north-west corner is the projection origin
    /// shifted to 10° N; equator-true scale, radius chosen so 1° = 1000 m.
    fn georef() -> GridGeoreference {
        let radius_m = 1000.0 * 180.0 / std::f64::consts::PI;
        GridGeoreference {
            projection: "EQUIRECTANGULAR".into(),
            radius_m,
            center_latitude_deg: 0.0,
            center_longitude_deg: 77.0,
            map_scale_m_per_px: 10.0,
            roi_x_min_m: 0.0,
            roi_y_max_m: 10_000.0,
            width: 100,
            height: 50,
            cell_size_x_m: 10.0 * (9.75f64).to_radians().cos(),
            cell_size_y_m: 10.0,
        }
    }

    #[test]
    fn north_west_corner_maps_to_projection_coordinates() {
        let g = georef();
        // Local origin is the south-west corner; the grid is 50 cells (500 m) tall.
        let ll = g.local_to_latlon(LocalPoint::new(0.0, 500.0));
        assert!((ll.lat_deg - 10.0).abs() < 1e-9, "lat {}", ll.lat_deg);
        assert!((ll.lon_east_deg - 77.0).abs() < 1e-9, "lon {}", ll.lon_east_deg);
    }

    #[test]
    fn south_east_corner_is_half_a_degree_south_and_one_degree_east() {
        let g = georef();
        // 100 cells east = 1000 projected metres = 1° of longitude at true scale;
        // 50 cells south = 500 m = 0.5° of latitude.
        let ll = g.local_to_latlon(LocalPoint::new(100.0 * g.cell_size_x_m, 0.0));
        assert!((ll.lat_deg - 9.5).abs() < 1e-9, "lat {}", ll.lat_deg);
        assert!((ll.lon_east_deg - 78.0).abs() < 1e-9, "lon {}", ll.lon_east_deg);
    }

    #[test]
    fn longitude_wraps_into_0_360_domain() {
        let mut g = georef();
        g.center_longitude_deg = 359.5;
        let ll = g.local_to_latlon(LocalPoint::new(100.0 * g.cell_size_x_m, 0.0));
        assert!((ll.lon_east_deg - 0.5).abs() < 1e-9, "lon {}", ll.lon_east_deg);
    }

    #[test]
    fn latlon_to_local_inverts_local_to_latlon() {
        let g = georef();
        let p = g.latlon_to_local(LatLon { lat_deg: 9.5, lon_east_deg: 78.0 });
        assert!((p.x_m - 100.0 * g.cell_size_x_m).abs() < 1e-6, "x {}", p.x_m);
        assert!(p.y_m.abs() < 1e-6, "y {}", p.y_m);
    }

    #[test]
    fn implied_cell_width_shrinks_with_cosine_of_latitude() {
        // Grid centre latitude is 9.75° N; true scale at the equator.
        let g = georef();
        let want = 10.0 * (9.75f64).to_radians().cos();
        assert!((g.implied_cell_size_x_m() - want).abs() < 1e-9);
    }
}
