//! Headless MARS-OPS: verify a packaged dataset, inspect a point, plan a mission.
//!
//! Exit codes: 0 success / feasible plan, 1 usage or data error, 2 no feasible plan.

use mars_ops_core::planning::{MissionScenario, PlanStatus};
use mars_ops_core::report::MissionReport;
use mars_ops_core::session::Session;
use mars_ops_core::LocalPoint;
use std::path::Path;
use std::process::ExitCode;

const USAGE: &str = "\
mars-ops-cli — headless MARS-OPS

USAGE:
  mars-ops-cli verify-manifest <dataset_dir>
  mars-ops-cli inspect <dataset_dir> <x_m> <y_m>
  mars-ops-cli plan <dataset_dir> [--scenario <scenario.json>] [--out <report.json>]
  mars-ops-cli benchmark <dataset_dir> [--scenario <scenario.json>] [--out <benchmark.json>]

`plan` without --scenario uses the scenario packaged with the dataset.
`benchmark` compares the greedy baseline with the exact subset/order planner
on the same declared cases and writes machine-readable results.";

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let result = match args.first().map(String::as_str) {
        Some("verify-manifest") if args.len() == 2 => verify(Path::new(&args[1])),
        Some("inspect") if args.len() == 4 => inspect(Path::new(&args[1]), &args[2], &args[3]),
        Some("plan") if args.len() >= 2 => plan(Path::new(&args[1]), &args[2..]),
        Some("benchmark") if args.len() >= 2 => benchmark(Path::new(&args[1]), &args[2..]),
        _ => Err(USAGE.to_string()),
    };
    match result {
        Ok(code) => code,
        Err(message) => {
            eprintln!("{message}");
            ExitCode::from(1)
        }
    }
}

fn open(dir: &Path) -> Result<Session, String> {
    Session::open(dir).map_err(|e| e.to_string())
}

fn verify(dir: &Path) -> Result<ExitCode, String> {
    let ds = open(dir)?.dataset;
    let m = &ds.manifest;
    println!("dataset   {} — {} ({})", m.dataset_id, m.display_name, m.region_name);
    println!("manifest  sha256 {}", ds.manifest_sha256);
    for l in &m.layers {
        println!("layer     {} [{:?}, {:?}]", l.id, l.kind, l.origin_type);
        println!("          product {}", l.product_id);
        println!("          file {} sha256 {} — matches", l.file, l.sha256_derived);
        println!(
            "          source sha256 {} — complete per its label and hashed at import: {}",
            l.sha256_source.as_deref().unwrap_or("(none)"),
            l.is_real_source_verified
        );
    }
    let g = &m.georeference;
    let (lo, hi) = ds.elevation.min_max().ok_or("elevation layer has no valid cells")?;
    let nodata = ds.elevation.data.iter().filter(|v| v.is_nan()).count();
    println!("grid      {} × {} cells of {:.4} × {:.4} m", g.width, g.height, g.cell_size_x_m, g.cell_size_y_m);
    println!("elevation {lo:.3} .. {hi:.3} m, {nodata} no-data cells");
    if ds.is_real_data_verified() {
        println!("REAL DATA VERIFIED");
        Ok(ExitCode::SUCCESS)
    } else {
        println!("NOT VERIFIED AS REAL DATA (files are intact, but the source is not recorded as verified)");
        Ok(ExitCode::from(1))
    }
}

fn inspect(dir: &Path, x: &str, y: &str) -> Result<ExitCode, String> {
    let parse = |v: &str| v.parse::<f64>().map_err(|_| format!("'{v}' is not a number\n\n{USAGE}"));
    let point = LocalPoint::new(parse(x)?, parse(y)?);
    let session = open(dir)?;
    let scenario = session.dataset.default_scenario().map_err(|e| e.to_string())?;
    let inspection = session.inspect(point, scenario.model.max_slope_deg.value);
    println!("{}", serde_json::to_string_pretty(&inspection).map_err(|e| e.to_string())?);
    Ok(ExitCode::SUCCESS)
}

fn plan(dir: &Path, options: &[String]) -> Result<ExitCode, String> {
    let (mut scenario_path, mut out_path) = (None, None);
    let mut it = options.iter();
    while let Some(flag) = it.next() {
        let value = it.next().ok_or_else(|| format!("{flag} needs a value\n\n{USAGE}"))?;
        match flag.as_str() {
            "--scenario" => scenario_path = Some(value),
            "--out" => out_path = Some(value),
            _ => return Err(format!("unknown option {flag}\n\n{USAGE}")),
        }
    }

    let session = open(dir)?;
    let scenario: MissionScenario = match scenario_path {
        Some(path) => {
            let text = std::fs::read_to_string(path).map_err(|e| format!("cannot read {path}: {e}"))?;
            serde_json::from_str(&text).map_err(|e| format!("{path} is not a mission scenario: {e}"))?
        }
        None => session.dataset.default_scenario().map_err(|e| e.to_string())?,
    };
    let report = session.solve(scenario).map_err(|e| e.to_string())?;
    let status = report.result.status;
    print_summary(&report);
    if let Some(path) = out_path {
        let json = serde_json::to_string_pretty(&report).map_err(|e| e.to_string())?;
        std::fs::write(path, json).map_err(|e| format!("cannot write {path}: {e}"))?;
        println!("report    {path}");
    }
    Ok(if status == PlanStatus::FeasibleModeled { ExitCode::SUCCESS } else { ExitCode::from(2) })
}

