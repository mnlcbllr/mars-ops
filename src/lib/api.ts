// Typed bindings for the commands in src-tauri/src/lib.rs.

import { invoke } from "@tauri-apps/api/core";
import type {
  DatasetInfo,
  DatasetSummary,
  LocalPoint,
  MissionScenario,
  PointInspection,
  SolvedRun,
  ValidationReport,
} from "./types";

export type DisplayLayer = "imagery" | "elevation" | "slope" | "geology";

export const api = {
  listDatasets: () => invoke<DatasetSummary[]>("list_datasets"),
  openDataset: (dataset_id: string) => invoke<DatasetInfo>("open_dataset", { dataset_id }),
  /** Raw layer bytes: PNG for imagery, JSON for geology, little-endian f32 for elevation and slope. */
  layer: (layer: DisplayLayer) => invoke<ArrayBuffer>("dataset_layer", { layer }),
  defaultScenario: () => invoke<MissionScenario>("default_scenario"),
  inspect: (p: LocalPoint, max_slope_deg: number) =>
    invoke<PointInspection>("inspect_map_point", { x_m: p.x_m, y_m: p.y_m, max_slope_deg }),
  validate: (scenario: MissionScenario) => invoke<ValidationReport>("validate_scenario", { scenario }),
  solve: (scenario: MissionScenario) => invoke<SolvedRun>("solve_mission", { scenario }),
  /** Writes the run to Documents/ARES/reports and resolves to the file path. */
  exportReport: (run_id: number) => invoke<string>("export_mission_report", { run_id }),
};

/** Tauri rejects with the command's error string; anything else is stringified. */
export function errorText(error: unknown): string {
  return typeof error === "string" ? error : error instanceof Error ? error.message : String(error);
}
