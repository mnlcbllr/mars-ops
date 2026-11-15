//! The exported mission report: one self-describing JSON document tying a
//! result to the exact data, assumptions and code that produced it.

use crate::data::{Dataset, LayerRecord};
use crate::mission_state::SimulationRecord;
use crate::planning::{MissionResult, MissionScenario};
use crate::provenance::EvidenceKind;
use crate::terrain::PlanningGrid;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// Source revision the core was built from (`unknown` outside a git checkout).
pub const CODE_REVISION: &str = env!("ARES_GIT_REVISION");

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct LayerRef {
    pub id: String,
    pub product_id: String,
    pub instrument: String,
    pub origin_type: EvidenceKind,
    pub source_url: String,
    pub sha256_source: Option<String>,
    pub sha256_derived: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct DatasetRef {
    pub dataset_id: String,
    pub manifest_sha256: String,
    pub real_data_verified: bool,
    pub layers: Vec<LayerRef>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct PlanningGridRef {
    pub cell_x_m: f64,
    pub cell_y_m: f64,
    pub raster_cells_per_planning_cell: usize,
}

/// Preserve schema-v1 waypoint reports alongside the time-based simulation record.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ReportSimulation {
    Timed(SimulationRecord),
    Waypoint(crate::mission::MissionState),
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct MissionReport {
    pub report_schema_version: u32,
    pub generated_utc: String,
    pub software: String,
    pub software_version: String,
    pub code_revision: String,
    pub dataset: DatasetRef,
    pub planning_grid: PlanningGridRef,
    pub scenario: MissionScenario,
    pub result: MissionResult,
    /// Present when the run was advanced in the stateful simulation. Optional
    /// so schema-v1 reports written before simulation existed still read back.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub simulation: Option<ReportSimulation>,
    /// What this report must not be read as.
    pub disclaimers: Vec<String>,
}

/// `YYYY-MM-DDTHH:MM:SSZ` for a number of seconds since the Unix epoch.
pub fn utc_iso8601(unix_seconds: u64) -> String {
    let (days, second_of_day) = (unix_seconds / 86_400, unix_seconds % 86_400);
    // Civil date from day count (Howard Hinnant's algorithm), valid from 1970 on.
    let z = days + 719_468;
    let era = z / 146_097;
    let day_of_era = z % 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_index = (5 * day_of_year + 2) / 153; // 0 = March
    let day = day_of_year - (153 * month_index + 2) / 5 + 1;
    let month = if month_index < 10 { month_index + 3 } else { month_index - 9 };
    let year = year_of_era + era * 400 + u64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
        second_of_day / 3600,
        second_of_day % 3600 / 60,
        second_of_day % 60
    )
}

impl MissionReport {
    pub fn new(
        dataset: &Dataset,
        grid: &PlanningGrid,
        scenario: MissionScenario,
        result: MissionResult,
    ) -> MissionReport {
        let now = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs());
        let layer_ref = |l: &LayerRecord| LayerRef {
            id: l.id.clone(),
            product_id: l.product_id.clone(),
            instrument: l.instrument.clone(),
            origin_type: l.origin_type,
            source_url: l.source_url.clone(),
            sha256_source: l.sha256_source.clone(),
            sha256_derived: l.sha256_derived.clone(),
        };
        MissionReport {
            report_schema_version: 1,
            generated_utc: utc_iso8601(now),
            software: "HYDE".into(),
            software_version: env!("CARGO_PKG_VERSION").into(),
            code_revision: CODE_REVISION.into(),
            dataset: DatasetRef {
                dataset_id: dataset.manifest.dataset_id.clone(),
                manifest_sha256: dataset.manifest_sha256.clone(),
                real_data_verified: dataset.is_real_data_verified(),
                layers: dataset.manifest.layers.iter().map(layer_ref).collect(),
            },
            planning_grid: PlanningGridRef {
                cell_x_m: grid.cell_x_m,
                cell_y_m: grid.cell_y_m,
                raster_cells_per_planning_cell: grid.factor,
            },
            scenario,
            result,
            simulation: None,
            disclaimers: vec![
                "Research prototype. Not validated astronaut flight software.".into(),
                "FEASIBLE_MODELED means every declared constraint holds under the stated \
                 assumptions; it is not a statement that the route is safe to walk."
                    .into(),
                "Resource coefficients are scenario assumptions, not NASA-certified rates.".into(),
                "Utility is a mission-designer preference value, not measured science value.".into(),
                "Slope is derived from an orbital stereo DTM and cannot resolve hazards smaller \
                 than the planning cell."
                    .into(),
            ],
        }
    }
}

/// Write JSON bytes into `dir` (created if needed) as `<stem>.json`, or
/// `<stem>_N.json` once the name is taken. An existing file is never replaced.
/// Returns the path.
pub fn write_new(dir: &Path, stem: &str, json: &[u8]) -> std::io::Result<PathBuf> {
    use std::io::{Error, ErrorKind, Write};
    std::fs::create_dir_all(dir)?;
    for attempt in 1..=9999u32 {
        let suffix = if attempt == 1 { String::new() } else { format!("_{attempt}") };
        let path = dir.join(format!("{stem}{suffix}.json"));
        match std::fs::OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(mut file) => {
                file.write_all(json)?;
                return Ok(path);
            }
            Err(e) if e.kind() == ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e),
        }
    }
    Err(Error::new(ErrorKind::AlreadyExists, "too many files with the same name"))
}

