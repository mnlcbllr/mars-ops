//! One opened dataset together with its planning lattice: the surface that
//! both the desktop shell and the CLI drive. Nothing here knows about Tauri.

use crate::data::{DataError, Dataset, LayerKind, Manifest};
use crate::inspect::{inspect_point, PointInspection};
use crate::planning::{plan_greedy, validate_scenario, MissionScenario, ValidationReport};
use crate::report::{MissionReport, CODE_REVISION};
use crate::terrain::{PlanningGrid, PLANNING_FACTOR};
use crate::LocalPoint;
use serde::{Deserialize, Serialize};
use std::path::Path;

/// A layer the map can draw, as raw bytes.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DisplayLayer {
    /// The imagery file exactly as packaged (PNG).
    Imagery,
    /// Source-resolution elevation: `f32` little-endian metres, row 0 = north,
    /// `NaN` = no data.
    Elevation,
    /// Planning-cell slope: `f32` little-endian degrees, row 0 = north,
    /// `NaN` = unknown.
    Slope,
    InfraredContext,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct PlanningGridInfo {
    pub width: usize,
    pub height: usize,
    pub cell_x_m: f64,
    pub cell_y_m: f64,
    pub raster_cells_per_planning_cell: usize,
    /// Planning cells with no usable elevation or slope.
    pub unknown_cells: usize,
}

/// What the app shows about an opened dataset.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct DatasetInfo {
    pub manifest: Manifest,
    pub manifest_sha256: String,
    pub real_data_verified: bool,
    /// `None` when the raster has no valid cell at all.
    pub elevation_min_m: Option<f32>,
    pub elevation_max_m: Option<f32>,
    pub nodata_cells: usize,
    pub planning_grid: PlanningGridInfo,
    pub software_version: String,
    pub code_revision: String,
}

#[derive(Debug, thiserror::Error)]
pub enum SessionError {
    #[error(transparent)]
    Data(#[from] DataError),
    #[error("ScenarioDatasetMismatch: the scenario is for dataset '{scenario}' but '{opened}' is open")]
    ScenarioDatasetMismatch { scenario: String, opened: String },
}

/// An opened, checksum-verified dataset and the lattice routes are planned on.
#[derive(Clone, Debug)]
pub struct Session {
    pub dataset: Dataset,
    pub grid: PlanningGrid,
}

impl Session {
    /// Open and verify the dataset in `dir`, then derive its planning lattice.
    pub fn open(dir: &Path) -> Result<Session, DataError> {
        let dataset = Dataset::open(dir)?;
        let grid = PlanningGrid::build(&dataset.elevation, PLANNING_FACTOR);
        Ok(Session { dataset, grid })
    }

    pub fn info(&self) -> DatasetInfo {
        let elevation = &self.dataset.elevation;
        let range = elevation.min_max();
        DatasetInfo {
            manifest: self.dataset.manifest.clone(),
            manifest_sha256: self.dataset.manifest_sha256.clone(),
            real_data_verified: self.dataset.is_real_data_verified(),
            elevation_min_m: range.map(|(lo, _)| lo),
            elevation_max_m: range.map(|(_, hi)| hi),
            nodata_cells: elevation.data.iter().filter(|v| v.is_nan()).count(),
            planning_grid: PlanningGridInfo {
                width: self.grid.width,
                height: self.grid.height,
                cell_x_m: self.grid.cell_x_m,
                cell_y_m: self.grid.cell_y_m,
                raster_cells_per_planning_cell: self.grid.factor,
                unknown_cells: self.known_slope().filter(|v| v.is_nan()).count(),
            },
            software_version: env!("CARGO_PKG_VERSION").into(),
            code_revision: CODE_REVISION.into(),
        }
    }

    /// Slope of every planning cell, `NaN` where elevation or slope is unknown.
    fn known_slope(&self) -> impl Iterator<Item = f32> + '_ {
        let cells = self.grid.slope_deg.iter().zip(&self.grid.elevation_m);
        cells.map(|(&slope, &elevation)| if elevation.is_nan() { f32::NAN } else { slope })
    }

