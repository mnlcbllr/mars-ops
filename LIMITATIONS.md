# Current limitations

- **Research model, not safety certification.** Resource coefficients, slope thresholds, activity durations and priorities are user-defined assumptions. Orbital data does not resolve all surface hazards or establish actual astronaut traversability.
- **One local region and one instrument.** The bundled Jezero crop contains HiRISE elevation and registered imagery, not a global Mars map or a multi-instrument integration. Registration offsets and processing notes are recorded in the dataset manifest.
- **Greedy baseline only.** Terrain routing and round-trip resource checks exist, but mission selection has no optimality guarantee. HyDE, DE/CMA-ES comparisons, exact mission baselines, benchmark campaigns and sensitivity analysis are not implemented.
- **Session-only editing.** Base coordinates, packaged candidate selection, activity settings, budgets and model coefficients can be edited. New-site creation, scenario persistence/import, dataset switching and arbitrary data import are not implemented. Export a solved report to retain its selected scenario.
- **No job cancellation/progress stream.** Planning runs off the UI thread; scenario edits and export are locked until the request finishes. Long-running jobs cannot yet be cancelled from the UI.
- **Finite-resolution views.** The 3D view uses every fourth elevation sample at true vertical scale and requires WebGL. Both views use the same planning outputs. The 2D map remains available without WebGL.
- **Verification scope.** Frontend state/presentation tests and Rust unit/real-dataset integration tests exist. Browser IPC mocks do not replace native desktop end-to-end testing. Release installers and clean-machine/cross-platform behavior have not been verified here.
