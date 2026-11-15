// Typed bindings for the commands in src-tauri/src/lib.rs.

import { invoke } from "@tauri-apps/api/core";
import type {
  ContingencyKind,
  DatasetInfo,
  DatasetSummary,
  LocalPoint,
  MissionScenario,
  PlanSummary,
  PointInspection,
  SimulationView,
  SolvedRun,
  ValidationReport,
} from "./types";

export type DisplayLayer = "imagery" | "elevation" | "slope" | "infrared_context";

export const api = {
  listDatasets: () => invoke<DatasetSummary[]>("list_datasets"),
  openDataset: (dataset_id: string) => invoke<DatasetInfo>("open_dataset", { dataset_id }),
  /** Raw layer bytes: PNG for imagery, little-endian f32 otherwise. */
  layer: (layer: DisplayLayer) => invoke<ArrayBuffer>("dataset_layer", { layer }),
  defaultScenario: () => invoke<MissionScenario>("default_scenario"),
  inspect: (p: LocalPoint, max_slope_deg: number) =>
    invoke<PointInspection>("inspect_map_point", { x_m: p.x_m, y_m: p.y_m, max_slope_deg }),
  validate: (scenario: MissionScenario) => invoke<ValidationReport>("validate_scenario", { scenario }),
  solve: (scenario: MissionScenario) => invoke<SolvedRun>("solve_mission", { scenario }),
  /** Start a stateful simulation from the most recent solved run. */
  startSimulation: (run_id: number) => invoke<SimulationView>("start_simulation", { run_id }),
  /** Advance modeled EVA time; returns the state at the new instant. */
  advanceSimulation: (seconds: number) => invoke<SimulationView>("advance_simulation", { seconds }),
  /** Advance exactly to the next arrival or activity boundary. */
  advanceSimulationToStop: () => invoke<SimulationView>("advance_simulation_to_stop"),
  /** Inject one typed contingency at the current instant. */
  injectSimulationEvent: (kind: ContingencyKind) =>
    invoke<SimulationView>("inject_simulation_event", { kind }),
  /** Replan from the current position with remaining budget and sites. */
  replanSimulation: () => invoke<SimulationView>("replan_simulation"),
  simulationView: () => invoke<SimulationView | null>("simulation_view"),
  clearSimulation: () => invoke<void>("clear_simulation"),
  /** Writes the run to Documents/MARS-OPS/reports and resolves to the file path. */
  exportReport: (run_id: number) => invoke<string>("export_mission_report", { run_id }),
  /** Writes the scenario (no result) to Documents/MARS-OPS/plans and resolves to the file path. */
  savePlan: (scenario: MissionScenario) => invoke<string>("save_plan", { scenario }),
  listPlans: () => invoke<PlanSummary[]>("list_plans"),
  /** Loads a saved plan; rejected unless it was saved for the open dataset. */
  loadPlan: (file: string) => invoke<MissionScenario>("load_plan", { file }),
};

/** Tauri rejects with the command's error string; anything else is stringified. */
export function errorText(error: unknown): string {
  return typeof error === "string" ? error : error instanceof Error ? error.message : String(error);
}
