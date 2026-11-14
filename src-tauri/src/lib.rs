//! HYDE desktop shell: a thin IPC layer over `ares_core::session`.
//!
//! No science happens here. Each command hands the request to the core and
//! returns its answer. The webview gets no filesystem, shell or network
//! access: datasets are read only from the bundled resource directory, and
//! reports are written only to one fixed folder.

use ares_core::data::{dataset_dir, find_datasets, DatasetSummary};
use ares_core::inspect::PointInspection;
use ares_core::planning::{MissionScenario, ValidationReport};
use ares_core::report::MissionReport;
use ares_core::report::{utc_iso8601, write_new};
use ares_core::session::{DatasetInfo, DisplayLayer, Session};
use ares_core::LocalPoint;
use ares_core::mission::{MissionState, MissionAction};
use ares_core::contingency::{cells_within_radius, CellRef};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::ipc::Response;
use tauri::{AppHandle, Manager, State};

#[derive(Default)]
struct AppState {
    session: Mutex<Option<Arc<Session>>>,
    /// The most recent solved run: the one on screen, and the only one that
    /// can be exported.
    last_run: Mutex<Option<(u64, MissionReport)>>,
    run_counter: AtomicU64,
    simulation_epoch: AtomicU64,
}

#[derive(serde::Serialize)]
struct SolvedRun {
    run_id: u64,
    report: MissionReport,
}

#[derive(serde::Serialize)]
struct SimulationSnapshot {
    run_id: u64,
    generation: u64,
    revision: usize,
    mission: MissionState,
}

/// Authoritative simulation lives in the native run report, not editable JS.
#[tauri::command(rename_all = "snake_case")]
fn start_simulation(state: State<'_, AppState>, run_id: u64) -> Result<SimulationSnapshot, String> {
    let session = current(&state)?;
    let mut run = lock(&state.last_run);
    let (_, report) = run.as_mut().filter(|(id, _)| *id == run_id).ok_or("RunNotAvailable")?;
    if report.dataset.manifest_sha256 != session.dataset.manifest_sha256 { return Err("DatasetChanged".into()); }
    if report.simulation.is_some() { return Err("SimulationAlreadyStarted: reset first".into()); }
    let mission = MissionState::start(report.scenario.clone(), report.result.clone(), report.dataset.manifest_sha256.clone()).map_err(message)?;
    report.simulation = Some(mission.clone());
    let generation = state.simulation_epoch.fetch_add(1, Ordering::SeqCst) + 1;
    Ok(SimulationSnapshot { run_id, generation, revision: 0, mission })
}

#[tauri::command(rename_all = "snake_case")]
async fn simulation_action(state: State<'_, AppState>, run_id: u64, generation: u64, revision: usize, action: MissionAction) -> Result<SimulationSnapshot, String> {
    let session = current(&state)?;
    let mission = {
        let run = lock(&state.last_run);
        if state.simulation_epoch.load(Ordering::SeqCst) != generation { return Err("StaleSimulationGeneration".into()); }
        let (_, report) = run.as_ref().filter(|(id, _)| *id == run_id).ok_or("RunNotAvailable")?;
        report.simulation.clone().filter(|m| m.timeline.len() == revision).ok_or("StaleSimulationRevision")?
    };
    if mission.manifest_sha256 != session.dataset.manifest_sha256 { return Err("DatasetChanged".into()); }
    let updated = tauri::async_runtime::spawn_blocking(move || mission.apply(&session.grid, action)).await.map_err(message)?.map_err(message)?;
    let mut run = lock(&state.last_run);
    if state.simulation_epoch.load(Ordering::SeqCst) != generation { return Err("StaleSimulationGeneration".into()); }
    let (_, report) = run.as_mut().filter(|(id, _)| *id == run_id).ok_or("RunNotAvailable")?;
    if report.simulation.as_ref().map(|m| m.timeline.len()) != Some(revision) { return Err("StaleSimulationRevision".into()); }
    report.simulation = Some(updated.clone());
    Ok(SimulationSnapshot { run_id, generation, revision: updated.timeline.len(), mission: updated })
}

#[tauri::command(rename_all = "snake_case")]
fn reset_simulation(state: State<'_, AppState>, run_id: u64) -> Result<(), String> {
    let mut run = lock(&state.last_run);
    let (_, report) = run.as_mut().filter(|(id, _)| *id == run_id).ok_or("RunNotAvailable")?;
    state.simulation_epoch.fetch_add(1, Ordering::SeqCst);
    report.simulation = None;
    Ok(())
}

