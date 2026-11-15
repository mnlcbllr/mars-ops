//! Checks against the packaged real dataset (`datasets/jezero-small`).
//!
//! `validation_samples.json` was written by `tools/preprocess_data.py` from a
//! raw-byte read of the original HiRISE `.IMG`, independently of this crate.

use mars_ops_core::data::Dataset;
use mars_ops_core::geo::LatLon;
use mars_ops_core::planning::{plan_greedy, MissionScenario, PlanStatus, BASE_ID};
use mars_ops_core::session::{DisplayLayer, Session};
use mars_ops_core::terrain::{PlanningGrid, TerrainClass, PLANNING_FACTOR};
use mars_ops_core::LocalPoint;
use std::path::PathBuf;

fn dataset_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../datasets/jezero-small")
}

fn open() -> Dataset {
    Dataset::open(&dataset_dir()).expect("packaged dataset must open and pass its checksums")
}

fn samples() -> serde_json::Value {
    let text = std::fs::read_to_string(dataset_dir().join("validation_samples.json")).unwrap();
    serde_json::from_str(&text).unwrap()
}

fn planned(edit: impl FnOnce(&mut MissionScenario)) -> (PlanningGrid, MissionScenario, mars_ops_core::planning::MissionResult) {
    let ds = open();
    let grid = PlanningGrid::build(&ds.elevation, PLANNING_FACTOR);
    let mut scenario = ds.default_scenario().unwrap();
    edit(&mut scenario);
    let result = plan_greedy(&grid, &scenario);
    (grid, scenario, result)
}

#[test]
fn packaged_dataset_is_the_verified_hirise_product() {
    let ds = open();
    assert!(ds.is_real_data_verified());
    let dtm = ds.layer(mars_ops_core::data::LayerKind::Elevation).unwrap();
    assert_eq!(dtm.product_id, "DTEEC_023524_1985_023379_1985_U01");
    assert_eq!(samples()["source_product_id"], "DTEEC_023524_1985_023379_1985_U01");
    assert_eq!(samples()["source_verified"], true);
}

#[test]
fn every_sampled_cell_holds_the_source_products_exact_value() {
    let ds = open();
    let samples = samples();
    let list = samples["samples"].as_array().unwrap();
    assert!(list.len() >= 64);
    for s in list {
        let (col, row) = (s["col"].as_u64().unwrap() as usize, s["row"].as_u64().unwrap() as usize);
        let want = s["elevation_m"].as_f64().expect("region has no missing cells") as f32;
        let got = ds.elevation.data[row * ds.elevation.width + col];
        assert_eq!(got.to_bits(), want.to_bits(), "cell ({col}, {row}): {got} vs source {want}");
        // The same value through the public sampling API at the cell centre.
        let centre = ds.elevation.cell_center(col, row);
        assert_eq!(ds.elevation.sample_nearest(centre), Some(want));
    }
}

#[test]
fn region_statistics_match_the_source_read() {
    let ds = open();
    let samples = samples();
    let (lo, hi) = ds.elevation.min_max().unwrap();
    assert_eq!(lo, samples["region_min_m"].as_f64().unwrap() as f32);
    assert_eq!(hi, samples["region_max_m"].as_f64().unwrap() as f32);
    let missing = ds.elevation.data.iter().filter(|v| v.is_nan()).count() as u64;
    assert_eq!(missing, samples["region_nodata_cells"].as_u64().unwrap());
}

#[test]
fn region_corners_map_to_the_latitude_and_longitude_computed_from_the_label() {
    let ds = open();
    let geo = &ds.manifest.georeference;
    let samples = samples();
    let corner = |name: &str| {
        let c = samples["corner_latlon"][name].as_array().unwrap();
        LatLon { lat_deg: c[0].as_f64().unwrap(), lon_east_deg: c[1].as_f64().unwrap() }
    };
    let (extent_x, extent_y) =
        (geo.width as f64 * geo.cell_size_x_m, geo.height as f64 * geo.cell_size_y_m);
    let nw = geo.local_to_latlon(LocalPoint::new(0.0, extent_y));
    let se = geo.local_to_latlon(LocalPoint::new(extent_x, 0.0));
    for (got, want) in [(nw, corner("north_west")), (se, corner("south_east"))] {
        assert!((got.lat_deg - want.lat_deg).abs() < 1e-9, "{got:?} vs {want:?}");
        assert!((got.lon_east_deg - want.lon_east_deg).abs() < 1e-9, "{got:?} vs {want:?}");
    }
    // Jezero Crater: about 18.4° N, 77.5° E, positive-east 0–360 longitude.
    assert!(nw.lat_deg > 18.4 && nw.lat_deg < 18.6 && nw.lon_east_deg > 77.4 && nw.lon_east_deg < 77.6);
}

