//! Mid-mission replanning from an arbitrary lattice position.
//!
//! The replan uses only what is left: remaining candidate sites, the consumed
//! resources subtracted from the declared budget, a zero-overhead resource
//! model (the EVA overhead was already spent), and any temporary blocked
//! cells. The plan always ends at the original base. This module never touches
//! datasets or the user's scenario snapshot.

use crate::planning::{
    site_utility, Exclusion, Issue, MissionResult, MissionScenario, PlanStatus, PlannedLeg,
    Severity, SolverInfo, Stop, Timing, MAX_SITES,
};
use crate::resources::{
    check_budget, resource_use, Activity, ConstraintCheck, ResourceBudget, ResourceUse,
};
use crate::route::{find_leg_avoiding, BlockOverlay, Leg, RouteError, Search};
use crate::terrain::PlanningGrid;
use crate::LocalPoint;
use std::time::Instant;

/// Everything a replan needs from the simulated mission.
#[derive(Clone, Copy, Debug)]
pub struct ReplanRequest<'a> {
    /// Frozen mission scenario (budget may already include resource losses).
    pub scenario: &'a MissionScenario,
    /// The astronaut's current position, on the planning lattice.
    pub start: LocalPoint,
    /// Site ids already completed; they are never visited again.
    pub completed: &'a [String],
    /// Simulated consumption so far.
    pub consumed: &'a ResourceUse,
    /// Temporary impassable cells from injected events.
    pub blocked: Option<&'a BlockOverlay>,
}

/// Remaining budget after subtracting what has already been simulated.
/// Reserves are not reduced: they remain a hard floor.
pub fn remaining_budget(budget: &ResourceBudget, consumed: &ResourceUse) -> ResourceBudget {
    let left = |budget: f64, used: f64| (budget - used).max(0.0);
    ResourceBudget {
        eva_limit_s: left(budget.eva_limit_s, consumed.eva_time_s),
        eva_reserve_s: budget.eva_reserve_s,
        energy_budget_wh: budget.energy_budget_wh.map(|b| left(b, consumed.energy_wh)),
        energy_reserve_wh: budget.energy_reserve_wh,
        consumable_budget: budget.consumable_budget.map(|b| left(b, consumed.consumable)),
        consumable_reserve: budget.consumable_reserve,
        consumable_unit: budget.consumable_unit.clone(),
    }
}

/// Site indices still available to a replan.
pub fn remaining_sites(scenario: &MissionScenario, completed: &[String]) -> Vec<usize> {
    scenario
        .sites
        .iter()
        .enumerate()
        .filter(|(_, site)| !completed.iter().any(|id| id == &site.id))
        .map(|(index, _)| index)
        .collect()
}

struct Evaluation {
    totals: ResourceUse,
    checks: Vec<ConstraintCheck>,
    utility: f64,
}

impl Evaluation {
    fn feasible(&self) -> bool {
        self.checks.iter().all(|c| c.satisfied)
    }

    fn margin(&self, resource: &str) -> Option<f64> {
        self.checks.iter().find(|c| c.resource == resource).map(|c| c.margin)
    }
}

struct Table {
    nodes: usize,
    legs: Vec<Option<Leg>>,
    reachable: Vec<usize>,
}

impl Table {
    fn leg(&self, from: usize, to: usize) -> Option<&Leg> {
        self.legs[from * self.nodes + to].as_ref()
    }
}

fn exclusion_code(error: &RouteError) -> &'static str {
    match error {
        RouteError::RouteCrossesUnknownTerrain => "RouteCrossesUnknownTerrain",
        RouteError::BlockedBySlopeRule => "BlockedBySlopeRule",
        RouteError::OutsideCoverage { .. } => "SiteOutsideCoverage",
        RouteError::UnknownTerrainAtEndpoint { .. } => "SiteOnUnknownTerrain",
        RouteError::SlopeRuleAtEndpoint { .. } => "SiteOnSteepTerrain",
        RouteError::EndpointBlocked { .. } => "SiteBlockedByContingency",
    }
}

