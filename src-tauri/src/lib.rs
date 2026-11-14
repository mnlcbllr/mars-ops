//! HYDE desktop shell: a thin IPC layer over `ares_core::session`.
//!
//! No science happens here. Each command hands the request to the core and
//! returns its answer. The webview gets no filesystem, shell or network
//! access: datasets are read only from the bundled resource directory, and
//! reports are written only to one fixed folder.

use ares_core::contingency::ContingencyKind;
use ares_core::data::{dataset_dir, find_datasets, DatasetSummary};
use ares_core::inspect::PointInspection;
use ares_core::mission_state::{MissionState, SimulationView};
use ares_core::planning::{MissionScenario, ValidationReport};
use ares_core::report::MissionReport;
use ares_core::report::{utc_iso8601, write_new};
use ares_core::session::{DatasetInfo, DisplayLayer, Session};
use ares_core::LocalPoint;
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
    /// Stateful simulation started from one solved run. Cleared whenever the
    /// dataset or the solved run changes.
    simulation: Mutex<Option<(u64, MissionState)>>,
    run_counter: AtomicU64,
}

#[derive(serde::Serialize)]
struct SolvedRun {
    run_id: u64,
    report: MissionReport,
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
    *lock(&state.last_run) = None;
    *lock(&state.simulation) = None;
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
) -> Result<SolvedRun, String> {
    let session = current(&state)?;
    let report = tauri::async_runtime::spawn_blocking(move || session.solve(scenario))
        .await
        .map_err(message)?
        .map_err(message)?;
    let run_id = state.run_counter.fetch_add(1, Ordering::Relaxed) + 1;
    *lock(&state.last_run) = Some((run_id, report.clone()));
    *lock(&state.simulation) = None;
    Ok(SolvedRun { run_id, report })
}

/// Start a stateful simulation from the most recent solved run. The frozen
/// scenario and plan come from the stored report, never from the webview.
#[tauri::command(rename_all = "snake_case")]
fn start_simulation(state: State<'_, AppState>, run_id: u64) -> Result<SimulationView, String> {
    let session = current(&state)?;
    let report = {
        let last = lock(&state.last_run);
        match last.as_ref() {
            Some((id, report)) if *id == run_id => report.clone(),
            _ => return Err("RunNotAvailable: start the simulation from the most recent run".into()),
        }
    };
    let simulation = MissionState::start(
        &session.grid,
        &session.dataset.manifest.dataset_id,
        report.scenario.clone(),
        report.result.clone(),
    )
    .map_err(message)?;
    let view = simulation.view(&session.grid);
    *lock(&state.simulation) = Some((run_id, simulation));
    Ok(view)
}

fn with_simulation(
    state: &State<'_, AppState>,
    change: impl FnOnce(&mut MissionState, &ares_core::terrain::PlanningGrid) -> Result<(), String>,
) -> Result<SimulationView, String> {
    let session = current(state)?;
    let mut guard = lock(&state.simulation);
    let (_, simulation) = guard
        .as_mut()
        .ok_or_else(|| "NoSimulation: start a simulation from a solved run first".to_string())?;
    change(simulation, &session.grid)?;
    Ok(simulation.view(&session.grid))
}

#[tauri::command(rename_all = "snake_case")]
fn advance_simulation(state: State<'_, AppState>, seconds: f64) -> Result<SimulationView, String> {
    with_simulation(&state, |simulation, grid| {
        simulation.advance(grid, seconds).map(|_| ()).map_err(message)
    })
}

/// Advance exactly to the next arrival or activity boundary, never past it.
#[tauri::command]
fn advance_simulation_to_stop(state: State<'_, AppState>) -> Result<SimulationView, String> {
    with_simulation(&state, |simulation, grid| {
        simulation.advance_to_stop(grid).map(|_| ()).map_err(message)
    })
}

#[tauri::command(rename_all = "snake_case")]
fn inject_simulation_event(
    state: State<'_, AppState>,
    kind: ContingencyKind,
) -> Result<SimulationView, String> {
    with_simulation(&state, |simulation, grid| {
        simulation.inject(grid, kind).map(|_| ()).map_err(message)
    })
}

#[tauri::command]
fn replan_simulation(state: State<'_, AppState>) -> Result<SimulationView, String> {
    with_simulation(&state, |simulation, grid| simulation.replan(grid).map(|_| ()).map_err(message))
}

#[tauri::command]
fn simulation_view(state: State<'_, AppState>) -> Result<Option<SimulationView>, String> {
    let session = current(&state)?;
    Ok(lock(&state.simulation).as_ref().map(|(_, simulation)| simulation.view(&session.grid)))
}

#[tauri::command]
fn clear_simulation(state: State<'_, AppState>) -> Result<(), String> {
    *lock(&state.simulation) = None;
    Ok(())
}

/// Write the run that is on screen to `Documents/ARES/reports` and return the
/// file's path. The webview cannot choose the location.
#[tauri::command(rename_all = "snake_case")]
fn export_mission_report(
    app: AppHandle,
    state: State<'_, AppState>,
    run_id: u64,
) -> Result<String, String> {
    let mut report = {
        let last_run = lock(&state.last_run);
        match last_run.as_ref() {
            Some((id, report)) if *id == run_id => report.clone(),
            _ => return Err("RunNotAvailable: only the most recent run can be exported".into()),
        }
    };
    {
        let session = current(&state)?;
        if let Some((id, simulation)) = lock(&state.simulation).as_ref() {
            if *id == run_id {
                simulation
                    .check_dataset(&session.dataset.manifest.dataset_id)
                    .map_err(message)?;
                report.simulation = Some(simulation.record(&session.grid));
                report.disclaimers.push(
                    "Simulation events are declared model inputs, not observations from Mars."
                        .into(),
                );
            }
        }
    }
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
            start_simulation,
            advance_simulation,
            advance_simulation_to_stop,
            inject_simulation_event,
            replan_simulation,
            simulation_view,
            clear_simulation,
            export_mission_report,
            save_plan,
            list_plans,
            load_plan,
        ])
        .run(tauri::generate_context!())
        .expect("error while running HYDE");
}
