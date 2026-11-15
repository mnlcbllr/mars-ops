// TypeScript mirrors of the Rust core's serialized types (crates/ares-core).
// Field names are the wire names; keep them identical to the Rust structs.

export type EvidenceKind = "OBSERVED" | "DERIVED" | "MODELED" | "USER_DEFINED" | "SYNTHETIC";

export interface LocalPoint {
  x_m: number;
  y_m: number;
}

export interface LatLon {
  lat_deg: number;
  lon_east_deg: number;
}

export interface Coefficient {
  value: number;
  unit: string;
  source_type: EvidenceKind;
  citation_or_assumption: string;
  range: [number, number] | null;
  version: number;
}

export interface ResourceBudget {
  eva_limit_s: number;
  eva_reserve_s: number;
  energy_budget_wh: number | null;
  energy_reserve_wh: number | null;
  consumable_budget: number | null;
  consumable_reserve: number | null;
  consumable_unit: string | null;
}

export interface ResourceModel {
  model_version: string;
  flat_speed_m_s: Coefficient;
  slope_time_penalty: Coefficient;
  max_slope_deg: Coefficient;
  overhead_s: Coefficient;
  base_power_w: Coefficient;
  consumable_rate_travel_per_h: Coefficient;
  consumable_rate_activity_per_h: Coefficient;
}

export interface ScientificSite {
  id: string;
  name: string;
  position: LocalPoint;
  science_rationale: string;
  source_product_ids: string[];
  evidence_kind: EvidenceKind;
  activity_min_s: number;
  activity_max_s: number;
  activity_power_w: number;
  preference_weight: number;
  /** If true, the planner must include this site or report infeasibility. */
  required?: boolean;
}

export interface MissionScenario {
  schema_version: number;
  name: string;
  dataset_id: string;
  base: LocalPoint;
  sites: ScientificSite[];
  budget: ResourceBudget;
  model: ResourceModel;
}

export type PlanStatus = "FEASIBLE_MODELED" | "INFEASIBLE" | "UNKNOWN_DATA_COVERAGE";

export interface Issue {
  severity: "ERROR" | "WARNING";
  code: string;
  message: string;
  site_id: string | null;
}

export interface ValidationReport {
  ok: boolean;
  issues: Issue[];
}

export interface Stop {
  site_id: string;
  arrive_s: number;
  activity_s: number;
  depart_s: number;
  utility: number;
}

export interface PlannedLeg {
  from: string;
  to: string;
  path: LocalPoint[];
  elevation_m: number[];
  distance_m: number;
  time_s: number;
  ascent_m: number;
  descent_m: number;
  max_slope_deg: number;
  cells_expanded: number;
}

export interface Exclusion {
  site_id: string;
  code: string;
  reason: string;
}

export interface CandidateInsight {
  site_id: string;
  /** `SELECTED`, `EXCLUDED`, or `INFEASIBLE`. */
  status: string;
  reachable_from_base: boolean;
  feasible_alone: boolean;
  explanation: string;
  reason_code: string | null;
  terrain: string;
  site_slope_deg: number | null;
  standalone_distance_m: number | null;
  standalone_travel_time_s: number | null;
  standalone_eva_time_s: number | null;
  standalone_checks: ConstraintCheck[];
  planned_utility: number;
  planned_activity_s: number;
}

export interface ResourceUse {
  distance_m: number;
  travel_time_s: number;
  activity_time_s: number;
  overhead_s: number;
  eva_time_s: number;
  energy_wh: number;
  consumable: number;
}

export interface ConstraintCheck {
  resource: "eva_time" | "energy" | "consumable";
  unit: string;
  used: number;
  budget: number;
  reserve: number;
  available: number;
  margin: number;
  satisfied: boolean;
}

export interface MissionResult {
  status: PlanStatus;
  solver: { name: string; version: string; description: string };
  stops: Stop[];
  legs: PlannedLeg[];
  totals: ResourceUse | null;
  checks: ConstraintCheck[];
  utility: number;
  issues: Issue[];
  excluded: Exclusion[];
  candidate_insights?: CandidateInsight[];
  timing: { routing_ms: number; planning_ms: number; legs_routed: number; cells_expanded: number };
}

export interface MissionReport {
  report_schema_version: number;
  generated_utc: string;
  software: string;
  software_version: string;
  code_revision: string;
  dataset: {
    dataset_id: string;
    manifest_sha256: string;
    real_data_verified: boolean;
    layers: {
      id: string;
      product_id: string;
      instrument: string;
      origin_type: EvidenceKind;
      source_url: string;
      sha256_source: string | null;
      sha256_derived: string;
    }[];
  };
  planning_grid: { cell_x_m: number; cell_y_m: number; raster_cells_per_planning_cell: number };
  scenario: MissionScenario;
  result: MissionResult;
  /** Present when the run was advanced in the stateful simulation. */
  simulation?: SimulationRecord;
  disclaimers: string[];
}

