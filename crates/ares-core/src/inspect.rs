//! "What is known about this spot?" — the map inspector's answer.

use crate::geo::{GridGeoreference, LatLon};
use crate::terrain::{PlanningGrid, Raster, TerrainClass};
use crate::LocalPoint;
use serde::{Deserialize, Serialize};

/// Values at one point. `None` means the data does not say — never zero.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct PointInspection {
    pub local: LocalPoint,
    pub latlon: LatLon,
    pub terrain: TerrainClass,
    /// Elevation interpolated between the source DTM's cells, metres.
    pub elevation_m: Option<f64>,
    /// Slope of the planning cell (derived by HYDE from the DTM), degrees.
    pub slope_deg: Option<f64>,
}

/// Inspect `p` against the source raster and the planning lattice.
pub fn inspect_point(
    georeference: &GridGeoreference,
    raster: &Raster,
    grid: &PlanningGrid,
    p: LocalPoint,
    max_slope_deg: f64,
) -> PointInspection {
    let (terrain, slope) = grid.classify(p, max_slope_deg);
    PointInspection {
        local: p,
        latlon: georeference.local_to_latlon(p),
        terrain,
        elevation_m: raster.sample_bilinear(p),
        slope_deg: slope.map(f64::from),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 8×8 raster of 1 m cells: a plane rising 0.5 m per metre northwards from −2600 m.
    fn fixture() -> (GridGeoreference, Raster, PlanningGrid) {
        let (w, h) = (8, 8);
        let mut data = Vec::new();
        for row in 0..h {
            for _ in 0..w {
                data.push(-2600.0 + 0.5 * ((h - 1 - row) as f32 + 0.5));
            }
        }
        let raster = Raster { width: w, height: h, dx_m: 1.0, dy_m: 1.0, data };
        let grid = PlanningGrid::build(&raster, 2);
        let radius_m = 1000.0 * 180.0 / std::f64::consts::PI; // 1° = 1000 m
        let geo = GridGeoreference {
            projection: "EQUIRECTANGULAR".into(),
            radius_m,
            center_latitude_deg: 0.0,
            center_longitude_deg: 77.0,
            map_scale_m_per_px: 1.0,
            roi_x_min_m: 0.0,
            roi_y_max_m: 8.0,
            width: w,
            height: h,
            cell_size_x_m: 1.0,
            cell_size_y_m: 1.0,
        };
        (geo, raster, grid)
    }

    #[test]
    fn reports_position_elevation_and_slope_of_a_known_point() {
        let (geo, raster, grid) = fixture();
        let i = inspect_point(&geo, &raster, &grid, LocalPoint::new(4.0, 4.0), 30.0);
        // Elevation is −2600 + 0.5·y on this plane.
        assert!((i.elevation_m.unwrap() - (-2598.0)).abs() < 1e-4, "{:?}", i.elevation_m);
        // Gradient 0.5 → 26.565°.
        assert!((i.slope_deg.unwrap() - 26.565).abs() < 1e-2, "{:?}", i.slope_deg);
        assert_eq!(i.terrain, TerrainClass::Traversable);
        // 4 m north of the south edge = 0.004° N; 4 m east of 77° E.
        assert!((i.latlon.lat_deg - 0.004).abs() < 1e-9 && (i.latlon.lon_east_deg - 77.004).abs() < 1e-9);
    }

    #[test]
    fn the_scenario_slope_limit_decides_the_class() {
        let (geo, raster, grid) = fixture();
        let i = inspect_point(&geo, &raster, &grid, LocalPoint::new(4.0, 4.0), 20.0);
        assert_eq!(i.terrain, TerrainClass::AboveSlopeLimit);
    }

    #[test]
    fn outside_the_raster_nothing_is_known_but_the_coordinates() {
        let (geo, raster, grid) = fixture();
        let i = inspect_point(&geo, &raster, &grid, LocalPoint::new(20.0, 4.0), 20.0);
        assert_eq!(i.terrain, TerrainClass::OutsideCoverage);
        assert_eq!((i.elevation_m, i.slope_deg), (None, None));
        assert!((i.latlon.lon_east_deg - 77.02).abs() < 1e-9);
    }

    #[test]
    fn elevation_is_reported_even_where_slope_is_unknown() {
        // The outer planning cells have no slope neighbourhood, but the DTM has values there.
        let (geo, raster, grid) = fixture();
        let i = inspect_point(&geo, &raster, &grid, LocalPoint::new(1.0, 1.0), 20.0);
        assert_eq!(i.terrain, TerrainClass::Unknown);
        assert_eq!(i.slope_deg, None);
        assert!((i.elevation_m.unwrap() - (-2599.5)).abs() < 1e-4);
    }
}
