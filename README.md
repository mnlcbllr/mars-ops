# HYDE

Offline Mars terrain viewer and contingency-aware excursion planner. Research prototype, not operational astronaut planning software.

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
3. Select **Run mission**. Native validation runs first, followed by the exact subset/order planner. The repository still contains the original greedy planner as a baseline and as the runtime fallback. Warnings may exclude sites; validation errors block planning.
4. Review the route in 3D. Expand **Resource checks & itinerary**, select a leg, or inspect excluded-site reasons. Feasibility is relative to the declared model, not a safety claim.
5. Select **Export JSON**. The app writes a `hyde-report_*.json` report to the existing `Documents/ARES/reports` folder (or its application-data directory if Documents is unavailable), and displays the actual path. It never overwrites an existing report.

Edits invalidate previous results, exports and saved paths. Inputs are locked during validation, planning, export and saving. **Save plan** writes the scenario without any result to `Documents/ARES/plans`; load it later from the same panel to continue editing. The exported report includes the selected scenario, model provenance, dataset hashes, solver result and limitations. Report import is not implemented. Displayed metrics are rounded for readability; the report retains the backend's numeric values.

## Simulation, contingencies and replanning

After a successful run, the **Simulation** panel starts a stateful drill from the solved plan. The scenario is frozen for the duration of the drill.

- **+15 min / +30 min / To next stop** advance simulated EVA time along the computed route. Travel and science work charge the declared resource model step by step.
- **Inject event** applies one typed, validated contingency at the current simulated instant: a temporary blocked corridor, a delay, or a loss of EVA time, energy or consumable budget.
- **Replan from here** routes from the crew's actual position, keeps completed stops, subtracts consumed resources, and must still return to the base. The amber line is the latest revised route; red cells are the temporary block. If no modeled return exists, the phase becomes `INFEASIBLE` with a concrete reason.
- **Reset** discards the simulation and restores the editable scenario. Datasets are never modified; block overlays exist only in the drill.

Exported reports include the simulation phase, event timeline, completed work, revised plan, remaining checks, return margin and replan count as an optional `simulation` object. Older schema-v1 reports without that object still read back.

## Checks

```sh
bun test src
bun run build
cargo test --workspace
cargo run -p ares-cli -- plan datasets/jezero-small
cargo run -p ares-cli -- benchmark datasets/jezero-small
cargo run -p ares-cli -- verify-manifest datasets/jezero-small
```

The benchmark compares `GreedyPlanner` with `ExactSubsetDp` on the bundled scenario for an open case and a fixed contingency script, and can write machine-readable JSON with `--out`.

`SHA256SUMS.txt` is not present in this checkout, so an external archive checksum comparison cannot be run. `verify-manifest` still opens the dataset and re-verifies every manifest-declared layer hash.

## Name and compatibility

HYDE is the project name, not a claim that the HyDE optimization algorithm is implemented. The default solver is the deterministic **ExactSubsetDp**; **GreedyPlanner** remains available as the transparent baseline and runtime fallback. No HyDE, DE or CMA-ES implementation is claimed. Existing report schemas, dataset/model IDs, the installed-app identifier and report storage location are unchanged. Internal Rust crate and CLI names retain `ares-*` for compatibility; previously exported reports remain readable as JSON.

See [LIMITATIONS.md](LIMITATIONS.md), [the implementation notes](docs/MARS_OPS_IMPLEMENTATION.md) and [the project specification](docs/HYDE_PROJECT_CONTEXT_AND_VALIDATION.md).