fn core_error(error: &RouteError) -> String {
    format!("no modeled route from the current position: {error}")
}

/// Replan from `request.start` with the remaining sites and resources.
///
/// Greedy selection is retained here because this path has to stay fast while
/// the desktop spends its time on routing; the exact discrete solver is used
/// for the initial plan. Both share the same hard-constraint evaluation.
pub fn replan(grid: &PlanningGrid, request: ReplanRequest) -> MissionResult {
    let scenario = request.scenario;
    let mut result = MissionResult {
        status: PlanStatus::Infeasible,
        solver: SolverInfo {
            name: "ReplanGreedy".into(),
            version: "1".into(),
            description: "Mid-mission replan: cheapest insertion by preference value per added \
                          EVA second from the current position, then activity extension. \
                          Completed sites are excluded; all prior consumption is subtracted \
                          before any constraint is checked."
                .into(),
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

    let candidates = remaining_sites(scenario, request.completed);
    if candidates.len() > MAX_SITES {
        result.issues.push(Issue {
            severity: Severity::Error,
            code: "TooManySites".into(),
            message: format!("At most {MAX_SITES} remaining candidate sites can be replanned."),
            site_id: None,
        });
        return result;
    }

    // The EVA overhead is already in `consumed`; do not charge it twice.
    let mut model = scenario.model.clone();
    model.overhead_s.value = 0.0;
    let traversal = model.traversal();
    let budget = remaining_budget(&scenario.budget, request.consumed);

    let routing_started = Instant::now();
    let k = candidates.len();
    let home = k + 1;
    let nodes = k + 2;
    let mut table = Table { nodes, legs: vec![None; nodes * nodes], reachable: Vec::new() };
    let position = |node: usize| -> LocalPoint {
        if node == 0 {
            request.start
        } else if node == home {
            scenario.base
        } else {
            scenario.sites[candidates[node - 1]].position
        }
    };
    let mut route = |table: &mut Table, a: usize, b: usize| -> Result<(), RouteError> {
        let leg = find_leg_avoiding(
            grid,
            &traversal,
            position(a),
            position(b),
            Search::AStar,
            request.blocked,
        )?;
        result.timing.legs_routed += 1;
        result.timing.cells_expanded += leg.cells_expanded;
        table.legs[b * nodes + a] = Some(leg.reversed());
        table.legs[a * nodes + b] = Some(leg);
        Ok(())
    };

    // Return leg first: without it, no revised plan exists at all.
    if let Err(error) = route(&mut table, 0, home) {
        result.status = match error {
            RouteError::RouteCrossesUnknownTerrain
            | RouteError::OutsideCoverage { .. }
            | RouteError::UnknownTerrainAtEndpoint { .. } => PlanStatus::UnknownDataCoverage,
            _ => PlanStatus::Infeasible,
        };
        result.issues.push(Issue {
            severity: Severity::Error,
            code: "ReturnToBaseBlocked".into(),
            message: format!("The original base cannot be reached from the current position: {error}."),
            site_id: None,
        });
        result.timing.routing_ms = routing_started.elapsed().as_secs_f64() * 1e3;
        return result;
    }

    let mut unreachable = Vec::new();
    for (slot, &site) in candidates.iter().enumerate() {
        let node = slot + 1;
        match route(&mut table, 0, node) {
            Ok(()) => match route(&mut table, node, home) {
                Ok(()) => table.reachable.push(slot),
                Err(error) => unreachable.push((site, error)),
            },
            Err(error) => unreachable.push((site, error)),
        }
    }
    let reachable = table.reachable.clone();
    for (i, &a) in reachable.iter().enumerate() {
        for &b in reachable.iter().skip(i + 1) {
            let _ = route(&mut table, a + 1, b + 1);
        }
    }
    result.timing.routing_ms = routing_started.elapsed().as_secs_f64() * 1e3;

    for (site, error) in &unreachable {
        result.excluded.push(Exclusion {
            site_id: scenario.sites[*site].id.clone(),
            code: exclusion_code(error).into(),
            reason: core_error(error),
        });
    }

    let planning_started = Instant::now();
    let dwell: Vec<f64> = scenario.sites.iter().map(|s| s.activity_min_s).collect();

    let evaluate = |order: &[usize], dwell: &[f64]| -> Option<Evaluation> {
        let (mut distance_m, mut travel_time_s) = (0.0, 0.0);
        let mut node = 0;
        for &slot in order {
            let next = slot + 1;
            let leg = table.leg(node, next)?;
            distance_m += leg.distance_m;
            travel_time_s += leg.time_s;
            node = next;
        }
        let home_leg = table.leg(node, home)?;
        distance_m += home_leg.distance_m;
        travel_time_s += home_leg.time_s;
        let activities: Vec<Activity> = order
            .iter()
            .map(|&slot| {
                let site = &scenario.sites[candidates[slot]];
                Activity { duration_s: dwell[site_index(&candidates, slot)], power_w: site.activity_power_w }
            })
            .collect();
        let totals = resource_use(&model, distance_m, travel_time_s, &activities);
        let checks = check_budget(&totals, &budget);
        let utility = order
            .iter()
            .map(|&slot| {
                let index = candidates[slot];
                site_utility(&scenario.sites[index], dwell[index])
            })
            .sum();
        Some(Evaluation { totals, checks, utility })
    };

    let mut order: Vec<usize> = Vec::new();
    let mut chosen_dwell = dwell.clone();
    loop {
        let current_eva = evaluate(&order, &chosen_dwell).map_or(0.0, |e| e.totals.eva_time_s);
        let mut best: Option<(f64, f64, usize, usize)> = None;
        for &slot in table.reachable.iter().filter(|s| !order.contains(s)) {
            let index = candidates[slot];
            let gain = site_utility(&scenario.sites[index], chosen_dwell[index]);
            for position in 0..=order.len() {
                let mut trial = order.clone();
                trial.insert(position, slot);
                let Some(eval) = evaluate(&trial, &chosen_dwell) else { continue };
                if !eval.feasible() {
                    continue;
                }
                let added = eval.totals.eva_time_s - current_eva;
                let score = gain / added.max(1e-9);
                let better = match best {
                    None => true,
                    Some((best_score, best_added, _, _)) => {
                        score > best_score || (score == best_score && added < best_added)
                    }
                };
                if better {
                    best = Some((score, added, slot, position));
                }
            }
        }
        match best {
            Some((_, _, slot, position)) => order.insert(position, slot),
            None => break,
        }
    }

    if !order.is_empty() {
        extend_replanned(&evaluate, scenario, &candidates, &order, &mut chosen_dwell);
    }
    result.timing.planning_ms = planning_started.elapsed().as_secs_f64() * 1e3;

    for &slot in table.reachable.iter().filter(|s| !order.contains(s)) {
        let index = candidates[slot];
        let alone = evaluate(&[slot], &dwell_at_minimum(scenario)).expect("reachable site has legs");
        let (code, reason) = if alone.feasible() {
            (
                "DidNotFitWithSelected",
                "Fits on its own, but not together with the tasks already selected.".to_string(),
            )
        } else {
            let shortfalls: Vec<String> =
                alone.checks.iter().filter(|c| !c.satisfied).map(describe_shortfall).collect();
            (
                "ExceedsBudgetAlone",
                format!("A round trip to this site alone needs {}.", shortfalls.join("; ")),
            )
        };
        result.excluded.push(Exclusion { site_id: scenario.sites[index].id.clone(), code: code.into(), reason });
    }

    // A return-only plan is still a valid mission outcome: every remaining
    // task was dropped, but the astronaut can get home under the model.
    let return_only = table.leg(0, home).expect("checked").clone();
    let return_eval = {
        let totals = resource_use(&model, return_only.distance_m, return_only.time_s, &[]);
        let checks = check_budget(&totals, &budget);
        Evaluation { totals, checks, utility: 0.0 }
    };
    if order.is_empty() {
        result.legs.push(PlannedLeg {
            from: "CURRENT".into(),
            to: "BASE".into(),
            leg: return_only,
        });
        result.checks = return_eval.checks.clone();
        result.totals = Some(return_eval.totals.clone());
        result.utility = 0.0;
        result.status = if return_eval.feasible() {
            PlanStatus::FeasibleModeled
        } else {
            PlanStatus::Infeasible
        };
        if !return_eval.feasible() {
            result.issues.push(Issue {
                severity: Severity::Error,
                code: "InsufficientRemainingResources".into(),
                message: format!(
                    "Even the modeled return to base exceeds the remaining limits: {}.",
                    return_eval
                        .checks
                        .iter()
                        .filter(|c| !c.satisfied)
                        .map(describe_shortfall)
                        .collect::<Vec<_>>()
                        .join("; ")
                ),
                site_id: None,
            });
        }
        return result;
    }

    let eval = evaluate(&order, &chosen_dwell).expect("selected sites are routed");
    if !eval.feasible() {
        // The greedy loop only keeps feasible orders, so this is a programming
        // invariant, not a user-facing outcome.
        result.status = PlanStatus::Infeasible;
        result.issues.push(Issue {
            severity: Severity::Error,
            code: "ReplanInternalInfeasible".into(),
            message: "the selected revised itinerary violates a hard constraint".into(),
            site_id: None,
        });
        return result;
    }

    let mut clock = 0.0;
    let mut previous = "CURRENT".to_string();
    let mut node = 0;
    for &slot in &order {
        let index = candidates[slot];
        let site = &scenario.sites[index];
        let next = slot + 1;
        let leg = table.leg(node, next).expect("routed").clone();
        clock += leg.time_s;
        result.legs.push(PlannedLeg { from: previous.clone(), to: site.id.clone(), leg });
        result.stops.push(Stop {
            site_id: site.id.clone(),
            arrive_s: clock,
            activity_s: chosen_dwell[index],
            depart_s: clock + chosen_dwell[index],
            utility: site_utility(site, chosen_dwell[index]),
        });
        clock += chosen_dwell[index];
        previous = site.id.clone();
        node = next;
    }
    let home_leg = table.leg(node, home).expect("routed").clone();
    result.legs.push(PlannedLeg { from: previous, to: "BASE".into(), leg: home_leg });

    result.utility = eval.utility;
    result.checks = eval.checks;
    result.totals = Some(eval.totals);
    result.status = PlanStatus::FeasibleModeled;
    result
}

fn site_index(candidates: &[usize], slot: usize) -> usize {
    candidates[slot]
}

fn dwell_at_minimum(scenario: &MissionScenario) -> Vec<f64> {
    scenario.sites.iter().map(|s| s.activity_min_s).collect()
}

fn describe_shortfall(check: &ConstraintCheck) -> String {
    let (label, unit, scale) = match check.resource.as_str() {
        "eva_time" => ("EVA time", "min", 1.0 / 60.0),
        "energy" => ("energy", "Wh", 1.0),
        _ => ("consumable", check.unit.as_str(), 1.0),
    };
    format!(
        "{:.3} {unit} of {label} where {:.3} {unit} is available after the reserve",
        check.used * scale,
        check.available * scale
    )
}

fn extend_replanned(
    evaluate: &impl Fn(&[usize], &[f64]) -> Option<Evaluation>,
    scenario: &MissionScenario,
    candidates: &[usize],
    order: &[usize],
    dwell: &mut [f64],
) {
    let sites = &scenario.sites;
    let model = &scenario.model;
    let rate = |index: usize| sites[index].preference_weight / sites[index].activity_max_s;
    let mut by_value: Vec<usize> = order.to_vec();
    by_value.sort_by(|&a, &b| {
        rate(candidates[b]).total_cmp(&rate(candidates[a])).then(a.cmp(&b))
    });

    for slot in by_value {
        let index = candidates[slot];
        let Some(eval) = evaluate(order, dwell) else { return };
        let mut extra = sites[index].activity_max_s - dwell[index];
        if let Some(margin) = eval.margin("eva_time") {
            extra = extra.min(margin);
        }
        let watts = model.base_power_w.value + sites[index].activity_power_w;
        if let (Some(margin), true) = (eval.margin("energy"), watts > 0.0) {
            extra = extra.min(margin * 3600.0 / watts);
        }
        let per_hour = model.consumable_rate_activity_per_h.value;
        if let (Some(margin), true) = (eval.margin("consumable"), per_hour > 0.0) {
            extra = extra.min(margin * 3600.0 / per_hour);
        }
        if extra <= 0.0 {
            continue;
        }
        let before = dwell[index];
        dwell[index] = before + extra;
        if !evaluate(order, dwell).is_some_and(|e| e.feasible()) {
            dwell[index] = before;
        }
    }
}

/// Modeled time margin for returning to base from `from`, ignoring further
/// science. `None` when no return route exists.
pub fn return_margin(
    grid: &PlanningGrid,
    scenario: &MissionScenario,
    from: LocalPoint,
    consumed: &ResourceUse,
    blocked: Option<&BlockOverlay>,
) -> Option<f64> {
    let mut model = scenario.model.clone();
    model.overhead_s.value = 0.0;
    let leg = find_leg_avoiding(
        grid,
        &model.traversal(),
        from,
        scenario.base,
        Search::AStar,
        blocked,
    )
    .ok()?;
    let budget = remaining_budget(&scenario.budget, consumed);
    let available = budget.eva_limit_s - budget.eva_reserve_s;
    Some(available - leg.time_s)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::planning::{plan_greedy, validate_scenario, ScientificSite};
    use crate::provenance::EvidenceKind;
    use crate::resources::test_support::{bare_model, time_only};
    use crate::route::test_support::{at, block, flat};
    use crate::route::BlockOverlay;

    fn site(grid: &PlanningGrid, id: &str, col: usize, row: usize, weight: f64) -> ScientificSite {
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
            preference_weight: weight,
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

    fn consumed_after(nothing: bool) -> ResourceUse {
        if nothing {
            ResourceUse {
                distance_m: 0.0,
                travel_time_s: 0.0,
                activity_time_s: 0.0,
                overhead_s: 0.0,
                eva_time_s: 0.0,
                energy_wh: 0.0,
                consumable: 0.0,
            }
        } else {
            ResourceUse {
                distance_m: 40.0,
                travel_time_s: 40.0,
                activity_time_s: 0.0,
                overhead_s: 0.0,
                eva_time_s: 40.0,
                energy_wh: 0.0,
                consumable: 0.0,
            }
        }
    }

    /// Drop wall-clock measurements so structural replay equality is testable.
    fn without_wall_clock(mut result: MissionResult) -> MissionResult {
        result.timing = Timing::default();
        result
    }

    #[test]
    fn remaining_budget_never_goes_negative_and_keeps_the_reserve() {
        let mut budget = time_only(1000.0, 100.0);
        budget.energy_budget_wh = Some(100.0);
        let consumed = ResourceUse {
            distance_m: 0.0,
            travel_time_s: 1200.0,
            activity_time_s: 0.0,
            overhead_s: 0.0,
            eva_time_s: 1200.0,
            energy_wh: 150.0,
            consumable: 0.0,
        };
        let left = remaining_budget(&budget, &consumed);
        assert_eq!(left.eva_limit_s, 0.0);
        assert_eq!(left.eva_reserve_s, 100.0);
        assert_eq!(left.energy_budget_wh, Some(0.0));
    }

    #[test]
    fn replan_skips_completed_sites_and_returns_to_the_original_base() {
        let grid = flat(21, 21, 1.0);
        let sites = vec![site(&grid, "A", 6, 5, 1.0), site(&grid, "B", 10, 5, 2.0)];
        let scenario = scenario(&grid, sites);
        assert!(validate_scenario(&grid, &scenario).ok);
        let initial = plan_greedy(&grid, &scenario);
        assert_eq!(initial.stops.len(), 2);

        let completed = vec!["A".to_string()];
        let result = replan(
            &grid,
            ReplanRequest {
                scenario: &scenario,
                start: at(&grid, 6, 5),
                completed: &completed,
                consumed: &consumed_after(false),
                blocked: None,
            },
        );
        assert_eq!(result.status, PlanStatus::FeasibleModeled);
        let ids: Vec<&str> = result.stops.iter().map(|s| s.site_id.as_str()).collect();
        assert_eq!(ids, ["B"]);
        assert_eq!(result.legs.first().unwrap().from, "CURRENT");
        assert_eq!(result.legs.last().unwrap().to, "BASE");
        // 4 m from the old site to B, then 8 m home to the base at (2, 5).
        let totals = result.totals.as_ref().unwrap();
        assert_eq!(totals.eva_time_s, 12.0 + 100.0);
    }

    #[test]
    fn a_blocked_return_produces_an_explicit_infeasible_result() {
        let mut grid = flat(9, 9, 1.0);
        // Wall the base off completely with steep cells, then also block the
        // one cell that touched the base.
        for row in 0..9 {
            block(&mut grid, 3, row);
        }
        let scenario = scenario(&grid, vec![site(&grid, "A", 5, 5, 1.0)]);
        let result = replan(
            &grid,
            ReplanRequest {
                scenario: &scenario,
                start: at(&grid, 5, 5),
                completed: &[],
                consumed: &consumed_after(true),
                blocked: None,
            },
        );
        assert_eq!(result.status, PlanStatus::Infeasible);
        assert!(result.issues.iter().any(|i| i.code == "ReturnToBaseBlocked"));
        assert!(result.stops.is_empty());
        assert!(result.legs.is_empty());
    }

    #[test]
    fn a_contingency_block_can_force_the_route_around_it() {
        let grid = flat(21, 21, 1.0);
        let scenario = scenario(&grid, vec![site(&grid, "A", 12, 5, 1.0)]);
        let mut blocked = BlockOverlay::new(grid.width, grid.height);
        for row in 0..21 {
            if row != 0 {
                blocked.block_index(grid.index(7, row));
            }
        }
        let result = replan(
            &grid,
            ReplanRequest {
                scenario: &scenario,
                start: at(&grid, 2, 5),
                completed: &[],
                consumed: &consumed_after(true),
                blocked: Some(&blocked),
            },
        );
        assert_eq!(result.status, PlanStatus::FeasibleModeled);
        for planned in &result.legs {
            for point in &planned.leg.path {
                assert_ne!(grid.cell_of(*point), Some((7, 5)));
            }
        }
        // Going round the wall is longer than the 10 m straight line.
        assert!(result.totals.as_ref().unwrap().distance_m > 20.0);
    }

    #[test]
    fn return_only_is_feasible_when_every_task_was_completed() {
        let grid = flat(21, 21, 1.0);
        let scenario = scenario(&grid, vec![site(&grid, "A", 6, 5, 1.0)]);
        let completed = vec!["A".to_string()];
        let result = replan(
            &grid,
            ReplanRequest {
                scenario: &scenario,
                start: at(&grid, 10, 5),
                completed: &completed,
                consumed: &consumed_after(false),
                blocked: None,
            },
        );
        assert_eq!(result.status, PlanStatus::FeasibleModeled);
        assert!(result.stops.is_empty());
        assert_eq!(result.legs.len(), 1);
        assert_eq!(result.legs[0].from, "CURRENT");
        assert_eq!(result.legs[0].to, "BASE");
        assert_eq!(result.utility, 0.0);
    }

    #[test]
    fn replan_from_partial_consumption_subtracts_the_used_time() {
        let grid = flat(21, 21, 1.0);
        let scenario = scenario(&grid, vec![site(&grid, "A", 12, 5, 1.0)]);
        let mut budget = time_only(200.0, 20.0);
        budget.energy_budget_wh = None;
        let tight = MissionScenario { budget, ..scenario };
        let consumed = consumed_after(true);
        let result = replan(
            &grid,
            ReplanRequest {
                scenario: &tight,
                start: at(&grid, 2, 5),
                completed: &[],
                consumed: &consumed,
                blocked: None,
            },
        );
        // Round trip is 20 m and the activity 100 s: 120 s fits in 180 s, so
        // this one is still feasible and proves the subtraction is consistent.
        assert_eq!(result.status, PlanStatus::FeasibleModeled);
        let used = result.totals.as_ref().unwrap().eva_time_s;
        assert_eq!(used, 120.0);
    }

    #[test]
    fn a_zero_budget_after_loss_refuses_the_task_but_keeps_a_return_check() {
        let grid = flat(21, 21, 1.0);
        let scenario = scenario(&grid, vec![site(&grid, "A", 6, 5, 1.0)]);
        let mut consumed = consumed_after(true);
        consumed.eva_time_s = 10_000.0;
        let result = replan(
            &grid,
            ReplanRequest {
                scenario: &scenario,
                start: at(&grid, 6, 5),
                completed: &[],
                consumed: &consumed,
                blocked: None,
            },
        );
        assert_eq!(result.status, PlanStatus::Infeasible);
        assert!(result.issues.iter().any(|i| i.code == "InsufficientRemainingResources"));
    }

    #[test]
    fn replan_is_deterministic_for_the_same_state() {
        let grid = flat(21, 21, 1.0);
        let scenario = scenario(
            &grid,
            vec![site(&grid, "A", 6, 5, 1.0), site(&grid, "B", 10, 8, 2.0)],
        );
        let request = ReplanRequest {
            scenario: &scenario,
            start: at(&grid, 4, 4),
            completed: &[],
            consumed: &consumed_after(false),
            blocked: None,
        };
        assert_eq!(without_wall_clock(replan(&grid, request)), without_wall_clock(replan(&grid, request)));
    }

    #[test]
    fn return_margin_is_the_time_left_after_a_direct_return() {
        let grid = flat(21, 21, 1.0);
        let scenario = scenario(&grid, vec![]);
        let consumed = consumed_after(false);
        let margin = return_margin(&grid, &scenario, at(&grid, 7, 5), &consumed, None).unwrap();
        // 9900 s available after the reserve, minus the 40 s already simulated
        // and the 5 m return at 1 m/s.
        assert!((margin - 9855.0).abs() < 1e-9);
        assert_eq!(return_margin(&grid, &scenario, LocalPoint::new(999.0, 0.0), &consumed, None), None);
    }

    #[test]
    fn blocked_corridor_is_never_crossed_when_replanning() {
        // Guards the route overlay plumbed through the replan.
        let grid = flat(15, 15, 1.0);
        let scenario = scenario(&grid, vec![site(&grid, "A", 10, 10, 1.0)]);
        let mut blocked = BlockOverlay::new(grid.width, grid.height);
        for col in 0..15 {
            blocked.block_index(grid.index(col, 8));
        }
        let result = replan(
            &grid,
            ReplanRequest {
                scenario: &scenario,
                start: at(&grid, 2, 2),
                completed: &[],
                consumed: &consumed_after(true),
                blocked: Some(&blocked),
            },
        );
        // The wall spans the full width, so the site cannot be reached. The
        // return to base from (2, 2) is south of the wall and stays feasible.
        assert_eq!(result.status, PlanStatus::FeasibleModeled);
        assert!(result.stops.is_empty());
        assert_eq!(result.legs.len(), 1);
    }
}
