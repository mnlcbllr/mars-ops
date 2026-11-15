//! Stateful mission simulation: deterministic progress along a planned route,
//! with resources accrued by the same model the planner uses.
//!
//! A simulation is a replayable state machine. It never says an event happened
//! on Mars: events are declared inputs, time is modeled EVA time, and every
//! resource figure is an estimate under the scenario's assumptions.

use crate::simulation_events::{ContingencyError, ContingencyEvent, ContingencyKind, ResourceKind};
use crate::planning::{MissionResult, MissionScenario, PlanStatus};
use crate::replan::{remaining_budget, return_margin, ReplanRequest};
use crate::resources::{check_budget, ConstraintCheck, ResourceBudget, ResourceUse};
use crate::route::{leg_step_metrics, BlockOverlay, StepMetric};
use crate::terrain::PlanningGrid;
use crate::LocalPoint;
use serde::{Deserialize, Serialize};

/// Schema version of a serialized simulation state.
pub const MISSION_STATE_SCHEMA: u32 = 1;

/// What the astronaut is doing at the current simulated instant.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum SimulationPhase {
    /// Walking the current planned leg.
    Travel,
    /// Working at the stop that ends the current leg.
    Activity,
    /// Back at the base; no further progress is possible.
    Complete,
    /// The latest replan could not produce a feasible route; the crew is
    /// held at the last simulated position until the scenario is reset.
    Infeasible,
}

/// One stop the simulated crew actually finished.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct CompletedStop {
    pub site_id: String,
    /// Science time executed, from the plan active at completion.
    pub activity_s: f64,
    /// Modeled preference utility of that executed work.
    pub utility: f64,
    /// Simulated EVA clock at departure.
    pub depart_s: f64,
}

/// One deterministic, serializable mission attempt.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct MissionState {
    pub schema_version: u32,
    pub dataset_id: String,
    /// Frozen copy of the user's scenario. Resource-loss events reduce its
    /// budget; disposable UI edits never reach this snapshot.
    pub scenario: MissionScenario,
    pub initial_plan: MissionResult,
    pub plan: MissionResult,
    pub phase: SimulationPhase,
    /// Index into `plan.legs`; starts at 0.
    pub leg_index: usize,
    /// Index of the path point the astronaut last reached on the active leg.
    pub point_index: usize,
    /// Time already spent on the step leaving `point_index`.
    pub step_elapsed_s: f64,
    /// Science time already completed at the active stop.
    pub activity_done_s: f64,
    /// Simulated EVA clock, including the initial overhead.
    pub elapsed_s: f64,
    /// Simulated consumption so far, accrued exactly once per interval.
    pub consumed: ResourceUse,
    /// Last position reached on the lattice. Retained when a replan fails so
    /// the crew is never teleported to the base.
    pub anchor: LocalPoint,
    pub completed_sites: Vec<String>,
    /// Realized work at each completed stop, in completion order. This records
    /// what the simulation actually executed, not what a later plan proposes.
    #[serde(default)]
    pub completed: Vec<CompletedStop>,
    pub events: Vec<ContingencyEvent>,
    pub blocked: BlockOverlay,
    pub replans: u32,
}

/// Why a simulation operation was refused.
#[derive(Clone, Debug, PartialEq, thiserror::Error)]
pub enum SimulationError {
    #[error("PlanNotSimulatable: the mission result has no route to simulate")]
    PlanNotSimulatable,
    #[error("PlanNotFeasible: the latest plan is not feasible under its declared limits")]
    PlanNotFeasible,
    #[error("MissionComplete: the simulated crew is already back at the base")]
    MissionComplete,
    #[error("InvalidAdvance: simulated seconds must be finite and greater than zero")]
    InvalidAdvance,
    #[error("InvalidRoute: a planned leg does not map onto the planning lattice")]
    InvalidRoute,
    #[error("BlockedAhead: the next cell ({col}, {row}) is blocked by a contingency; replan first")]
    BlockedAhead { col: usize, row: usize },
    #[error("DifferentDataset: the simulation belongs to dataset '{state}' but '{opened}' is open")]
    DifferentDataset { state: String, opened: String },
    #[error(transparent)]
    Contingency(#[from] ContingencyError),
}

/// The state plus derived figures the HUD needs, without recomputing them in
/// the UI.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SimulationView {
    pub state: MissionState,
    pub position: LocalPoint,
    pub remaining_budget: ResourceBudget,
    pub remaining_checks: Vec<ConstraintCheck>,
    pub return_margin_s: Option<f64>,
    pub remaining_sites: usize,
    /// Fraction of the active leg already walked (0..=1); 1 at a stop.
    pub leg_progress: f64,
}

