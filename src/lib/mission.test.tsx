import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { MissionResults } from "@/components/MissionResults";
import { ScenarioEditor } from "@/components/ScenarioEditor";
import { editCoefficient, addedSite, initialMission, missionReducer, planningScenario, type MissionState } from "./mission";
import type { MissionScenario, SimulationView, SolvedRun, ValidationReport } from "./types";

function scenario(): MissionScenario {
  const read = (file: string) => JSON.parse(readFileSync(new URL(`../../datasets/jezero-small/${file}`, import.meta.url), "utf8"));
  const assumptions = read("assumptions.json");
  const targets = read("targets.json");
  return { schema_version: 1, name: "Test scenario", dataset_id: "jezero-small", ...assumptions, base: targets.base, sites: targets.sites };
}

/** Synthetic result for presentation/state tests; not a claimed real-data planning result. */
function solved(input = scenario()): SolvedRun {
  return {
    run_id: 17,
    report: {
      report_schema_version: 1, generated_utc: "2026-11-14T00:00:00Z", software: "HYDE", software_version: "test", code_revision: "test",
      dataset: { dataset_id: input.dataset_id, manifest_sha256: "test", real_data_verified: false, layers: [] },
      planning_grid: { cell_x_m: 4, cell_y_m: 4, raster_cells_per_planning_cell: 4 },
      scenario: input, disclaimers: ["Research prototype; not flight software."],
      result: {
        status: "FEASIBLE_MODELED", solver: { name: "Test planner", version: "1", description: "Synthetic fixture; no optimality claim." },
        stops: [{ site_id: "S1", arrive_s: 240, activity_s: 60, depart_s: 300, utility: 1.25 }],
        legs: [
          { from: "BASE", to: "S1", path: [input.base, input.sites[0]!.position], elevation_m: [-2600, -2590], distance_m: 123, time_s: 120, ascent_m: 10, descent_m: 0, max_slope_deg: 5, cells_expanded: 12 },
          { from: "S1", to: "BASE", path: [input.sites[0]!.position, input.base], elevation_m: [-2590, -2600], distance_m: 123, time_s: 120, ascent_m: 0, descent_m: 10, max_slope_deg: 5, cells_expanded: 12 },
        ],
        totals: { distance_m: 246, eva_time_s: 600, travel_time_s: 240, activity_time_s: 60, overhead_s: 300, energy_wh: 321.5, consumable: 0.123 },
        checks: [{ resource: "eva_time", unit: "s", used: 600, budget: 3600, reserve: 300, available: 3300, margin: 2700, satisfied: true }],
        utility: 1.25, issues: [], excluded: [], timing: { routing_ms: 12, planning_ms: 0.5, legs_routed: 2, cells_expanded: 24 },
      },
    },
  };
}

function planned(): MissionState {
  let state = initialMission(scenario());
  state = missionReducer(state, { type: "startRun" });
  state = missionReducer(state, { type: "validated", report: { ok: true, issues: [] } });
  return missionReducer(state, { type: "solved", run: solved(state.scenario) });
}

/** Synthetic simulation view for reducer and lock tests; no real mission. */
function running(input: MissionState): SimulationView {
  const report = input.run!.report;
  return {
    state: {
      schema_version: 1, dataset_id: report.dataset.dataset_id, scenario: report.scenario,
      initial_plan: report.result, plan: report.result, phase: "TRAVEL",
      leg_index: 0, point_index: 0, step_elapsed_s: 0, activity_done_s: 0,
      elapsed_s: report.result.totals!.overhead_s, consumed: report.result.totals!,
      anchor: report.scenario.base, completed_sites: [], completed: [], events: [],
      blocked: { width: 512, height: 512, cells: [] }, replans: 0,
    },
    position: report.scenario.base, remaining_budget: report.scenario.budget,
    remaining_checks: report.result.checks, return_margin_s: 2400, remaining_sites: 1,
    leg_progress: 0.2,
  };
}

