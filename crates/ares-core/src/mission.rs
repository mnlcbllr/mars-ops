//! MODELED execution on route waypoints, never interpolated off the lattice.
//! The shell owns a session snapshot; transitions are clone/validate/commit.
use crate::contingency::{CellRef, ContingencyError, ContingencyEvent, RemainingBudgets, ResourceKind};
use crate::planning::{plan_continuation, MissionResult, MissionScenario, PlanStatus, Timing};
use crate::resources::{check_budget, resource_use, Activity, ResourceBudget, ResourceUse};
use crate::route::edge_cost;
use crate::terrain::{PlanningGrid, TerrainClass};
use crate::LocalPoint;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "phase", rename_all = "SCREAMING_SNAKE_CASE")]
pub enum Phase {
    Overhead,
    Traveling { leg_index: usize, waypoint: usize },
    Working { leg_index: usize },
    Returned,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "SCREAMING_SNAKE_CASE")]
pub enum MissionAction {
    Advance { steps: usize },
    Inject { dataset_id: String, event: ContingencyEvent },
    Replan { exact: bool },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct TimelineEntry {
    pub at_s: f64,
    pub position: LocalPoint,
    pub action: MissionAction,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct PlanRevision {
    pub at_s: f64,
    pub position: LocalPoint,
    pub completed: Vec<String>,
    pub dropped: Vec<String>,
    pub plan: MissionResult,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct MissionState {
    pub scenario: MissionScenario,
    pub manifest_sha256: String,
    pub original_plan: MissionResult,
    /// Estimates for the remaining route, not total expedition consumption.
    pub plan: MissionResult,
    pub position: LocalPoint,
    pub phase: Phase,
    pub plan_valid: bool,
    pub completed: Vec<String>,
    pub utility_earned: f64,
    pub used: ResourceUse,
    /// Budgets after event losses but before simulated consumption and reserves.
    pub adjusted_budget: ResourceBudget,
    pub events: Vec<ContingencyEvent>,
    pub timeline: Vec<TimelineEntry>,
    pub revisions: Vec<PlanRevision>,
    /// Activity duration committed when the original mission started. Replans
    /// use these fixed durations for incomplete tasks; no utility for partial work.
    pub activity_durations_s: Vec<(String, f64)>,
}

#[derive(Debug, thiserror::Error)]
pub enum MissionError {
    #[error("InvalidMission: {0}")]
    Invalid(String),
    #[error("PlanNotFeasible: simulation requires a modeled feasible plan")]
    PlanNotFeasible,
    #[error("MissionReturned: reset to start another simulation")]
    Returned,
    #[error("PlanInvalidated: request Replan from here before advancing")]
    Invalidated,
    #[error(transparent)]
    Event(#[from] ContingencyError),
}

impl MissionState {
    /// Only call with a result produced by the core for this scenario/dataset.
    pub fn start(scenario: MissionScenario, mut plan: MissionResult, manifest_sha256: String) -> Result<Self, MissionError> {
        if plan.status != PlanStatus::FeasibleModeled || plan.legs.is_empty() {
            return Err(MissionError::PlanNotFeasible);
        }
        // Wall-clock measurements are not replay state.
        plan.timing = Timing::default();
        let position = plan.legs[0].leg.path[0];
        let adjusted_budget = scenario.budget.clone();
        let mut model = scenario.model.clone();
        model.overhead_s.value = 0.0;
        let used = resource_use(&model, 0.0, 0.0, &[]);
        let activity_durations_s = scenario.sites.iter().map(|s| (
            s.id.clone(), plan.stops.iter().find(|p| p.site_id == s.id).map_or(s.activity_min_s, |p| p.activity_s)
        )).collect();
        Ok(Self { scenario, manifest_sha256, original_plan: plan.clone(), plan,
            position, phase: Phase::Overhead, plan_valid: true, completed: vec![],
            utility_earned: 0.0, used, adjusted_budget, events: vec![], timeline: vec![],
            revisions: vec![], activity_durations_s })
    }

    pub fn blocked_set(&self, grid: &PlanningGrid) -> HashSet<usize> {
        self.events.iter().flat_map(|e| match e {
            ContingencyEvent::BlockCells { cells, .. } => cells.as_slice(),
            _ => &[],
        }).map(|c| grid.index(c.col, c.row)).collect()
    }

    /// Signed balances; deficits must remain visible, not clamped to zero.
    pub fn remaining(&self) -> ResourceBudget {
        let mut budget = self.adjusted_budget.clone();
        budget.eva_limit_s -= self.used.eva_time_s;
        budget.energy_budget_wh = budget.energy_budget_wh.map(|b| b - self.used.energy_wh);
        budget.consumable_budget = budget.consumable_budget.map(|b| b - self.used.consumable);
        budget
    }

    pub fn apply(&self, grid: &PlanningGrid, action: MissionAction) -> Result<Self, MissionError> {
        if self.phase == Phase::Returned { return Err(MissionError::Returned); }
        let mut next = self.clone();
        match &action {
            MissionAction::Advance { steps } => {
                if !self.plan_valid { return Err(MissionError::Invalidated); }
                if !(1..=4096).contains(steps) { return Err(MissionError::Invalid("advance steps must be 1–4096".into())); }
                for _ in 0..*steps {
                    if next.phase == Phase::Returned { break; }
                    next.step(grid)?;
                }
            }
            MissionAction::Inject { dataset_id, event } => {
                if dataset_id != &self.scenario.dataset_id { return Err(MissionError::Invalid("event dataset mismatch".into())); }
                let balance = self.remaining();
                let remaining = RemainingBudgets { eva_time_s: Some(balance.eva_limit_s.max(0.0)),
                    energy_wh: balance.energy_budget_wh.map(|v| v.max(0.0)), consumable: balance.consumable_budget.map(|v| v.max(0.0)) };
                let (col, row) = grid.cell_of(self.position).ok_or_else(|| MissionError::Invalid("current position outside coverage".into()))?;
                event.validate(grid.width, grid.height, Some(CellRef { col, row }), &remaining)?;
                match event {
                    ContingencyEvent::BlockCells { cells, .. } => {
                        for cell in cells {
                            if grid.classify(grid.cell_center(cell.col, cell.row), self.scenario.model.max_slope_deg.value).0 != TerrainClass::Traversable {
                                return Err(MissionError::Invalid("blockage must select known passable cells".into()));
                            }
                        }
                    }
                    ContingencyEvent::Delay { seconds, .. } => next.consume(0.0, 0.0, &[], *seconds),
                    ContingencyEvent::ResourceAdjustment { resource, amount, .. } => match resource {
                        ResourceKind::EvaTime => next.adjusted_budget.eva_limit_s -= amount,
                        ResourceKind::Energy => *next.adjusted_budget.energy_budget_wh.as_mut().unwrap() -= amount,
                        ResourceKind::Consumable => *next.adjusted_budget.consumable_budget.as_mut().unwrap() -= amount,
                    },
                }
                next.events.push(event.clone());
                next.plan_valid = false;
            }
            MissionAction::Replan { exact } => next.replan(grid, *exact),
        }
        next.timeline.push(TimelineEntry { at_s: self.used.eva_time_s, position: self.position, action });
        Ok(next)
    }

    fn consume(&mut self, distance: f64, travel: f64, activities: &[Activity], overhead: f64) {
        let mut model = self.scenario.model.clone();
        model.overhead_s.value = overhead;
        let use_ = resource_use(&model, distance, travel, activities);
        self.used.distance_m += use_.distance_m;
        self.used.travel_time_s += use_.travel_time_s;
        self.used.activity_time_s += use_.activity_time_s;
        self.used.overhead_s += use_.overhead_s;
        self.used.eva_time_s += use_.eva_time_s;
        self.used.energy_wh += use_.energy_wh;
        self.used.consumable += use_.consumable;
    }

    fn step(&mut self, grid: &PlanningGrid) -> Result<(), MissionError> {
        match self.phase.clone() {
            Phase::Overhead => {
                self.consume(0.0, 0.0, &[], self.scenario.model.overhead_s.value);
                self.phase = Phase::Traveling { leg_index: 0, waypoint: 0 };
            }
            Phase::Traveling { leg_index, waypoint } => {
                let leg = &self.plan.legs[leg_index];
                if let Some(&to) = leg.leg.path.get(waypoint + 1) {
                    let (distance, time) = edge_cost(grid, &self.scenario.model.traversal(), self.position, to, &self.blocked_set(grid))
                        .map_err(|e| MissionError::Invalid(e.to_string()))?;
                    self.consume(distance, time, &[], 0.0);
                    self.position = to;
                    self.phase = Phase::Traveling { leg_index, waypoint: waypoint + 1 };
                } else if leg.to == "BASE" {
                    self.phase = Phase::Returned;
                } else {
                    self.phase = Phase::Working { leg_index };
                }
            }
            Phase::Working { leg_index } => {
                let stop = self.plan.stops[leg_index].clone();
                if self.completed.contains(&stop.site_id) { return Err(MissionError::Invalid("task already completed".into())); }
                let site = self.scenario.sites.iter().find(|s| s.id == stop.site_id).unwrap();
                let power_w = site.activity_power_w;
                self.consume(0.0, 0.0, &[Activity { duration_s: stop.activity_s, power_w }], 0.0);
                self.completed.push(stop.site_id);
                self.utility_earned += stop.utility;
                self.phase = Phase::Traveling { leg_index: leg_index + 1, waypoint: 0 };
            }
            Phase::Returned => {},
        }
        if check_budget(&self.used, &self.adjusted_budget).iter().any(|c| !c.satisfied) {
            return Err(MissionError::Invalid("advancement would breach a declared reserve".into()));
        }
        Ok(())
    }

    fn replan(&mut self, grid: &PlanningGrid, exact: bool) {
        let mut scenario = self.scenario.clone();
        scenario.budget = self.remaining();
        // Unconsumed start overhead is still required; once started it is zero.
        if self.phase != Phase::Overhead { scenario.model.overhead_s.value = 0.0; }
        scenario.sites.retain(|s| !self.completed.contains(&s.id));
        for site in &mut scenario.sites {
            let duration = self.activity_durations_s.iter().find(|(id, _)| id == &site.id).unwrap().1;
            // Preserve the original linear utility denominator when fixing duration.
            site.preference_weight *= duration / site.activity_max_s;
            site.activity_min_s = duration;
            site.activity_max_s = duration;
        }
        let mut plan = plan_continuation(grid, &scenario, &self.blocked_set(grid), self.position, exact);
        plan.timing = Timing::default();
        let dropped = self.plan.stops.iter().filter(|s| !self.completed.contains(&s.site_id)
            && !plan.stops.iter().any(|p| p.site_id == s.site_id)).map(|s| s.site_id.clone()).collect();
        for stop in &mut plan.stops { stop.arrive_s += self.used.eva_time_s; stop.depart_s += self.used.eva_time_s; }
        self.plan_valid = plan.status == PlanStatus::FeasibleModeled;
        self.revisions.push(PlanRevision { at_s: self.used.eva_time_s, position: self.position,
            completed: self.completed.clone(), dropped, plan: plan.clone() });
        self.plan = plan;
        if self.plan_valid && self.phase != Phase::Overhead {
            self.phase = Phase::Traveling { leg_index: 0, waypoint: 0 };
        }
    }
}