/// Compact, exportable record of a simulation at one instant.
///
/// Included in an exported mission report so a reader can see the events that
/// were injected, what was consumed, and the current plan. It is a record of a
/// modeled exercise, not an observation.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SimulationRecord {
    pub schema_version: u32,
    pub phase: SimulationPhase,
    pub elapsed_s: f64,
    pub consumed: ResourceUse,
    pub completed_sites: Vec<String>,
    pub completed: Vec<CompletedStop>,
    pub events: Vec<ContingencyEvent>,
    pub replans: u32,
    pub current_plan: MissionResult,
    pub remaining_budget: ResourceBudget,
    pub remaining_checks: Vec<ConstraintCheck>,
    pub return_margin_s: Option<f64>,
}

impl MissionState {
    /// Start a mission attempt from a feasible plan.
    pub fn start(
        grid: &PlanningGrid,
        dataset_id: &str,
        scenario: MissionScenario,
        plan: MissionResult,
    ) -> Result<Self, SimulationError> {
        if plan.status != PlanStatus::FeasibleModeled || plan.legs.is_empty() {
            return Err(SimulationError::PlanNotSimulatable);
        }
        let model = &scenario.model;
        let overhead = model.overhead_s.value;
        let consumed = ResourceUse {
            distance_m: 0.0,
            travel_time_s: 0.0,
            activity_time_s: 0.0,
            overhead_s: overhead,
            eva_time_s: overhead,
            energy_wh: model.base_power_w.value * overhead / 3600.0,
            consumable: model.consumable_rate_activity_per_h.value * overhead / 3600.0,
        };
        let anchor = plan
            .legs
            .first()
            .and_then(|planned| planned.leg.path.first().copied())
            .unwrap_or(scenario.base);
        Ok(Self {
            schema_version: MISSION_STATE_SCHEMA,
            dataset_id: dataset_id.into(),
            scenario,
            initial_plan: plan.clone(),
            plan,
            phase: SimulationPhase::Travel,
            leg_index: 0,
            point_index: 0,
            step_elapsed_s: 0.0,
            activity_done_s: 0.0,
            elapsed_s: overhead,
            consumed,
            anchor,
            completed_sites: Vec::new(),
            completed: Vec::new(),
            events: Vec::new(),
            blocked: BlockOverlay::new(grid.width, grid.height),
            replans: 0,
        })
    }

    /// Refuse work for a simulation started on another dataset.
    pub fn check_dataset(&self, opened: &str) -> Result<(), SimulationError> {
        if self.dataset_id == opened {
            Ok(())
        } else {
            Err(SimulationError::DifferentDataset {
                state: self.dataset_id.clone(),
                opened: opened.into(),
            })
        }
    }

    fn active_leg(&self) -> Option<&crate::route::Leg> {
        self.plan.legs.get(self.leg_index).map(|planned| &planned.leg)
    }

    fn active_site(&self) -> Option<&crate::planning::ScientificSite> {
        let stop = self.plan.stops.get(self.leg_index)?;
        self.scenario.sites.iter().find(|site| site.id == stop.site_id)
    }

    fn step_metrics(&self, grid: &PlanningGrid) -> Result<Vec<StepMetric>, SimulationError> {
        let leg = self.active_leg().ok_or(SimulationError::InvalidRoute)?;
        leg_step_metrics(grid, &self.scenario.model.traversal(), leg)
            .ok_or(SimulationError::InvalidRoute)
    }

    /// Current position on the lattice, interpolating within a partial step.
    pub fn position(&self, grid: &PlanningGrid) -> LocalPoint {
        if matches!(self.phase, SimulationPhase::Infeasible) || self.plan.legs.is_empty() {
            return self.anchor;
        }
        if self.phase == SimulationPhase::Complete {
            return self
                .plan
                .legs
                .last()
                .and_then(|leg| leg.leg.path.last().copied())
                .unwrap_or(self.scenario.base);
        }
        let Some(leg) = self.active_leg() else { return self.scenario.base };
        if self.phase == SimulationPhase::Activity {
            return leg.path.last().copied().unwrap_or(self.scenario.base);
        }
        let Some(current) = leg.path.get(self.point_index).copied() else {
            return leg.path.last().copied().unwrap_or(self.scenario.base);
        };
        let Some(next) = leg.path.get(self.point_index + 1).copied() else {
            return current;
        };
        let Ok(metrics) = self.step_metrics(grid) else { return current };
        let Some(step) = metrics.get(self.point_index) else { return current };
        if step.time_s <= 0.0 {
            return next;
        }
        let fraction = (self.step_elapsed_s / step.time_s).clamp(0.0, 1.0);
        LocalPoint::new(
            current.x_m + (next.x_m - current.x_m) * fraction,
            current.y_m + (next.y_m - current.y_m) * fraction,
        )
    }

