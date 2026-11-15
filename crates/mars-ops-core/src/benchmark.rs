//! Headless comparison of the reproducible greedy baseline with the exact
//! subset/order planner on identical maps, scenarios and declared events.
//!
//! Every number here is a model output. The event script is declared in code,
//! not sampled from Mars, and no result is a claim about NASA performance.

use crate::simulation_events::{ContingencyKind, ResourceKind};
use crate::mission_state::{MissionState, SimulationPhase};
use crate::planning::{plan_dp, plan_greedy, MissionResult, MissionScenario, PlanStatus};
use crate::resources::ConstraintCheck;
use crate::terrain::PlanningGrid;
use crate::LocalPoint;
use serde::{Deserialize, Serialize};
use std::time::Instant;

/// Schema version of the machine-readable benchmark document.
pub const BENCHMARK_SCHEMA: u32 = 1;

/// Cap on simulated time after the declared script, independent of the
/// scenario's own limits. A mission that has not finished by then is reported
/// as unfinished, never as successful.
const SIMULATION_CAP_S: f64 = 24.0 * 3600.0;
/// Wall-clock guards so a headless run always terminates.
const MAX_SCRIPT_STEPS: usize = 64;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct BenchmarkOutcome {
    pub solver: String,
    pub planned_status: PlanStatus,
    pub final_phase: Option<SimulationPhase>,
    /// The crew reached the original base within the declared model.
    pub feasible_return: bool,
    pub planned_sites: Vec<String>,
    pub completed_sites: Vec<String>,
    pub planned_utility: f64,
    /// Sum of the modeled utility of the work the simulation actually did.
    pub achieved_utility: f64,
    pub replans: u32,
    pub events: usize,
    pub elapsed_s: f64,
    pub checks: Vec<ConstraintCheck>,
    pub return_margin_s: Option<f64>,
    pub runtime_ms: f64,
    pub failure: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct BenchmarkCase {
    pub name: String,
    pub description: String,
    pub greedy: BenchmarkOutcome,
    pub exact: BenchmarkOutcome,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct BenchmarkReport {
    pub schema_version: u32,
    pub dataset_id: String,
    pub scenario_name: String,
    pub generated_utc: String,
    pub cases: Vec<BenchmarkCase>,
    pub notes: Vec<String>,
}

impl BenchmarkReport {
    pub fn to_json(&self) -> Result<String, serde_json::Error> {
        serde_json::to_string_pretty(self)
    }
}

/// Run the declared benchmark cases. Both solvers see the same map, scenario,
/// budgets and event script; only the site selection and order may differ.
pub fn compare(
    dataset_id: &str,
    grid: &PlanningGrid,
    scenario: &MissionScenario,
) -> BenchmarkReport {
    let cases = vec![
        run_case(
            "open",
            "No contingency. Plan, walk the route, finish every activity and return.",
            dataset_id,
            grid,
            scenario,
            Script::Open,
        ),
        run_case(
            "contingency",
            "Declared sequence: 10 min walk, 20 min delay, 25 min walk, 5 min EVA loss, \
             replan, 20 min walk, a 12 m block radius 32 m ahead on the active leg, replan, \
             then continue to the base.",
            dataset_id,
            grid,
            scenario,
            Script::Contingency,
        ),
    ];
    BenchmarkReport {
        schema_version: BENCHMARK_SCHEMA,
        dataset_id: dataset_id.into(),
        scenario_name: scenario.name.clone(),
        generated_utc: crate::report::utc_iso8601(
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0),
        ),
        cases,
        notes: vec![
            "All values are MODELED or USER_DEFINED outputs of the declared resource model.".into(),
            "Utility is the scenario's user-defined preference weight times allocated activity, not measured science value.".into(),
            "The blocked corridor is a hypothetical constraint recorded per run; the dataset is unchanged.".into(),
            "No result implies NASA validation, astronaut safety, or operational performance.".into(),
        ],
    }
}

#[derive(Clone, Copy)]
enum Script {
    Open,
    Contingency,
}

#[derive(Clone, Copy)]
enum Solver {
    Greedy,
    Exact,
}

impl Solver {
    fn name(self) -> &'static str {
        match self {
            Solver::Greedy => "GreedyPlanner",
            Solver::Exact => "ExactSubsetDp",
        }
    }

    fn plan(self, grid: &PlanningGrid, scenario: &MissionScenario) -> MissionResult {
        match self {
            Solver::Greedy => plan_greedy(grid, scenario),
            Solver::Exact => plan_dp(grid, scenario),
        }
    }
}

