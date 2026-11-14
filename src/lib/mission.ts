import { useEffect, useReducer, useRef } from "react";
import { api, errorText } from "./api";
import type { LocalPoint, MissionScenario, ResourceModel, SolvedRun, ValidationReport, SimulationSnapshot, MissionAction } from "./types";

export type CoefficientKey = Exclude<keyof ResourceModel, "model_version">;
export type MissionPhase = "idle" | "validating" | "solving" | "exporting" | "saving" | "simulating";

export interface MissionState {
  scenario: MissionScenario;
  phase: MissionPhase;
  validation: ValidationReport | null;
  run: SolvedRun | null;
  error: string | null;
  exportPath: string | null;
  savePath: string | null;
  simulation: SimulationSnapshot | null;
}

type Action =
  | { type: "edit"; scenario: MissionScenario }
  | { type: "startRun" }
  | { type: "validated"; report: ValidationReport }
  | { type: "solved"; run: SolvedRun }
  | { type: "startExport" }
  | { type: "exported"; path: string }
  | { type: "startSave" }
  | { type: "saved"; path: string }
  | { type: "failed"; message: string };
type SimulationAction = { type: "simulationRequest" } | { type: "simulationUpdated"; snapshot: SimulationSnapshot; expected: SimulationSnapshot | null }
  | { type: "simulationReset" };

export function initialMission(scenario: MissionScenario): MissionState {
  return {
    scenario, phase: "idle",
    validation: null, run: null, error: null, exportPath: null, savePath: null, simulation: null,
  };
}

export function missionReducer(state: MissionState, action: Action | SimulationAction): MissionState {
  switch (action.type) {
    case "edit": {
      if (state.phase !== "idle" || state.simulation) return state;
      return {
        ...state, scenario: action.scenario,
        run: null, validation: null, error: null, exportPath: null, savePath: null,
      };
    }
    case "startRun":
      return state.phase === "idle" && !state.simulation
        ? { ...state, phase: "validating", validation: null, run: null, error: null, exportPath: null, savePath: null }
        : state;
    case "validated":
      return state.phase === "validating"
        ? { ...state, validation: action.report, phase: action.report.ok ? "solving" : "idle" }
        : state;
    case "solved":
      return state.phase === "solving" ? { ...state, phase: "idle", run: action.run } : state;
    case "startExport":
      return state.phase === "idle" && state.run
        ? { ...state, phase: "exporting", error: null, exportPath: null }
        : state;
    case "exported":
      return state.phase === "exporting" ? { ...state, phase: "idle", exportPath: action.path } : state;
    case "startSave":
      return state.phase === "idle"
        ? { ...state, phase: "saving", error: null, savePath: null }
        : state;
    case "saved":
      return state.phase === "saving" ? { ...state, phase: "idle", savePath: action.path } : state;
    case "failed":
      return { ...state, phase: "idle", error: action.message };
    case "simulationRequest":
      return state.phase === "idle" && state.run ? { ...state, phase: "simulating", error: null, exportPath: null } : state;
    case "simulationUpdated":
      if (state.phase !== "simulating" || action.snapshot.run_id !== state.run?.run_id || state.simulation !== action.expected) return state;
      if (action.expected && (action.snapshot.generation !== action.expected.generation || action.snapshot.revision !== action.expected.revision + 1)) return state;
      return { ...state, phase: "idle", simulation: action.snapshot };
    case "simulationReset":
      return state.phase === "simulating" ? { ...state, phase: "idle", simulation: null, exportPath: null } : state;
  }
}

/** The scenario the user edits is exactly what the planner receives. */
export function planningScenario(state: MissionState): MissionScenario {
  // JSON IPC would silently turn NaN/Infinity from incomplete fields into null.
  JSON.stringify(state.scenario, (_key, value: unknown) => {
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new Error("Complete the numeric fields with finite numbers before running the mission.");
    }
    return value;
  });
  return state.scenario;
}