    /// Advance simulated time along the plan. Returns the seconds actually
    /// advanced (equal to the request unless the mission finishes first).
    pub fn advance(&mut self, grid: &PlanningGrid, seconds: f64) -> Result<f64, SimulationError> {
        if !(seconds.is_finite() && seconds > 0.0) {
            return Err(SimulationError::InvalidAdvance);
        }
        if self.plan.status != PlanStatus::FeasibleModeled
            || matches!(self.phase, SimulationPhase::Infeasible)
        {
            return Err(SimulationError::PlanNotFeasible);
        }
        if self.phase == SimulationPhase::Complete {
            return Err(SimulationError::MissionComplete);
        }
        let mut remaining = seconds;
        while remaining > 1e-12 {
            match self.phase {
                SimulationPhase::Complete => break,
                SimulationPhase::Infeasible => break,
                SimulationPhase::Travel => {
                    let metrics = self.step_metrics(grid)?;
                    if self.point_index >= metrics.len() {
                        self.arrive();
                        continue;
                    }
                    let leg = self.active_leg().ok_or(SimulationError::InvalidRoute)?;
                    let target = leg.path[self.point_index + 1];
                    let (col, row) = grid.cell_of(target).ok_or(SimulationError::InvalidRoute)?;
                    if self.blocked.contains(grid.index(col, row)) {
                        return Err(SimulationError::BlockedAhead { col, row });
                    }
                    let step = metrics[self.point_index];
                    let left = (step.time_s - self.step_elapsed_s).max(0.0);
                    if left <= remaining {
                        self.charge_travel(step.distance_m, left);
                        remaining -= left;
                        self.point_index += 1;
                        self.step_elapsed_s = 0.0;
                        if self.point_index >= metrics.len() {
                            self.arrive();
                        }
                    } else {
                        let fraction = remaining / step.time_s;
                        self.charge_travel(step.distance_m * fraction, remaining);
                        self.step_elapsed_s += remaining;
                        remaining = 0.0;
                    }
                }
                SimulationPhase::Activity => {
                    let stop = self
                        .plan
                        .stops
                        .get(self.leg_index)
                        .ok_or(SimulationError::InvalidRoute)?
                        .clone();
                    let power = self.active_site().map_or(0.0, |site| site.activity_power_w);
                    let left = (stop.activity_s - self.activity_done_s).max(0.0);
                    if left <= remaining {
                        self.charge_activity(power, left);
                        self.activity_done_s += left;
                        remaining -= left;
                        self.finish_stop(&stop.site_id);
                    } else {
                        self.charge_activity(power, remaining);
                        self.activity_done_s += remaining;
                        remaining = 0.0;
                    }
                }
            }
        }
        self.anchor = self.position(grid);
        Ok(seconds - remaining)
    }

    fn arrive(&mut self) {
        self.point_index = 0;
        self.step_elapsed_s = 0.0;
        self.activity_done_s = 0.0;
        if self.leg_index < self.plan.stops.len() {
            self.phase = SimulationPhase::Activity;
        } else {
            self.phase = SimulationPhase::Complete;
        }
    }

    fn finish_stop(&mut self, site_id: &str) {
        if !self.completed_sites.iter().any(|id| id == site_id) {
            self.completed_sites.push(site_id.to_string());
        }
        let stop = self.plan.stops.get(self.leg_index).cloned();
        let activity_s = stop.as_ref().map_or(self.activity_done_s, |s| s.activity_s);
        let utility = self
            .scenario
            .sites
            .iter()
            .find(|site| site.id == site_id)
            .map_or(0.0, |site| crate::planning::site_utility(site, activity_s));
        self.completed.push(CompletedStop {
            site_id: site_id.to_string(),
            activity_s,
            utility,
            depart_s: self.elapsed_s,
        });
        self.leg_index += 1;
        self.point_index = 0;
        self.step_elapsed_s = 0.0;
        self.activity_done_s = 0.0;
        self.phase = if self.leg_index < self.plan.legs.len() {
            SimulationPhase::Travel
        } else {
            SimulationPhase::Complete
        };
    }

    fn charge_travel(&mut self, distance_m: f64, seconds: f64) {
        let model = &self.scenario.model;
        self.consumed.distance_m += distance_m;
        self.consumed.travel_time_s += seconds;
        self.consumed.eva_time_s += seconds;
        self.consumed.energy_wh += model.base_power_w.value * seconds / 3600.0;
        self.consumed.consumable +=
            model.consumable_rate_travel_per_h.value * seconds / 3600.0;
        self.elapsed_s += seconds;
    }

