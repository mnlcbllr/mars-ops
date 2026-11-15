//! Mission scenario, validation and the deterministic greedy baseline planner.
//!
//! The planning problem: choose an ordered subset of candidate science sites
//! and an activity duration at each, starting and ending at the base, so that
//! declared science utility is maximised while every hard constraint holds.
//!
//! Utility is a **mission-designer preference model**, not measured science
//! value: `q_i(τ_i) = preference_weight_i · τ_i / activity_max_i`.
//!
//! Hard constraints (never traded against utility):
//! start and end at the base; every leg has a traversable route inside known
//! terrain; EVA time, energy and consumable use each stay within
//! `budget − reserve`; `activity_min ≤ τ_i ≤ activity_max`.

use crate::provenance::EvidenceKind;
use crate::resources::{
    check_budget, invalid_inputs, resource_use, Activity, ConstraintCheck, ResourceBudget,
    ResourceModel, ResourceUse,
};
use crate::route::{find_leg, Leg, RouteError, Search};
use crate::terrain::{PlanningGrid, TerrainClass};
use crate::LocalPoint;
use serde::{Deserialize, Serialize};
use std::time::Instant;

/// Identifier used for the base in leg endpoints.
pub const BASE_ID: &str = "BASE";
/// Most candidate sites a scenario may carry. Routing work grows with the
/// square of this, so it also bounds what one request can make the planner do.
pub const MAX_SITES: usize = 16;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ScientificSite {
    pub id: String,
    pub name: String,
    pub position: LocalPoint,
    pub science_rationale: String,
    pub source_product_ids: Vec<String>,
    pub evidence_kind: EvidenceKind,
    pub activity_min_s: f64,
    pub activity_max_s: f64,
    /// Equipment load while working at the site, watts (scenario assumption).
    pub activity_power_w: f64,
    /// Mission-designer preference. NOT a NASA science score.
    pub preference_weight: f64,
    /// When true, the planner must include this site if a feasible modeled plan
    /// exists that satisfies all hard constraints including this site; otherwise
    /// the plan is reported infeasible for this requirement.
    #[serde(default)]
    pub required: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct MissionScenario {
    pub schema_version: u32,
    pub name: String,
    pub dataset_id: String,
    pub base: LocalPoint,
    /// Candidate sites the planner may choose from.
    pub sites: Vec<ScientificSite>,
    pub budget: ResourceBudget,
    pub model: ResourceModel,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum PlanStatus {
    /// Every hard constraint holds under the declared model. Not a safety claim.
    FeasibleModeled,
    /// No plan satisfies the hard constraints; see `issues` / `excluded`.
    Infeasible,
    /// The plan cannot be assessed because required terrain data is missing.
    UnknownDataCoverage,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum Severity {
    /// The scenario cannot be planned.
    Error,
    /// The scenario can be planned but something will be left out.
    Warning,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Issue {
    pub severity: Severity,
    /// Stable machine-readable code, e.g. `InvalidResourceBudget`.
    pub code: String,
    pub message: String,
    pub site_id: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ValidationReport {
    /// True when there are no `Error` issues.
    pub ok: bool,
    pub issues: Vec<Issue>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Stop {
    pub site_id: String,
    /// Seconds since the start of the EVA.
    pub arrive_s: f64,
    pub activity_s: f64,
    pub depart_s: f64,
    /// Modeled preference value earned at this stop.
    pub utility: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct PlannedLeg {
    /// Site id or `BASE`.
    pub from: String,
    pub to: String,
    #[serde(flatten)]
    pub leg: Leg,
}

/// A candidate site that is not in the plan, and why.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Exclusion {
    pub site_id: String,
    pub code: String,
    pub reason: String,
}

/// Per-candidate analysis computed by the planner from actual route/resource
/// evaluations. Figures are modeled estimates under the declared scenario.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct CandidateInsight {
    pub site_id: String,
    /// `SELECTED`, `EXCLUDED`, or `INFEASIBLE`.
    pub status: String,
    /// True when a traversable route to and from the base exists in this run.
    pub reachable_from_base: bool,
    /// True when a base->site->base round trip is feasible alone at minimum
    /// activity duration under the declared limits/reserves.
    pub feasible_alone: bool,
    /// Why the optimizer included or excluded this candidate (engine-derived).
    pub explanation: String,
    /// Stable machine-readable reason/category when excluded or infeasible.
    pub reason_code: Option<String>,
    /// Terrain class at the site position under the scenario slope limit.
    pub terrain: String,
    /// Derived slope at the site, degrees, when known.
    pub site_slope_deg: Option<f64>,
    /// Standalone round-trip distance/time at minimum dwell, when reachable.
    pub standalone_distance_m: Option<f64>,
    pub standalone_travel_time_s: Option<f64>,
    pub standalone_eva_time_s: Option<f64>,
    pub standalone_checks: Vec<ConstraintCheck>,
    /// Modeled preference utility earned in the final plan (0 if not selected).
    pub planned_utility: f64,
    /// Activity duration assigned in the final plan (0 if not selected).
    pub planned_activity_s: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SolverInfo {
    pub name: String,
    pub version: String,
    pub description: String,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Timing {
    /// Wall time spent routing legs (preprocessing for the planner).
    pub routing_ms: f64,
    /// Wall time spent selecting and scheduling sites.
    pub planning_ms: f64,
    pub legs_routed: usize,
    pub cells_expanded: usize,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct MissionResult {
    pub status: PlanStatus,
    pub solver: SolverInfo,
    pub stops: Vec<Stop>,
    /// Legs in travel order; the last one returns to the base.
    pub legs: Vec<PlannedLeg>,
    /// `None` when there is no plan.
    pub totals: Option<ResourceUse>,
    pub checks: Vec<ConstraintCheck>,
    /// Sum of modeled preference value over the stops.
    pub utility: f64,
    pub issues: Vec<Issue>,
    pub excluded: Vec<Exclusion>,
    /// Per-candidate selection analysis from planner calculations.
    #[serde(default)]
    pub candidate_insights: Vec<CandidateInsight>,
    pub timing: Timing,
}

/// Check a scenario against the terrain and the resource model's own rules.
pub fn validate_scenario(grid: &PlanningGrid, scenario: &MissionScenario) -> ValidationReport {
    let mut issues = Vec::new();
    let mut push = |severity, code: &str, message: String, site_id: Option<&str>| {
        issues.push(Issue { severity, code: code.into(), message, site_id: site_id.map(String::from) })
    };
    let max_slope = scenario.model.max_slope_deg.value;

    for message in invalid_inputs(&scenario.budget, &scenario.model) {
        push(Severity::Error, "InvalidResourceBudget", message, None);
    }

    match grid.classify(scenario.base, max_slope) {
        (TerrainClass::OutsideCoverage, _) => push(
            Severity::Error,
            "BaseOutsideCoverage",
            "The base lies outside the elevation coverage.".into(),
            None,
        ),
        (TerrainClass::Unknown, _) => push(
            Severity::Error,
            "BaseOnUnknownTerrain",
            "The base lies on terrain with no elevation data.".into(),
            None,
        ),
        (TerrainClass::AboveSlopeLimit, slope) => push(
            Severity::Error,
            "BaseOnSteepTerrain",
            format!(
                "The base lies on a {:.1}° slope, above the scenario limit of {max_slope:.1}°.",
                slope.unwrap_or(f32::NAN)
            ),
            None,
        ),
        (TerrainClass::Traversable, _) => {}
    }

    if scenario.sites.is_empty() {
        push(Severity::Error, "NoSites", "No candidate science sites are selected.".into(), None);
    }

    if scenario.sites.len() > MAX_SITES {
        push(
            Severity::Error,
            "TooManySites",
            format!("{} candidate sites; at most {MAX_SITES} are supported.", scenario.sites.len()),
            None,
        );
        return ValidationReport { ok: false, issues };
    }

    for (i, site) in scenario.sites.iter().enumerate() {
        let id = Some(site.id.as_str());
        if let Some(problem) = site_problem(site, &scenario.sites[..i]) {
            push(Severity::Error, "InvalidSite", problem, id);
            continue;
        }
        match grid.classify(site.position, max_slope) {
            (TerrainClass::OutsideCoverage, _) => push(
                Severity::Warning,
                "SiteOutsideCoverage",
                "Site lies outside the elevation coverage and cannot be planned.".into(),
                id,
            ),
            (TerrainClass::Unknown, _) => push(
                Severity::Warning,
                "SiteOnUnknownTerrain",
                "Site lies on terrain with no elevation data and cannot be planned.".into(),
                id,
            ),
            (TerrainClass::AboveSlopeLimit, slope) => push(
                Severity::Warning,
                "SiteOnSteepTerrain",
                format!(
                    "Site lies on a {:.1}° slope, above the scenario limit of {max_slope:.1}°.",
                    slope.unwrap_or(f32::NAN)
                ),
                id,
            ),
            (TerrainClass::Traversable, _) => {}
        }
    }

    ValidationReport { ok: issues.iter().all(|i| i.severity != Severity::Error), issues }
}

/// First problem with a site's own numbers or identity, if any.
fn site_problem(site: &ScientificSite, earlier: &[ScientificSite]) -> Option<String> {
    let non_negative = |v: f64| v.is_finite() && v >= 0.0;
    if site.id.trim().is_empty() || site.id == BASE_ID {
        Some(format!("Site id '{}' is empty or reserved.", site.id))
    } else if earlier.iter().any(|other| other.id == site.id) {
        Some(format!("Site id '{}' is used more than once.", site.id))
    } else if !(site.position.x_m.is_finite() && site.position.y_m.is_finite()) {
        Some("Site position is not a number.".into())
    } else if !non_negative(site.activity_min_s) {
        Some("Minimum activity time must be a non-negative number.".into())
    } else if !(site.activity_max_s.is_finite() && site.activity_max_s > 0.0) {
        Some("Maximum activity time must be positive.".into())
    } else if site.activity_min_s > site.activity_max_s {
        Some("Minimum activity time is longer than the maximum.".into())
    } else if !non_negative(site.activity_power_w) {
        Some("Activity power must be a non-negative number.".into())
    } else if !non_negative(site.preference_weight) {
        Some("Preference weight must be a non-negative number.".into())
    } else {
        None
    }
}

/// Deterministic baseline: cheapest-insertion by utility per added EVA second,
/// then extend activities with whatever every resource still allows.
pub fn plan_greedy(grid: &PlanningGrid, scenario: &MissionScenario) -> MissionResult {
    let mut result = MissionResult {
        status: PlanStatus::Infeasible,
        solver: SolverInfo {
            name: "GreedyPlanner".into(),
            version: "1".into(),
            description: "Deterministic baseline: cheapest insertion by preference value per added \
                          EVA second, then activity extension. Not an optimality claim."
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

    let report = validate_scenario(grid, scenario);
    result.issues = report.issues;
    if !report.ok {
        let base_data_missing = result.issues.iter().any(|i| {
            i.severity == Severity::Error
                && matches!(i.code.as_str(), "BaseOutsideCoverage" | "BaseOnUnknownTerrain")
        });
        if base_data_missing {
            result.status = PlanStatus::UnknownDataCoverage;
        }
        return result;
    }
    for issue in &result.issues {
        if let Some(site_id) = &issue.site_id {
            result.excluded.push(Exclusion {
                site_id: site_id.clone(),
                code: issue.code.clone(),
                reason: issue.message.clone(),
            });
        }
    }

    // ---- Route the legs (preprocessing for the planner) ----------------------
    let routing_started = Instant::now();
    let table = LegTable::route(grid, scenario, &mut result);
    result.timing.routing_ms = routing_started.elapsed().as_secs_f64() * 1e3;

    // ---- Select, order and schedule ------------------------------------------
    let planning_started = Instant::now();
    let problem = Problem { scenario, table: &table };
    let minimum = dwell_at_minimum(scenario);
    let required: Vec<usize> = scenario
        .sites
        .iter()
        .enumerate()
        .filter_map(|(i, s)| if s.required { Some(i) } else { None })
        .collect();
    for &req in &required {
        if !table.reachable.contains(&req) {
            let site_id = &scenario.sites[req].id;
            let reason = result
                .excluded
                .iter()
                .find(|e| &e.site_id == site_id)
                .map(|e| e.reason.clone())
                .unwrap_or_else(|| "Required site is not reachable from the base under the declared model.".into());
            result.status = PlanStatus::Infeasible;
            result.issues.push(Issue {
                severity: Severity::Error,
                code: "RequiredSiteUnsatisfied".into(),
                message: format!("Required site {site_id} cannot be included: {reason}"),
                site_id: Some(site_id.clone()),
            });
            result.timing.planning_ms = planning_started.elapsed().as_secs_f64() * 1e3;
            return result;
        }
        let alone = problem.evaluate(&[req], &minimum).expect("reachable required site has base legs");
        if !alone.feasible() {
            let site_id = &scenario.sites[req].id;
            let shortfalls: Vec<String> = alone.checks.iter().filter(|c| !c.satisfied).map(describe_shortfall).collect();
            result.status = PlanStatus::Infeasible;
            result.issues.push(Issue {
                severity: Severity::Error,
                code: "RequiredSiteUnsatisfied".into(),
                message: format!(
                    "Required site {site_id} cannot be included: a round trip alone (minimum activity, return to base) does not satisfy the declared limits: {}.",
                    shortfalls.join("; ")
                ),
                site_id: Some(site_id.clone()),
            });
            result.timing.planning_ms = planning_started.elapsed().as_secs_f64() * 1e3;
            return result;
        }
    }
    let Some(order) = greedy_selection(&problem, scenario, &table, &minimum, &required) else {
        result.status = PlanStatus::Infeasible;
        result.issues.push(Issue {
            severity: Severity::Error,
            code: "RequiredSiteUnsatisfied".into(),
            message: "One or more required sites cannot be included together within the declared limits while preserving a modeled return to base.".into(),
            site_id: None,
        });
        result.timing.planning_ms = planning_started.elapsed().as_secs_f64() * 1e3;
        return result;
    };
    let mut dwell = minimum;

    if !order.is_empty() {
        extend_activities(&problem, &order, &mut dwell);
    }
    result.timing.planning_ms = planning_started.elapsed().as_secs_f64() * 1e3;

    finalize_plan(grid, scenario, &table, &problem, &order, &dwell, result)
}

/// Best-insertion order used by the baseline and as a DP fallback.
/// `required` sites are inserted first when feasible; if any required site
/// cannot be included in a feasible plan, returns `None`.
fn greedy_selection(
    problem: &Problem,
    scenario: &MissionScenario,
    table: &LegTable,
    dwell: &[f64],
    required: &[usize],
) -> Option<Vec<usize>> {
    let mut order: Vec<usize> = Vec::new();
    // Insert required sites first (deterministic order by site index).
    let mut required_sorted = required.to_vec();
    required_sorted.sort_unstable();
    for site in required_sorted {
        if !table.reachable.contains(&site) {
            return None;
        }
        let mut best_pos: Option<(f64, usize)> = None;
        for position in 0..=order.len() {
            let mut trial = order.clone();
            trial.insert(position, site);
            let Some(eval) = problem.evaluate(&trial, dwell) else { continue };
            if !eval.feasible() {
                continue;
            }
            let better = match best_pos {
                None => true,
                Some((best_time, _)) => eval.totals.eva_time_s < best_time - 1e-12,
            };
            if better {
                best_pos = Some((eval.totals.eva_time_s, position));
            }
        }
        match best_pos {
            Some((_, position)) => order.insert(position, site),
            None => return None,
        }
    }

    loop {
        let current_eva = problem.evaluate(&order, dwell).map_or(0.0, |e| e.totals.eva_time_s);
        // (score, added seconds, site, position) of the best feasible insertion.
        let mut best: Option<(f64, f64, usize, usize)> = None;
        for &site in table.reachable.iter().filter(|s| !order.contains(s)) {
            let gain = site_utility(&scenario.sites[site], dwell[site]);
            for position in 0..=order.len() {
                let mut trial = order.clone();
                trial.insert(position, site);
                let Some(eval) = problem.evaluate(&trial, dwell) else { continue };
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
                    best = Some((score, added, site, position));
                }
            }
        }
        match best {
            Some((_, _, site, position)) => order.insert(position, site),
            None => break,
        }
    }
    Some(order)
}

/// Explain left-out sites, refuse an empty itinerary, or assemble the final
/// plan from the canonical evaluation. Shared by every solver so status and
/// accounting cannot drift between them.
fn finalize_plan(
    grid: &PlanningGrid,
    scenario: &MissionScenario,
    table: &LegTable,
    problem: &Problem,
    order: &[usize],
    dwell: &[f64],
    mut result: MissionResult,
) -> MissionResult {
    use std::collections::HashMap;

    let minimum = dwell_at_minimum(scenario);
    let mut alone_map: HashMap<String, Evaluation> = HashMap::new();

    for &site in table.reachable.iter().filter(|s| !order.contains(s)) {
        let alone = problem
            .evaluate(&[site], &minimum)
            .expect("a reachable site has both of its base legs");
        let site_id = scenario.sites[site].id.clone();
        let (code, reason) = if alone.feasible() {
            (
                "DidNotFitWithSelected",
                "Feasible alone under the declared model, but not included with the selected sites: another combination provides better modeled utility within the mission limits."
                    .to_string(),
            )
        } else {
            let shortfalls: Vec<String> =
                alone.checks.iter().filter(|c| !c.satisfied).map(describe_shortfall).collect();
            (
                "ExceedsBudgetAlone",
                format!(
                    "A round trip to this site alone (minimum activity, return to base) does not satisfy the declared limits: {}.",
                    shortfalls.join("; ")
                ),
            )
        };
        result.excluded.push(Exclusion {
            site_id: site_id.clone(),
            code: code.into(),
            reason,
        });
        alone_map.insert(site_id, alone);
    }

    if order.is_empty() {
        let only_missing_data = !result.excluded.is_empty()
            && result.excluded.iter().all(|e| {
                matches!(
                    e.code.as_str(),
                    "SiteOutsideCoverage" | "SiteOnUnknownTerrain" | "RouteCrossesUnknownTerrain"
                )
            });
        result.status = if only_missing_data {
            PlanStatus::UnknownDataCoverage
        } else {
            PlanStatus::Infeasible
        };
        result.issues.push(Issue {
            severity: Severity::Error,
            code: "NoFeasiblePlan".into(),
            message: "No candidate site can be visited and returned from within the declared limits."
                .into(),
            site_id: None,
        });
        result.candidate_insights = build_candidate_insights(
            grid, scenario, table, problem, order, &result, &alone_map,
        );
        return result;
    }

    // ---- Assemble the plan from the canonical evaluation ---------------------
    let eval = problem.evaluate(order, dwell).expect("selected sites are mutually routed");
    debug_assert!(eval.feasible());
    let mut clock = scenario.model.overhead_s.value;
    let mut previous = BASE_ID.to_string();
    let mut previous_node = 0;
    for &site in order {
        let s = &scenario.sites[site];
        let leg = table.leg(previous_node, site + 1).expect("routed").clone();
        clock += leg.time_s;
        result.legs.push(PlannedLeg { from: previous.clone(), to: s.id.clone(), leg });
        result.stops.push(Stop {
            site_id: s.id.clone(),
            arrive_s: clock,
            activity_s: dwell[site],
            depart_s: clock + dwell[site],
            utility: site_utility(s, dwell[site]),
        });
        clock += dwell[site];
        previous = s.id.clone();
        previous_node = site + 1;
    }
    let home = table.leg(previous_node, 0).expect("routed").clone();
    result.legs.push(PlannedLeg { from: previous, to: BASE_ID.into(), leg: home });
    result.utility = eval.utility;
    result.checks = eval.checks;
    result.totals = Some(eval.totals);
    result.status = PlanStatus::FeasibleModeled;
    result.candidate_insights = build_candidate_insights(
        grid, scenario, table, problem, order, &result, &alone_map,
    );
    result
}

fn build_candidate_insights(
    grid: &PlanningGrid,
    scenario: &MissionScenario,
    table: &LegTable,
    problem: &Problem,
    order: &[usize],
    result: &MissionResult,
    alone_map: &std::collections::HashMap<String, Evaluation>,
) -> Vec<CandidateInsight> {
    let minimum = dwell_at_minimum(scenario);
    let max_slope = scenario.model.max_slope_deg.value;
    let mut insights = Vec::with_capacity(scenario.sites.len());
    for (index, site) in scenario.sites.iter().enumerate() {
        let (terrain, slope) = grid.classify(site.position, max_slope);
        let terrain_name = match terrain {
            TerrainClass::Traversable => "TRAVERSABLE",
            TerrainClass::AboveSlopeLimit => "ABOVE_SLOPE_LIMIT",
            TerrainClass::Unknown => "UNKNOWN",
            TerrainClass::OutsideCoverage => "OUTSIDE_COVERAGE",
        }
        .to_string();
        let site_slope_deg = slope.map(|s| s as f64);
        let selected = order.contains(&index);
        let reachable = table.reachable.contains(&index);
        let exclusion = result.excluded.iter().find(|e| e.site_id == site.id);
        let issue = result.issues.iter().find(|i| i.site_id.as_deref() == Some(site.id.as_str()));

        let mut standalone_distance_m = None;
        let mut standalone_travel_time_s = None;
        let mut standalone_eva_time_s = None;
        let mut standalone_checks = Vec::new();
        let mut feasible_alone = false;

        if let Some(alone) = alone_map.get(&site.id) {
            standalone_distance_m = Some(alone.totals.distance_m);
            standalone_travel_time_s = Some(alone.totals.travel_time_s);
            standalone_eva_time_s = Some(alone.totals.eva_time_s);
            standalone_checks = alone.checks.clone();
            feasible_alone = alone.feasible();
        } else if reachable && selected {
            if let Some(alone) = problem.evaluate(&[index], &minimum) {
                standalone_distance_m = Some(alone.totals.distance_m);
                standalone_travel_time_s = Some(alone.totals.travel_time_s);
                standalone_eva_time_s = Some(alone.totals.eva_time_s);
                standalone_checks = alone.checks.clone();
                feasible_alone = alone.feasible();
            }
        }

        let (planned_utility, planned_activity_s) = if selected {
            result
                .stops
                .iter()
                .find(|stop| stop.site_id == site.id)
                .map(|stop| (stop.utility, stop.activity_s))
                .unwrap_or((0.0, 0.0))
        } else {
            (0.0, 0.0)
        };

        let (status, reason_code, explanation) = if selected {
            let mut parts = vec![format!(
                "Selected in the final modeled plan (utility {:.3} at {:.1} min activity).",
                planned_utility,
                planned_activity_s / 60.0
            )];
            if let Some(total) = &result.totals {
                parts.push(format!(
                    "Contributes to total modeled utility {:.3} within declared limits (EVA {:.1} min used).",
                    result.utility,
                    total.eva_time_s / 60.0
                ));
            }
            ("SELECTED".to_string(), None, parts.join(" "))
        } else if let Some(ex) = exclusion {
            let status = if matches!(
                ex.code.as_str(),
                "SiteOutsideCoverage"
                    | "SiteOnUnknownTerrain"
                    | "RouteCrossesUnknownTerrain"
                    | "BlockedBySlopeRule"
                    | "SiteOnSteepTerrain"
                    | "SiteBlockedByContingency"
                    | "ExceedsBudgetAlone"
            ) {
                "INFEASIBLE"
            } else {
                "EXCLUDED"
            };
            (
                status.to_string(),
                Some(ex.code.clone()),
                ex.reason.clone(),
            )
        } else if let Some(issue) = issue {
            let status = if issue.code.contains("Unknown") || issue.code.contains("Outside") {
                "INFEASIBLE"
            } else {
                "EXCLUDED"
            };
            (
                status.to_string(),
                Some(issue.code.clone()),
                issue.message.clone(),
            )
        } else {
            (
                "EXCLUDED".to_string(),
                Some("NotSelected".to_string()),
                "Not included in the final modeled plan.".to_string(),
            )
        };

        insights.push(CandidateInsight {
            site_id: site.id.clone(),
            status,
            reachable_from_base: reachable,
            feasible_alone,
            explanation,
            reason_code,
            terrain: terrain_name,
            site_slope_deg,
            standalone_distance_m,
            standalone_travel_time_s,
            standalone_eva_time_s,
            standalone_checks,
            planned_utility,
            planned_activity_s,
        });
    }
    insights
}

/// Wall-clock budget for the exact subset search. On expiry the planner
/// abandons the partial search and uses the reproducible greedy baseline, so
/// the desktop stays responsive and never presents a truncated search as
/// exact.
const DP_BUDGET_MS: f64 = 2_500.0;

/// Exact subset and order search over the routed leg table (Held-Karp), then
/// the same greedy activity extension as the baseline.
///
/// Scope of the exactness claim: at minimum activity durations, with the
/// resource coefficients validated non-negative, every resource use is
/// monotone in travel time for a fixed site set. The dynamic program therefore
/// finds the feasible site set with the highest minimum-dwell utility and, on
/// ties, the least travel time. Activity extension is a heuristic. The
/// baseline greedy schedule is evaluated on the same leg table and used when
/// its extension yields more final utility.
pub fn plan_dp(grid: &PlanningGrid, scenario: &MissionScenario) -> MissionResult {
    plan_dp_within(grid, scenario, DP_BUDGET_MS)
}

/// `plan_dp` with an explicit subset-search budget. A nonpositive budget
/// exercises the documented greedy fallback; callers never present the
/// fallback as an exact result.
fn plan_dp_within(
    grid: &PlanningGrid,
    scenario: &MissionScenario,
    subset_budget_ms: f64,
) -> MissionResult {
    let mut result = MissionResult {
        status: PlanStatus::Infeasible,
        solver: SolverInfo {
            name: "ExactSubsetDp".into(),
            version: "1".into(),
            description: "Held-Karp subset/order search at minimum activity durations over the \
                          routed leg table, then greedy activity extension. Exact for the \
                          minimum-dwell objective; the baseline schedule is used when its \
                          extension yields more utility. Not an optimality claim for arbitrary \
                          dwell allocations."
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

    let report = validate_scenario(grid, scenario);
    result.issues = report.issues;
    if !report.ok {
        let base_data_missing = result.issues.iter().any(|i| {
            i.severity == Severity::Error
                && matches!(i.code.as_str(), "BaseOutsideCoverage" | "BaseOnUnknownTerrain")
        });
        if base_data_missing {
            result.status = PlanStatus::UnknownDataCoverage;
        }
        return result;
    }
    for issue in &result.issues {
        if let Some(site_id) = &issue.site_id {
            result.excluded.push(Exclusion {
                site_id: site_id.clone(),
                code: issue.code.clone(),
                reason: issue.message.clone(),
            });
        }
    }

    let routing_started = Instant::now();
    let table = LegTable::route(grid, scenario, &mut result);
    result.timing.routing_ms = routing_started.elapsed().as_secs_f64() * 1e3;

    let planning_started = Instant::now();
    let problem = Problem { scenario, table: &table };
    let minimum = dwell_at_minimum(scenario);
    let required: Vec<usize> = scenario
        .sites
        .iter()
        .enumerate()
        .filter_map(|(i, s)| if s.required { Some(i) } else { None })
        .collect();
    for &req in &required {
        if !table.reachable.contains(&req) {
            let site_id = &scenario.sites[req].id;
            let reason = result
                .excluded
                .iter()
                .find(|e| &e.site_id == site_id)
                .map(|e| e.reason.clone())
                .unwrap_or_else(|| "Required site is not reachable from the base under the declared model.".into());
            result.status = PlanStatus::Infeasible;
            result.issues.push(Issue {
                severity: Severity::Error,
                code: "RequiredSiteUnsatisfied".into(),
                message: format!("Required site {site_id} cannot be included: {reason}"),
                site_id: Some(site_id.clone()),
            });
            result.timing.planning_ms = planning_started.elapsed().as_secs_f64() * 1e3;
            return result;
        }
        let alone = problem.evaluate(&[req], &minimum).expect("reachable required site has base legs");
        if !alone.feasible() {
            let site_id = &scenario.sites[req].id;
            let shortfalls: Vec<String> = alone.checks.iter().filter(|c| !c.satisfied).map(describe_shortfall).collect();
            result.status = PlanStatus::Infeasible;
            result.issues.push(Issue {
                severity: Severity::Error,
                code: "RequiredSiteUnsatisfied".into(),
                message: format!(
                    "Required site {site_id} cannot be included: a round trip alone (minimum activity, return to base) does not satisfy the declared limits: {}.",
                    shortfalls.join("; ")
                ),
                site_id: Some(site_id.clone()),
            });
            result.timing.planning_ms = planning_started.elapsed().as_secs_f64() * 1e3;
            return result;
        }
    }
    let required_reachable: Vec<usize> = required.clone();
    let dp_order = subset_dp_order_within(&problem, &table, &minimum, subset_budget_ms, &required_reachable);
    let greedy_order = greedy_selection(&problem, scenario, &table, &minimum, &required_reachable).unwrap_or_default();
    let dp_choice = schedule_order(&problem, dp_order, &minimum);
    let greedy_choice = schedule_order(&problem, greedy_order, &minimum);
    let (order, dwell, used_greedy) = match (dp_choice, greedy_choice) {
        (Some(dp), Some(greedy)) => {
            if greedy.2.utility > dp.2.utility + 1e-9 {
                (greedy.0, greedy.1, true)
            } else {
                (dp.0, dp.1, false)
            }
        }
        (Some(dp), None) => (dp.0, dp.1, false),
        (None, Some(greedy)) => (greedy.0, greedy.1, true),
        (None, None) => (Vec::new(), minimum.clone(), false),
    };
    if used_greedy {
        result.solver.name = "GreedyPlanner".into();
        result.solver.description =
            "Baseline cheapest-insertion schedule chosen because the exact subset/order search \
             produced no better extended schedule or ran out of its wall-clock budget."
                .into();
    }
    if !required_reachable.is_empty() && !required_reachable.iter().all(|r| order.contains(r)) {
        result.status = PlanStatus::Infeasible;
        result.issues.push(Issue {
            severity: Severity::Error,
            code: "RequiredSiteUnsatisfied".into(),
            message: "One or more required sites cannot be included together within the declared limits while preserving a modeled return to base.".into(),
            site_id: None,
        });
        result.timing.planning_ms = planning_started.elapsed().as_secs_f64() * 1e3;
        return result;
    }
    result.timing.planning_ms = planning_started.elapsed().as_secs_f64() * 1e3;

    finalize_plan(grid, scenario, &table, &problem, &order, &dwell, result)
}

/// Extend a minimum-dwell order with the shared heuristic, then evaluate it.
fn schedule_order(
    problem: &Problem,
    order: Vec<usize>,
    minimum: &[f64],
) -> Option<(Vec<usize>, Vec<f64>, Evaluation)> {
    if order.is_empty() {
        return None;
    }
    let mut dwell = minimum.to_vec();
    extend_activities(problem, &order, &mut dwell);
    let eval = problem.evaluate(&order, &dwell)?;
    if !eval.feasible() {
        return None;
    }
    Some((order, dwell, eval))
}

/// Held-Karp over subsets of reachable sites: the least travel time to visit
/// exactly `mask` and finish at each site. Returns the best feasible order.
/// `budget_ms <= 0` tests the fallback path. An abandoned search returns an
/// empty order, never a partial result labelled exact.
/// When `required` is non-empty, only subsets containing every required site
/// are considered.
fn subset_dp_order_within(
    problem: &Problem,
    table: &LegTable,
    minimum: &[f64],
    budget_ms: f64,
    required: &[usize],
) -> Vec<usize> {
    let started = Instant::now();
    let reachable = &table.reachable;
    let k = reachable.len();
    if k == 0 {
        return Vec::new();
    }
    let mut required_mask = 0usize;
    for &req in required {
        if let Some(slot) = reachable.iter().position(|&s| s == req) {
            required_mask |= 1 << slot;
        } else {
            // Required site not reachable: cannot satisfy.
            return Vec::new();
        }
    }
    let size = 1usize << k;
    let mut best = vec![f64::INFINITY; size * k];
    let mut parent = vec![u8::MAX; size * k];

    for (slot, &site) in reachable.iter().enumerate() {
        if let Some(leg) = table.leg(0, site + 1) {
            best[(1 << slot) * k + slot] = leg.time_s;
        }
    }
    for mask in 1..size {
        if started.elapsed().as_secs_f64() * 1e3 > budget_ms {
            return Vec::new();
        }
        for last in 0..k {
            if mask & (1 << last) == 0 {
                continue;
            }
            let reached = best[mask * k + last];
            if !reached.is_finite() {
                continue;
            }
            for next in 0..k {
                if mask & (1 << next) != 0 {
                    continue;
                }
                let Some(leg) = table.leg(reachable[last] + 1, reachable[next] + 1) else {
                    continue;
                };
                let candidate = reached + leg.time_s;
                let index = (mask | (1 << next)) * k + next;
                if candidate < best[index] {
                    best[index] = candidate;
                    parent[index] = last as u8;
                }
            }
        }
    }

    // (utility, travel time, mask, last) of the best feasible subset.
    let mut choice: Option<(f64, f64, usize, usize)> = None;
    for mask in 1..size {
        if started.elapsed().as_secs_f64() * 1e3 > budget_ms {
            return Vec::new();
        }
        if (mask & required_mask) != required_mask {
            continue;
        }
        let mut tail: Option<(f64, usize)> = None;
        for last in 0..k {
            if mask & (1 << last) == 0 {
                continue;
            }
            let Some(home) = table.leg(reachable[last] + 1, 0) else { continue };
            let total = best[mask * k + last] + home.time_s;
            if !total.is_finite() {
                continue;
            }
            if tail.map_or(true, |(known, _)| total < known) {
                tail = Some((total, last));
            }
        }
        let Some((total, last)) = tail else { continue };
        let order = reconstruct_order(mask, last, &parent, k, reachable);
        let Some(eval) = problem.evaluate(&order, minimum) else { continue };
        if !eval.feasible() {
            continue;
        }
        let utility = eval.utility;
        let better = match choice {
            None => true,
            Some((known_utility, known_time, _, _)) => {
                utility > known_utility + 1e-12
                    || ((utility - known_utility).abs() <= 1e-12
                        && total < known_time - 1e-12)
            }
        };
        if better {
            choice = Some((utility, total, mask, last));
        }
    }
    match choice {
        Some((_, _, mask, last)) => reconstruct_order(mask, last, &parent, k, reachable),
        None => Vec::new(),
    }
}

fn reconstruct_order(
    mut mask: usize,
    mut last: usize,
    parent: &[u8],
    k: usize,
    reachable: &[usize],
) -> Vec<usize> {
    let mut order = Vec::with_capacity(k);
    loop {
        order.push(reachable[last]);
        let previous = parent[mask * k + last];
        mask &= !(1 << last);
        if mask == 0 || previous == u8::MAX {
            break;
        }
        last = previous as usize;
    }
    order.reverse();
    order
}

/// Modeled preference value of working `activity_s` at `site`.
pub fn site_utility(site: &ScientificSite, activity_s: f64) -> f64 {
    site.preference_weight * activity_s / site.activity_max_s
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

/// Routed legs between the base (node 0) and each site (node `index + 1`).
struct LegTable {
    nodes: usize,
    legs: Vec<Option<Leg>>,
    /// Site indices with a route to and from the base.
    reachable: Vec<usize>,
}

impl LegTable {
    /// Route base ↔ site and site ↔ site legs, recording unreachable sites in
    /// `result.excluded` and search effort in `result.timing`.
    fn route(grid: &PlanningGrid, scenario: &MissionScenario, result: &mut MissionResult) -> LegTable {
        let model = scenario.model.traversal();
        let nodes = scenario.sites.len() + 1;
        let mut table = LegTable { nodes, legs: vec![None; nodes * nodes], reachable: Vec::new() };
        let position = |node: usize| match node {
            0 => scenario.base,
            n => scenario.sites[n - 1].position,
        };
        let mut route = |table: &mut LegTable, a: usize, b: usize| -> Result<(), RouteError> {
            let leg = find_leg(grid, &model, position(a), position(b), Search::AStar)?;
            result.timing.legs_routed += 1;
            result.timing.cells_expanded += leg.cells_expanded;
            table.legs[b * nodes + a] = Some(leg.reversed());
            table.legs[a * nodes + b] = Some(leg);
            Ok(())
        };

        let already_excluded: Vec<String> =
            result.excluded.iter().map(|e| e.site_id.clone()).collect();
        let mut unreachable = Vec::new();
        for (i, site) in scenario.sites.iter().enumerate() {
            if already_excluded.contains(&site.id) {
                continue;
            }
            match route(&mut table, 0, i + 1) {
                Ok(()) => table.reachable.push(i),
                Err(error) => unreachable.push((site.id.clone(), error)),
            }
        }
        let reachable = table.reachable.clone();
        for (k, &a) in reachable.iter().enumerate() {
            for &b in &reachable[k + 1..] {
                // Both connect to the base, so they connect to each other; a
                // failure here would only leave the pair unusable together.
                let _ = route(&mut table, a + 1, b + 1);
            }
        }
        for (site_id, error) in unreachable {
            let code = match &error {
                RouteError::RouteCrossesUnknownTerrain => "RouteCrossesUnknownTerrain",
                RouteError::BlockedBySlopeRule => "BlockedBySlopeRule",
                RouteError::OutsideCoverage { .. } => "SiteOutsideCoverage",
                RouteError::UnknownTerrainAtEndpoint { .. } => "SiteOnUnknownTerrain",
                RouteError::SlopeRuleAtEndpoint { .. } => "SiteOnSteepTerrain",
                RouteError::EndpointBlocked { .. } => "SiteBlockedByContingency",
            };
            result.excluded.push(Exclusion {
                site_id,
                code: code.into(),
                reason: format!("No route from the base: {error}."),
            });
        }
        table
    }

    fn leg(&self, from: usize, to: usize) -> Option<&Leg> {
        self.legs[from * self.nodes + to].as_ref()
    }
}

/// The one evaluation every planner must use: resources, constraints and
/// utility of visiting `order` (site indices) with `dwell` seconds at each.
struct Problem<'a> {
    scenario: &'a MissionScenario,
    table: &'a LegTable,
}

#[derive(Clone)]
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

impl Problem<'_> {
    /// `None` if a needed leg does not exist. The return to base is always included.
    fn evaluate(&self, order: &[usize], dwell: &[f64]) -> Option<Evaluation> {
        let (mut distance_m, mut travel_time_s) = (0.0, 0.0);
        let mut node = 0;
        for next in order.iter().map(|&site| site + 1).chain(std::iter::once(0)) {
            if next == node {
                continue; // empty itinerary: base to base
            }
            let leg = self.table.leg(node, next)?;
            distance_m += leg.distance_m;
            travel_time_s += leg.time_s;
            node = next;
        }
        let activities: Vec<Activity> = order
            .iter()
            .map(|&site| Activity {
                duration_s: dwell[site],
                power_w: self.scenario.sites[site].activity_power_w,
            })
            .collect();
        let totals = resource_use(&self.scenario.model, distance_m, travel_time_s, &activities);
        let checks = check_budget(&totals, &self.scenario.budget);
        let utility =
            order.iter().map(|&site| site_utility(&self.scenario.sites[site], dwell[site])).sum();
        Some(Evaluation { totals, checks, utility })
    }
}

/// Lengthen activities, most valuable per second first, by as much as every
/// declared resource still allows.
fn extend_activities(problem: &Problem, order: &[usize], dwell: &mut [f64]) {
    let sites = &problem.scenario.sites;
    let model = &problem.scenario.model;
    let rate = |site: usize| sites[site].preference_weight / sites[site].activity_max_s;
    let mut by_value: Vec<usize> = order.to_vec();
    by_value.sort_by(|&a, &b| rate(b).total_cmp(&rate(a)).then(a.cmp(&b)));

    for site in by_value {
        let Some(eval) = problem.evaluate(order, dwell) else { return };
        let mut extra = sites[site].activity_max_s - dwell[site];
        if let Some(margin) = eval.margin("eva_time") {
            extra = extra.min(margin);
        }
        let watts = model.base_power_w.value + sites[site].activity_power_w;
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
        let before = dwell[site];
        dwell[site] = before + extra;
        // Hard gate: keep the extension only if every constraint still holds.
        if !problem.evaluate(order, dwell).is_some_and(|e| e.feasible()) {
            dwell[site] = before;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::resources::test_support::{bare_model, coef, time_only};
    use crate::route::test_support::{at, block, flat, unknown};

    fn site(g: &PlanningGrid, id: &str, col: usize, row: usize, weight: f64, tmin: f64, tmax: f64) -> ScientificSite {
        ScientificSite {
            id: id.into(),
            name: id.into(),
            position: at(g, col, row),
            science_rationale: "test fixture".into(),
            source_product_ids: vec![],
            evidence_kind: EvidenceKind::Synthetic,
            activity_min_s: tmin,
            activity_max_s: tmax,
            activity_power_w: 0.0,
            preference_weight: weight,
            required: false,
        }
    }

    fn scenario(g: &PlanningGrid, base: (usize, usize), sites: Vec<ScientificSite>, budget: ResourceBudget) -> MissionScenario {
        MissionScenario {
            schema_version: 1,
            name: "fixture".into(),
            dataset_id: "synthetic".into(),
            base: at(g, base.0, base.1),
            sites,
            budget,
            model: bare_model(),
        }
    }

    fn ids(result: &MissionResult) -> Vec<&str> {
        result.stops.iter().map(|s| s.site_id.as_str()).collect()
    }

    fn exclusion<'a>(result: &'a MissionResult, id: &str) -> &'a Exclusion {
        result.excluded.iter().find(|e| e.site_id == id).unwrap_or_else(|| panic!("{id} not excluded"))
    }

    // ---- Fixture 1: flat grid, one site, obvious out-and-back ----------------

    /// Base at column 2, site 10 m east; 100 s of work; walking at 1 m/s.
    fn out_and_back(budget: ResourceBudget) -> MissionResult {
        let g = flat(21, 21, 1.0);
        let s = scenario(&g, (2, 10), vec![site(&g, "A", 12, 10, 1.0, 100.0, 100.0)], budget);
        plan_greedy(&g, &s)
    }

    #[test]
    fn single_site_round_trip_has_the_hand_computed_cost() {
        let r = out_and_back(time_only(1000.0, 100.0));
        assert_eq!(r.status, PlanStatus::FeasibleModeled);
        assert_eq!(ids(&r), ["A"]);
        let t = r.totals.as_ref().unwrap();
        assert_eq!((t.distance_m, t.travel_time_s, t.activity_time_s, t.eva_time_s), (20.0, 20.0, 100.0, 120.0));
        assert_eq!(r.utility, 1.0);
        let stop = &r.stops[0];
        assert_eq!((stop.arrive_s, stop.activity_s, stop.depart_s), (10.0, 100.0, 110.0));
        let eva = &r.checks[0];
        assert_eq!((eva.available, eva.margin, eva.satisfied), (900.0, 780.0, true));
    }

    #[test]
    fn plan_starts_and_ends_at_the_base() {
        let g = flat(21, 21, 1.0);
        let r = out_and_back(time_only(1000.0, 100.0));
        assert_eq!(r.legs.len(), 2);
        assert_eq!((r.legs[0].from.as_str(), r.legs[0].to.as_str()), (BASE_ID, "A"));
        assert_eq!((r.legs[1].from.as_str(), r.legs[1].to.as_str()), ("A", BASE_ID));
        assert_eq!(r.legs[0].leg.path[0], at(&g, 2, 10));
        assert_eq!(*r.legs[1].leg.path.last().unwrap(), at(&g, 2, 10));
        assert_eq!(*r.legs[0].leg.path.last().unwrap(), r.legs[1].leg.path[0]);
    }

    #[test]
    fn return_leg_counts_against_the_time_limit() {
        // Outbound + work is 110 s and would fit in 115 s; the full round trip is 120 s.
        let r = out_and_back(time_only(115.0, 0.0));
        assert_eq!(r.status, PlanStatus::Infeasible);
        assert!(r.stops.is_empty() && r.legs.is_empty() && r.totals.is_none());
        let e = exclusion(&r, "A");
        assert_eq!(e.code, "ExceedsBudgetAlone");
        assert!(e.reason.contains("EVA time"), "{}", e.reason);
    }

    #[test]
    fn reserve_is_a_hard_limit_even_when_the_raw_budget_would_fit() {
        // 120 s needed. 150 s limit fits; 150 s limit with 40 s reserve does not.
        assert_eq!(out_and_back(time_only(150.0, 0.0)).status, PlanStatus::FeasibleModeled);
        assert_eq!(out_and_back(time_only(150.0, 40.0)).status, PlanStatus::Infeasible);
    }

    #[test]
    fn energy_limit_is_a_hard_constraint() {
        let g = flat(21, 21, 1.0);
        let mut a = site(&g, "A", 12, 10, 1.0, 100.0, 100.0);
        a.activity_power_w = 3600.0; // 100 Wh over 100 s
        let mut s = scenario(&g, (2, 10), vec![a], time_only(1000.0, 0.0));
        s.model.base_power_w = coef(360.0, "W"); // 12 Wh over the 120 s EVA
        s.budget.energy_budget_wh = Some(120.0);
        s.budget.energy_reserve_wh = Some(10.0);
        let r = plan_greedy(&g, &s);
        assert_eq!(r.status, PlanStatus::Infeasible);
        assert!(exclusion(&r, "A").reason.contains("energy"));

        s.budget.energy_budget_wh = Some(130.0);
        let r = plan_greedy(&g, &s);
        assert_eq!(r.status, PlanStatus::FeasibleModeled);
        let energy = r.checks.iter().find(|c| c.resource == "energy").unwrap();
        assert!((energy.used - 112.0).abs() < 1e-9 && (energy.margin - 8.0).abs() < 1e-9);
    }

    #[test]
    fn overhead_delays_the_first_arrival_and_counts_in_eva_time() {
        let g = flat(21, 21, 1.0);
        let mut s = scenario(&g, (2, 10), vec![site(&g, "A", 12, 10, 1.0, 100.0, 100.0)], time_only(1000.0, 0.0));
        s.model.overhead_s = coef(30.0, "s");
        let r = plan_greedy(&g, &s);
        assert_eq!(r.totals.unwrap().eva_time_s, 150.0);
        assert_eq!(r.stops[0].arrive_s, 40.0);
    }

    // ---- Activity duration ---------------------------------------------------

    fn flexible(budget: ResourceBudget) -> MissionResult {
        let g = flat(21, 21, 1.0);
        let s = scenario(&g, (2, 10), vec![site(&g, "A", 12, 10, 2.0, 100.0, 300.0)], budget);
        plan_greedy(&g, &s)
    }

    #[test]
    fn spare_time_extends_the_activity_up_to_its_maximum() {
        let r = flexible(time_only(1000.0, 0.0));
        assert_eq!(r.stops[0].activity_s, 300.0);
        assert_eq!(r.utility, 2.0);
    }

    #[test]
    fn activity_extension_stops_at_the_available_time() {
        // 250 s available, 20 s of travel → 230 s of work → utility 2 · 230/300.
        let r = flexible(time_only(300.0, 50.0));
        assert_eq!(r.stops[0].activity_s, 230.0);
        assert!((r.utility - 2.0 * 230.0 / 300.0).abs() < 1e-12);
        assert_eq!(r.checks[0].margin, 0.0);
        assert!(r.checks[0].satisfied);
    }

    #[test]
    fn activity_extension_respects_the_energy_limit_too() {
        let g = flat(21, 21, 1.0);
        let mut a = site(&g, "A", 12, 10, 2.0, 100.0, 300.0);
        a.activity_power_w = 3600.0; // 1 Wh per second of work
        let mut s = scenario(&g, (2, 10), vec![a], time_only(1000.0, 0.0));
        s.budget.energy_budget_wh = Some(150.0);
        s.budget.energy_reserve_wh = Some(0.0);
        let r = plan_greedy(&g, &s);
        assert!((r.stops[0].activity_s - 150.0).abs() < 1e-9, "{}", r.stops[0].activity_s);
        assert!(r.checks.iter().all(|c| c.satisfied));
    }

    // ---- Fixture 3: resource-binding ----------------------------------------

    #[test]
    fn valuable_site_beyond_the_reserve_is_excluded_and_the_reachable_one_kept() {
        // 10 m cells. Near site 30 m away (weight 1); far site 530 m away (weight 10).
        // Far round trip alone: 1060 s travel + 100 s work > 800 s available.
        let g = flat(60, 5, 10.0);
        let s = scenario(
            &g,
            (2, 2),
            vec![site(&g, "far", 55, 2, 10.0, 100.0, 100.0), site(&g, "near", 5, 2, 1.0, 100.0, 100.0)],
            time_only(1000.0, 200.0),
        );
        let r = plan_greedy(&g, &s);
        assert_eq!(r.status, PlanStatus::FeasibleModeled);
        assert_eq!(ids(&r), ["near"]);
        assert_eq!(exclusion(&r, "far").code, "ExceedsBudgetAlone");
        assert!(r.checks.iter().all(|c| c.satisfied));
    }

    // ---- Selection and ordering ---------------------------------------------

    #[test]
    fn two_sites_on_the_way_are_visited_in_one_trip_without_backtracking() {
        let g = flat(21, 21, 1.0);
        let s = scenario(
            &g,
            (2, 10),
            vec![site(&g, "far", 12, 10, 1.0, 10.0, 10.0), site(&g, "mid", 7, 10, 1.0, 10.0, 10.0)],
            time_only(1000.0, 0.0),
        );
        let r = plan_greedy(&g, &s);
        assert_eq!(r.stops.len(), 2);
        assert_eq!(r.totals.unwrap().distance_m, 20.0);
        assert_eq!(r.legs.len(), 3);
        assert_eq!(r.legs[2].to, BASE_ID);
    }

    #[test]
    fn when_only_one_fits_the_higher_value_per_second_wins() {
        // H: weight 5, 40 m away → 180 s alone. L: weight 1, 10 m away → 120 s alone.
        // Both together need 280 s; 200 s are available.
        let g = flat(60, 21, 1.0);
        let s = scenario(
            &g,
            (2, 10),
            vec![site(&g, "L", 12, 10, 1.0, 100.0, 100.0), site(&g, "H", 42, 10, 5.0, 100.0, 100.0)],
            time_only(200.0, 0.0),
        );
        let r = plan_greedy(&g, &s);
        assert_eq!(ids(&r), ["H"]);
        assert_eq!(exclusion(&r, "L").code, "DidNotFitWithSelected");
    }

    // ---- Fixture 2: trap -----------------------------------------------------

    #[test]
    fn plan_routes_around_blocked_terrain_and_pays_for_the_detour() {
        // Wall in column 3, rows 1–5 of a 7×7 grid; site straight across it.
        let mut g = flat(7, 7, 1.0);
        for row in 1..=5 {
            block(&mut g, 3, row);
        }
        let s = scenario(&g, (1, 3), vec![site(&g, "A", 5, 3, 1.0, 10.0, 10.0)], time_only(1000.0, 0.0));
        let r = plan_greedy(&g, &s);
        let want = 2.0 * (6.0 + 2.0 * std::f64::consts::SQRT_2);
        assert!((r.totals.unwrap().distance_m - want).abs() < 1e-9);
    }

    // ---- Fixture 4: unknown data --------------------------------------------

    #[test]
    fn site_behind_missing_data_is_reported_as_unknown_coverage_not_planned() {
        let mut g = flat(7, 5, 1.0);
        for row in 0..5 {
            unknown(&mut g, 3, row);
        }
        let s = scenario(&g, (1, 2), vec![site(&g, "A", 5, 2, 1.0, 10.0, 10.0)], time_only(1000.0, 0.0));
        let r = plan_greedy(&g, &s);
        assert_eq!(r.status, PlanStatus::UnknownDataCoverage);
        assert!(r.stops.is_empty() && r.totals.is_none());
        assert_eq!(exclusion(&r, "A").code, "RouteCrossesUnknownTerrain");
    }

    #[test]
    fn site_placed_on_missing_data_is_excluded_while_others_are_planned() {
        let mut g = flat(21, 21, 1.0);
        unknown(&mut g, 15, 15);
        let s = scenario(
            &g,
            (2, 10),
            vec![site(&g, "hole", 15, 15, 9.0, 10.0, 10.0), site(&g, "ok", 12, 10, 1.0, 10.0, 10.0)],
            time_only(1000.0, 0.0),
        );
        let r = plan_greedy(&g, &s);
        assert_eq!(r.status, PlanStatus::FeasibleModeled);
        assert_eq!(ids(&r), ["ok"]);
        assert_eq!(exclusion(&r, "hole").code, "SiteOnUnknownTerrain");
    }

    #[test]
    fn base_on_missing_data_is_unknown_coverage() {
        let mut g = flat(21, 21, 1.0);
        unknown(&mut g, 2, 10);
        let s = scenario(&g, (2, 10), vec![site(&g, "A", 12, 10, 1.0, 10.0, 10.0)], time_only(1000.0, 0.0));
        let r = plan_greedy(&g, &s);
        assert_eq!(r.status, PlanStatus::UnknownDataCoverage);
        assert!(r.issues.iter().any(|i| i.code == "BaseOnUnknownTerrain" && i.severity == Severity::Error));
    }

    #[test]
    fn site_enclosed_by_steep_terrain_is_excluded_by_the_slope_rule() {
        let mut g = flat(21, 21, 1.0);
        for (c, r) in [(14, 14), (15, 14), (16, 14), (14, 15), (16, 15), (14, 16), (15, 16), (16, 16)] {
            block(&mut g, c, r);
        }
        let s = scenario(&g, (2, 10), vec![site(&g, "island", 15, 15, 1.0, 10.0, 10.0)], time_only(1000.0, 0.0));
        let r = plan_greedy(&g, &s);
        assert_eq!(r.status, PlanStatus::Infeasible);
        assert_eq!(exclusion(&r, "island").code, "BlockedBySlopeRule");
    }

    // ---- Invalid input fails safely -----------------------------------------

    #[test]
    fn negative_budget_is_infeasible_with_an_invalid_budget_issue() {
        let r = out_and_back(time_only(-100.0, 0.0));
        assert_eq!(r.status, PlanStatus::Infeasible);
        assert!(r.issues.iter().any(|i| i.code == "InvalidResourceBudget"));
        assert!(r.stops.is_empty());
    }

    #[test]
    fn scenario_without_sites_is_reported_not_planned() {
        let g = flat(21, 21, 1.0);
        let s = scenario(&g, (2, 10), vec![], time_only(1000.0, 0.0));
        let report = validate_scenario(&g, &s);
        assert!(!report.ok);
        assert!(report.issues.iter().any(|i| i.code == "NoSites"));
        assert_eq!(plan_greedy(&g, &s).status, PlanStatus::Infeasible);
    }

    #[test]
    fn more_sites_than_the_limit_is_refused_before_any_routing() {
        let g = flat(21, 21, 1.0);
        let sites = |n: usize| (0..n).map(|i| site(&g, &format!("S{i}"), 2 + i, 10, 1.0, 10.0, 10.0)).collect();

        let at_limit = scenario(&g, (2, 2), sites(MAX_SITES), time_only(1000.0, 0.0));
        assert!(validate_scenario(&g, &at_limit).ok);

        let over = scenario(&g, (2, 2), sites(MAX_SITES + 1), time_only(1000.0, 0.0));
        let report = validate_scenario(&g, &over);
        assert!(!report.ok);
        assert!(report.issues.iter().any(|i| i.code == "TooManySites" && i.severity == Severity::Error));
        let result = plan_greedy(&g, &over);
        assert_eq!(result.status, PlanStatus::Infeasible);
        assert_eq!(result.timing.legs_routed, 0);
    }

    #[test]
    fn inconsistent_activity_bounds_and_bad_weights_are_errors() {
        let g = flat(21, 21, 1.0);
        let mut bad_bounds = site(&g, "A", 12, 10, 1.0, 200.0, 100.0);
        let report = validate_scenario(&g, &scenario(&g, (2, 10), vec![bad_bounds.clone()], time_only(1000.0, 0.0)));
        assert!(!report.ok && report.issues[0].code == "InvalidSite" && report.issues[0].site_id.as_deref() == Some("A"));

        bad_bounds.activity_min_s = -1.0;
        bad_bounds.activity_max_s = 100.0;
        assert!(!validate_scenario(&g, &scenario(&g, (2, 10), vec![bad_bounds], time_only(1000.0, 0.0))).ok);

        let nan_weight = site(&g, "A", 12, 10, f64::NAN, 10.0, 10.0);
        assert!(!validate_scenario(&g, &scenario(&g, (2, 10), vec![nan_weight], time_only(1000.0, 0.0))).ok);

        let zero_max = site(&g, "A", 12, 10, 1.0, 0.0, 0.0);
        assert!(!validate_scenario(&g, &scenario(&g, (2, 10), vec![zero_max], time_only(1000.0, 0.0))).ok);
    }

    #[test]
    fn duplicate_or_reserved_site_ids_are_errors() {
        let g = flat(21, 21, 1.0);
        let dup = vec![site(&g, "A", 12, 10, 1.0, 10.0, 10.0), site(&g, "A", 7, 10, 1.0, 10.0, 10.0)];
        assert!(!validate_scenario(&g, &scenario(&g, (2, 10), dup, time_only(1000.0, 0.0))).ok);
        let reserved = vec![site(&g, BASE_ID, 12, 10, 1.0, 10.0, 10.0)];
        assert!(!validate_scenario(&g, &scenario(&g, (2, 10), reserved, time_only(1000.0, 0.0))).ok);
    }

    #[test]
    fn site_outside_coverage_is_a_warning_not_an_error() {
        let g = flat(21, 21, 1.0);
        let mut far = site(&g, "A", 12, 10, 1.0, 10.0, 10.0);
        far.position = LocalPoint::new(500.0, 10.0);
        let report = validate_scenario(&g, &scenario(&g, (2, 10), vec![far], time_only(1000.0, 0.0)));
        assert!(report.ok);
        assert_eq!(report.issues[0].code, "SiteOutsideCoverage");
        assert_eq!(report.issues[0].severity, Severity::Warning);
    }

    // ---- Invariants ----------------------------------------------------------

    /// Rolling terrain with a few steep cells and a hole; six candidate sites.
    fn varied() -> (PlanningGrid, MissionScenario) {
        let (w, h) = (60, 40);
        let mut g = flat(w, h, 5.0);
        for row in 0..h {
            for col in 0..w {
                let i = g.index(col, row);
                g.elevation_m[i] = (col as f32 * 0.35).sin() * 4.0 + (row as f32 * 0.21).cos() * 3.0;
                g.slope_deg[i] = 3.0 + ((col * 7 + row * 13) % 11) as f32;
            }
        }
        for row in 5..30 {
            block(&mut g, 30, row);
        }
        unknown(&mut g, 45, 20);
        let sites = vec![
            site(&g, "s1", 10, 5, 3.0, 300.0, 900.0),
            site(&g, "s2", 25, 30, 2.0, 300.0, 600.0),
            site(&g, "s3", 40, 10, 5.0, 600.0, 1200.0),
            site(&g, "s4", 55, 35, 4.0, 300.0, 900.0),
            site(&g, "s5", 50, 5, 1.0, 120.0, 300.0),
            site(&g, "s6", 45, 20, 9.0, 120.0, 300.0),
        ];
        let mut s = scenario(&g, (5, 20), sites, time_only(3600.0, 600.0));
        s.model.overhead_s = coef(120.0, "s");
        s.model.base_power_w = coef(200.0, "W");
        s.model.consumable_rate_travel_per_h = coef(0.08, "kg/h");
        s.model.consumable_rate_activity_per_h = coef(0.05, "kg/h");
        (g, s)
    }

    #[test]
    fn feasible_plans_never_violate_a_hard_constraint_across_many_budgets() {
        let (g, base) = varied();
        let mut feasible = 0;
        for eva in [200.0, 900.0, 1800.0, 3600.0, 7200.0, 20_000.0] {
            for energy in [None, Some(60.0), Some(400.0)] {
                for cons in [None, Some(0.03), Some(0.5)] {
                    let mut s = base.clone();
                    s.budget = ResourceBudget {
                        eva_limit_s: eva,
                        eva_reserve_s: eva * 0.15,
                        energy_budget_wh: energy,
                        energy_reserve_wh: energy.map(|e| e * 0.1),
                        consumable_budget: cons,
                        consumable_reserve: cons.map(|c| c * 0.2),
                        consumable_unit: cons.map(|_| "kg".to_string()),
                    };
                    let r = plan_greedy(&g, &s);
                    if r.status != PlanStatus::FeasibleModeled {
                        assert!(r.stops.is_empty() && r.legs.is_empty());
                        continue;
                    }
                    feasible += 1;
                    assert!(!r.stops.is_empty());
                    assert!(r.checks.iter().all(|c| c.satisfied), "violated: {:?}", r.checks);
                    assert_eq!(r.legs.first().unwrap().from, BASE_ID);
                    assert_eq!(r.legs.last().unwrap().to, BASE_ID);
                    assert_eq!(r.legs.len(), r.stops.len() + 1);
                    for stop in &r.stops {
                        let site = s.sites.iter().find(|x| x.id == stop.site_id).unwrap();
                        assert!(stop.activity_s >= site.activity_min_s - 1e-9);
                        assert!(stop.activity_s <= site.activity_max_s + 1e-9);
                        assert_ne!(stop.site_id, "s6", "site on missing data must never be visited");
                    }
                }
            }
        }
        assert!(feasible >= 10, "fixture should exercise feasible plans, got {feasible}");
    }

    #[test]
    fn same_inputs_give_the_same_plan() {
        let (g, s) = varied();
        let mut a = plan_greedy(&g, &s);
        let mut b = plan_greedy(&g, &s);
        a.timing = Timing::default();
        b.timing = Timing::default();
        assert_eq!(serde_json::to_string(&a).unwrap(), serde_json::to_string(&b).unwrap());
    }

    #[test]
    fn totals_equal_the_sum_of_legs_and_stops() {
        let (g, s) = varied();
        let r = plan_greedy(&g, &s);
        let t = r.totals.as_ref().unwrap();
        let leg_time: f64 = r.legs.iter().map(|l| l.leg.time_s).sum();
        let leg_dist: f64 = r.legs.iter().map(|l| l.leg.distance_m).sum();
        let work: f64 = r.stops.iter().map(|x| x.activity_s).sum();
        assert!((t.travel_time_s - leg_time).abs() < 1e-6);
        assert!((t.distance_m - leg_dist).abs() < 1e-6);
        assert!((t.activity_time_s - work).abs() < 1e-6);
        assert!((t.eva_time_s - (leg_time + work + 120.0)).abs() < 1e-6);
        let last = r.stops.last().unwrap();
        let back = r.legs.last().unwrap().leg.time_s;
        assert!((last.depart_s + back - t.eva_time_s).abs() < 1e-6);
    }

    // ---- Exact subset/order solver ------------------------------------------

    /// Highest minimum-dwell utility over every ordered subset, by exhaustion.
    fn exhaustive_min_dwell_utility(grid: &PlanningGrid, scenario: &MissionScenario) -> f64 {
        let mut scratch = MissionResult {
            status: PlanStatus::Infeasible,
            solver: SolverInfo { name: "Scratch".into(), version: "1".into(), description: String::new() },
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
        let table = LegTable::route(grid, scenario, &mut scratch);
        let problem = Problem { scenario, table: &table };
        let minimum = dwell_at_minimum(scenario);
        fn walk(
            problem: &Problem,
            minimum: &[f64],
            remaining: &mut Vec<usize>,
            prefix: &mut Vec<usize>,
            best: &mut f64,
        ) {
            if !prefix.is_empty() {
                if let Some(eval) = problem.evaluate(prefix, minimum) {
                    if eval.feasible() {
                        *best = best.max(eval.utility);
                    }
                }
            }
            for i in 0..remaining.len() {
                let site = remaining.remove(i);
                prefix.push(site);
                walk(problem, minimum, remaining, prefix, best);
                prefix.pop();
                remaining.insert(i, site);
            }
        }
        let mut remaining: Vec<usize> = (0..scenario.sites.len()).collect();
        let mut best = 0.0;
        walk(&problem, &minimum, &mut remaining, &mut Vec::new(), &mut best);
        best
    }

    #[test]
    fn dp_matches_exhaustive_search_when_durations_are_fixed() {
        let g = flat(31, 31, 1.0);
        let s = scenario(
            &g,
            (15, 15),
            vec![
                site(&g, "A", 5, 15, 1.0, 50.0, 50.0),
                site(&g, "B", 25, 15, 0.9, 50.0, 50.0),
                site(&g, "C", 15, 5, 0.8, 50.0, 50.0),
                site(&g, "D", 15, 25, 0.7, 50.0, 50.0),
            ],
            time_only(180.0, 0.0),
        );
        let result = plan_dp(&g, &s);
        assert_eq!(result.status, PlanStatus::FeasibleModeled);
        let expected = exhaustive_min_dwell_utility(&g, &s);
        assert!((expected - 1.9).abs() < 1e-9, "fixture should fit A and B only");
        assert!((result.utility - expected).abs() < 1e-9);
    }

    #[test]
    fn dp_selects_a_better_subset_than_greedy_insertion() {
        let g = flat(31, 31, 1.0);
        let s = scenario(
            &g,
            (15, 15),
            vec![
                site(&g, "X", 18, 15, 1.0, 100.0, 100.0),
                site(&g, "Y", 5, 15, 1.1, 100.0, 100.0),
                site(&g, "Z", 25, 15, 1.1, 100.0, 100.0),
            ],
            time_only(240.0, 0.0),
        );
        let greedy = plan_greedy(&g, &s);
        let dp = plan_dp(&g, &s);
        assert_eq!(greedy.status, PlanStatus::FeasibleModeled);
        assert!((greedy.utility - 2.1).abs() < 1e-9, "baseline takes X plus one side");
        assert_eq!(dp.status, PlanStatus::FeasibleModeled);
        assert!((dp.utility - 2.2).abs() < 1e-9, "exact solver takes both sides");
        assert!(ids(&dp).contains(&"Y") && ids(&dp).contains(&"Z"));
        assert!(!ids(&dp).contains(&"X"));
    }

    #[test]
    fn dp_is_never_worse_than_the_baseline_on_the_varied_fixture() {
        let (g, s) = varied();
        let dp = plan_dp(&g, &s);
        let greedy = plan_greedy(&g, &s);
        if greedy.status == PlanStatus::FeasibleModeled {
            assert_eq!(dp.status, PlanStatus::FeasibleModeled);
        }
        assert!(dp.utility + 1e-9 >= greedy.utility);
    }

    #[test]
    fn dp_is_deterministic() {
        let (g, s) = varied();
        let mut a = plan_dp(&g, &s);
        let mut b = plan_dp(&g, &s);
        a.timing = Timing::default();
        b.timing = Timing::default();
        assert_eq!(serde_json::to_string(&a).unwrap(), serde_json::to_string(&b).unwrap());
    }

    #[test]
    fn dp_abandons_a_search_that_exceeds_its_budget() {
        let (g, s) = varied();
        let mut scratch = MissionResult {
            status: PlanStatus::Infeasible,
            solver: SolverInfo { name: "Scratch".into(), version: "1".into(), description: String::new() },
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
        let table = LegTable::route(&g, &s, &mut scratch);
        let problem = Problem { scenario: &s, table: &table };
        let minimum = dwell_at_minimum(&s);
        assert!(subset_dp_order_within(&problem, &table, &minimum, 0.0, &[]).is_empty());
        // The public planner still produces the baseline schedule.
        let fallback = plan_dp_within(&g, &s, 0.0);
        assert_eq!(fallback.status, PlanStatus::FeasibleModeled);
        assert_eq!(fallback.solver.name, "GreedyPlanner");
        assert!(!fallback.stops.is_empty());
    }
}