describe("mission workflow", () => {
  test("starts idle with no fabricated plan or saved path", () => {
    const state = initialMission(scenario());
    expect(state.run).toBeNull();
    expect(state.phase).toBe("idle");
    expect(state.savePath).toBeNull();
  });

  test("placed sites get the next free S-number and defaults, without mutating the scenario", () => {
    const initial = initialMission(scenario());
    const added = addedSite(initial.scenario, { x_m: 100, y_m: 200 });
    const site = added.sites.at(-1)!;
    expect(added.sites).toHaveLength(initial.scenario.sites.length + 1);
    expect(initial.scenario.sites.at(-1)!.id).toBe("S7"); // source untouched
    expect(site.id).toBe("S8");
    expect(site.evidence_kind).toBe("USER_DEFINED");
    expect(site.activity_min_s).toBeLessThanOrEqual(site.activity_max_s);
    const again = addedSite(added, { x_m: 0, y_m: 0 });
    expect(again.sites.at(-1)!.id).toBe("S9");
  });

  test("the planning input is the edited scenario itself", () => {
    const state = initialMission(scenario());
    expect(planningScenario(state)).toBe(state.scenario);
  });

  test("validation errors stop the workflow and reject a late solve completion", () => {
    const report: ValidationReport = { ok: false, issues: [{ severity: "ERROR", code: "InvalidResourceBudget", message: "Reserve exceeds budget", site_id: null }] };
    const validating = missionReducer(initialMission(scenario()), { type: "startRun" });
    const invalid = missionReducer(validating, { type: "validated", report });
    expect(invalid.phase).toBe("idle");
    expect(invalid.validation).toEqual(report);
    expect(invalid.run).toBeNull();
    expect(missionReducer(invalid, { type: "solved", run: solved() })).toBe(invalid);
  });

  test("warnings permit solving and the returned report is retained unchanged", () => {
    const report: ValidationReport = { ok: true, issues: [{ severity: "WARNING", code: "SiteOnSteepTerrain", message: "One site is steep", site_id: "S2" }] };
    const validating = missionReducer(initialMission(scenario()), { type: "startRun" });
    const solving = missionReducer(validating, { type: "validated", report });
    expect(solving.phase).toBe("solving");
    expect(solving.validation).toBe(report);
    const run = solved();
    expect(missionReducer(solving, { type: "solved", run }).run).toBe(run);
  });

  test("scenario edits clear the report, validation and export/save paths", () => {
    const exported = { ...planned(), exportPath: "/reports/17.json", savePath: "/plans/1.json" };
    const state = missionReducer(exported, { type: "edit", scenario: { ...exported.scenario, budget: { ...exported.scenario.budget, eva_limit_s: 2400 } } });
    expect(state.run).toBeNull();
    expect(state.validation).toBeNull();
    expect(state.exportPath).toBeNull();
    expect(state.savePath).toBeNull();
  });

  test("active validation, solve, export and save lock edits and duplicate operations", () => {
    const initial = initialMission(scenario());
    for (const phase of ["validating", "solving", "exporting", "saving"] as const) {
      const state = { ...initial, phase };
      expect(missionReducer(state, { type: "edit", scenario: scenario() })).toBe(state);
      expect(missionReducer(state, { type: "startRun" })).toBe(state);
      expect(missionReducer(state, { type: "startExport" })).toBe(state);
      expect(missionReducer(state, { type: "startSave" })).toBe(state);
    }
  });

  test("rerunning clears an older result; a failed run never restores it", () => {
    const state = missionReducer(planned(), { type: "startRun" });
    expect(state.run).toBeNull();
    const failed = missionReducer(state, { type: "failed", message: "IPC unavailable" });
    expect(failed.phase).toBe("idle");
    expect(failed.error).toBe("IPC unavailable");
    expect(failed.run).toBeNull();
  });

  test("a simulation locks editing and only reset clears it", () => {
    let state = planned();
    state = missionReducer(state, { type: "startSimulation" });
    expect(state.simulationBusy).toBe(true);
    expect(missionReducer(state, { type: "startSimulation" })).toBe(state);
    const view = running(state);
    state = missionReducer(state, { type: "simulation", view });
    expect(state.simulation).toBe(view);
    expect(state.simulationBusy).toBe(false);
    // A late async edit cannot unfreeze an active drill.
    expect(missionReducer(state, { type: "edit", scenario: { ...state.scenario, name: "Changed" } })).toBe(state);
    state = missionReducer(state, { type: "clearSimulation" });
    expect(state.simulation).toBeNull();
    const edited = missionReducer(state, { type: "edit", scenario: { ...state.scenario, name: "Changed" } });
    expect(edited.simulation).toBeNull();
    expect(edited.run).toBeNull();

    const html = renderToStaticMarkup(<ScenarioEditor state={state} placingBase={false} placingSite={false}
      datasetId="jezero-small" locked onPlaceBase={() => {}} onTogglePlaceSite={() => {}} onLoadPackaged={() => {}} onDeleteSite={() => {}}
      onChange={() => {}} onSavePlan={() => {}} onLoadPlan={() => {}} onRun={() => {}} />);
    expect(html).toContain("Simulation active. The scenario is frozen; reset the simulation to edit it.");
    expect(html).toContain("<fieldset disabled");
  });

  test("export requires a current run; export failure leaves it available for retry", () => {
    const initial = initialMission(scenario());
    expect(missionReducer(initial, { type: "startExport" })).toBe(initial);
    const state = planned();
    const exporting = missionReducer(state, { type: "startExport" });
    expect(exporting.run?.run_id).toBe(17);
    const failed = missionReducer(exporting, { type: "failed", message: "Disk full" });
    expect(failed.run).toBe(state.run);
    expect(failed.phase).toBe("idle");
    const done = missionReducer(missionReducer(failed, { type: "startExport" }), { type: "exported", path: "/reports/17.json" });
    expect(done.exportPath).toBe("/reports/17.json");
    expect(done.error).toBeNull();
  });

  test("saving needs no run; a failed save keeps the scenario editable and retryable", () => {
    const initial = initialMission(scenario());
    expect(missionReducer(initial, { type: "saved", path: "/plans/1.json" })).toBe(initial);
    const saving = missionReducer(initial, { type: "startSave" });
    expect(saving.phase).toBe("saving");
    const failed = missionReducer(saving, { type: "failed", message: "Disk full" });
    expect(failed.phase).toBe("idle");
    expect(failed.savePath).toBeNull();
    const done = missionReducer(missionReducer(failed, { type: "startSave" }), { type: "saved", path: "/plans/1.json" });
    expect(done.savePath).toBe("/plans/1.json");
    expect(done.error).toBeNull();
  });

  test("non-finite draft numbers cannot become null in JSON IPC", () => {
    const state = initialMission(scenario());
    for (const invalid of [NaN, Infinity, -Infinity]) {
      expect(() => planningScenario({ ...state, scenario: { ...state.scenario, base: { x_m: invalid, y_m: 0 } } })).toThrow("finite numbers");
      expect(() => planningScenario({ ...state, scenario: editCoefficient(state.scenario, "flat_speed_m_s", invalid) })).toThrow("finite numbers");
      expect(() => planningScenario({ ...state, scenario: { ...state.scenario, budget: { ...state.scenario.budget, eva_limit_s: invalid } } })).toThrow("finite numbers");
    }
    const noEnergy = { ...state.scenario, budget: { ...state.scenario.budget, energy_budget_wh: null, energy_reserve_wh: null } };
    expect(planningScenario({ ...state, scenario: noEnergy }).budget.energy_budget_wh).toBeNull();
  });

  test("a missing optional budget does not silently remove the declared reserve", () => {
    const state = initialMission(scenario());
    const edited = missionReducer(state, { type: "edit", scenario: {
      ...state.scenario, budget: { ...state.scenario.budget, energy_budget_wh: null },
    } });
    expect(planningScenario(edited).budget.energy_budget_wh).toBeNull();
    expect(planningScenario(edited).budget.energy_reserve_wh).toBe(200);
    const html = renderToStaticMarkup(<ScenarioEditor state={edited} placingBase={false} placingSite={false} datasetId="jezero-small" locked={false} onPlaceBase={() => {}} onTogglePlaceSite={() => {}} onLoadPackaged={() => {}} onDeleteSite={() => {}} onChange={() => {}} onSavePlan={() => {}} onLoadPlan={() => {}} onRun={() => {}} />);
    expect(html).toContain("Energy reserve needs a budget.");
    expect(html).not.toContain("No energy limit set.");
  });

  test("edited coefficients carry honest provenance without mutating the source", () => {
    const original = scenario();
    const before = structuredClone(original);
    const first = editCoefficient(original, "max_slope_deg", 10);
    const second = editCoefficient(first, "max_slope_deg", 12);
    expect(original).toEqual(before);
    expect(first.model.max_slope_deg.value).toBe(10);
    expect(first.model.max_slope_deg.source_type).toBe("USER_DEFINED");
    expect(first.model.max_slope_deg.citation_or_assumption).toStartWith("User-edited in HYDE. ");
    expect(first.model.max_slope_deg.range).toBeNull();
    expect(second.model.max_slope_deg.version).toBe(original.model.max_slope_deg.version + 2);
    expect(second.model.max_slope_deg.citation_or_assumption).toBe(first.model.max_slope_deg.citation_or_assumption);
  });
});