    fn charge_activity(&mut self, power_w: f64, seconds: f64) {
        let model = &self.scenario.model;
        self.consumed.activity_time_s += seconds;
        self.consumed.eva_time_s += seconds;
        self.consumed.energy_wh += (model.base_power_w.value + power_w) * seconds / 3600.0;
        self.consumed.consumable +=
            model.consumable_rate_activity_per_h.value * seconds / 3600.0;
        self.elapsed_s += seconds;
    }

    /// Charge an idle interval to the active phase without moving or working.
    fn charge_delay(&mut self, seconds: f64) {
        match self.phase {
            SimulationPhase::Travel => {
                let model = &self.scenario.model;
                self.consumed.travel_time_s += seconds;
                self.consumed.eva_time_s += seconds;
                self.consumed.energy_wh += model.base_power_w.value * seconds / 3600.0;
                self.consumed.consumable +=
                    model.consumable_rate_travel_per_h.value * seconds / 3600.0;
                self.elapsed_s += seconds;
            }
            SimulationPhase::Activity => {
                let power = self.active_site().map_or(0.0, |site| site.activity_power_w);
                self.charge_activity(power, seconds);
            }
            SimulationPhase::Complete => {}
            SimulationPhase::Infeasible => {}
        }
    }

    /// Inject and apply a validated contingency at the current instant.
    pub fn inject(
        &mut self,
        grid: &PlanningGrid,
        kind: ContingencyKind,
    ) -> Result<ContingencyEvent, SimulationError> {
        if self.phase == SimulationPhase::Complete {
            return Err(SimulationError::MissionComplete);
        }
        kind.validate(grid, &self.scenario)?;
        match &kind {
            ContingencyKind::Delay { seconds } => self.charge_delay(*seconds),
            ContingencyKind::ResourceLoss { resource, amount } => {
                let budget = &mut self.scenario.budget;
                match resource {
                    ResourceKind::EvaTime => {
                        budget.eva_limit_s = (budget.eva_limit_s - amount).max(0.0)
                    }
                    ResourceKind::Energy => {
                        if let Some(value) = budget.energy_budget_wh.as_mut() {
                            *value = (*value - amount).max(0.0);
                        }
                    }
                    ResourceKind::Consumable => {
                        if let Some(value) = budget.consumable_budget.as_mut() {
                            *value = (*value - amount).max(0.0);
                        }
                    }
                }
            }
            ContingencyKind::BlockCells { .. } | ContingencyKind::BlockCorridor { .. } => {
                kind.apply_to_overlay(grid, &mut self.blocked)?;
            }
        }
        let event = ContingencyEvent {
            id: self.events.len() as u64 + 1,
            at_elapsed_s: self.elapsed_s,
            kind,
        };
        self.events.push(event.clone());
        Ok(event)
    }

    /// Replan from the current position and reset the route cursor to it.
    pub fn replan(&mut self, grid: &PlanningGrid) -> Result<MissionResult, SimulationError> {
        if self.phase == SimulationPhase::Complete {
            return Err(SimulationError::MissionComplete);
        }
        let position = self.position(grid);
        let result = crate::replan::replan(
            grid,
            ReplanRequest {
                scenario: &self.scenario,
                start: position,
                completed: &self.completed_sites,
                consumed: &self.consumed,
                blocked: Some(&self.blocked),
            },
        );
        self.replans += 1;
        self.plan = result.clone();
        self.leg_index = 0;
        self.point_index = 0;
        self.step_elapsed_s = 0.0;
        self.activity_done_s = 0.0;
        self.phase = if result.status == PlanStatus::FeasibleModeled && !result.legs.is_empty() {
            SimulationPhase::Travel
        } else {
            SimulationPhase::Infeasible
        };
        Ok(result)
    }

    /// Simulated seconds until the next phase boundary: arrival at the active
    /// stop, or the end of the current activity. Zero when the mission is
    /// complete, infeasible, or already at a boundary.
    pub fn seconds_to_next_stop(&self, grid: &PlanningGrid) -> Result<f64, SimulationError> {
        match self.phase {
            SimulationPhase::Complete | SimulationPhase::Infeasible => Ok(0.0),
            SimulationPhase::Travel => {
                let metrics = self.step_metrics(grid)?;
                let total: f64 = metrics
                    .iter()
                    .skip(self.point_index)
                    .map(|step| step.time_s)
                    .sum();
                Ok((total - self.step_elapsed_s).max(0.0))
            }
            SimulationPhase::Activity => {
                let stop = self
                    .plan
                    .stops
                    .get(self.leg_index)
                    .ok_or(SimulationError::InvalidRoute)?;
                Ok((stop.activity_s - self.activity_done_s).max(0.0))
            }
        }
    }