fn run_case(
    name: &str,
    description: &str,
    dataset_id: &str,
    grid: &PlanningGrid,
    scenario: &MissionScenario,
    script: Script,
) -> BenchmarkCase {
    BenchmarkCase {
        name: name.into(),
        description: description.into(),
        greedy: run_one(dataset_id, grid, scenario, Solver::Greedy, script),
        exact: run_one(dataset_id, grid, scenario, Solver::Exact, script),
    }
}

fn run_one(
    dataset_id: &str,
    grid: &PlanningGrid,
    scenario: &MissionScenario,
    solver: Solver,
    script: Script,
) -> BenchmarkOutcome {
    let started = Instant::now();
    let plan = solver.plan(grid, scenario);
    let planned_sites: Vec<String> = plan.stops.iter().map(|stop| stop.site_id.clone()).collect();
    let planned_utility = plan.utility;
    let mut outcome = BenchmarkOutcome {
        solver: solver.name().into(),
        planned_status: plan.status,
        final_phase: None,
        feasible_return: false,
        planned_sites,
        completed_sites: Vec::new(),
        planned_utility,
        achieved_utility: 0.0,
        replans: 0,
        events: 0,
        elapsed_s: 0.0,
        checks: Vec::new(),
        return_margin_s: None,
        runtime_ms: 0.0,
        failure: None,
    };
    if plan.status != PlanStatus::FeasibleModeled {
        outcome.failure = Some("the planner produced no simulated mission".into());
        outcome.runtime_ms = started.elapsed().as_secs_f64() * 1e3;
        return outcome;
    }

    let mut state = match MissionState::start(grid, dataset_id, scenario.clone(), plan) {
        Ok(state) => state,
        Err(error) => {
            outcome.failure = Some(error.to_string());
            outcome.runtime_ms = started.elapsed().as_secs_f64() * 1e3;
            return outcome;
        }
    };

    if let Err(failure) = apply_script(&mut state, grid, script) {
        outcome.failure = Some(failure);
    }
    finish(&mut state, grid, &mut outcome);

    let view = state.view(grid);
    outcome.final_phase = Some(state.phase);
    outcome.feasible_return = state.phase == SimulationPhase::Complete;
    outcome.completed_sites = state.completed_sites.clone();
    outcome.achieved_utility = state.completed.iter().map(|stop| stop.utility).sum();
    outcome.replans = state.replans;
    outcome.events = state.events.len();
    outcome.elapsed_s = state.elapsed_s;
    outcome.checks = view.remaining_checks;
    outcome.return_margin_s = view.return_margin_s;
    outcome.runtime_ms = started.elapsed().as_secs_f64() * 1e3;
    outcome
}

/// Apply the declared event sequence. Fixed advance amounts are simulated
/// minutes; they are not wall-clock or orbital timings.
fn apply_script(
    state: &mut MissionState,
    grid: &PlanningGrid,
    script: Script,
) -> Result<(), String> {
    if matches!(script, Script::Open) {
        return Ok(());
    }
    let mut steps = 0usize;
    run_step(state, grid, Action::Advance(10.0 * 60.0), &mut steps)?;
    run_step(state, grid, Action::Delay(20.0 * 60.0), &mut steps)?;
    run_step(state, grid, Action::Advance(25.0 * 60.0), &mut steps)?;
    run_step(
        state,
        grid,
        Action::ResourceLoss(ResourceKind::EvaTime, 5.0 * 60.0),
        &mut steps,
    )?;
    run_step(state, grid, Action::Replan, &mut steps)?;
    run_step(state, grid, Action::Advance(20.0 * 60.0), &mut steps)?;
    run_step(state, grid, Action::BlockAhead { radius_m: 12.0 }, &mut steps)?;
    run_step(state, grid, Action::Replan, &mut steps)?;
    Ok(())
}

fn run_step(
    state: &mut MissionState,
    grid: &PlanningGrid,
    action: Action,
    steps: &mut usize,
) -> Result<(), String> {
    *steps += 1;
    if *steps > MAX_SCRIPT_STEPS {
        return Err("script step cap reached".into());
    }
    action.apply(state, grid)
}

enum Action {
    Advance(f64),
    Delay(f64),
    ResourceLoss(ResourceKind, f64),
    BlockAhead { radius_m: f64 },
    Replan,
}