    /// Raw bytes of a display layer (see [`DisplayLayer`] for each encoding).
    pub fn layer_bytes(&self, layer: DisplayLayer) -> Result<Vec<u8>, DataError> {
        fn f32_le(values: impl Iterator<Item = f32>) -> Vec<u8> {
            values.flat_map(f32::to_le_bytes).collect()
        }
        Ok(match layer {
            DisplayLayer::Imagery => self.dataset.read_layer_verified(LayerKind::Imagery)?,
            DisplayLayer::InfraredContext => self.dataset.read_layer_verified(LayerKind::InfraredContext)?,
            DisplayLayer::Elevation => f32_le(self.dataset.elevation.data.iter().copied()),
            DisplayLayer::Slope => f32_le(self.known_slope()),
        })
    }

    /// What the data says at `p`, judged against `max_slope_deg`.
    pub fn inspect(&self, p: LocalPoint, max_slope_deg: f64) -> PointInspection {
        let georeference = &self.dataset.manifest.georeference;
        inspect_point(georeference, &self.dataset.elevation, &self.grid, p, max_slope_deg)
    }

    fn check_dataset(&self, scenario: &MissionScenario) -> Result<(), SessionError> {
        let opened = &self.dataset.manifest.dataset_id;
        if &scenario.dataset_id != opened {
            return Err(SessionError::ScenarioDatasetMismatch {
                scenario: scenario.dataset_id.clone(),
                opened: opened.clone(),
            });
        }
        Ok(())
    }

    pub fn validate(&self, scenario: &MissionScenario) -> Result<ValidationReport, SessionError> {
        self.check_dataset(scenario)?;
        Ok(validate_scenario(&self.grid, scenario))
    }

    /// Plan `scenario` with the deterministic baseline and bind the result to
    /// this dataset's hashes in a report.
    pub fn solve(&self, scenario: MissionScenario) -> Result<MissionReport, SessionError> {
        self.check_dataset(&scenario)?;
        let result = plan_greedy(&self.grid, &scenario);
        Ok(MissionReport::new(&self.dataset, &self.grid, scenario, result))
    }

