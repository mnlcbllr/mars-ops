# HYDE

Offline Mars terrain viewer and scenario-based excursion planner. Research prototype, not operational astronaut planning software.

## Run

Requires Bun, Rust and the [Tauri v2 prerequisites](https://v2.tauri.app/start/prerequisites/) for your OS.

```sh
bun install
bun tauri dev
```

Use the desktop window: a regular browser does not provide the native dataset/planning commands. The bundled Jezero dataset requires no Python at runtime. Only one dev server can use port 1420.

## Mission workflow

1. Edit the base, place candidate sites on the map, and set their activity bounds, preferences and the resource budgets in the right rail. Missions start with no candidates; you add each one yourself.
2. Optionally place the base on the map. Only known terrain within the declared slope limit is accepted; coordinates are also keyboard-editable.
3. Select **Run mission**. Native validation runs first, followed by the deterministic greedy baseline. Warnings may exclude sites; validation errors block planning.
4. Review the route in 3D. Expand **Resource checks & itinerary**, select a leg, or inspect excluded-site reasons. Feasibility is relative to the declared model, not a safety claim.
5. Select **Export JSON**. The app writes a `hyde-report_*.json` report to the existing `Documents/ARES/reports` folder (or its application-data directory if Documents is unavailable), and displays the actual path. It never overwrites an existing report.

Edits invalidate previous results, exports and saved paths. Inputs are locked during validation, planning, export and saving. **Save plan** writes the scenario without any result to `Documents/ARES/plans`; load it later from the same panel to continue editing. The exported report includes the selected scenario, model provenance, dataset hashes, solver result and limitations. Report import is not implemented. Displayed metrics are rounded for readability; the report retains the backend's numeric values.

## Checks

```sh
bun test
bun run build
cargo test -p ares-core -p ares-cli
```

Headless planning smoke test (prints the plan; does not write a report):

```sh
cargo run -p ares-cli -- plan datasets/jezero-small
```

## Name and compatibility

HYDE is the project name, not a claim that the HyDE optimization algorithm is implemented. The current solver remains **GreedyPlanner**. Existing report schemas, dataset/model IDs, the installed-app identifier and report storage location are unchanged. Internal Rust crate and CLI names retain `ares-*` for compatibility; previously exported reports remain readable as JSON.

See [LIMITATIONS.md](LIMITATIONS.md) and [the project specification](docs/HYDE_PROJECT_CONTEXT_AND_VALIDATION.md).
