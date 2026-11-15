import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { assessReplan } from "./replan";
import type {
  ConstraintCheck, MissionResult, MissionScenario, SimulationPhase, SimulationView,
} from "./types";

/** Synthetic fixtures for the advisory logic; no real mission is claimed. */
function scenario(): MissionScenario {
  const read = (file: string) => JSON.parse(readFileSync(new URL(`../../datasets/jezero-small/${file}`, import.meta.url), "utf8"));
  const assumptions = read("assumptions.json");
  const targets = read("targets.json");
  return { schema_version: 1, name: "Test scenario", dataset_id: "jezero-small", ...assumptions, base: targets.base, sites: targets.sites };
}

function plan(): MissionResult {
  return {
    status: "FEASIBLE_MODELED",
    solver: { name: "Test planner", version: "1", description: "Synthetic fixture." },
    stops: [], legs: [], totals: null, checks: [], utility: 0, issues: [], excluded: [],
    timing: { routing_ms: 0, planning_ms: 0, legs_routed: 0, cells_expanded: 0 },
  };
}

function check(overrides: Partial<ConstraintCheck> & { resource: ConstraintCheck["resource"] }): ConstraintCheck {
  const budget = overrides.budget ?? 21600;
  const reserve = overrides.reserve ?? 2700;
  const used = overrides.used ?? 1000;
  const available = budget - reserve;
  return {
    unit: overrides.resource === "eva_time" ? "s" : "Wh",
    used,
    budget,
    reserve,
    available,
    margin: available - used,
    satisfied: used <= available,
    ...overrides,
  };
}

function view(options: {
  checks?: ConstraintCheck[];
  margin?: number | null;
  limit?: number;
  reserve?: number;
  phase?: SimulationPhase;
}): SimulationView {
  const input = scenario();
  const limit = options.limit ?? 21600;
  const reserve = options.reserve ?? 2700;
  return {
    state: {
      schema_version: 1, dataset_id: input.dataset_id, scenario: input,
      initial_plan: plan(), plan: plan(), phase: options.phase ?? "TRAVEL",
      leg_index: 0, point_index: 0, step_elapsed_s: 0, activity_done_s: 0,
      elapsed_s: 600, consumed: {
        distance_m: 0, travel_time_s: 0, activity_time_s: 0, overhead_s: 0,
        eva_time_s: 600, energy_wh: 0, consumable: 0,
      },
      anchor: input.base, completed_sites: [], completed: [], events: [],
      blocked: { width: 1, height: 1, cells: [] }, replans: 0,
    },
    position: input.base,
    remaining_budget: {
      eva_limit_s: limit, eva_reserve_s: reserve,
      energy_budget_wh: null, energy_reserve_wh: null,
      consumable_budget: null, consumable_reserve: null, consumable_unit: null,
    },
    remaining_checks: options.checks ?? [],
    return_margin_s: options.margin === undefined ? 600 : options.margin,
    remaining_sites: 0,
    leg_progress: 0,
  };
}

describe("replan advisory", () => {
  test("a feasible plan in flight raises nothing", () => {
    const advisory = assessReplan(view({
      checks: [check({ resource: "eva_time", used: 1000, budget: 21600, reserve: 2700 })],
    }), false);
    expect(advisory.active).toBe(false);
    expect(advisory.required).toBe(false);
    expect(advisory.chip).toBe("");
  });

  test("a finished or infeasible drill raises nothing", () => {
    for (const phase of ["COMPLETE", "INFEASIBLE"] as const) {
      const advisory = assessReplan(view({
        phase,
        checks: [check({ resource: "eva_time", used: 20000 })],
        margin: null,
      }), true);
      expect(advisory.active).toBe(false);
    }
  });

  test("a reserve that is gone is reported as reserve in use, not as a broken plan", () => {
    const advisory = assessReplan(view({
      checks: [check({ resource: "eva_time", used: 19000, budget: 21600, reserve: 2700 })],
    }), false);
    expect(advisory.active).toBe(true);
    expect(advisory.required).toBe(false);
    expect(advisory.severity).toBe("warning");
    expect(advisory.chip).toBe("Reserve in use");
    expect(advisory.reasons[0]?.text).toContain("reserve");
    expect(advisory.reasons[0]?.text).toContain("total limit still holds");
  });

  test("a resource over the total limit requires a replan", () => {
    const advisory = assessReplan(view({
      checks: [check({ resource: "eva_time", used: 22000, budget: 21600, reserve: 2700 })],
    }), false);
    expect(advisory.required).toBe(true);
    expect(advisory.severity).toBe("critical");
    expect(advisory.chip).toBe("Replan required");
    expect(advisory.reasons[0]?.text).toContain("over the total limit");
  });

  test("a return that eats the reserve still counts as flyable", () => {
    const advisory = assessReplan(view({
      checks: [check({ resource: "eva_time", used: 19000, budget: 21600, reserve: 2700 })],
      margin: -600, limit: 2600, reserve: 2700,
    }), false);
    expect(advisory.required).toBe(false);
    expect(advisory.severity).toBe("warning");
    expect(advisory.reasons.some((reason) => reason.text.includes("still returns inside"))).toBe(true);
  });

  test("a return that needs more than the remaining EVA time requires a replan", () => {
    const advisory = assessReplan(view({
      checks: [check({ resource: "eva_time", used: 20000, budget: 21600, reserve: 2700 })],
      margin: -3000, limit: 1600, reserve: 2700,
    }), false);
    expect(advisory.required).toBe(true);
    expect(advisory.severity).toBe("critical");
    expect(advisory.reasons.some((reason) => reason.text.includes("of EVA time remains"))).toBe(true);
  });

  test("no modeled return route requires a replan", () => {
    const advisory = assessReplan(view({ margin: null }), false);
    expect(advisory.required).toBe(true);
    expect(advisory.reasons[0]?.text).toContain("No direct return route");
  });

  test("a plan that predates a contingency is out of date, not unsafe", () => {
    const advisory = assessReplan(view({}), true);
    expect(advisory.active).toBe(true);
    expect(advisory.required).toBe(false);
    expect(advisory.severity).toBe("info");
    expect(advisory.chip).toBe("Plan out of date");
  });
});
