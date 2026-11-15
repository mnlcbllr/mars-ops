use crate::contingency::{CellRef, ContingencyEvent, ResourceKind};
use crate::mission::*;
use crate::planning::{plan_exact_small, plan_greedy, ScientificSite, MissionScenario, PlanStatus};
use crate::terrain::PlanningGrid;
use crate::resources::ResourceBudget;
use crate::provenance::EvidenceKind;
use crate::resources::test_support::{bare_model, coef, time_only};
use crate::route::test_support::{at, flat};

pub(crate) fn fixture() -> (PlanningGrid, MissionScenario) {
    let g = flat(15, 9, 1.0);
    let sites = [("A", 4), ("B", 8), ("C", 12)].iter().map(|(id, col)| ScientificSite {
        id: id.to_string(), name: id.to_string(), position: at(&g, *col, 4),
        science_rationale: "SYNTHETIC fixture".into(), source_product_ids: vec![],
        evidence_kind: EvidenceKind::Synthetic, activity_min_s: 10.0, activity_max_s: 10.0,
        activity_power_w: 360.0, preference_weight: 1.0, required: false,
    }).collect();
    let mut model = bare_model();
    model.base_power_w = coef(360.0, "W");
    model.overhead_s = coef(5.0, "s");
    model.consumable_rate_travel_per_h = coef(36.0, "kg/h");
    model.consumable_rate_activity_per_h = coef(72.0, "kg/h");
    let s = MissionScenario { schema_version: 1, name: "SYNTHETIC three stops".into(),
        dataset_id: "synthetic".into(), base: at(&g, 1, 4), sites,
        budget: ResourceBudget { energy_budget_wh: Some(200.0), energy_reserve_wh: Some(20.0),
            consumable_budget: Some(10.0), consumable_reserve: Some(1.0), consumable_unit: Some("kg".into()),
            ..time_only(100.0, 10.0) }, model };
    (g, s)
}

fn start(g: &PlanningGrid, s: &MissionScenario) -> MissionState {
    MissionState::start(s.clone(), plan_greedy(g, s), "fixture-hash".into()).unwrap()
}

fn advance(g: &PlanningGrid, m: &mut MissionState, steps: usize) {
    *m = m.apply(g, MissionAction::Advance { steps }).unwrap();
}

fn first_stop(g: &PlanningGrid, m: &mut MissionState) {
    for _ in 0..100 {
        if !m.completed.is_empty() { return; }
        advance(g, m, 1);
    }
    panic!("fixture never reached first stop");
}

fn inject(g: &PlanningGrid, m: &mut MissionState, event: ContingencyEvent) {
    *m = m.apply(g, MissionAction::Inject { dataset_id: m.scenario.dataset_id.clone(), event }).unwrap();
}

#[test]
fn simulation_follows_the_actual_lattice_and_matches_resource_model_without_double_counting() {
    let (g, s) = fixture();
    let mut m = start(&g, &s);
    let totals = m.plan.totals.clone().unwrap();
    while m.phase != Phase::Returned {
        let before = m.used.clone();
        advance(&g, &mut m, 1);
        assert!(m.used.eva_time_s >= before.eva_time_s && m.used.energy_wh >= before.energy_wh
            && m.used.consumable >= before.consumable);
        let (c, r) = g.cell_of(m.position).unwrap();
        assert_eq!(m.position, g.cell_center(c, r));
    }
    assert_eq!(m.completed.len(), 3);
    assert_eq!(m.position, m.original_plan.legs[0].leg.path[0]);
    assert!((totals.energy_wh - m.used.energy_wh).abs() < 1e-9);
    assert!((totals.consumable - m.used.consumable).abs() < 1e-9);
    assert_eq!(totals.eva_time_s, m.used.eva_time_s);
    assert_eq!(m.used.overhead_s, 5.0);
    assert!(matches!(m.apply(&g, MissionAction::Advance { steps: 1 }), Err(MissionError::Returned)));
}

#[test]
fn blocked_corridor_after_science_requires_real_replan_and_returns_to_original_base() {
    let (g, s) = fixture();
    let mut m = start(&g, &s);
    first_stop(&g, &mut m);
    let position = m.position;
    let used = m.used.clone();
    let done = m.completed.clone();
    inject(&g, &mut m, ContingencyEvent::BlockCells { cells: (2..=6).map(|row| CellRef { col: 6, row }).collect(), reason: "USER_DEFINED corridor".into() });
    assert!(matches!(m.apply(&g, MissionAction::Advance { steps: 1 }), Err(MissionError::Invalidated)));
    m = m.apply(&g, MissionAction::Replan { exact: true }).unwrap();
    assert_eq!(m.position, position);
    assert_eq!(m.used, used);
    assert_eq!(m.completed, done);
    assert!(m.plan_valid);
    assert_eq!(m.plan.legs[0].leg.path[0], position);
    assert_eq!(*m.plan.legs.last().unwrap().leg.path.last().unwrap(), m.original_plan.legs[0].leg.path[0]);
    assert!(!m.plan.stops.iter().any(|p| done.contains(&p.site_id)));
    let blocked = m.blocked_set(&g);
    for p in m.plan.legs.iter().flat_map(|l| &l.leg.path) {
        let (c, r) = g.cell_of(*p).unwrap();
        assert!(!blocked.contains(&g.index(c, r)));
    }
    advance(&g, &mut m, 4096);
    assert_eq!(m.phase, Phase::Returned);
    assert_eq!(m.completed.len(), 3);
}

