//! Elevation raster, the coarser planning lattice derived from it, and slope.
//!
//! Row 0 is the northern edge. A cell `(col, row)` has its centre at
//! `x = (col + 0.5)·dx`, `y = (height − row − 0.5)·dy` in local metres.
//! Missing elevation is `NaN` and is never treated as zero or as "safe".

use crate::LocalPoint;

/// Elevation samples on the source product's own pixel grid.
#[derive(Clone, Debug)]
pub struct Raster {
    pub width: usize,
    pub height: usize,
    /// Ground size of a cell east–west, metres.
    pub dx_m: f64,
    /// Ground size of a cell north–south, metres.
    pub dy_m: f64,
    /// Row-major, north to south. `NaN` = no data.
    pub data: Vec<f32>,
}

/// Why a raster could not be built from bytes.
#[derive(Debug, PartialEq, thiserror::Error)]
pub enum RasterError {
    #[error("raster has {actual} bytes but {width}×{height} 32-bit cells need {expected}")]
    SizeMismatch {
        width: usize,
        height: usize,
        expected: usize,
        actual: usize,
    },
    #[error("cell size must be positive and finite (got {dx_m} × {dy_m} m)")]
    BadCellSize { dx_m: f64, dy_m: f64 },
}

impl Raster {
    /// Decode little-endian `f32` cells; cells equal to `nodata` become `NaN`.
    pub fn from_f32le_bytes(
        bytes: &[u8],
        width: usize,
        height: usize,
        dx_m: f64,
        dy_m: f64,
        nodata: f32,
    ) -> Result<Raster, RasterError> {
        if !(dx_m.is_finite() && dy_m.is_finite() && dx_m > 0.0 && dy_m > 0.0) {
            return Err(RasterError::BadCellSize { dx_m, dy_m });
        }
        let expected = width * height * 4;
        if bytes.len() != expected {
            return Err(RasterError::SizeMismatch { width, height, expected, actual: bytes.len() });
        }
        let data = bytes
            .chunks_exact(4)
            .map(|b| {
                let v = f32::from_le_bytes([b[0], b[1], b[2], b[3]]);
                if v == nodata || !v.is_finite() {
                    f32::NAN
                } else {
                    v
                }
            })
            .collect();
        Ok(Raster { width, height, dx_m, dy_m, data })
    }

    /// `(col, row)` of the cell containing `p`, or `None` outside the raster.
    pub fn cell_of(&self, p: LocalPoint) -> Option<(usize, usize)> {
        cell_of(p, self.width, self.height, self.dx_m, self.dy_m)
    }

    /// Centre of cell `(col, row)` in local metres.
    pub fn cell_center(&self, col: usize, row: usize) -> LocalPoint {
        cell_center(col, row, self.height, self.dx_m, self.dy_m)
    }

    /// Value of the cell containing `p`; `None` outside the raster or on no-data.
    pub fn sample_nearest(&self, p: LocalPoint) -> Option<f32> {
        let (col, row) = self.cell_of(p)?;
        let v = self.data[row * self.width + col];
        (!v.is_nan()).then_some(v)
    }

    /// Bilinear interpolation between the four surrounding cell centres.
    /// `None` if any of the four is missing or outside the raster.
    pub fn sample_bilinear(&self, p: LocalPoint) -> Option<f64> {
        self.cell_of(p)?;
        // Position in units of cells, measured between cell centres; points in
        // the outer half-cell are held at the nearest centre along that axis.
        let cf = (p.x_m / self.dx_m - 0.5).clamp(0.0, (self.width - 1) as f64);
        let rf = (self.height as f64 - p.y_m / self.dy_m - 0.5).clamp(0.0, (self.height - 1) as f64);
        let (c0, r0) = (cf.floor() as usize, rf.floor() as usize);
        let (c1, r1) = ((c0 + 1).min(self.width - 1), (r0 + 1).min(self.height - 1));
        let (tc, tr) = (cf - c0 as f64, rf - r0 as f64);
        let corners = [
            (c0, r0, (1.0 - tc) * (1.0 - tr)),
            (c1, r0, tc * (1.0 - tr)),
            (c0, r1, (1.0 - tc) * tr),
            (c1, r1, tc * tr),
        ];
        let mut sum = 0.0;
        for (col, row, weight) in corners {
            if weight == 0.0 {
                continue;
            }
            let v = self.data[row * self.width + col];
            if v.is_nan() {
                return None;
            }
            sum += weight * v as f64;
        }
        Some(sum)
    }