#[tauri::command(rename_all = "snake_case")]
fn preview_blockage(state: State<'_, AppState>, centre: LocalPoint, radius_m: f64) -> Result<Vec<CellRef>, String> {
    if !radius_m.is_finite() || !(0.0..=100.0).contains(&radius_m) { return Err("InvalidRadius: use 0–100 metres".into()); }
    let session = current(&state)?;
    if session.grid.cell_of(centre).is_none() { return Err("OutsideCoverage".into()); }
    let cells = cells_within_radius(session.grid.width, session.grid.height, session.grid.cell_x_m, session.grid.cell_y_m, centre, radius_m);
    if cells.is_empty() || cells.len() > 4096 { return Err("InvalidBlockage: choose 1–4096 cells".into()); }
    Ok(cells)
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

fn message(error: impl std::fmt::Display) -> String {
    error.to_string()
}

fn datasets_root(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().resource_dir().map_err(message)?.join("datasets"))
}

fn current(state: &AppState) -> Result<Arc<Session>, String> {
    lock(&state.session).clone().ok_or_else(|| "NoDatasetOpen: no dataset is open".to_string())
}

#[tauri::command]
fn list_datasets(app: AppHandle) -> Result<Vec<DatasetSummary>, String> {
    Ok(find_datasets(&datasets_root(&app)?))
}

/// Open a bundled dataset, verifying every layer's checksum.
#[tauri::command(rename_all = "snake_case")]
async fn open_dataset(
    app: AppHandle,
    state: State<'_, AppState>,
    dataset_id: String,
) -> Result<DatasetInfo, String> {
    *lock(&state.session) = None;
    state.run_counter.fetch_add(1, Ordering::SeqCst);
    *lock(&state.last_run) = None;
    let dir = dataset_dir(&datasets_root(&app)?, &dataset_id).map_err(message)?;
    let session = tauri::async_runtime::spawn_blocking(move || Session::open(&dir))
        .await
        .map_err(message)?
        .map_err(message)?;
    let info = session.info();
    *lock(&state.session) = Some(Arc::new(session));
    Ok(info)
}

/// Raw bytes of a display layer; see `DisplayLayer` for the encodings.
#[tauri::command]
async fn dataset_layer(state: State<'_, AppState>, layer: DisplayLayer) -> Result<Response, String> {
    let session = current(&state)?;
    tauri::async_runtime::spawn_blocking(move || session.layer_bytes(layer))
        .await
        .map_err(message)?
        .map(Response::new)
        .map_err(message)
}

/// The base, candidate sites and assumptions packaged with the open dataset.
#[tauri::command]
fn default_scenario(state: State<'_, AppState>) -> Result<MissionScenario, String> {
    current(&state)?.dataset.default_scenario().map_err(message)
}

#[tauri::command(rename_all = "snake_case")]
fn inspect_map_point(
    state: State<'_, AppState>,
    x_m: f64,
    y_m: f64,
    max_slope_deg: f64,
) -> Result<PointInspection, String> {
    Ok(current(&state)?.inspect(LocalPoint::new(x_m, y_m), max_slope_deg))
}

#[tauri::command]
fn validate_scenario(
    state: State<'_, AppState>,
    scenario: MissionScenario,
) -> Result<ValidationReport, String> {
    current(&state)?.validate(&scenario).map_err(message)
}

/// Plan the scenario off the UI thread and remember the run for export.
#[tauri::command]
async fn solve_mission(
    state: State<'_, AppState>,
    scenario: MissionScenario,
    exact: Option<bool>,
) -> Result<SolvedRun, String> {
    let session = current(&state)?;
    let opened = session.clone();
    let run_id = state.run_counter.fetch_add(1, Ordering::SeqCst) + 1;
    let report = tauri::async_runtime::spawn_blocking(move || if exact.unwrap_or(false) { session.solve_exact(scenario) } else { session.solve(scenario) })
        .await
        .map_err(message)?
        .map_err(message)?;
    if state.run_counter.load(Ordering::SeqCst) != run_id || !Arc::ptr_eq(&current(&state)?, &opened) {
        return Err("StaleSolve: the dataset or run changed".into());
    }
    *lock(&state.last_run) = Some((run_id, report.clone()));
    Ok(SolvedRun { run_id, report })
}

