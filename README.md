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

1. Keep the packaged scenario or edit the base, candidate selection, activity bounds, preferences and resource budgets in the right rail.
2. Optionally place the base on the map. Only known terrain within the declared slope limit is accepted; coordinates are also keyboard-editable.
3. Select **Run mission**. Native validation runs first, followed by the deterministic greedy baseline. Warnings may exclude sites; validation errors block planning.
4. Review the route in 2D or 3D. Expand **Resource checks & itinerary**, select a leg, or inspect excluded-site reasons. Feasibility is relative to the declared model, not a safety claim.
5. Select **Export JSON**. The app writes a `hyde-report_*.json` report to the existing `Documents/ARES/reports` folder (or its application-data directory if Documents is unavailable), and displays the actual path. It never overwrites an existing report.

Edits invalidate previous results and exports. Inputs are locked during validation, planning and export. Drafts are session-only; the exported report includes the selected scenario, model provenance, dataset hashes, solver result and limitations. Report import is not implemented. Displayed metrics are rounded for readability; the report retains the backend's numeric values.

## Hackathon demo

HYDE plans a modeled round trip on the Jezero crater floor. The science task is
to compare visible layering and textures at light-toned mounds and nearby
reference terrain. The staging point, observation activities and EVA constraints
are demo assumptions.

1. Start on **Mars globe**. Drag to orbit or scroll to zoom. Select the Jezero
   marker to zoom into the georeferenced HiRISE patch without leaving the globe.
   Use **Show full Mars globe** to zoom back out.
2. Turn on **Geology** to see the mapped Jezero floor and fan units. The regional
   layer supplements **Imagery** and **Elevation** and is available offline.
3. Select **Run mission** while on the globe to draw the round trip directly
   over Jezero. **Play route on globe** follows the planned geometry. Select
   a numbered stop to see its science task, or **Return to base** to inspect
   the final leg. **Open local 3D terrain** switches to the elevation mesh
   when you need to see hills and slopes in relief.
4. Expand **Resource checks & itinerary** and **Excluded sites**. Try a stricter
   slope limit and rerun. The planner uses terrain and scenario resource rules,
   not the regional geology overlay.

The animation is inspired by [NASA's Curiosity's Proposed Path up Mount
Sharp](https://science.nasa.gov/resource/curiositys-proposed-path-up-mount-sharp/).
It depicts HYDE’s computed Jezero route, not the Curiosity route. It is an
illustrative replay, not elapsed EVA time.

**Data credits.** The globe uses the NASA/JPL Mars Trek [MGS MOC Atlas Global
Color Mosaic](https://trek.nasa.gov/tiles/apidoc/trekAPI.html?body=mars). HYDE
bundles a 2048 × 1024 equirectangular overview stitched from the level-2 WMTS
tiles (layer `msss_atlas_simp_clon`, matrix set `default028mm`, 8 columns by 4
rows, north at top, −180° east longitude at left). The source tiles are
grayscale and are tinted for display, not presented as true color. To rebuild,
run `python tools/import_mars_globe.py` with Pillow installed. The globe uses a spherical
surface. At close range the same HiRISE imagery, elevation colors, regional
geology and derived hazard overlay are projected onto that sphere with the
dataset’s georeference. The globe drape does not model local relief. Route
calculation remains on the local HiRISE grid, and the separate 3D terrain view
shows elevations in relief.

HiRISE imagery and stereo elevation: NASA/JPL-Caltech/UArizona.
Regional geology: [USGS SIM 3464, Sun and Stack (2020)](https://doi.org/10.3133/sim3464).
The data manifest records the products, processing and hashes. To rebuild only
the geology layer from the USGS feature service, use
`python tools/import_jezero_geology.py` with `pyproj` and `shapely` installed.
Re-run that import after rebuilding the base HiRISE manifest. No Python or
internet is needed to run the app with the bundled layers.

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
