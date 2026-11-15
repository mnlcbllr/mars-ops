# MARS-OPS

Offline Mars terrain viewer and contingency-aware excursion planner. Research prototype, not operational astronaut planning software.

## Install

Linux (x86-64 or aarch64), one command:

```sh
curl -fsSL https://raw.githubusercontent.com/mnlcbllr/mars-ops/main/scripts/install.sh | sh
```

The installer builds the application from the reviewed source, never from a third-party mirror, and places it in `$HOME/.local`:

- `$HOME/.local/bin/mars-ops-app` — the desktop application
- `$HOME/.local/bin/mars-ops-cli` — the headless planner, verifier and benchmark runner
- `$HOME/.local/lib/mars-ops-app/datasets/jezero-small` — the bundled dataset

Useful flags: `--prefix DIR`, `--system`, `--source DIR` (build a local checkout), `--ref REF`, `--offline`, `--skip-deps`, `--dry-run`, `--no-verify`. Run `sh scripts/install.sh --help` for the full list.

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
5. Select **Export JSON**. The app writes a `mars-ops-report_*.json` report to the existing `Documents/MARS-OPS/reports` folder (or its application-data directory if Documents is unavailable), and displays the actual path. It never overwrites an existing report.

Edits invalidate previous results, exports and saved paths. Inputs are locked during validation, planning, export and saving. **Save plan** writes the scenario without any result to `Documents/MARS-OPS/plans`; load it later from the same panel to continue editing. The exported report includes the selected scenario, model provenance, dataset hashes, solver result and limitations. Report import is not implemented. Displayed metrics are rounded for readability; the report retains the backend's numeric values.

## Simulation, contingencies and replanning

After a successful run, the **Simulation** panel starts a stateful drill from the solved plan. The scenario is frozen for the duration of the drill.

- **+15 min / +30 min / To next stop** advance simulated EVA time along the computed route. Travel and science work charge the declared resource model step by step.
- **Inject event** applies one typed, validated contingency at the current simulated instant: a temporary blocked corridor, a delay, or a loss of EVA time, energy or consumable budget.
- **Replan from here** routes from the crew's actual position, keeps completed stops, subtracts consumed resources, and must still return to the base. The amber line is the latest revised route; red cells are the temporary block. If no modeled return exists, the phase becomes `INFEASIBLE` with a concrete reason.
- **Reset** discards the simulation and restores the editable scenario. Datasets are never modified; block overlays exist only in the drill.
- The advisory in the simulation panel states what changed, not what the planner did: **Replan required** when the plan can no longer be flown (a resource is over its total limit, or no direct return is modeled), **Reserve margin in use** when the drill has spent part of the declared reserve but the crew still returns inside the total EVA limit, and **Plan out of date** when a contingency has been injected since the last plan. The declared reserve is a planning margin, so spending it does not mean the planner failed.

Exported reports include the simulation phase, event timeline, completed work, revised plan, remaining checks, return margin and replan count as an optional `simulation` object. Older schema-v1 reports without that object still read back.

## Checks

```sh
bun test src
bun run build
cargo test --workspace
cargo run -p mars-ops-cli -- plan datasets/jezero-small
cargo run -p mars-ops-cli -- benchmark datasets/jezero-small
cargo run -p mars-ops-cli -- verify-manifest datasets/jezero-small
```

The benchmark compares `GreedyPlanner` with `ExactSubsetDp` on the bundled scenario for an open case and a fixed contingency script, and can write machine-readable JSON with `--out`.

`SHA256SUMS.txt` is not present in this checkout, so an external archive checksum comparison cannot be run. `verify-manifest` still opens the dataset and re-verifies every manifest-declared layer hash.

## Name and compatibility

MARS-OPS is the project name, not a claim that the MARS-OPS optimization algorithm is implemented. The default solver is the deterministic **ExactSubsetDp**; **GreedyPlanner** remains available as the transparent baseline and runtime fallback. No MARS-OPS, DE or CMA-ES implementation is claimed. Existing report schemas, dataset/model IDs, the installed-app identifier and report storage location are unchanged. Internal Rust crate and CLI names retain `mars-ops-*` for compatibility; previously exported reports remain readable as JSON.

See [LIMITATIONS.md](LIMITATIONS.md), [the implementation notes](docs/MARS_OPS_IMPLEMENTATION.md) and [the project specification](docs/MARS-OPS_PROJECT_CONTEXT_AND_VALIDATION.md).
