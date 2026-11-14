import { useEffect, useReducer, useRef } from "react";
import { api, errorText } from "./api";
import type { MissionScenario, ResourceModel, SolvedRun, ValidationReport } from "./types";

export type CoefficientKey = Exclude<keyof ResourceModel, "model_version">;
export type MissionPhase = "idle" | "validating" | "solving" | "exporting";

export interface MissionState {
  scenario: MissionScenario;
  selected: ReadonlySet<string>;
  phase: MissionPhase;
  validation: ValidationReport | null;
  run: SolvedRun | null;
  error: string | null;
  exportPath: string | null;
}

type Action =
  | { type: "edit"; scenario: MissionScenario }
  | { type: "toggleSite"; id: string }
  | { type: "startRun" }
  | { type: "validated"; report: ValidationReport }
  | { type: "solved"; run: SolvedRun }
  | { type: "startExport" }
  | { type: "exported"; path: string }
  | { type: "failed"; message: string };

export function initialMission(scenario: MissionScenario): MissionState {
  return {
    scenario, selected: new Set(scenario.sites.map((site) => site.id)), phase: "idle",
    validation: null, run: null, error: null, exportPath: null,
  };
}

export function missionReducer(state: MissionState, action: Action): MissionState {
  switch (action.type) {
    case "edit":
    case "toggleSite": {
      if (state.phase !== "idle") return state;
      const selected = new Set(state.selected);
      if (action.type === "toggleSite") {
        if (selected.has(action.id)) selected.delete(action.id);
        else selected.add(action.id);
      }
      return {
        ...state, scenario: action.type === "edit" ? action.scenario : state.scenario, selected,
        run: null, validation: null, error: null, exportPath: null,
      };
    }
    case "startRun":
      return state.phase === "idle"
        ? { ...state, phase: "validating", validation: null, run: null, error: null, exportPath: null }
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
    case "failed":
      return { ...state, phase: "idle", error: action.message };
  }
}

/** Keep deselected sites in the editor, but never send them to the planner. */
export function planningScenario(state: MissionState): MissionScenario {
  const scenario = { ...state.scenario, sites: state.scenario.sites.filter((site) => state.selected.has(site.id)) };
  // JSON IPC would silently turn NaN/Infinity from incomplete fields into null.
  JSON.stringify(scenario, (_key, value: unknown) => {
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new Error("Complete the numeric fields with finite numbers before running the mission.");
    }
    return value;
  });
  return scenario;
}

export function editCoefficient(scenario: MissionScenario, key: CoefficientKey, value: number): MissionScenario {
  const coefficient = scenario.model[key];
  const note = "User-edited in ARES. ";
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

  const run = async () => {
    if (locked.current) return;
    locked.current = true;
    dispatch({ type: "startRun" });
    try {
      const input = planningScenario(state);
      const report = await api.validate(input);
      if (!mounted.current) return;
      dispatch({ type: "validated", report });
      if (!report.ok) return;
      const run = await api.solve(input);
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

  return {
    state, run, exportReport,
    edit: (scenario: MissionScenario) => dispatch({ type: "edit", scenario }),
    toggleSite: (id: string) => dispatch({ type: "toggleSite", id }),
  };
}
