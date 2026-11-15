import { useEffect, useReducer, useRef } from "react";
import { api, errorText } from "./api";
import { fmt, minutes } from "./format";
import type {
  ContingencyEvent, ContingencyKind, LocalPoint, MissionScenario, ResourceModel, SimulationView,
  SolvedRun, ValidationReport,
} from "./types";

export type CoefficientKey = Exclude<keyof ResourceModel, "model_version">;
export type MissionPhase = "idle" | "validating" | "solving" | "exporting" | "saving";

export interface MissionState {
  scenario: MissionScenario;
  phase: MissionPhase;
  validation: ValidationReport | null;
  run: SolvedRun | null;
  error: string | null;
  exportPath: string | null;
  savePath: string | null;
  /** Stateful drill started from the current run, or null. */
  simulation: SimulationView | null;
  simulationBusy: boolean;
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
  | { type: "startSimulation" }
  | { type: "simulation"; view: SimulationView }
  | { type: "clearSimulation" }
  | { type: "failed"; message: string };

export function initialMission(scenario: MissionScenario): MissionState {
  return {
    scenario, phase: "idle",
    validation: null, run: null, error: null, exportPath: null, savePath: null,
    simulation: null, simulationBusy: false,
  };
}

export function missionReducer(state: MissionState, action: Action): MissionState {
  switch (action.type) {
    case "edit": {
      if (state.phase !== "idle" || state.simulation !== null || state.simulationBusy) return state;
      return {
        ...state, scenario: action.scenario,
        run: null, validation: null, error: null, exportPath: null, savePath: null,
        simulation: null, simulationBusy: false,
      };
    }
    case "startRun":
      return state.phase === "idle"
        ? {
            ...state, phase: "validating", validation: null, run: null, error: null,
            exportPath: null, savePath: null, simulation: null, simulationBusy: false,
          }
        : state;
    case "validated":
      return state.phase === "validating"
        ? { ...state, validation: action.report, phase: action.report.ok ? "solving" : "idle" }
        : state;
    case "solved":
      return state.phase === "solving"
        ? { ...state, phase: "idle", run: action.run, simulation: null, simulationBusy: false }
        : state;
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
    case "startSimulation":
      return state.simulationBusy || state.phase !== "idle"
        ? state
        : { ...state, simulationBusy: true, error: null };
    case "simulation":
      return { ...state, simulation: action.view, simulationBusy: false };
    case "clearSimulation":
      return { ...state, simulation: null, simulationBusy: false };
    case "failed":
      return { ...state, phase: "idle", simulationBusy: false, error: action.message };
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

/** Defaults for a site the user places on the map, mirroring the packaged demo targets. */const PLACED_SITE_DEFAULTS = {
  name: "User candidate",
  science_rationale: "Placed by the user on the map; terrain was checked at placement time.",
  source_product_ids: [] as string[],
  evidence_kind: "USER_DEFINED" as const,
  activity_min_s: 1800,
  activity_max_s: 3600,
  activity_power_w: 60,
  preference_weight: 5,
  required: false,
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
  const note = "User-edited in MARS-OPS. ";
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

/**
 * Frontend staleness tracker: a plan goes stale when a contingency is injected
 * after the last replan. Resource checks cannot catch block events (they change
 * neither consumption nor budget), so this closes the gap. A seek/reset drops
 * events, which resets the tracker.
 */
const planStaleness = new Map<number, { events: number; replans: number; stale: boolean }>();

export function simPlanStale(runId: number, state: { events: ContingencyEvent[]; replans: number }): boolean {
  const entry = planStaleness.get(runId) ?? { events: 0, replans: 0, stale: false };
  if (state.events.length < entry.events) {
    entry.events = state.events.length;
    entry.replans = state.replans;
    entry.stale = false;
  } else {
    if (state.events.length > entry.events) entry.stale = true;
    if (state.replans > entry.replans) entry.stale = false;
    entry.events = Math.max(entry.events, state.events.length);
    entry.replans = Math.max(entry.replans, state.replans);
  }
  planStaleness.set(runId, entry);
  return entry.stale;
}

const LOW_MARGIN_FRACTION = 0.2;

const LOW_MARGIN_LABEL: Record<string, string> = {
  eva_time: "EVA time",
  energy: "Energy",
  consumable: "Consumable",
};

/**
 * Automatic, path-driven warnings: no injected event is needed. As the drill
 * walks the route, consumption grows and every still-passing check whose
 * margin has dropped into the last LOW_MARGIN_FRACTION of its remaining
 * budget is flagged, along with a return margin that is a thin slice of the
 * remaining EVA time. So a marginal plan warns on its own as it unfolds.
 */
export function simLowMargins(view: SimulationView): string[] {
  const warnings: string[] = [];
  const eva = view.remaining_checks.find((check) => check.resource === "eva_time");
  for (const check of view.remaining_checks) {
    if (!check.satisfied || check.available <= 0) continue;
    if (check.margin > check.available * LOW_MARGIN_FRACTION) continue;
    const label = LOW_MARGIN_LABEL[check.resource] ?? check.resource;
    const left = check.resource === "eva_time"
      ? minutes(check.margin, 1)
      : `${fmt(check.margin, 1)} ${check.unit}`;
    warnings.push(`${label} margin low — ${left} left`);
  }
  if (eva && eva.available > 0 && view.return_margin_s !== null
    && view.return_margin_s >= 0 && view.return_margin_s < eva.available * LOW_MARGIN_FRACTION) {
    warnings.push(`return margin low — ${minutes(view.return_margin_s, 1)} left after returning`);
  }
  return warnings;
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

  const run = async (scenarioOverride?: MissionScenario) => {
    if (locked.current) return;
    locked.current = true;
    dispatch({ type: "startRun" });
    try {
      const source = scenarioOverride ?? state.scenario;
      const input = planningScenario({ ...state, scenario: source } as MissionState);
      const report = await api.validate(input);
      if (!mounted.current) return;
      dispatch({ type: "validated", report });
      if (!report.ok) return;
      const runResult = await api.solve(input);
      if (mounted.current) dispatch({ type: "solved", run: runResult });
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

  /** Run one simulation IPC call under the shared job lock. */
  const simulationCall = async (call: () => Promise<SimulationView>) => {
    if (locked.current) return;
    locked.current = true;
    dispatch({ type: "startSimulation" });
    try {
      const view = await call();
      if (mounted.current) dispatch({ type: "simulation", view });
    } catch (failure) {
      if (mounted.current) dispatch({ type: "failed", message: errorText(failure) });
    } finally {
      locked.current = false;
    }
  };

  const startSimulation = async () => {
    if (!state.run) return;
    const runId = state.run.run_id;
    await simulationCall(() => api.startSimulation(runId));
  };
  const advanceSimulation = async (seconds: number) =>
    simulationCall(() => api.advanceSimulation(seconds));
  const advanceSimulationToStop = async () => simulationCall(() => api.advanceSimulationToStop());
  const injectSimulationEvent = async (kind: ContingencyKind) =>
    simulationCall(() => api.injectSimulationEvent(kind));
  const replanSimulation = async () => simulationCall(() => api.replanSimulation());

  /** Seek by restarting from initial solved plan and advancing to target elapsed seconds.
   *  Uses actual backend simulation calculations (no arbitrary state injection). */
  const seekSimulation = async (targetSeconds: number) => {
    if (!state.run || locked.current) return;
    const runId = state.run.run_id;
    const target = Math.max(0, targetSeconds);
    locked.current = true;
    dispatch({ type: "startSimulation" });
    try {
      let view = await api.startSimulation(runId);
      if (target > 0) view = await api.advanceSimulation(target);
      if (mounted.current) dispatch({ type: "simulation", view });
    } catch (failure) {
      if (mounted.current) dispatch({ type: "failed", message: errorText(failure) });
    } finally {
      locked.current = false;
    }
  };

  const clearSimulation = async () => {
    if (locked.current) return;
    locked.current = true;
    try {
      await api.clearSimulation();
      if (mounted.current) dispatch({ type: "clearSimulation" });
    } catch (failure) {
      if (mounted.current) dispatch({ type: "failed", message: errorText(failure) });
    } finally {
      locked.current = false;
    }
  };

  return {
    state, run, runWith: run, exportReport, savePlan,
    startSimulation, advanceSimulation, advanceSimulationToStop, seekSimulation, injectSimulationEvent, replanSimulation, clearSimulation,
    edit: (scenario: MissionScenario) => dispatch({ type: "edit", scenario }),
  };
}
