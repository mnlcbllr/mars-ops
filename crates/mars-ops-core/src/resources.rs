//! Declared resource model: EVA time, energy and one consumable.
//!
//! Research prototype. Every coefficient is a scenario assumption carried with
//! its provenance; none is a NASA-certified astronaut rate.
//!
//! * EVA time  = travel + activities + fixed overhead
//! * energy    = base power × EVA time + Σ activity power × activity time
//! * consumable = travel rate × travel time + activity rate × (activity + overhead time)
//!
//! A plan may use at most `budget − reserve` of each resource. Reserves are a
//! hard constraint: no weight can trade them away.

use crate::provenance::Coefficient;
use crate::route::TraversalModel;
use serde::{Deserialize, Serialize};

/// What the excursion is allowed to consume. `None` = no limit declared for
/// that resource (shown as "no limit set", never as zero).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ResourceBudget {
    pub eva_limit_s: f64,
    pub eva_reserve_s: f64,
    pub energy_budget_wh: Option<f64>,
    pub energy_reserve_wh: Option<f64>,
    pub consumable_budget: Option<f64>,
    pub consumable_reserve: Option<f64>,
    pub consumable_unit: Option<String>,
}

/// Scenario coefficients of the traversal and consumption models.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ResourceModel {
    pub model_version: String,
    pub flat_speed_m_s: Coefficient,
    pub slope_time_penalty: Coefficient,
    pub max_slope_deg: Coefficient,
    pub overhead_s: Coefficient,
    pub base_power_w: Coefficient,
    pub consumable_rate_travel_per_h: Coefficient,
    pub consumable_rate_activity_per_h: Coefficient,
}

impl ResourceModel {
    pub fn traversal(&self) -> TraversalModel {
        TraversalModel {
            max_slope_deg: self.max_slope_deg.value,
            flat_speed_m_s: self.flat_speed_m_s.value,
            slope_time_penalty: self.slope_time_penalty.value,
        }
    }
}

/// One activity as the resource model sees it.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Activity {
    pub duration_s: f64,
    pub power_w: f64,
}

/// Modeled consumption of a whole round trip.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ResourceUse {
    pub distance_m: f64,
    pub travel_time_s: f64,
    pub activity_time_s: f64,
    pub overhead_s: f64,
    pub eva_time_s: f64,
    pub energy_wh: f64,
    pub consumable: f64,
}

/// One hard constraint, evaluated.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ConstraintCheck {
    /// `eva_time`, `energy` or `consumable`.
    pub resource: String,
    pub unit: String,
    pub used: f64,
    pub budget: f64,
    pub reserve: f64,
    /// `budget − reserve`: the most a plan may use.
    pub available: f64,
    /// `available − used`; negative when violated.
    pub margin: f64,
    pub satisfied: bool,
}

/// Total consumption of a route with the given travel and activities.
pub fn resource_use(
    model: &ResourceModel,
    distance_m: f64,
    travel_time_s: f64,
    activities: &[Activity],
) -> ResourceUse {
    let activity_time_s: f64 = activities.iter().map(|a| a.duration_s).sum();
    let overhead_s = model.overhead_s.value;
    let eva_time_s = travel_time_s + activity_time_s + overhead_s;
    let activity_energy_ws: f64 = activities.iter().map(|a| a.power_w * a.duration_s).sum();
    ResourceUse {
        distance_m,
        travel_time_s,
        activity_time_s,
        overhead_s,
        eva_time_s,
        energy_wh: (model.base_power_w.value * eva_time_s + activity_energy_ws) / 3600.0,
        consumable: (model.consumable_rate_travel_per_h.value * travel_time_s
            + model.consumable_rate_activity_per_h.value * (activity_time_s + overhead_s))
            / 3600.0,
    }
}

/// Evaluate every declared limit. Resources without a budget produce no check.
pub fn check_budget(used: &ResourceUse, budget: &ResourceBudget) -> Vec<ConstraintCheck> {
    let check = |resource: &str, unit: &str, used: f64, budget: f64, reserve: f64| {
        let available = budget - reserve;
        // Tolerance covers floating-point noise only (one part in 10⁹).
        let tolerance = 1e-9 * available.abs().max(1.0);
        ConstraintCheck {
            resource: resource.into(),
            unit: unit.into(),
            used,
            budget,
            reserve,
            available,
            margin: available - used,
            satisfied: used <= available + tolerance,
        }
    };
    let mut checks =
        vec![check("eva_time", "s", used.eva_time_s, budget.eva_limit_s, budget.eva_reserve_s)];
    if let Some(energy) = budget.energy_budget_wh {
        checks.push(check(
            "energy",
            "Wh",
            used.energy_wh,
            energy,
            budget.energy_reserve_wh.unwrap_or(0.0),
        ));
    }
    if let Some(consumable) = budget.consumable_budget {
        checks.push(check(
            "consumable",
            budget.consumable_unit.as_deref().unwrap_or(""),
            used.consumable,
            consumable,
            budget.consumable_reserve.unwrap_or(0.0),
        ));
    }
    checks
}

