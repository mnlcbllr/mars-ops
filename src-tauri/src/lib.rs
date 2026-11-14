//! ARES desktop shell: a thin IPC layer over `ares_core::session`.
//!
//! No science happens here. Each command hands the request to the core and
//! returns its answer. The webview gets no filesystem, shell or network
//! access: datasets are read only from the bundled resource directory, and
//! reports are written only to one fixed folder.

use ares_core::data::{dataset_dir, find_datasets, DatasetSummary};
use ares_core::inspect::PointInspection;
use ares_core::planning::{MissionScenario, ValidationReport};
use ares_core::report::MissionReport;
use ares_core::session::{DatasetInfo, DisplayLayer, Session};
use ares_core::LocalPoint;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use tauri::ipc::Response;
use tauri::{AppHandle, Manager, State};

#[derive(Default)]
struct AppState {
    session: Mutex<Option<Arc<Session>>>,
    /// The most recent solved run: the one on screen, and the only one that
    /// can be exported.
    last_run: Mutex<Option<(u64, MissionReport)>>,
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
    let path = report.write_to_dir(&documents.join("ARES").join("reports")).map_err(message)?;
    Ok(path.display().to_string())
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running ARES");
}