impl Action {
    fn apply(self, state: &mut MissionState, grid: &PlanningGrid) -> Result<(), String> {
        if matches!(state.phase, SimulationPhase::Complete | SimulationPhase::Infeasible) {
            return Ok(());
        }
        let result = match self {
            Action::Advance(seconds) => state.advance(grid, seconds).map(|_| ()),
            Action::Delay(seconds) => state
                .inject(grid, ContingencyKind::Delay { seconds })
                .map(|_| ()),
            Action::ResourceLoss(resource, amount) => state
                .inject(grid, ContingencyKind::ResourceLoss { resource, amount })
                .map(|_| ()),
            Action::BlockAhead { radius_m } => match block_center(state) {
                Some(center) => state
                    .inject(grid, ContingencyKind::BlockCorridor { center, radius_m })
                    .map(|_| ()),
                None => return Ok(()),
            },
            Action::Replan => state.replan(grid).map(|_| ()),
        };
        result.map_err(|error| error.to_string())
    }
}

/// A point 32 m ahead on the leg the crew would walk next, so a 12 m radius
/// leaves the current position and the immediate next cell clear.
fn block_center(state: &MissionState) -> Option<LocalPoint> {
    let leg = match state.phase {
        SimulationPhase::Travel => state.plan.legs.get(state.leg_index),
        SimulationPhase::Activity => state.plan.legs.get(state.leg_index + 1),
        _ => None,
    }?;
    let index = if state.phase == SimulationPhase::Travel {
        (state.point_index + 8).min(leg.leg.path.len().saturating_sub(1))
    } else {
        8.min(leg.leg.path.len().saturating_sub(1))
    };
    leg.leg.path.get(index).copied()
}

/// Walk the remaining route in bounded chunks until the mission finishes or
/// the simulation cap is reached. No step is skipped or teleported.
fn finish(state: &mut MissionState, grid: &PlanningGrid, outcome: &mut BenchmarkOutcome) {
    let mut simulated = 0.0;
    while simulated < SIMULATION_CAP_S {
        match state.phase {
            SimulationPhase::Complete | SimulationPhase::Infeasible => break,
            _ => {}
        }
        let before = state.elapsed_s;
        if let Err(error) = state.advance(grid, 15.0 * 60.0) {
            outcome.failure.get_or_insert_with(|| error.to_string());
            break;
        }
        simulated += (state.elapsed_s - before).max(0.0);
    }
    if simulated >= SIMULATION_CAP_S && state.phase != SimulationPhase::Complete {
        outcome.failure.get_or_insert_with(|| "simulation cap reached".into());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::planning::ScientificSite;
    use crate::provenance::EvidenceKind;
    use crate::resources::test_support::{bare_model, time_only};
    use crate::route::test_support::{at, flat};

    fn site(grid: &PlanningGrid, id: &str, col: usize, row: usize, weight: f64) -> ScientificSite {
        ScientificSite {
            id: id.into(),
            name: id.into(),
            position: at(grid, col, row),
            science_rationale: "benchmark fixture".into(),
            source_product_ids: vec![],
            evidence_kind: EvidenceKind::Synthetic,
            activity_min_s: 60.0,
            activity_max_s: 60.0,
            activity_power_w: 0.0,
            preference_weight: weight,
            required: false,
        }
    }

    fn scenario(grid: &PlanningGrid) -> MissionScenario {
        MissionScenario {
            schema_version: 1,
            name: "benchmark fixture".into(),
            dataset_id: "synthetic".into(),
            base: at(grid, 15, 15),
            sites: vec![
                site(grid, "A", 5, 15, 1.0),
                site(grid, "B", 25, 15, 1.1),
                site(grid, "C", 15, 5, 0.8),
            ],
            budget: time_only(6_000.0, 120.0),
            model: bare_model(),
        }
    }

    #[test]
    fn both_solvers_run_the_same_declared_cases() {
        let grid = flat(31, 31, 1.0);
        let report = compare("synthetic", &grid, &scenario(&grid));
        assert_eq!(report.cases.len(), 2);
        for case in &report.cases {
            assert_eq!(case.greedy.solver, "GreedyPlanner");
            assert_eq!(case.exact.solver, "ExactSubsetDp");
            assert!(case.greedy.final_phase.is_some());
            assert!(case.exact.final_phase.is_some());
        }
        let open = &report.cases[0];
        assert!(open.exact.feasible_return || open.exact.failure.is_some());
        assert!(open.exact.achieved_utility + 1e-9 >= open.greedy.achieved_utility);
    }

    #[test]
    fn the_benchmark_is_reproducible() {
        let grid = flat(31, 31, 1.0);
        let mut a = compare("synthetic", &grid, &scenario(&grid));
        let mut b = compare("synthetic", &grid, &scenario(&grid));
        a.generated_utc = String::new();
        b.generated_utc = String::new();
        for case in a.cases.iter_mut().chain(b.cases.iter_mut()) {
            case.greedy.runtime_ms = 0.0;
            case.exact.runtime_ms = 0.0;
        }
        assert_eq!(a, b);
    }
}