/// Problems that make a budget or model unusable, as human-readable messages.
/// Empty when the inputs are valid.
pub fn invalid_inputs(budget: &ResourceBudget, model: &ResourceModel) -> Vec<String> {
    let mut problems = Vec::new();
    let ok = |v: f64| v.is_finite() && v >= 0.0;

    let mut pair = |name: &str, limit: Option<f64>, reserve: Option<f64>| match (limit, reserve) {
        (None, None) => {}
        (None, Some(_)) => problems.push(format!("{name} has a reserve but no budget")),
        (Some(l), _) if !ok(l) => {
            problems.push(format!("{name} budget must be a non-negative number (got {l})"))
        }
        (Some(_), Some(r)) if !ok(r) => {
            problems.push(format!("{name} reserve must be a non-negative number (got {r})"))
        }
        (Some(l), Some(r)) if r > l => {
            problems.push(format!("{name} reserve ({r}) is larger than its budget ({l})"))
        }
        _ => {}
    };
    pair("EVA time", Some(budget.eva_limit_s), Some(budget.eva_reserve_s));
    pair("energy", budget.energy_budget_wh, budget.energy_reserve_wh);
    pair("consumable", budget.consumable_budget, budget.consumable_reserve);
    if budget.consumable_budget.is_some()
        && budget.consumable_unit.as_deref().map_or(true, |u| u.trim().is_empty())
    {
        problems.push("consumable budget needs a unit".to_string());
    }

    if !(model.flat_speed_m_s.value.is_finite() && model.flat_speed_m_s.value > 0.0) {
        problems.push(format!("flat speed must be positive (got {})", model.flat_speed_m_s.value));
    }
    let slope = model.max_slope_deg.value;
    if !(slope.is_finite() && slope > 0.0 && slope <= 90.0) {
        problems.push(format!("slope limit must be between 0° and 90° (got {slope})"));
    }
    for (name, c) in [
        ("slope time penalty", &model.slope_time_penalty),
        ("EVA overhead", &model.overhead_s),
        ("base power", &model.base_power_w),
        ("consumable travel rate", &model.consumable_rate_travel_per_h),
        ("consumable activity rate", &model.consumable_rate_activity_per_h),
    ] {
        if !ok(c.value) {
            problems.push(format!("{name} must be a non-negative number (got {})", c.value));
        }
    }
    problems
}

#[cfg(test)]
pub(crate) mod test_support {
    use super::*;
    use crate::provenance::EvidenceKind;

    pub fn coef(value: f64, unit: &str) -> Coefficient {
        Coefficient {
            value,
            unit: unit.into(),
            source_type: EvidenceKind::Synthetic,
            citation_or_assumption: "test fixture".into(),
            range: None,
            version: 1,
        }
    }

    /// 1 m/s, no overhead, no power, no consumable use.
    pub fn bare_model() -> ResourceModel {
        ResourceModel {
            model_version: "test".into(),
            flat_speed_m_s: coef(1.0, "m/s"),
            slope_time_penalty: coef(5.0, "1"),
            max_slope_deg: coef(20.0, "deg"),
            overhead_s: coef(0.0, "s"),
            base_power_w: coef(0.0, "W"),
            consumable_rate_travel_per_h: coef(0.0, "kg/h"),
            consumable_rate_activity_per_h: coef(0.0, "kg/h"),
        }
    }

