# MARS-OPS implementation notes

This document records what the current HYDE repository actually implements, how to reproduce it, and what remains blocked. The original specification (`HYDE_PROJECT_CONTEXT_AND_VALIDATION.md`) still governs scope and safety.

## What works

- **Stateful mission simulation.** A solved plan can be advanced along its computed A* route with an explicit cursor, elapsed clock and consumed resources. Travel, activity and idle phases are distinguished; completed science stops record realized activity and utility.
- **Typed contingencies.** A temporary blocked corridor or cell set, a delay, and an EVA-time, energy or consumable loss are validated against the lattice and declared model before they are applied. Datasets are never mutated; blocks live in a sparse per-run overlay.
- **Replanning from the actual position.** Replanning keeps completed sites out, subtracts consumed resources, charges no second EVA overhead, preserves the required base return, and reports `INFEASIBLE` with a concrete shortfall when no modeled return exists. A* avoids temporary blocks and continues to treat unknown terrain as impassable.
- **Exact discrete planner with fallback.** `ExactSubsetDp` performs Held-Karp subset and order optimization over the routed leg table at minimum activity durations, then uses the shared greedy dwell extension. `GreedyPlanner` is retained as the transparent baseline and is used when the exact search finishes no better or exhausts its 2.5 s wall-clock budget.
- **Benchmark harness.** `Session::benchmark` and the CLI `benchmark` command run both solvers on identical open and contingency cases and can write a machine-readable JSON document.
- **Compact UI.** The existing 3D map remains the only map. It overlays revised routes, the simulated position, corridor preview and blocked cells. The right rail exposes start, advance, boundary advance, event injection, replan, reset, before/after totals and `INFEASIBLE` reasons. Scenario editing is locked while a drill is active.
- **Report export.** `hyde-report_*.json` keeps schema version 1 and now includes an optional `simulation` object with phase, event timeline, completed work, revised plan, remaining checks, return margin and replan count. Reports without that object still parse.

## Tauri commands added or extended

| Command | Purpose |
|---|---|
| `start_simulation(run_id)` | Freeze the most recent solved report into a new simulation. |
| `advance_simulation(seconds)` | Advance simulated EVA time, stopping no earlier than the requested interval or a phase boundary. |
| `advance_simulation_to_stop()` | Advance exactly to the next arrival or activity completion. |
| `inject_simulation_event(kind)` | Validate and apply a typed contingency at the current instant. |
| `replan_simulation()` | Replan from the current position and current consumed budget. |
| `simulation_view()` | Read the current simulation view without changing it. |
| `clear_simulation()` | Discard the drill and restore the editable scenario. |
| `export_mission_report(run_id)` | Existing command; now attaches the simulation record when the exported run owns the active simulation. |

Rust APIs live in `ares-core`: `contingency`, `replan`, `mission_state`, `benchmark`, `route::BlockOverlay`, `planning::plan_dp`, `session::{SolverChoice, solve_with, benchmark}`. TypeScript mirrors them in `src/lib/types.ts`, `src/lib/api.ts` and `src/lib/mission.ts`.

## Benchmark (bundled Jezero scenario)

Command:

```sh
cargo run -p ares-cli -- benchmark datasets/jezero-small --out benchmark.json
```

Measured on this checkout:

| Case | Solver | Stops | Achieved utility | EVA used | Replans | Events | Final phase | Runtime |
|---|---|---:|---:|---:|---:|---:|---|---:|
| open | GreedyPlanner | 5 | 10.982 | 315.0 min | 0 | 0 | returned to base | 484 ms |
| open | ExactSubsetDp | 5 | 10.982 | 315.0 min | 0 | 0 | returned to base | 512 ms |
| contingency | GreedyPlanner | 5 | 8.128 | 310.0 min | 2 | 3 | returned to base | 1369 ms |
| contingency | ExactSubsetDp | 5 | 8.128 | 310.0 min | 2 | 3 | returned to base | 1355 ms |

Both solvers match on this scenario. The exact subset search demonstrates a strictly better result on the reproducible synthetic fixture in `planning::tests::dp_selects_a_better_subset_than_greedy_insertion` (utility 2.2 versus 2.1, both feasible). No statistical or general superiority is claimed.

The contingency script is declared in code, not sampled: 10 min walk, 20 min delay, 25 min walk, 5 min EVA loss, replan, 20 min walk, a 12 m block radius 32 m ahead on the active leg, replan, then continue. Runtime is informative, not a performance guarantee.

## 60 to 90 second demo