    /// Advance exactly to the next phase boundary without crossing it. Returns
    /// the simulated seconds advanced. A blocked next cell is reported exactly
    /// as in `advance`; the caller must replan before resuming.
    pub fn advance_to_stop(&mut self, grid: &PlanningGrid) -> Result<f64, SimulationError> {
        let phase = self.phase;
        let mut advanced = 0.0;
        // Two attempts absorb a floating-point residual at a leg's last step;
        // the phase guard means an arrival never runs into the next activity.
        for _ in 0..2 {
            if self.phase != phase {
                break;
            }
            let seconds = self.seconds_to_next_stop(grid)?;
            if seconds <= 0.0 {
                break;
            }
            advanced += self.advance(grid, seconds)?;
        }
        Ok(advanced)
    }

    /// Derived HUD figures for the current state.
    pub fn view(&self, grid: &PlanningGrid) -> SimulationView {
        let budget = remaining_budget(&self.scenario.budget, &self.consumed);
        let remaining_checks = check_budget(&self.consumed, &self.scenario.budget);
        let return_margin_s =
            return_margin(grid, &self.scenario, self.position(grid), &self.consumed, Some(&self.blocked));
        let remaining_sites = self
            .scenario
            .sites
            .iter()
            .filter(|site| !self.completed_sites.iter().any(|id| id == &site.id))
            .count();
        let leg_progress = match self.phase {
            SimulationPhase::Travel => {
                let metrics = self.step_metrics(grid).unwrap_or_default();
                if metrics.is_empty() {
                    1.0
                } else {
                    ((self.point_index as f64 + 0.5) / metrics.len() as f64).clamp(0.0, 1.0)
                }
            }
            SimulationPhase::Activity | SimulationPhase::Complete => 1.0,
            SimulationPhase::Infeasible => 0.0,
        };
        SimulationView {
            state: self.clone(),
            position: self.position(grid),
            remaining_budget: budget,
            remaining_checks,
            return_margin_s,
            remaining_sites,
            leg_progress,
        }
    }

