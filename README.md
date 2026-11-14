# ARES

Offline Mars terrain viewer and scenario-based excursion planner. Research prototype, not operational astronaut planning software.

## Run

Requires Bun, Rust and the [Tauri v2 prerequisites](https://v2.tauri.app/start/prerequisites/) for your OS.

```sh
bun install
bun tauri dev
```

Use the desktop window: a regular browser does not provide the native dataset/planning commands. The bundled Jezero dataset requires no Python at runtime. Only one dev server can use port 1420.

## Mission workflow

1. Keep the packaged scenario or edit the base, candidate selection, activity bounds, preferences and resource budgets in the right rail.
2. Optionally place the base on the map. Only known terrain within the declared slope limit is accepted; coordinates are also keyboard-editable.
3. Select **Run mission**. Native validation runs first, followed by the deterministic greedy baseline. Warnings may exclude sites; validation errors block planning.
4. Review the route in 2D or 3D. Expand **Resource checks & itinerary**, select a leg, or inspect excluded-site reasons. Feasibility is relative to the declared model, not a safety claim.
5. Select **Export JSON**. The app writes the current report to `Documents/ARES/reports` (or its application-data directory if Documents is unavailable), and displays the actual path. It never overwrites an existing report.

Edits invalidate previous results and exports. Inputs are locked during validation, planning and export. Drafts are session-only; the exported report includes the selected scenario, model provenance, dataset hashes, solver result and limitations. Report import is not implemented. Displayed metrics are rounded for readability; the report retains the backend's numeric values.

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

See [LIMITATIONS.md](LIMITATIONS.md) and [the project specification](docs/ARES_PROJECT_CONTEXT_AND_VALIDATION.md).