    /// Minimum and maximum of the valid cells, or `None` if there are none.
    pub fn min_max(&self) -> Option<(f32, f32)> {
        self.data.iter().filter(|v| !v.is_nan()).fold(None, |acc, &v| match acc {
            None => Some((v, v)),
            Some((lo, hi)) => Some((lo.min(v), hi.max(v))),
        })
    }
}

/// The lattice routes are planned on: blocks of `factor × factor` raster cells.
///
/// A planning cell is *unknown* (`NaN`) if any raster cell inside it has no
/// data — partial coverage is not enough to call terrain known.
#[derive(Clone, Debug)]
pub struct PlanningGrid {
    pub width: usize,
    pub height: usize,
    pub cell_x_m: f64,
    pub cell_y_m: f64,
    /// Raster cells per planning cell along each axis.
    pub factor: usize,
    /// Mean elevation of the block, metres. `NaN` = unknown.
    pub elevation_m: Vec<f32>,
    /// Slope magnitude (Horn 3×3) in degrees. `NaN` = unknown, which includes
    /// cells without a complete 3×3 neighbourhood (grid edge, next to no-data).
    pub slope_deg: Vec<f32>,
}

impl PlanningGrid {
    /// Aggregate `raster` by `factor` and compute slope on the result.
    /// Columns / rows that do not fill a whole block are left out.
    pub fn build(raster: &Raster, factor: usize) -> PlanningGrid {
        let factor = factor.max(1);
        let (width, height) = (raster.width / factor, raster.height / factor);
        let (cell_x_m, cell_y_m) = (raster.dx_m * factor as f64, raster.dy_m * factor as f64);

        let mut elevation_m = vec![f32::NAN; width * height];
        for row in 0..height {
            for col in 0..width {
                let mut sum = 0.0f64;
                let mut complete = true;
                'block: for r in row * factor..(row + 1) * factor {
                    for c in col * factor..(col + 1) * factor {
                        let v = raster.data[r * raster.width + c];
                        if v.is_nan() {
                            complete = false;
                            break 'block;
                        }
                        sum += v as f64;
                    }
                }
                if complete {
                    elevation_m[row * width + col] = (sum / (factor * factor) as f64) as f32;
                }
            }
        }

        // Horn (1981) 3×3 gradient. Rows run north to south.
        let mut slope_deg = vec![f32::NAN; width * height];
        if width >= 3 && height >= 3 {
            for row in 1..height - 1 {
                for col in 1..width - 1 {
                    let z = |dc: isize, dr: isize| {
                        let c = (col as isize + dc) as usize;
                        let r = (row as isize + dr) as usize;
                        elevation_m[r * width + c] as f64
                    };
                    let (nw, n, ne) = (z(-1, -1), z(0, -1), z(1, -1));
                    let (w, centre, e) = (z(-1, 0), z(0, 0), z(1, 0));
                    let (sw, s, se) = (z(-1, 1), z(0, 1), z(1, 1));
                    if [nw, n, ne, w, centre, e, sw, s, se].iter().any(|v| v.is_nan()) {
                        continue;
                    }
                    let dz_dx = ((ne + 2.0 * e + se) - (nw + 2.0 * w + sw)) / (8.0 * cell_x_m);
                    let dz_dy = ((nw + 2.0 * n + ne) - (sw + 2.0 * s + se)) / (8.0 * cell_y_m);
                    slope_deg[row * width + col] = dz_dx.hypot(dz_dy).atan().to_degrees() as f32;
                }
            }
        }

        PlanningGrid { width, height, cell_x_m, cell_y_m, factor, elevation_m, slope_deg }
    }

    pub fn index(&self, col: usize, row: usize) -> usize {
        row * self.width + col
    }

    /// `(col, row)` of the planning cell containing `p`, or `None` outside.
    pub fn cell_of(&self, p: LocalPoint) -> Option<(usize, usize)> {
        cell_of(p, self.width, self.height, self.cell_x_m, self.cell_y_m)
    }

    /// Centre of planning cell `(col, row)` in local metres.
    pub fn cell_center(&self, col: usize, row: usize) -> LocalPoint {
        cell_center(col, row, self.height, self.cell_x_m, self.cell_y_m)
    }
}

fn cell_of(p: LocalPoint, width: usize, height: usize, dx: f64, dy: f64) -> Option<(usize, usize)> {
    let (extent_x, extent_y) = (width as f64 * dx, height as f64 * dy);
    if !(p.x_m >= 0.0 && p.x_m < extent_x && p.y_m >= 0.0 && p.y_m < extent_y) {
        return None;
    }
    let col = ((p.x_m / dx) as usize).min(width - 1);
    let row_from_south = ((p.y_m / dy) as usize).min(height - 1);
    Some((col, height - 1 - row_from_south))
}