    /// Compact exportable record of the current simulated instant.
    pub fn record(&self, grid: &PlanningGrid) -> SimulationRecord {
        let view = self.view(grid);
        SimulationRecord {
            schema_version: self.schema_version,
            phase: self.phase,
            elapsed_s: self.elapsed_s,
            consumed: self.consumed.clone(),
            completed_sites: self.completed_sites.clone(),
            completed: self.completed.clone(),
            events: self.events.clone(),
            replans: self.replans,
            current_plan: self.plan.clone(),
            remaining_budget: view.remaining_budget,
            remaining_checks: view.remaining_checks,
            return_margin_s: view.return_margin_s,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::simulation_events::GridCellRef;
    use crate::planning::{plan_greedy, ScientificSite};
    use crate::provenance::EvidenceKind;
    use crate::resources::test_support::{bare_model, coef, time_only};
    use crate::route::test_support::{at, flat};
    use crate::route::BlockOverlay;

    fn site(grid: &PlanningGrid, id: &str, col: usize, row: usize) -> ScientificSite {
        ScientificSite {
            id: id.into(),
            name: id.into(),
            position: at(grid, col, row),
            science_rationale: "test fixture".into(),
            source_product_ids: vec![],
            evidence_kind: EvidenceKind::Synthetic,
            activity_min_s: 100.0,
            activity_max_s: 100.0,
            activity_power_w: 0.0,
            preference_weight: 1.0,
            required: false,
        }
    }

    fn scenario(grid: &PlanningGrid, sites: Vec<ScientificSite>) -> MissionScenario {
        MissionScenario {
            schema_version: 1,
            name: "fixture".into(),
            dataset_id: "synthetic".into(),
            base: at(grid, 2, 5),
            sites,
            budget: time_only(10_000.0, 100.0),
            model: bare_model(),
        }
    }

    fn start(grid: &PlanningGrid, scenario: MissionScenario) -> MissionState {
        let plan = plan_greedy(grid, &scenario);
        MissionState::start(grid, "synthetic", scenario, plan).unwrap()
    }

    /// Drop wall-clock measurements so structural replay equality is testable.
    fn without_wall_clock(mut state: MissionState) -> MissionState {
        state.initial_plan.timing = crate::planning::Timing::default();
        state.plan.timing = crate::planning::Timing::default();
        state
    }

    #[test]
    fn a_full_mission_moves_through_every_stop_and_back_to_base() {
        let grid = flat(31, 31, 1.0);
        let state_scenario = scenario(
            &grid,
            vec![site(&grid, "A", 6, 5), site(&grid, "B", 12, 5)],
        );
        let mut state = start(&grid, state_scenario.clone());
        let total = state.plan.totals.as_ref().unwrap().eva_time_s;
        // The plan clock starts at the overhead; the simulation starts there too.
        let advanced = state.advance(&grid, total).unwrap();
        let expected = total - state.scenario.model.overhead_s.value;
        assert!((advanced - expected).abs() < 1e-9);
        assert_eq!(state.phase, SimulationPhase::Complete);
        let mut completed = state.completed_sites.clone();
        completed.sort();
        assert_eq!(completed, vec!["A".to_string(), "B".to_string()]);

        let planned = &state_scenario;
        let used = &state.consumed;
        assert!((used.eva_time_s - total).abs() < 1e-6);
        assert!((used.distance_m - state.plan.totals.as_ref().unwrap().distance_m).abs() < 1e-6);
        assert!(used.energy_wh >= 0.0);
        let base = state.position(&grid);
        assert_eq!((base.x_m, base.y_m), (planned.base.x_m, planned.base.y_m));
    }

    #[test]
    fn advance_to_stop_stops_at_the_arrival_then_finishes_the_activity() {
        let grid = flat(31, 31, 1.0);
        let mut state = start(&grid, scenario(&grid, vec![site(&grid, "A", 12, 5)]));
        let arrival = state.plan.legs[0].leg.time_s;
        let advanced = state.advance_to_stop(&grid).unwrap();
        assert!((advanced - arrival).abs() < 1e-9);
        assert_eq!(state.phase, SimulationPhase::Activity);
        assert_eq!(state.activity_done_s, 0.0);
        assert_eq!(state.point_index, 0);
        let site = at(&grid, 12, 5);
        assert_eq!(state.position(&grid), site);

        let work = state.plan.stops[0].activity_s;
        let advanced = state.advance_to_stop(&grid).unwrap();
        assert!((advanced - work).abs() < 1e-9);
        assert_eq!(state.phase, SimulationPhase::Travel);
        assert_eq!(state.completed_sites, vec!["A".to_string()]);

        state.advance_to_stop(&grid).unwrap();
        assert_eq!(state.phase, SimulationPhase::Complete);
        assert_eq!(state.seconds_to_next_stop(&grid).unwrap(), 0.0);
        assert_eq!(state.position(&grid), at(&grid, 2, 5));
    }

    #[test]
    fn advance_to_stop_refuses_a_blocked_next_cell() {
        let grid = flat(31, 31, 1.0);
        let mut state = start(&grid, scenario(&grid, vec![site(&grid, "A", 12, 5)]));
        let next = state.plan.legs[0].leg.path[1];
        let (col, row) = grid.cell_of(next).unwrap();
        state
            .inject(&grid, ContingencyKind::BlockCells { cells: vec![GridCellRef { col, row }] })
            .unwrap();
        assert!(matches!(
            state.advance_to_stop(&grid),
            Err(SimulationError::BlockedAhead { col: c, row: r }) if (c, r) == (col, row)
        ));
    }

    #[test]
    fn resources_only_increase_while_advancing() {
        let grid = flat(31, 31, 1.0);
        let mut state = start(&grid, scenario(&grid, vec![site(&grid, "A", 12, 5)]));
        let mut previous = state.consumed.clone();
        for _ in 0..12 {
            state.advance(&grid, 20.0).unwrap();
            let now = state.consumed.clone();
            assert!(now.distance_m >= previous.distance_m);
            assert!(now.travel_time_s >= previous.travel_time_s);
            assert!(now.activity_time_s >= previous.activity_time_s);
            assert!(now.eva_time_s >= previous.eva_time_s);
            assert!(now.energy_wh >= previous.energy_wh);
            assert!(now.consumable >= previous.consumable);
            previous = now;
            if state.phase == SimulationPhase::Complete {
                break;
            }
        }
        assert_eq!(state.phase, SimulationPhase::Complete);
    }

    #[test]
    fn advancing_half_a_second_stops_between_waypoints() {
        let grid = flat(21, 21, 1.0);
        let mut state = start(&grid, scenario(&grid, vec![site(&grid, "A", 10, 5)]));
        state.advance(&grid, 0.5).unwrap();
        assert_eq!(state.point_index, 0);
        assert!((state.step_elapsed_s - 0.5).abs() < 1e-12);
        let p = state.position(&grid);
        assert!((p.x_m - 3.0).abs() < 1e-12);
        assert_eq!(state.phase, SimulationPhase::Travel);
    }

    #[test]
    fn a_delay_consumes_time_and_resources_but_not_science_progress() {
        let grid = flat(21, 21, 1.0);
        let mut state = start(&grid, scenario(&grid, vec![site(&grid, "A", 10, 5)]));
        state.advance(&grid, 8.0).unwrap();
        let before = state.consumed.clone();
        let event = state
            .inject(&grid, ContingencyKind::Delay { seconds: 60.0 })
            .unwrap();
        assert_eq!(event.at_elapsed_s, state.elapsed_s);
        assert!((state.consumed.eva_time_s - before.eva_time_s - 60.0).abs() < 1e-9);
        assert_eq!(state.completed_sites.len(), 0);
        assert_eq!(state.plan.stops.len(), 1);
    }

    #[test]
    fn a_block_ahead_stops_travel_until_replanning() {
        let grid = flat(21, 21, 1.0);
        let mut state = start(&grid, scenario(&grid, vec![site(&grid, "A", 15, 5)]));
        state.advance(&grid, 5.0).unwrap();
        let (col, row) = grid.cell_of(state.plan.legs[0].leg.path[state.point_index + 1]).unwrap();
        state
            .inject(
                &grid,
                ContingencyKind::BlockCells { cells: vec![GridCellRef { col, row }] },
            )
            .unwrap();
        let error = state.advance(&grid, 1.0).unwrap_err();
        assert_eq!(error, SimulationError::BlockedAhead { col, row });
        // Position and consumption are unchanged by the refused advance.
        assert_eq!(state.point_index, 5);
    }

    #[test]
    fn replanning_after_a_block_uses_the_current_position_and_keeps_completed_work() {
        let grid = flat(41, 41, 1.0);
        let mut state = start(
            &grid,
            scenario(&grid, vec![site(&grid, "A", 8, 5), site(&grid, "B", 30, 5)]),
        );
        // The baseline visits B first; walk there, finish its activity, and
        // start the return leg.
        state.advance(&grid, 28.0 + 100.0 + 2.0).unwrap();
        assert_eq!(state.completed_sites, vec!["B".to_string()]);
        let before = state.position(&grid);
        assert_eq!(state.phase, SimulationPhase::Travel);

        // Block the direct corridor west of B.
        let mut cells = Vec::new();
        for row in 0..41 {
            if row != 0 {
                cells.push(GridCellRef { col: 15, row });
            }
        }
        state.inject(&grid, ContingencyKind::BlockCells { cells }).unwrap();
        let revised = state.replan(&grid).unwrap();
        assert_eq!(revised.status, PlanStatus::FeasibleModeled);
        assert!(revised.stops.iter().all(|s| s.site_id != "B"));
        assert!(revised.stops.iter().any(|s| s.site_id == "A"));
        assert_eq!(revised.legs.first().unwrap().from, "CURRENT");
        // The new route starts where the astronaut actually is.
        let start = revised.legs.first().unwrap().leg.path.first().copied().unwrap();
        assert_eq!(grid.cell_of(start), grid.cell_of(before));
        // No leg crosses the blocked column except the detour row 0.
        for leg in &revised.legs {
            for point in &leg.leg.path {
                if let Some((col, row)) = grid.cell_of(*point) {
                    assert!(!(col == 15 && row != 0), "crossed block at {col},{row}");
                }
            }
        }
        assert_eq!(state.replans, 1);
        assert_eq!(state.leg_index, 0);
        assert_eq!(state.phase, SimulationPhase::Travel);
    }

    #[test]
    fn a_completed_site_is_never_repeated_after_replanning() {
        let grid = flat(31, 31, 1.0);
        let mut state = start(&grid, scenario(&grid, vec![site(&grid, "A", 10, 5)]));
        // Finish the activity and start walking home, without reaching it.
        state.advance(&grid, 110.0).unwrap();
        assert!(state.completed_sites.contains(&"A".to_string()));
        assert_eq!(state.phase, SimulationPhase::Travel);
        let revised = state.replan(&grid).unwrap();
        assert!(revised.stops.is_empty());
        assert_eq!(revised.status, PlanStatus::FeasibleModeled);
    }

    #[test]
    fn a_resource_loss_reduces_the_frozen_budget() {
        let grid = flat(21, 21, 1.0);
        let mut state = start(&grid, scenario(&grid, vec![site(&grid, "A", 10, 5)]));
        let before = state.scenario.budget.energy_budget_wh;
        assert_eq!(before, None);
        state
            .inject(
                &grid,
                ContingencyKind::ResourceLoss { resource: ResourceKind::EvaTime, amount: 500.0 },
            )
            .unwrap();
        assert_eq!(state.scenario.budget.eva_limit_s, 9500.0);
        assert_eq!(state.events.len(), 1);
    }

    #[test]
    fn an_unknown_resource_loss_is_refused() {
        let grid = flat(21, 21, 1.0);
        let mut state = start(&grid, scenario(&grid, vec![site(&grid, "A", 10, 5)]));
        let error = state
            .inject(
                &grid,
                ContingencyKind::ResourceLoss { resource: ResourceKind::Consumable, amount: 1.0 },
            )
            .unwrap_err();
        assert!(matches!(error, SimulationError::Contingency(_)));
    }

    #[test]
    fn a_second_injection_gets_a_monotonic_id() {
        let grid = flat(21, 21, 1.0);
        let mut state = start(&grid, scenario(&grid, vec![site(&grid, "A", 10, 5)]));
        let first = state.inject(&grid, ContingencyKind::Delay { seconds: 5.0 }).unwrap();
        let second = state.inject(&grid, ContingencyKind::Delay { seconds: 5.0 }).unwrap();
        assert_eq!((first.id, second.id), (1, 2));
        assert!(second.at_elapsed_s > first.at_elapsed_s);
    }

    #[test]
    fn the_same_operation_sequence_is_structurally_identical() {
        let grid = flat(31, 31, 1.0);
        let scenario = scenario(&grid, vec![site(&grid, "A", 8, 5), site(&grid, "B", 20, 9)]);
        let run = || {
            let mut state = start(&grid, scenario.clone());
            state.advance(&grid, 37.5).unwrap();
            state.inject(&grid, ContingencyKind::Delay { seconds: 45.0 }).unwrap();
            state
                .inject(
                    &grid,
                    ContingencyKind::BlockCells { cells: vec![GridCellRef { col: 12, row: 6 }] },
                )
                .unwrap();
            state.replan(&grid).unwrap();
            state.advance(&grid, 20.0).unwrap();
            state
        };
        assert_eq!(without_wall_clock(run()), without_wall_clock(run()));
    }

    #[test]
    fn advancing_past_the_end_caps_at_completion() {
        let grid = flat(21, 21, 1.0);
        let mut state = start(&grid, scenario(&grid, vec![site(&grid, "A", 6, 5)]));
        let advanced = state.advance(&grid, 1_000_000.0).unwrap();
        assert!(advanced < 1_000_000.0);
        assert_eq!(state.phase, SimulationPhase::Complete);
        assert_eq!(state.advance(&grid, 1.0), Err(SimulationError::MissionComplete));
    }

    #[test]
    fn a_mismatched_dataset_is_refused() {
        let grid = flat(9, 9, 1.0);
        let state = start(&grid, scenario(&grid, vec![site(&grid, "A", 4, 4)]));
        assert!(state.check_dataset("synthetic").is_ok());
        assert!(matches!(
            state.check_dataset("other"),
            Err(SimulationError::DifferentDataset { .. })
        ));
    }

    #[test]
    fn view_reports_remaining_budget_and_return_margin() {
        let grid = flat(21, 21, 1.0);
        let mut state = start(&grid, scenario(&grid, vec![site(&grid, "A", 10, 5)]));
        state.advance(&grid, 4.0).unwrap();
        let view = state.view(&grid);
        assert_eq!(view.state.completed_sites.len(), 0);
        assert_eq!(view.remaining_sites, 1);
        assert!(view.return_margin_s.unwrap() > 0.0);
        assert!(!view.remaining_checks.is_empty());
        assert!((view.position.x_m - 6.5).abs() < 1e-9);
    }

    #[test]
    fn overhead_is_charged_once_at_start() {
        let grid = flat(21, 21, 1.0);
        let mut scenario = scenario(&grid, vec![site(&grid, "A", 10, 5)]);
        scenario.model.overhead_s = coef(600.0, "s");
        scenario.budget = time_only(10_000.0, 0.0);
        let plan = plan_greedy(&grid, &scenario);
        let state = MissionState::start(&grid, "synthetic", scenario, plan).unwrap();
        assert_eq!(state.elapsed_s, 600.0);
        assert_eq!(state.consumed.eva_time_s, 600.0);
    }

    #[test]
    fn blocked_overlay_is_initialized_to_the_lattice_size() {
        let grid = flat(13, 13, 1.0);
        let state = start(&grid, scenario(&grid, vec![site(&grid, "A", 6, 6)]));
        assert_eq!(state.blocked.width, 13);
        assert_eq!(state.blocked.height, 13);
        assert_eq!(state.blocked, BlockOverlay::new(13, 13));
    }
}