#[test]
fn packaged_scenario_yields_a_feasible_round_trip_on_real_terrain() {
    let (grid, scenario, r) = planned(|_| {});
    assert_eq!(r.status, PlanStatus::FeasibleModeled);
    assert!(!r.stops.is_empty());
    assert!(r.checks.iter().all(|c| c.satisfied), "{:?}", r.checks);
    assert_eq!(r.legs.first().unwrap().from, BASE_ID);
    assert_eq!(r.legs.last().unwrap().to, BASE_ID);
    assert_eq!(grid.cell_of(r.legs[0].leg.path[0]), grid.cell_of(scenario.base));
    assert_eq!(grid.cell_of(*r.legs.last().unwrap().leg.path.last().unwrap()), grid.cell_of(scenario.base));

    // Every point of every leg is on known terrain within the scenario slope limit.
    let limit = scenario.model.max_slope_deg.value;
    for leg in &r.legs {
        for p in &leg.leg.path {
            assert_eq!(grid.classify(*p, limit).0, TerrainClass::Traversable, "{p:?} on leg {}→{}", leg.from, leg.to);
        }
    }
}

#[test]
fn a_forty_minute_allowance_is_reported_infeasible_with_a_reason_per_site() {
    let (_, scenario, r) = planned(|s| {
        s.budget.eva_limit_s = 40.0 * 60.0;
        s.budget.eva_reserve_s = 10.0 * 60.0;
    });
    assert_eq!(r.status, PlanStatus::Infeasible);
    assert!(r.stops.is_empty() && r.legs.is_empty() && r.totals.is_none());
    assert_eq!(r.excluded.len(), scenario.sites.len());
    for e in &r.excluded {
        assert_eq!(e.code, "ExceedsBudgetAlone", "{e:?}");
        assert!(e.reason.contains("EVA time"), "{}", e.reason);
    }
}

#[test]
fn a_stricter_slope_rule_removes_the_mound_summit_from_the_plan() {
    let (_, _, default_plan) = planned(|_| {});
    assert!(default_plan.stops.iter().any(|s| s.site_id == "S1"), "summit is reachable at the default limit");

    let (_, _, strict) = planned(|s| s.model.max_slope_deg.value = 10.0);
    assert!(strict.stops.iter().all(|s| s.site_id != "S1"));
    let why = strict.excluded.iter().find(|e| e.site_id == "S1").expect("summit must be explained");
    assert_eq!(why.code, "BlockedBySlopeRule");
}

#[test]
fn session_serves_the_packaged_layers_at_their_real_dimensions() {
    let session = Session::open(&dataset_dir()).unwrap();
    let info = session.info();
    assert!(info.real_data_verified);
    assert_eq!(info.nodata_cells, 0);
    assert_eq!((info.planning_grid.width, info.planning_grid.height), (512, 512));
    // No missing cells, so only the outer ring of the lattice is unknown: 4 × 512 − 4.
    assert_eq!(info.planning_grid.unknown_cells, 2044);

    let elevation = session.layer_bytes(DisplayLayer::Elevation).unwrap();
    assert_eq!(elevation.len(), 2048 * 2048 * 4);
    // Served bytes are the packaged file itself: same hash as the manifest records.
    let dtm = session.dataset.layer(mars_ops_core::data::LayerKind::Elevation).unwrap();
    assert_eq!(mars_ops_core::data::sha256_hex(&elevation), dtm.sha256_derived);

    assert_eq!(session.layer_bytes(DisplayLayer::Slope).unwrap().len(), 512 * 512 * 4);
    let png = session.layer_bytes(DisplayLayer::Imagery).unwrap();
    assert_eq!(&png[..8], b"\x89PNG\r\n\x1a\n");
}

#[test]
fn session_report_matches_a_direct_run_of_the_planner() {
    let session = Session::open(&dataset_dir()).unwrap();
    let scenario = session.dataset.default_scenario().unwrap();
    let report = session.solve(scenario.clone()).unwrap();
    let (_, _, direct) = planned(|_| {});
    assert_eq!(report.result.status, PlanStatus::FeasibleModeled);
    assert_eq!(report.result.stops, direct.stops);
    assert_eq!(report.result.totals, direct.totals);
    assert_eq!(report.result.checks, direct.checks);
    assert_eq!(report.scenario, scenario);
    assert!(report.dataset.real_data_verified);
}