    pub fn time_only(eva_limit_s: f64, eva_reserve_s: f64) -> ResourceBudget {
        ResourceBudget {
            eva_limit_s,
            eva_reserve_s,
            energy_budget_wh: None,
            energy_reserve_wh: None,
            consumable_budget: None,
            consumable_reserve: None,
            consumable_unit: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::*;
    use super::*;

    fn model() -> ResourceModel {
        ResourceModel {
            overhead_s: coef(60.0, "s"),
            base_power_w: coef(360.0, "W"),
            consumable_rate_travel_per_h: coef(36.0, "kg/h"),
            consumable_rate_activity_per_h: coef(72.0, "kg/h"),
            ..bare_model()
        }
    }

    fn used() -> ResourceUse {
        let acts = [
            Activity { duration_s: 100.0, power_w: 3600.0 },
            Activity { duration_s: 50.0, power_w: 0.0 },
        ];
        resource_use(&model(), 25.0, 20.0, &acts)
    }

    #[test]
    fn eva_time_is_travel_plus_activities_plus_overhead() {
        let u = used();
        assert_eq!(u.travel_time_s, 20.0);
        assert_eq!(u.activity_time_s, 150.0);
        assert_eq!(u.overhead_s, 60.0);
        assert_eq!(u.eva_time_s, 230.0);
        assert_eq!(u.distance_m, 25.0);
    }

    #[test]
    fn energy_is_base_load_over_the_eva_plus_each_activity_load() {
        // 360 W × 230 s = 23 Wh; 3600 W × 100 s = 100 Wh.
        assert!((used().energy_wh - 123.0).abs() < 1e-9);
    }

    #[test]
    fn consumable_uses_travel_rate_for_travel_and_activity_rate_otherwise() {
        // 36/h × 20 s = 0.2; 72/h × (150 + 60) s = 4.2.
        assert!((used().consumable - 4.4).abs() < 1e-9);
    }

    #[test]
    fn only_declared_limits_are_checked() {
        let checks = check_budget(&used(), &time_only(1000.0, 100.0));
        assert_eq!(checks.len(), 1);
        assert_eq!(checks[0].resource, "eva_time");
    }

    #[test]
    fn reserve_is_subtracted_before_comparing() {
        // 230 s used. Limit 300 with 60 reserve leaves 240: satisfied, margin 10.
        let c = &check_budget(&used(), &time_only(300.0, 60.0))[0];
        assert_eq!((c.available, c.margin, c.satisfied), (240.0, 10.0, true));
        // Same limit with 80 reserve leaves 220: violated although 230 < 300.
        let c = &check_budget(&used(), &time_only(300.0, 80.0))[0];
        assert_eq!((c.available, c.margin, c.satisfied), (220.0, -10.0, false));
    }

    #[test]
    fn using_exactly_what_is_available_is_allowed() {
        let c = &check_budget(&used(), &time_only(230.0, 0.0))[0];
        assert!(c.satisfied);
    }

    #[test]
    fn energy_and_consumable_limits_are_enforced_when_declared() {
        let budget = ResourceBudget {
            energy_budget_wh: Some(130.0),
            energy_reserve_wh: Some(10.0),
            consumable_budget: Some(5.0),
            consumable_reserve: Some(0.5),
            consumable_unit: Some("kg O2".into()),
            ..time_only(1000.0, 0.0)
        };
        let checks = check_budget(&used(), &budget);
        let energy = checks.iter().find(|c| c.resource == "energy").unwrap();
        // 123 Wh used of 120 available.
        assert!(!energy.satisfied && (energy.margin + 3.0).abs() < 1e-9);
        let cons = checks.iter().find(|c| c.resource == "consumable").unwrap();
        // 4.4 used of 4.5 available.
        assert!(cons.satisfied && (cons.margin - 0.1).abs() < 1e-9);
        assert_eq!(cons.unit, "kg O2");
    }

    #[test]
    fn valid_inputs_report_no_problems() {
        assert!(invalid_inputs(&time_only(1000.0, 100.0), &model()).is_empty());
    }

    #[test]
    fn negative_or_non_finite_budget_values_are_rejected() {
        assert_eq!(invalid_inputs(&time_only(-1.0, 0.0), &model()).len(), 1);
        assert_eq!(invalid_inputs(&time_only(f64::NAN, 0.0), &model()).len(), 1);
        assert_eq!(invalid_inputs(&time_only(1000.0, -5.0), &model()).len(), 1);
        let b = ResourceBudget { energy_budget_wh: Some(-10.0), ..time_only(1000.0, 0.0) };
        assert_eq!(invalid_inputs(&b, &model()).len(), 1);
    }

    #[test]
    fn reserve_larger_than_budget_is_rejected() {
        assert_eq!(invalid_inputs(&time_only(100.0, 200.0), &model()).len(), 1);
        let b = ResourceBudget {
            consumable_budget: Some(1.0),
            consumable_reserve: Some(2.0),
            consumable_unit: Some("kg".into()),
            ..time_only(1000.0, 0.0)
        };
        assert_eq!(invalid_inputs(&b, &model()).len(), 1);
    }

    #[test]
    fn reserve_without_a_budget_is_rejected() {
        let b = ResourceBudget { energy_reserve_wh: Some(5.0), ..time_only(1000.0, 0.0) };
        assert_eq!(invalid_inputs(&b, &model()).len(), 1);
    }

    #[test]
    fn non_positive_speed_and_negative_rates_are_rejected() {
        let m = ResourceModel { flat_speed_m_s: coef(0.0, "m/s"), ..model() };
        assert_eq!(invalid_inputs(&time_only(1000.0, 0.0), &m).len(), 1);
        let m = ResourceModel { base_power_w: coef(-1.0, "W"), ..model() };
        assert_eq!(invalid_inputs(&time_only(1000.0, 0.0), &m).len(), 1);
        let m = ResourceModel { max_slope_deg: coef(95.0, "deg"), ..model() };
        assert_eq!(invalid_inputs(&time_only(1000.0, 0.0), &m).len(), 1);
    }
}
