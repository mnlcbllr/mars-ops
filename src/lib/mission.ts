import { useEffect, useReducer, useRef } from "react";
import { api, errorText } from "./api";
import { minutes } from "./format";
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

/**
 * Automatic, path-driven warning, with no injected event needed and none
 * expected: the drill walks the current plan, so "consumed so far plus the
 * modeled time of the route still ahead" is the projected EVA total. The
 * backend `remaining_checks` compare consumption against the full budget and
 * say nothing about the route ahead, and an optimized plan legitimately uses
 * most of the limit — so an absolute margin threshold would cry wolf on a
 * healthy plan. This warns only when the remaining route no longer fits (or
 * nearly no longer fits) the remaining budget, which clears after a replan.
 */
export function simRouteFit(view: SimulationView): string[] {
  const plan = view.state.plan;
  if (plan.status !== "FEASIBLE_MODELED" || view.state.phase === "INFEASIBLE") return [];
  const eva = view.remaining_checks.find((check) => check.resource === "eva_time");
  if (!eva || eva.available <= 0) return [];
  const { phase, leg_index, activity_done_s } = view.state;
  let remaining = 0;
  for (let i = leg_index; i < plan.legs.length; i++) {
    remaining += plan.legs[i]!.time_s * (i === leg_index ? 1 - view.leg_progress : 1);
  }
  if (phase === "TRAVEL") {
    for (const stop of plan.stops.slice(leg_index)) remaining += stop.activity_s;
  } else if (phase === "ACTIVITY") {
    const stop = plan.stops[leg_index];
    if (stop) remaining += Math.max(stop.activity_s - activity_done_s, 0);
    for (const s of plan.stops.slice(leg_index + 1)) remaining += s.activity_s;
  }
  const projected = view.state.consumed.eva_time_s + remaining;
  // Tolerance covers floating-point noise only, mirroring the backend check.
  const tolerance = 1e-9 * Math.abs(eva.available);
  if (projected > eva.available + tolerance) {
    return [`remaining route exceeds the EVA limit by ${minutes(projected - eva.available, 1)}`];
  }
  if (projected > eva.available * 0.95) {
    return [`remaining route nearly exceeds the EVA limit — ${minutes(eva.available - projected, 1)} left`];
  }
  return [];
}

export function useMission(scenario: MissionScenario) {
  const [state, dispatch] = useReducer(missionReducer, scenario, initialMission);
  // Close the gap before the disabled controls render: rapid clicks must not start concurrent jobs.
  const locked = useRef(false);
  const pendingSeek = useRef<number | null>(null);
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

  /** Seek by restarting from initial solved plan and advancing to the target
   *  mission clock. The replay starts at elapsed = overhead (EVA egress/ingress
   *  prep is charged up-front), so advance only the difference — otherwise the
   *  state lands `overhead` ahead of the requested slider position.
   *  Concurrent seeks coalesce: the latest target wins instead of being dropped. */
  const seekSimulation = async (targetSeconds: number) => {
    if (!state.run) return;
    const runId = state.run.run_id;
    const overheadS = state.scenario.model.overhead_s.value;
    const target = Math.max(overheadS, targetSeconds);
    if (locked.current) { pendingSeek.current = target; return; }
    locked.current = true;
    dispatch({ type: "startSimulation" });
    try {
      let view = await api.startSimulation(runId);
      const fromStart = target - overheadS;
      if (fromStart > 0) view = await api.advanceSimulation(fromStart);
      if (mounted.current) dispatch({ type: "simulation", view });
    } catch (failure) {
      if (mounted.current) dispatch({ type: "failed", message: errorText(failure) });
    } finally {
      locked.current = false;
      const next = pendingSeek.current;
      pendingSeek.current = null;
      if (next !== null && next !== target) void seekSimulation(next);
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