fn cell_center(col: usize, row: usize, height: usize, dx: f64, dy: f64) -> LocalPoint {
    LocalPoint::new((col as f64 + 0.5) * dx, (height as f64 - row as f64 - 0.5) * dy)
}

#[cfg(test)]
mod tests {
    use super::*;

    const NODATA: f32 = -3.402_822_6e38;

    fn bytes(values: &[f32]) -> Vec<u8> {
        values.iter().flat_map(|v| v.to_le_bytes()).collect()
    }

    /// 3 wide × 2 tall, 2 m × 1 m cells:
    /// north row: 10 20 30
    /// south row: 40 50 (no data)
    fn small() -> Raster {
        Raster::from_f32le_bytes(
            &bytes(&[10.0, 20.0, 30.0, 40.0, 50.0, NODATA]),
            3,
            2,
            2.0,
            1.0,
            NODATA,
        )
        .unwrap()
    }

    #[test]
    fn nodata_cells_become_nan_and_others_keep_exact_values() {
        let r = small();
        assert_eq!(&r.data[..5], &[10.0, 20.0, 30.0, 40.0, 50.0]);
        assert!(r.data[5].is_nan());
    }

    #[test]
    fn byte_count_must_match_dimensions() {
        let err = Raster::from_f32le_bytes(&[0u8; 20], 3, 2, 1.0, 1.0, NODATA).unwrap_err();
        assert_eq!(
            err,
            RasterError::SizeMismatch { width: 3, height: 2, expected: 24, actual: 20 }
        );
    }

    #[test]
    fn non_positive_cell_size_is_rejected() {
        let err = Raster::from_f32le_bytes(&[0u8; 24], 3, 2, 0.0, 1.0, NODATA).unwrap_err();
        assert_eq!(err, RasterError::BadCellSize { dx_m: 0.0, dy_m: 1.0 });
    }

    #[test]
    fn local_origin_is_south_west_and_row_zero_is_north() {
        let r = small();
        // South-west cell (col 0, row 1) holds 40; north-east (col 2, row 0) holds 30.
        assert_eq!(r.sample_nearest(LocalPoint::new(0.5, 0.2)), Some(40.0));
        assert_eq!(r.sample_nearest(LocalPoint::new(5.9, 1.9)), Some(30.0));
        assert_eq!(r.cell_of(LocalPoint::new(5.9, 1.9)), Some((2, 0)));
        assert_eq!(r.cell_center(2, 0), LocalPoint::new(5.0, 1.5));
    }

    #[test]
    fn points_outside_the_raster_have_no_cell() {
        let r = small();
        assert_eq!(r.cell_of(LocalPoint::new(-0.1, 0.5)), None);
        assert_eq!(r.cell_of(LocalPoint::new(6.0, 0.5)), None);
        assert_eq!(r.cell_of(LocalPoint::new(1.0, 2.0)), None);
        assert_eq!(r.sample_nearest(LocalPoint::new(1.0, -0.01)), None);
    }

    #[test]
    fn nodata_cell_samples_as_none_not_zero() {
        let r = small();
        assert_eq!(r.sample_nearest(LocalPoint::new(5.0, 0.5)), None);
    }

    #[test]
    fn bilinear_interpolates_between_cell_centres() {
        let r = small();
        // Midway between the centres of the four western cells (10, 20, 40, 50).
        let v = r.sample_bilinear(LocalPoint::new(2.0, 1.0)).unwrap();
        assert!((v - 30.0).abs() < 1e-9, "{v}");
        // Exactly on a cell centre returns that cell.
        let v = r.sample_bilinear(LocalPoint::new(3.0, 1.5)).unwrap();
        assert!((v - 20.0).abs() < 1e-9, "{v}");
    }

    #[test]
    fn bilinear_refuses_to_interpolate_across_nodata() {
        let r = small();
        // Surrounded by 20, 30, 50 and the missing cell.
        assert_eq!(r.sample_bilinear(LocalPoint::new(4.0, 1.0)), None);
    }

    #[test]
    fn min_max_ignores_nodata() {
        assert_eq!(small().min_max(), Some((10.0, 50.0)));
    }

    /// `w × h` raster of 1 m cells with elevation given by `f(col, row)`.
    fn raster_from(w: usize, h: usize, dx: f64, dy: f64, f: impl Fn(usize, usize) -> f32) -> Raster {
        let mut data = Vec::with_capacity(w * h);
        for row in 0..h {
            for col in 0..w {
                data.push(f(col, row));
            }
        }
        Raster { width: w, height: h, dx_m: dx, dy_m: dy, data }
    }