    pub fn solve_exact(&self, scenario: MissionScenario) -> Result<MissionReport, SessionError> {
        self.check_dataset(&scenario)?;
        let result = crate::planning::plan_exact_small(&self.grid, &scenario);
        Ok(MissionReport::new(&self.dataset, &self.grid, scenario, result))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::data::test_support::{f32_bytes, layer, temp_dir, write_raster_dataset, NODATA};
    use crate::data::sha256_hex;
    use crate::planning::{PlanStatus, ScientificSite};
    use crate::provenance::EvidenceKind;
    use crate::resources::test_support::{bare_model, time_only};
    use crate::terrain::TerrainClass;
    use std::fs;

    const SIDE: usize = 32;
    /// Raster cell (13, 13) is missing; it lies in planning cell (3, 3).
    const MISSING: usize = 13 * SIDE + 13;

    /// 32 × 32 cells of 1 m, flat at −2600 m, one cell missing.
    fn raster_values() -> Vec<f32> {
        let mut values = vec![-2600.0f32; SIDE * SIDE];
        values[MISSING] = NODATA;
        values
    }

    fn open(tag: &str) -> Session {
        let dir = temp_dir(tag);
        write_raster_dataset(&dir, SIDE, SIDE, &raster_values(), true, |_| {});
        Session::open(&dir).unwrap()
    }

    fn f32s(bytes: &[u8]) -> Vec<f32> {
        bytes.chunks_exact(4).map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]])).collect()
    }

    /// Base at planning cell (1, 6), one site 20 m east at (6, 6), 100 s of work.
    fn scenario(session: &Session, dataset_id: &str) -> MissionScenario {
        MissionScenario {
            schema_version: 1,
            name: "fixture".into(),
            dataset_id: dataset_id.into(),
            base: session.grid.cell_center(1, 6),
            sites: vec![ScientificSite {
                id: "A".into(),
                name: "A".into(),
                position: session.grid.cell_center(6, 6),
                science_rationale: "test fixture".into(),
                source_product_ids: vec![],
                evidence_kind: EvidenceKind::Synthetic,
                activity_min_s: 100.0,
                activity_max_s: 100.0,
                activity_power_w: 0.0,
                preference_weight: 1.0,
            }],
            budget: time_only(1000.0, 100.0),
            model: bare_model(),
        }
    }

    #[test]
    fn info_reports_exact_raster_and_lattice_statistics() {
        let info = open("info").info();
        assert_eq!(info.manifest.dataset_id, "tiny");
        assert_eq!(info.manifest_sha256.len(), 64);
        assert!(info.real_data_verified);
        assert_eq!((info.elevation_min_m, info.elevation_max_m), (Some(-2600.0), Some(-2600.0)));
        assert_eq!(info.nodata_cells, 1);
        // 8 × 8 planning cells of 4 m. Unknown: the 28-cell outer ring (no full
        // 3 × 3 neighbourhood), cell (3, 3) holding the missing raster cell,
        // and its 8 neighbours, whose slope would need that cell: 28 + 1 + 8.
        assert_eq!(
            info.planning_grid,
            PlanningGridInfo {
                width: 8,
                height: 8,
                cell_x_m: 4.0,
                cell_y_m: 4.0,
                raster_cells_per_planning_cell: 4,
                unknown_cells: 37,
            }
        );
        assert_eq!(info.software_version, env!("CARGO_PKG_VERSION"));
    }

    #[test]
    fn elevation_layer_is_the_raster_with_nan_for_missing_cells() {
        let values = f32s(&open("elev").layer_bytes(DisplayLayer::Elevation).unwrap());
        assert_eq!(values.len(), SIDE * SIDE);
        for (i, v) in values.iter().enumerate() {
            if i == MISSING {
                assert!(v.is_nan());
            } else {
                assert_eq!(*v, -2600.0, "cell {i}");
            }
        }
    }

    #[test]
    fn slope_layer_is_nan_exactly_where_the_lattice_is_unknown() {
        let slope = f32s(&open("slope").layer_bytes(DisplayLayer::Slope).unwrap());
        assert_eq!(slope.len(), 8 * 8);
        for row in 0..8 {
            for col in 0..8 {
                let ring = row == 0 || row == 7 || col == 0 || col == 7;
                let near_missing = (2..=4).contains(&row) && (2..=4).contains(&col);
                let v = slope[row * 8 + col];
                if ring || near_missing {
                    assert!(v.is_nan(), "cell ({col}, {row}) should be unknown");
                } else {
                    assert_eq!(v, 0.0, "cell ({col}, {row}) is flat");
                }
            }
        }
    }

    #[test]
    fn imagery_layer_is_the_packaged_file_or_missing_layer() {
        let without = open("noimg");
        assert!(matches!(without.layer_bytes(DisplayLayer::Imagery), Err(DataError::MissingLayer(_))));

        let png = b"stand-in imagery bytes".to_vec();
        let dir = temp_dir("img");
        fs::write(dir.join("ortho.png"), &png).unwrap();
        write_raster_dataset(&dir, SIDE, SIDE, &raster_values(), true, |m| {
            m.layers.push(layer(LayerKind::Imagery, "ortho.png", &sha256_hex(&png), true));
        });
        assert_eq!(Session::open(&dir).unwrap().layer_bytes(DisplayLayer::Imagery).unwrap(), png);
    }

    #[test]
    fn inspect_reads_the_opened_raster_and_lattice() {
        let session = open("inspect");
        let known = session.inspect(session.grid.cell_center(6, 6), 20.0);
        assert_eq!(known.terrain, TerrainClass::Traversable);
        assert_eq!((known.elevation_m, known.slope_deg), (Some(-2600.0), Some(0.0)));

        let unknown = session.inspect(session.grid.cell_center(3, 3), 20.0);
        assert_eq!(unknown.terrain, TerrainClass::Unknown);
        assert_eq!(unknown.slope_deg, None);

        let outside = session.inspect(LocalPoint::new(-1.0, 5.0), 20.0);
        assert_eq!(outside.terrain, TerrainClass::OutsideCoverage);
    }

    #[test]
    fn solve_binds_the_result_to_the_dataset_and_the_scenario() {
        let session = open("solve");
        let scenario = scenario(&session, "tiny");
        assert!(session.validate(&scenario).unwrap().ok);

        let report = session.solve(scenario.clone()).unwrap();
        assert_eq!(report.software, "HYDE");
        assert_eq!(report.report_schema_version, 1);
        assert_eq!(report.result.solver.name, "GreedyPlanner");
        assert_eq!(report.result.status, PlanStatus::FeasibleModeled);
        // 5 cells of 4 m each way at 1 m/s, plus 100 s of work.
        let totals = report.result.totals.as_ref().unwrap();
        assert_eq!((totals.distance_m, totals.eva_time_s), (40.0, 140.0));
        assert_eq!(report.scenario, scenario);
        assert_eq!(report.dataset.manifest_sha256, session.dataset.manifest_sha256);
        assert_eq!(report.dataset.layers[0].sha256_derived, sha256_hex(&f32_bytes(&raster_values())));
        assert_eq!(report.planning_grid.raster_cells_per_planning_cell, 4);
    }

    #[test]
    fn a_scenario_for_another_dataset_is_refused() {
        let session = open("mismatch");
        let other = scenario(&session, "somewhere-else");
        assert!(matches!(session.validate(&other), Err(SessionError::ScenarioDatasetMismatch { .. })));
        assert!(matches!(session.solve(other), Err(SessionError::ScenarioDatasetMismatch { .. })));
    }

    #[test]
    fn exported_report_reads_back_equal_and_never_overwrites() {
        let session = open("export");
        let report = session.solve(scenario(&session, "tiny")).unwrap();
        let out = temp_dir("export-out").join("reports");

        let first = report.write_to_dir(&out).unwrap();
        let second = report.write_to_dir(&out).unwrap();
        assert_ne!(first, second, "a second export must not replace the first");
        for path in [&first, &second] {
            assert_eq!(path.parent().unwrap(), out);
            let name = path.file_name().unwrap().to_str().unwrap();
            assert!(name.starts_with("hyde-report_tiny_") && name.ends_with(".json"), "{name}");
            let read_back: MissionReport = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
            assert_eq!(read_back, report);
        }
    }

    #[test]
    fn report_file_name_keeps_only_safe_characters_of_the_dataset_id() {
        let session = open("name");
        let mut report = session.solve(scenario(&session, "tiny")).unwrap();
        report.dataset.dataset_id = "../evil id".into();
        report.generated_utc = "2026-11-14T05:06:07Z".into();
        let out = temp_dir("name-out");
        let path = report.write_to_dir(&out).unwrap();
        // '.', '.', '/' and ' ' each become '_'.
        assert_eq!(path, out.join("hyde-report____evil_id_20261114T050607Z.json"));
    }

    #[test]
    fn legacy_report_branding_remains_readable() {
        let session = open("legacy-report");
        let mut legacy = session.solve(scenario(&session, "tiny")).unwrap();
        legacy.software = "ARES — Adaptive Resource & Exploration System".into();
        // Wall-clock timing precision is unrelated to branding compatibility.
        legacy.result.timing.routing_ms = 0.0;
        legacy.result.timing.planning_ms = 0.0;
        let json = serde_json::to_vec(&legacy).unwrap();
        let read_back: MissionReport = serde_json::from_slice(&json).unwrap();
        assert_eq!(read_back, legacy);
    }
}