#[test]
fn mid_route_and_return_only_replans_never_jump_or_reset_consumption() {
    let (g, s) = fixture();
    let mut m = start(&g, &s);
    advance(&g, &mut m, 3);
    let here = m.position;
    let used = m.used.clone();
    m = m.apply(&g, MissionAction::Replan { exact: false }).unwrap();
    assert_eq!(m.position, here);
    assert_eq!(m.used, used);
    advance(&g, &mut m, 4096);
    assert_eq!(m.phase, Phase::Returned);
    // Replan on the final return leg, all science already complete.
    let mut m = start(&g, &s);
    while m.completed.len() < 3 { advance(&g, &mut m, 1); }
    m = m.apply(&g, MissionAction::Replan { exact: true }).unwrap();
    assert!(m.plan_valid && m.plan.stops.is_empty());
    assert_eq!(m.plan.legs.last().unwrap().to, "BASE");
    advance(&g, &mut m, 4096);
    assert_eq!(m.phase, Phase::Returned);
}

#[test]
fn delay_and_resource_loss_reduce_feasibility_and_never_spend_the_reserve() {
    let (g, s) = fixture();
    for event in [
        ContingencyEvent::Delay { seconds: 90.0, reason: "MODELED delay".into() },
        ContingencyEvent::ResourceAdjustment { resource: ResourceKind::EvaTime, amount: 70.0, reason: "USER_DEFINED reduced allowance".into() },
        ContingencyEvent::ResourceAdjustment { resource: ResourceKind::Energy, amount: 180.0, reason: "USER_DEFINED loss".into() },
        ContingencyEvent::ResourceAdjustment { resource: ResourceKind::Consumable, amount: 9.0, reason: "USER_DEFINED loss".into() },
    ] {
        let mut m = start(&g, &s);
        first_stop(&g, &mut m);
        inject(&g, &mut m, event);
        m = m.apply(&g, MissionAction::Replan { exact: true }).unwrap();
        assert_eq!(m.plan.status, PlanStatus::Infeasible);
        assert!(!m.plan_valid && !m.plan.issues.is_empty());
    }
}

#[test]
fn impossible_terrain_return_is_explicit_and_repeated_replans_do_not_complete_tasks_twice() {
    let (g, s) = fixture();
    let mut m = start(&g, &s);
    first_stop(&g, &mut m);
    inject(&g, &mut m, ContingencyEvent::BlockCells { cells: (0..g.height).map(|row| CellRef { col: 2, row }).collect(), reason: "cut off base".into() });
    m = m.apply(&g, MissionAction::Replan { exact: false }).unwrap();
    assert_eq!(m.plan.status, PlanStatus::Infeasible);
    assert!(m.plan.issues.iter().any(|i| i.code == "ReturnInfeasible"));
    let done = m.completed.clone();
    m = m.apply(&g, MissionAction::Replan { exact: true }).unwrap();
    assert_eq!(m.completed, done);
}

#[test]
fn wrong_dataset_occupied_unknown_and_invalid_cells_are_refused_transactionally() {
    let (mut g, s) = fixture();
    let m = start(&g, &s);
    assert!(m.apply(&g, MissionAction::Inject { dataset_id: "other".into(), event: ContingencyEvent::Delay { seconds: 1.0, reason: "".into() } }).is_err());
    for cell in [CellRef { col: 1, row: 4 }, CellRef { col: 15, row: 0 }, CellRef { col: 3, row: 3 }] {
        g.elevation_m[3 * g.width + 3] = f32::NAN;
        assert!(m.apply(&g, MissionAction::Inject { dataset_id: "synthetic".into(), event: ContingencyEvent::BlockCells { cells: vec![cell], reason: "".into() } }).is_err());
    }
    assert!(m.events.is_empty());
}

#[test]
fn deterministic_replay_is_structurally_identical_including_replans() {
    let (g, s) = fixture();
    let mut a = start(&g, &s);
    first_stop(&g, &mut a);
    inject(&g, &mut a, ContingencyEvent::Delay { seconds: 3.0, reason: "seed 42".into() });
    a = a.apply(&g, MissionAction::Replan { exact: true }).unwrap();
    advance(&g, &mut a, 4096);
    let mut b = start(&g, &s);
    for entry in &a.timeline { b = b.apply(&g, entry.action.clone()).unwrap(); }
    assert_eq!(serde_json::to_vec(&a).unwrap(), serde_json::to_vec(&b).unwrap());
    assert_eq!(serde_json::from_slice::<MissionState>(&serde_json::to_vec(&a).unwrap()).unwrap(), a);
}

#[test]
fn exact_matches_or_improves_fixed_duration_greedy_and_caps_large_instances() {
    let (g, s) = fixture();
    let greedy = plan_greedy(&g, &s);
    let exact = plan_exact_small(&g, &s);
    assert!(exact.utility >= greedy.utility);
    assert!(exact.checks.iter().all(|c| c.satisfied));
    assert!(exact.solver.description.contains("completed"));
    let mut large = s.clone();
    large.sites = (0..9).map(|i| { let mut site = s.sites[0].clone(); site.id = format!("T{i}"); site }).collect();
    let capped = plan_exact_small(&g, &large);
    assert!(capped.solver.description.contains("fallback"));
    assert!(capped.checks.iter().all(|c| c.satisfied));
}