1. Run `bun tauri dev` and open the desktop window.
2. In the right rail, expand **Reproducible demo** under Candidate sites and choose **Load packaged scenario**. This loads the seven USER_DEFINED targets, base, budgets and model assumptions packaged with the dataset. A fresh mission still starts empty.
3. Choose **Run mission**. The current measured plan visits 5 sites with utility 10.982 and 315.0 min of EVA under the declared model.
4. In **Simulation**, choose **Start simulation**, then **Next boundary** twice: the crew arrives at the first stop and finishes its science work.
5. Choose **Pick centre on map** and click a point roughly 30 to 40 m ahead on the pink route, just beyond the amber crew marker. Set radius 12 m and choose **Block corridor**.
6. Choose **Replan from here**. The amber revised route starts at the current position and avoids the red cells. If the block is too large, the panel reports `INFEASIBLE` and the concrete reason instead of inventing a route.
7. Compare initial and current totals, expand **Event history**, then choose **Export JSON**. The report includes the `simulation` object and the declared-event disclaimer. Choose **Reset** to restore editing.

Repeatable headless checks:

```sh
cargo run -p ares-cli -- plan datasets/jezero-small
cargo run -p ares-cli -- benchmark datasets/jezero-small --out /tmp/mars-ops-benchmark.json
cargo run -p ares-cli -- verify-manifest datasets/jezero-small
```

`SHA256SUMS.txt` is absent from this checkout, so an external archive checksum comparison cannot be run. `verify-manifest` still re-verifies every manifest-declared layer hash and reports `REAL DATA VERIFIED` for the bundled crop.

## Evidence classification

- **OBSERVED**: the packaged HiRISE elevation and ortho-imagery products identified in the dataset manifest. Their layer hashes are re-verified on open.
- **DERIVED**: slope from the elevation raster, A* routes, leg distances, ascent/descent and travel time under the declared traversal model.
- **MODELED**: resource consumption, mission simulation, utility totals, block-overlay effects and `INFEASIBLE` outcomes.
- **USER_DEFINED**: base, candidate sites, activity bounds, preference weights, budgets, reserves, resource coefficients, slope limit and every injected event.
- **SYNTHETIC**: only unit-test fixtures. No synthetic science layer, mineral score, radiation field or hazard forecast was added to the application.

No CRISM, THEMIS, MEDA or PIXL layer was added. Those archives are absent locally, and none could be spatially verified against the packaged HiRISE crop. Adding an unverified overlay would violate the source rules.

## Verification

```sh
cargo test --workspace
bun test src
bun run build
cargo run -p ares-cli -- plan datasets/jezero-small
cargo run -p ares-cli -- benchmark datasets/jezero-small
cargo run -p ares-cli -- verify-manifest datasets/jezero-small
```

Relevant automated coverage:

- `mission_state::tests::the_same_operation_sequence_is_structurally_identical` (deterministic replay).
- `mission_state::tests::replanning_after_a_block_uses_the_current_position_and_keeps_completed_work`.
- `mission_state::tests::a_block_ahead_stops_travel_until_replanning`.
- `mission_state::tests::a_resource_loss_reduces_the_frozen_budget`.
- `replan::tests::a_blocked_return_produces_an_explicit_infeasible_result`.
- `replan::tests::blocked_corridor_is_never_crossed_when_replanning`.
- `report::tests::reports_without_and_with_a_simulation_record_round_trip`.
- `data::tests::a_changed_byte_in_the_raster_is_a_checksum_mismatch`.
- `benchmark::tests::the_benchmark_is_reproducible`.
- `planning::tests::dp_matches_exhaustive_search_when_durations_are_fixed`.
- `planning::tests::dp_abandons_a_search_that_exceeds_its_budget`.
- `src/lib/mission.test.tsx` for edit locks, simulation state and stale/failed call handling.

## Remaining gaps and smallest next actions

1. **Science layer:** supply an archived CRISM/THEMIS/MEDA/PIXL product with verifiable spatial metadata and a checksum manifest; then add a provenance-labelled layer and a test that its coverage matches the packaged crop.
2. **External checksum:** add the expected `SHA256SUMS.txt` and run the archive verification command.
3. **Continuous dwell optimality:** the exact guarantee covers selection and order at minimum durations only. A future bounded MILP or dynamic program could allocate dwell exactly; it must keep the same fallback and honesty labels.
4. **Cancellation:** planning and simulation calls cannot be cancelled from the UI. Add cooperative cancellation only if long runs become routine.
5. **Desktop end-to-end test:** browser mocks do not exercise the native IPC surface. Add a packaged desktop smoke test before claiming release readiness.
