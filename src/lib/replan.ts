// Turns simulation resource and return state into an honest replan assessment.
//
// The declared reserve is a planning margin, not the operational limit. A
// contingency can spend part of that margin while the crew still returns
// inside the total budget, so the assessment separates three states:
// the plan can no longer be flown (replan required), the safety margin is
// gone but the mission is still flyable (reserve in use), and the displayed
// route predates the last contingency (plan out of date).
//
// The wording is deliberately operational: it states what the crew can and
// cannot do next. It never implies that the planner produced a bad plan.

import { fmt, minutes } from "./format";
import type { ConstraintCheck, SimulationView } from "./types";

export type ReplanSeverity = "critical" | "warning" | "info";

export interface ReplanReason {
  severity: ReplanSeverity;
  text: string;
}

export interface ReplanAssessment {
  /** True when the crew should replan before continuing. */
  active: boolean;
  /** True only when the current plan can no longer be flown as-is. */
  required: boolean;
  /** Worst severity across all reasons. */
  severity: ReplanSeverity | null;
  /** Short label for compact chips. */
  chip: string;
  /** Sentence shown as the panel heading. */
  title: string;
  reasons: ReplanReason[];
}

const LABEL: Record<ConstraintCheck["resource"], string> = {
  eva_time: "EVA time",
  energy: "Energy",
  consumable: "Consumable",
};

const INACTIVE: ReplanAssessment = {
  active: false,
  required: false,
  severity: null,
  chip: "",
  title: "",
  reasons: [],
};

/** EVA time is tracked in seconds; every other resource keeps its own unit. */
function scaleOf(check: ConstraintCheck): number {
  return check.resource === "eva_time" ? 60 : 1;
}

function unitOf(check: ConstraintCheck): string {
  return check.resource === "eva_time" ? "min" : check.unit;
}

function checkReason(check: ConstraintCheck): ReplanReason {
  const scale = scaleOf(check);
  const label = LABEL[check.resource];
  const unit = unitOf(check);
  const used = check.used / scale;
  const budget = check.budget / scale;
  const available = check.available / scale;
  const reserve = check.reserve / scale;
  if (used > budget + 1e-6) {
    return {
      severity: "critical",
      text: `${label} is over the total limit: ${fmt(used, 1)} ${unit} used of ${fmt(budget, 1)} ${unit}.`,
    };
  }
  return {
    severity: "warning",
    text: `${label} has used ${fmt(used - available, 1)} ${unit} of the ${fmt(reserve, 1)} ${unit} reserve. The ${fmt(budget, 1)} ${unit} total limit still holds.`,
  };
}

/** Classify the current simulation state for the replan advisory. */
export function assessReplan(view: SimulationView | null, planStale: boolean): ReplanAssessment {
  if (!view || view.state.phase === "COMPLETE" || view.state.phase === "INFEASIBLE") return INACTIVE;

  const reasons: ReplanReason[] = view.remaining_checks
    .filter((check) => !check.satisfied)
    .map(checkReason);

  const margin = view.return_margin_s;
  const limitS = view.remaining_budget.eva_limit_s;
  const reserveS = view.remaining_budget.eva_reserve_s;
  if (margin === null) {
    reasons.push({
      severity: "critical",
      text: "No direct return route to base is modeled from the current position.",
    });
  } else if (margin < 0) {
    // The margin counts the reserve the return consumes: a negative value means
    // the return eats into the reserve, and a return larger than the whole
    // remaining EVA time cannot be flown at all.
    const reserveUsedS = -margin;
    if (reserveUsedS > reserveS + 1e-6) {
      const returnS = limitS - reserveS + reserveUsedS;
      reasons.push({
        severity: "critical",
        text: `Returning now needs ${minutes(returnS, 1)}, but only ${minutes(limitS, 1)} of EVA time remains.`,
      });
    } else {
      reasons.push({
        severity: "warning",
        text: `Returning now uses ${minutes(reserveUsedS, 1)} of the ${minutes(reserveS, 1)} reserve. The crew still returns inside the ${minutes(limitS, 1)} EVA limit.`,
      });
    }
  }

  if (planStale) {
    reasons.push({
      severity: "info",
      text: "The route and consumption shown predate the last contingency. Replanning refreshes them.",
    });
  }

  if (reasons.length === 0) return INACTIVE;

  const required = reasons.some((reason) => reason.severity === "critical");
  const warning = reasons.some((reason) => reason.severity === "warning");
  return {
    active: true,
    required,
    severity: required ? "critical" : warning ? "warning" : "info",
    chip: required ? "Replan required" : warning ? "Reserve in use" : "Plan out of date",
    title: required
      ? "Replan required"
      : warning
        ? "Reserve margin in use"
        : "Plan out of date",
    reasons,
  };
}