export type SimulationPhase = "TRAVEL" | "ACTIVITY" | "COMPLETE" | "INFEASIBLE";
export type ResourceKind = "EVA_TIME" | "ENERGY" | "CONSUMABLE";

export interface GridCellRef {
  col: number;
  row: number;
}

export type ContingencyKind =
  | { type: "BLOCK_CELLS"; cells: GridCellRef[] }
  | { type: "BLOCK_CORRIDOR"; center: LocalPoint; radius_m: number }
  | { type: "DELAY"; seconds: number }
  | { type: "RESOURCE_LOSS"; resource: ResourceKind; amount: number };

export interface ContingencyEvent {
  id: number;
  at_elapsed_s: number;
  kind: ContingencyKind;
}

/** Sparse temporary blocked cells; the dataset itself is never modified. */
export interface BlockOverlay {
  width: number;
  height: number;
  cells: number[];
}

export interface CompletedStop {
  site_id: string;
  activity_s: number;
  utility: number;
  depart_s: number;
}

export interface MissionState {
  schema_version: number;
  dataset_id: string;
  scenario: MissionScenario;
  initial_plan: MissionResult;
  plan: MissionResult;
  phase: SimulationPhase;
  leg_index: number;
  point_index: number;
  step_elapsed_s: number;
  activity_done_s: number;
  elapsed_s: number;
  consumed: ResourceUse;
  anchor: LocalPoint;
  completed_sites: string[];
  /** Work the simulation actually executed, in completion order. */
  completed: CompletedStop[];
  events: ContingencyEvent[];
  blocked: BlockOverlay;
  replans: number;
}

export interface SimulationView {
  state: MissionState;
  position: LocalPoint;
  remaining_budget: ResourceBudget;
  remaining_checks: ConstraintCheck[];
  return_margin_s: number | null;
  remaining_sites: number;
  leg_progress: number;
}

export interface SimulationRecord {
  schema_version: number;
  phase: SimulationPhase;
  elapsed_s: number;
  consumed: ResourceUse;
  completed_sites: string[];
  completed: CompletedStop[];
  events: ContingencyEvent[];
  replans: number;
  current_plan: MissionResult;
  remaining_budget: ResourceBudget;
  remaining_checks: ConstraintCheck[];
  return_margin_s: number | null;
}

export interface SolvedRun {
  run_id: number;
  report: MissionReport;
}

export type TerrainClass = "TRAVERSABLE" | "ABOVE_SLOPE_LIMIT" | "UNKNOWN" | "OUTSIDE_COVERAGE";

export interface PointInspection {
  local: LocalPoint;
  latlon: LatLon;
  terrain: TerrainClass;
  elevation_m: number | null;
  slope_deg: number | null;
}

export interface GridGeoreference {
  projection: string;
  radius_m: number;
  center_latitude_deg: number;
  center_longitude_deg: number;
  map_scale_m_per_px: number;
  roi_x_min_m: number;
  roi_y_max_m: number;
  width: number;
  height: number;
  cell_size_x_m: number;
  cell_size_y_m: number;
}

export interface BBoxDeg {
  lat_min: number;
  lat_max: number;
  lon_east_min: number;
  lon_east_max: number;
}

export interface LayerRecord {
  id: string;
  display_name: string;
  kind: "ELEVATION" | "IMAGERY" | "INFRARED_CONTEXT";
  file: string;
  origin_type: EvidenceKind;
  provider: string;
  instrument: string;
  product_id: string;
  source_url: string;
  license_and_credit: string;
  retrieved_utc: string | null;
  observation_date: string | null;
  source_crs: string | null;
  output_crs: string | null;
  vertical_datum: string | null;
  pixel_size_m: [number, number] | null;
  bbox_original: BBoxDeg | null;
  bbox_projected_m: [number, number, number, number] | null;
  nodata_value: number | null;
  sha256_source: string | null;
  sha256_derived: string;
  processing_steps: string[];
  quality_notes: string[];
  is_real_source_verified: boolean;
}

export interface Manifest {
  schema_version: number;
  dataset_id: string;
  display_name: string;
  body: string;
  region_name: string;
  generated_utc: string | null;
  georeference: GridGeoreference;
  roi_bbox: BBoxDeg;
  layers: LayerRecord[];
}

export interface DatasetInfo {
  manifest: Manifest;
  manifest_sha256: string;
  real_data_verified: boolean;
  elevation_min_m: number | null;
  elevation_max_m: number | null;
  nodata_cells: number;
  planning_grid: {
    width: number;
    height: number;
    cell_x_m: number;
    cell_y_m: number;
    raster_cells_per_planning_cell: number;
    unknown_cells: number;
  };
  software_version: string;
  code_revision: string;
}

export interface DatasetSummary {
  dataset_id: string;
  display_name: string;
  region_name: string;
}

/** A scenario saved by the user, without any solved result. */
export interface PlanSummary {
  file: string;
  name: string;
  dataset_id: string;
}