describe("mission presentation", () => {
  const render = (state: MissionState) => renderToStaticMarkup(<MissionResults state={state} selectedLeg={null} onSelectLeg={() => {}} />);

  test("before a run, metrics and feasibility are not invented", () => {
    const html = render(initialMission(scenario()));
    expect(html).toContain("Configure a scenario");
    expect(html).not.toContain("Sites visited");
    expect(html).not.toContain("Feasible under declared model");
  });

  test("renders report metrics, hard-constraint margins, return leg and export path", () => {
    const html = render({ ...planned(), exportPath: "/reports/17.json" });
    expect(html).toContain("Feasible under declared model");
    expect(html).toContain("246 m");
    expect(html).toContain("10.0 min");
    expect(html).toContain("1.25");
    expect(html.toLowerCase()).toContain("margin after reserve");
    expect(html).toContain("45.00");
    expect(html).toContain("Return to base");
    expect(html).toContain("/reports/17.json");
  });

  test("infeasible and unknown results show their actual reasons, not success metrics", () => {
    for (const status of ["INFEASIBLE", "UNKNOWN_DATA_COVERAGE"] as const) {
      const state = planned();
      state.run!.report.result = { ...state.run!.report.result, status, totals: null, stops: [], legs: [],
        excluded: [{ site_id: "S1", code: "NoRoute", reason: "A return route is unavailable." }] };
      const html = render(state);
      expect(html).toContain(status === "INFEASIBLE" ? "No feasible plan" : "Unknown data coverage");
      expect(html).toContain("A return route is unavailable.");
      expect(html).not.toContain("Sites visited");
      expect(html).not.toContain("Feasible under declared model");
    }
  });

  test("editor exposes minutes, optional limits, site editing, saving and model assumptions", () => {
    const state = initialMission(scenario());
    state.scenario.budget.energy_budget_wh = null;
    state.scenario.budget.energy_reserve_wh = null;
    const html = renderToStaticMarkup(<ScenarioEditor state={state} placingBase={false} placingSite={false} datasetId="jezero-small" locked={false} onPlaceBase={() => {}} onTogglePlaceSite={() => {}} onLoadPackaged={() => {}} onDeleteSite={() => {}} onChange={() => {}} onSavePlan={() => {}} onLoadPlan={() => {}} onRun={() => {}} />);
    expect(html).toContain('id="mission-scenario"');
    expect(html).toContain("EVA limit (min)");
    expect(html).toContain('value="360"');
    expect(html).toContain("No energy limit set.");
    expect(html).toContain("maximum activity (min)");
    expect(html).toContain("Add candidate on map");
    expect(html).toContain("Save plan");
    expect(html).toContain("Load a saved plan");
    expect(html).toContain("Model assumptions");
    expect(html).toContain("session-only");
  });
});