fn benchmark(dir: &Path, options: &[String]) -> Result<ExitCode, String> {
    let (mut scenario_path, mut out_path) = (None, None);
    let mut it = options.iter();
    while let Some(flag) = it.next() {
        let value = it.next().ok_or_else(|| format!("{flag} needs a value\n\n{USAGE}"))?;
        match flag.as_str() {
            "--scenario" => scenario_path = Some(value),
            "--out" => out_path = Some(value),
            _ => return Err(format!("unknown option {flag}\n\n{USAGE}")),
        }
    }
    let session = open(dir)?;
    let scenario: MissionScenario = match scenario_path {
        Some(path) => {
            let text = std::fs::read_to_string(path).map_err(|e| format!("cannot read {path}: {e}"))?;
            serde_json::from_str(&text).map_err(|e| format!("{path} is not a mission scenario: {e}"))?
        }
        None => session.dataset.default_scenario().map_err(|e| e.to_string())?,
    };
    let report = session.benchmark(&scenario).map_err(|e| e.to_string())?;
    println!(
        "{:<12} {:<14} {:>5} {:>8} {:>9} {:>8} {:>8} {:>7} {:>8}",
        "case", "solver", "stops", "utility", "EVA min", "margin", "replans", "events", "runtime"
    );
    for case in &report.cases {
        for outcome in [&case.greedy, &case.exact] {
            let eva = outcome
                .checks
                .iter()
                .find(|check| check.resource == "eva_time")
                .map(|check| check.used / 60.0)
                .unwrap_or(f64::NAN);
            let margin = outcome
                .checks
                .iter()
                .find(|check| check.resource == "eva_time")
                .map(|check| check.margin / 60.0)
                .unwrap_or(f64::NAN);
            println!(
                "{:<12} {:<14} {:>5} {:>8.3} {:>9.1} {:>8.1} {:>8} {:>7} {:>7.1}ms  {}",
                case.name,
                outcome.solver,
                outcome.completed_sites.len(),
                outcome.achieved_utility,
                eva,
                margin,
                outcome.replans,
                outcome.events,
                outcome.runtime_ms,
                match outcome.final_phase {
                    Some(mars_ops_core::mission_state::SimulationPhase::Complete) => "returned to base",
                    Some(mars_ops_core::mission_state::SimulationPhase::Infeasible) => "INFEASIBLE",
                    Some(_) => "unfinished",
                    None => "not simulated",
                }
            );
            if let Some(failure) = &outcome.failure {
                println!("             note: {failure}");
            }
        }
    }
    if let Some(path) = out_path {
        let json = report.to_json().map_err(|e| e.to_string())?;
        std::fs::write(path, json).map_err(|e| format!("cannot write {path}: {e}"))?;
        println!("benchmark {path}");
    }
    Ok(ExitCode::SUCCESS)
}

fn print_summary(report: &MissionReport) {
    let r = &report.result;
    println!(
        "data      {} — real data verified: {}",
        report.dataset.dataset_id, report.dataset.real_data_verified
    );
    println!("solver    {} v{} (rev {})", r.solver.name, r.solver.version, report.code_revision);
    println!("status    {:?}", r.status);
    for issue in &r.issues {
        println!("  {:?} {}: {}", issue.severity, issue.code, issue.message);
    }
    if let Some(t) = &r.totals {
        println!(
            "plan      {} stops, {:.0} m, EVA {:.1} min (travel {:.1}, work {:.1}, overhead {:.1}), utility {:.3} (modeled preference)",
            r.stops.len(),
            t.distance_m,
            t.eva_time_s / 60.0,
            t.travel_time_s / 60.0,
            t.activity_time_s / 60.0,
            t.overhead_s / 60.0,
            r.utility
        );
        println!("          energy {:.1} Wh, consumable {:.4}", t.energy_wh, t.consumable);
    }
    for leg in &r.legs {
        println!(
            "  leg {:>6} → {:<6} {:>7.1} m {:>6.1} min  +{:.1}/−{:.1} m  max slope {:.1}°",
            leg.from,
            leg.to,
            leg.leg.distance_m,
            leg.leg.time_s / 60.0,
            leg.leg.ascent_m,
            leg.leg.descent_m,
            leg.leg.max_slope_deg
        );
    }
    for stop in &r.stops {
        println!(
            "  stop {:<6} arrive {:>6.1} min, work {:>5.1} min, utility {:.3}",
            stop.site_id,
            stop.arrive_s / 60.0,
            stop.activity_s / 60.0,
            stop.utility
        );
    }
    for c in &r.checks {
        println!(
            "  check {:<10} used {:.3} of {:.3} available ({} {}) margin {:.3} — {}",
            c.resource,
            c.used,
            c.available,
            c.budget,
            c.unit,
            c.margin,
            if c.satisfied { "ok" } else { "VIOLATED" }
        );
    }
    for e in &r.excluded {
        println!("  excluded {} [{}]: {}", e.site_id, e.code, e.reason);
    }
    println!(
        "timing    routing {:.1} ms ({} legs, {} cells expanded), planning {:.2} ms",
        r.timing.routing_ms, r.timing.legs_routed, r.timing.cells_expanded, r.timing.planning_ms
    );
}