/** Defaults for a site the user places on the map, mirroring the packaged demo targets. */
const PLACED_SITE_DEFAULTS = {
  name: "User candidate",
  science_rationale: "Placed by the user on the map; terrain was checked at placement time.",
  source_product_ids: [] as string[],
  evidence_kind: "USER_DEFINED" as const,
  activity_min_s: 1800,
  activity_max_s: 3600,
  activity_power_w: 60,
  preference_weight: 5,
};

/** A scenario with one more user-placed candidate, given the next free S-number. */
export function addedSite(scenario: MissionScenario, point: LocalPoint): MissionScenario {
  const used = new Set(scenario.sites.map((site) => site.id));
  let n = 1;
  while (used.has(`S${n}`)) n++;
  return {
    ...scenario,
    sites: [...scenario.sites, { id: `S${n}`, position: point, ...PLACED_SITE_DEFAULTS }],
  };
}

export function editCoefficient(scenario: MissionScenario, key: CoefficientKey, value: number): MissionScenario {
  const coefficient = scenario.model[key];
  const note = "User-edited in HYDE. ";
  return {
    ...scenario,
    model: {
      ...scenario.model,
      [key]: {
        ...coefficient, value, source_type: "USER_DEFINED", version: coefficient.version + 1, range: null,
        citation_or_assumption: coefficient.citation_or_assumption.startsWith(note)
          ? coefficient.citation_or_assumption : note + coefficient.citation_or_assumption,
      },
    },
  };
}

export function useMission(scenario: MissionScenario) {
  const [state, dispatch] = useReducer(missionReducer, scenario, initialMission);
  // Close the gap before the disabled controls render: rapid clicks must not start concurrent jobs.
  const locked = useRef(false);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const run = async (exact = false) => {
    if (locked.current || state.simulation) return;
    locked.current = true;
    dispatch({ type: "startRun" });
    try {
      const input = planningScenario(state);
      const report = await api.validate(input);
      if (!mounted.current) return;
      dispatch({ type: "validated", report });
      if (!report.ok) return;
      const run = await api.solve(input, exact);
      if (mounted.current) dispatch({ type: "solved", run });
    } catch (failure) {
      if (mounted.current) dispatch({ type: "failed", message: errorText(failure) });
    } finally {
      locked.current = false;
    }
  };

  const exportReport = async () => {
    if (locked.current || !state.run) return;
    locked.current = true;
    dispatch({ type: "startExport" });
    try {
      const path = await api.exportReport(state.run.run_id);
      if (mounted.current) dispatch({ type: "exported", path });
    } catch (failure) {
      if (mounted.current) dispatch({ type: "failed", message: errorText(failure) });
    } finally {
      locked.current = false;
    }
  };

  const savePlan = async () => {
    if (locked.current) return;
    locked.current = true;
    dispatch({ type: "startSave" });
    try {
      const path = await api.savePlan(planningScenario(state));
      if (mounted.current) dispatch({ type: "saved", path });
    } catch (failure) {
      if (mounted.current) dispatch({ type: "failed", message: errorText(failure) });
    } finally {
      locked.current = false;
    }
  };

  const simulation = async (action?: MissionAction | "reset") => {
    if (locked.current || !state.run) return;
    locked.current = true;
    dispatch({ type: "simulationRequest" });
    const expected = state.simulation;
    try {
      if (action === "reset") {
        await api.resetSimulation(state.run.run_id);
        if (mounted.current) dispatch({ type: "simulationReset" });
      } else {
        const snapshot = expected && action ? await api.simulationAction(expected, action)
          : await api.startSimulation(state.run.run_id);
        if (mounted.current) dispatch({ type: "simulationUpdated", snapshot, expected });
      }
    } catch (failure) {
      if (mounted.current) dispatch({ type: "failed", message: errorText(failure) });
    } finally { locked.current = false; }
  };

  return {
    state, run, exportReport, savePlan, simulation,
    edit: (scenario: MissionScenario) => { if (!locked.current) dispatch({ type: "edit", scenario }); },
  };
}