    #[test]
    fn planning_cell_is_mean_of_its_block() {
        // 4×4 raster, factor 2. North-west block holds 1, 2, 3, 6 → mean 3.
        let r = raster_from(4, 4, 1.0, 1.0, |c, row| match (c, row) {
            (0, 0) => 1.0,
            (1, 0) => 2.0,
            (0, 1) => 3.0,
            (1, 1) => 6.0,
            _ => 100.0,
        });
        let g = PlanningGrid::build(&r, 2);
        assert_eq!((g.width, g.height), (2, 2));
        assert_eq!((g.cell_x_m, g.cell_y_m), (2.0, 2.0));
        assert_eq!(g.elevation_m[g.index(0, 0)], 3.0);
        assert_eq!(g.elevation_m[g.index(1, 1)], 100.0);
    }

    #[test]
    fn one_missing_raster_cell_makes_the_whole_planning_cell_unknown() {
        let r = raster_from(4, 4, 1.0, 1.0, |c, row| if (c, row) == (3, 2) { f32::NAN } else { 5.0 });
        let g = PlanningGrid::build(&r, 2);
        assert!(g.elevation_m[g.index(1, 1)].is_nan());
        assert_eq!(g.elevation_m[g.index(0, 1)], 5.0);
    }

    #[test]
    fn partial_blocks_at_the_edge_are_left_out() {
        let r = raster_from(5, 7, 1.0, 1.0, |_, _| 0.0);
        let g = PlanningGrid::build(&r, 2);
        assert_eq!((g.width, g.height), (2, 3));
    }

    #[test]
    fn slope_of_a_plane_rising_east_matches_its_gradient() {
        // z = 0.1·x with 2 m (east–west) × 5 m cells: slope = atan(0.1) = 5.7106°
        // regardless of the anisotropic cell shape.
        let r = raster_from(5, 5, 2.0, 5.0, |c, _| 0.1 * (c as f32 * 2.0));
        let g = PlanningGrid::build(&r, 1);
        let s = g.slope_deg[g.index(2, 2)];
        assert!((s - 5.7106).abs() < 1e-3, "{s}");
    }

    #[test]
    fn slope_of_a_plane_rising_north_uses_the_north_south_cell_size() {
        // Row 0 is north. z rises 1 m per row northwards over 5 m cells:
        // gradient 0.2 → 11.3099°.
        let r = raster_from(5, 5, 2.0, 5.0, |_, row| (4 - row) as f32);
        let g = PlanningGrid::build(&r, 1);
        let s = g.slope_deg[g.index(2, 2)];
        assert!((s - 11.3099).abs() < 1e-3, "{s}");
    }

    #[test]
    fn flat_terrain_has_zero_slope() {
        let r = raster_from(4, 4, 1.0, 1.0, |_, _| -2500.0);
        let g = PlanningGrid::build(&r, 1);
        assert_eq!(g.slope_deg[g.index(1, 1)], 0.0);
    }

    #[test]
    fn slope_is_unknown_without_a_complete_neighbourhood() {
        // Flat 5×5 with one missing cell in the centre.
        let r = raster_from(5, 5, 1.0, 1.0, |c, row| if (c, row) == (2, 2) { f32::NAN } else { 0.0 });
        let g = PlanningGrid::build(&r, 1);
        // Grid edge: no 3×3 neighbourhood.
        assert!(g.slope_deg[g.index(0, 0)].is_nan());
        assert!(g.slope_deg[g.index(4, 2)].is_nan());
        // The missing cell and every cell touching it.
        assert!(g.slope_deg[g.index(2, 2)].is_nan());
        assert!(g.slope_deg[g.index(1, 1)].is_nan());
        assert!(g.slope_deg[g.index(3, 3)].is_nan());
    }

    #[test]
    fn planning_cells_use_the_same_local_frame_as_the_raster() {
        let r = raster_from(8, 4, 1.0, 1.0, |_, _| 0.0);
        let g = PlanningGrid::build(&r, 2);
        // 4×2 planning cells of 2 m; north-east cell (3, 0) is centred at (7, 3).
        assert_eq!(g.cell_center(3, 0), LocalPoint::new(7.0, 3.0));
        assert_eq!(g.cell_of(LocalPoint::new(7.9, 3.9)), Some((3, 0)));
        assert_eq!(g.cell_of(LocalPoint::new(8.0, 1.0)), None);
    }
}