impl MissionReport {
    /// Write the report as pretty JSON into `dir` (created if needed) under a
    /// name built from the dataset id and generation time. An existing file is
    /// never replaced: a numeric suffix is added instead. Returns the path.
    pub fn write_to_dir(&self, dir: &Path) -> std::io::Result<PathBuf> {
        let json = serde_json::to_vec_pretty(self).map_err(std::io::Error::other)?;

        let keep = |c: char| c.is_ascii_alphanumeric() || c == '-' || c == '_';
        let id: String =
            self.dataset.dataset_id.chars().map(|c| if keep(c) { c } else { '_' }).collect();
        let stamp: String = self.generated_utc.chars().filter(char::is_ascii_alphanumeric).collect();
        write_new(dir, &format!("hyde-report_{id}_{stamp}"), &json)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::data::test_support::write_raster_dataset;
    use crate::mission_state::{SimulationPhase, SimulationRecord};
    use crate::planning::{MissionResult, MissionScenario, PlanStatus, SolverInfo, Timing};
    use crate::resources::test_support::{bare_model, time_only};
    use crate::terrain::PlanningGrid;
    use crate::LocalPoint;

    #[test]
    fn formats_known_instants() {
        assert_eq!(utc_iso8601(0), "1970-01-01T00:00:00Z");
        assert_eq!(utc_iso8601(951_782_400), "2000-02-29T00:00:00Z"); // leap day
        assert_eq!(utc_iso8601(1_700_000_000), "2023-11-14T22:13:20Z");
        assert_eq!(utc_iso8601(4_102_444_799), "2099-12-31T23:59:59Z");
    }

    /// A schema-v1 report written before simulation existed must still parse,
    /// and a report carrying a simulation record must round-trip unchanged.
    #[test]
    fn reports_without_and_with_a_simulation_record_round_trip() {
        let dir = crate::data::test_support::temp_dir("report-simulation");
        write_raster_dataset(&dir, 5, 5, &[0.0; 25], true, |_| {});
        let dataset = Dataset::open(&dir).unwrap();
        let grid = PlanningGrid::build(&dataset.elevation, 1);
        let scenario = MissionScenario {
            schema_version: 1,
            name: "report fixture".into(),
            dataset_id: dataset.manifest.dataset_id.clone(),
            base: LocalPoint { x_m: 2.5, y_m: 2.5 },
            sites: Vec::new(),
            budget: time_only(600.0, 60.0),
            model: bare_model(),
        };
        let result = MissionResult {
            status: PlanStatus::Infeasible,
            solver: SolverInfo {
                name: "TestPlanner".into(),
                version: "1".into(),
                description: "fixture".into(),
            },
            stops: Vec::new(),
            legs: Vec::new(),
            totals: None,
            checks: Vec::new(),
            utility: 0.0,
            issues: Vec::new(),
            excluded: Vec::new(),
            candidate_insights: Vec::new(),
            timing: Timing::default(),
        };
        let mut report = MissionReport::new(&dataset, &grid, scenario, result);
        let old_json = serde_json::to_string(&report).unwrap();
        assert!(!old_json.contains("\"simulation\""));
        assert_eq!(serde_json::from_str::<MissionReport>(&old_json).unwrap(), report);

        report.simulation = Some(ReportSimulation::Timed(SimulationRecord {
            schema_version: 1,
            phase: SimulationPhase::Travel,
            elapsed_s: 0.0,
            consumed: crate::resources::ResourceUse {
                distance_m: 0.0,
                travel_time_s: 0.0,
                activity_time_s: 0.0,
                overhead_s: 0.0,
                eva_time_s: 0.0,
                energy_wh: 0.0,
                consumable: 0.0,
            },
            completed_sites: Vec::new(),
            completed: Vec::new(),
            events: Vec::new(),
            replans: 0,
            current_plan: report.result.clone(),
            remaining_budget: time_only(600.0, 60.0),
            remaining_checks: Vec::new(),
            return_margin_s: Some(0.0),
        }));
        let new_json = serde_json::to_string(&report).unwrap();
        assert!(new_json.contains("\"simulation\""));
        assert_eq!(serde_json::from_str::<MissionReport>(&new_json).unwrap(), report);
        let (grid, scenario) = crate::mission_tests::fixture();
        let plan = crate::planning::plan_greedy(&grid, &scenario);
        report.simulation = Some(ReportSimulation::Waypoint(
            crate::mission::MissionState::start(scenario, plan, "legacy-fixture".into()).unwrap(),
        ));
        let legacy_json = serde_json::to_string(&report).unwrap();
        assert_eq!(serde_json::from_str::<MissionReport>(&legacy_json).unwrap(), report);
    }
}