/// Write the run that is on screen to `Documents/ARES/reports` and return the
/// file's path. The webview cannot choose the location.
#[tauri::command(rename_all = "snake_case")]
fn export_mission_report(
    app: AppHandle,
    state: State<'_, AppState>,
    run_id: u64,
) -> Result<String, String> {
    let last_run = lock(&state.last_run);
    let report = match last_run.as_ref() {
        Some((id, report)) if *id == run_id => report,
        _ => return Err("RunNotAvailable: only the most recent run can be exported".into()),
    };
    let documents = app.path().document_dir().or_else(|_| app.path().app_data_dir()).map_err(message)?;
    // Retain the legacy storage location so a branding change does not relocate user reports.
    let path = report.write_to_dir(&documents.join("ARES").join("reports")).map_err(message)?;
    Ok(path.display().to_string())
}

/// Directory for user-saved mission plans: scenarios without a solved result.
fn plans_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let documents = app.path().document_dir().or_else(|_| app.path().app_data_dir()).map_err(message)?;
    Ok(documents.join("ARES").join("plans"))
}

#[derive(serde::Serialize)]
struct PlanSummary {
    file: String,
    name: String,
    dataset_id: String,
}

/// Save the edited scenario as pretty JSON in `Documents/ARES/plans` and
/// return the file's path. The webview cannot choose the location. A plan
/// holds no result: load it and run the mission again.
#[tauri::command]
fn save_plan(app: AppHandle, scenario: MissionScenario) -> Result<String, String> {
    let json = serde_json::to_vec_pretty(&scenario).map_err(message)?;
    let keep = |c: char| c.is_ascii_alphanumeric() || c == '-' || c == '_';
    let id: String = scenario.dataset_id.chars().map(|c| if keep(c) { c } else { '_' }).collect();
    let seconds = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();
    let stamp: String = utc_iso8601(seconds).chars().filter(char::is_ascii_alphanumeric).collect();
    let path = write_new(&plans_dir(&app)?, &format!("hyde-plan_{id}_{stamp}"), &json).map_err(message)?;
    Ok(path.display().to_string())
}

/// Summaries of saved plans, newest first. A damaged file is skipped, not an
/// error, so one bad file cannot hide the rest.
#[tauri::command]
fn list_plans(app: AppHandle) -> Result<Vec<PlanSummary>, String> {
    const MAX_PLAN_BYTES: u64 = 4 * 1024 * 1024;
    let mut plans = Vec::new();
    let entries = match std::fs::read_dir(plans_dir(&app)?) {
        Ok(entries) => entries,
        // Nothing saved yet: an empty list, not a failure.
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(plans),
        Err(e) => return Err(message(e)),
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let parsed = entry.metadata().ok().filter(|m| m.len() <= MAX_PLAN_BYTES).and_then(|_| {
            std::fs::read(&path).ok().and_then(|bytes| serde_json::from_slice::<MissionScenario>(&bytes).ok())
        });
        let Some(scenario) = parsed else { continue };
        let Some(file) = path.file_name().and_then(|f| f.to_str()) else { continue };
        plans.push(PlanSummary {
            file: file.to_string(),
            name: scenario.name,
            dataset_id: scenario.dataset_id,
        });
    }
    // The file names embed an ISO-like timestamp, so reverse order is newest first.
    plans.sort_by(|a, b| b.file.cmp(&a.file));
    Ok(plans)
}

/// Load a saved plan by file name, only if it was saved for the open dataset.
#[tauri::command(rename_all = "snake_case")]
fn load_plan(app: AppHandle, state: State<'_, AppState>, file: String) -> Result<MissionScenario, String> {
    const MAX_PLAN_BYTES: usize = 4 * 1024 * 1024;
    if file.is_empty() || file.contains('/') || file.contains('\\') || file.contains("..") {
        return Err("InvalidPlanFile: not the name of a saved plan".into());
    }
    let bytes = std::fs::read(plans_dir(&app)?.join(&file)).map_err(message)?;
    if bytes.len() > MAX_PLAN_BYTES {
        return Err("PlanTooLarge: the saved plan file is unexpectedly large".into());
    }
    let scenario: MissionScenario = serde_json::from_slice(&bytes).map_err(message)?;
    if scenario.dataset_id != current(&state)?.dataset.manifest.dataset_id {
        return Err("PlanDatasetMismatch: the saved plan belongs to a different dataset".into());
    }
    Ok(scenario)
}

pub fn run() {
    tauri::Builder::default()
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            list_datasets,
            open_dataset,
            dataset_layer,
            default_scenario,
            inspect_map_point,
            validate_scenario,
            solve_mission,
            export_mission_report,
            save_plan,
            list_plans,
            load_plan,
            start_simulation,
            simulation_action,
            reset_simulation,
            preview_blockage,
        ])
        .run(tauri::generate_context!())
        .expect("error while running HYDE");
}
