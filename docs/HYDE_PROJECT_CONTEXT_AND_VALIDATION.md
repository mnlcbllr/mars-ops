# HYDE — Project Context, Scientific Validation, and Implementation Specification

> **Coding-agent handoff** — NASA Space Apps Challenge 2026, Challenge #11: **Interplanetary Survival Guide: Martian Map**  
> **Target:** Desktop application using **Tauri v2 + React/TypeScript frontend + Rust backend**.  
> **Document date:** 2026-11-14. **Status:** Proposed research-driven MVP, **not validated astronaut flight software**.  
> **Main instruction:** Prioritize a correct, traceable, NASA-data-backed **map and mission-planning demonstration**, not an impressive-looking but synthetic simulation.

---

## 0. Instructions to the coding agent — read this first

You are building **HYDE** (formerly ARES — Adaptive Resource & Exploration System) as a transparent, research-oriented planetary mission-planning desktop application. This document is the source of truth for scope, constraints, architecture, acceptance criteria, and credibility requirements. HYDE is the project brand, not a claim that the HyDE optimizer is implemented; the current solver remains GreedyPlanner.

**Non-negotiable rules**

1. **Do not claim to use real NASA data until a verified NASA/USGS dataset is loaded.** Clearly distinguish `OBSERVED`, `DERIVED`, `MODELED`, `USER_DEFINED`, and `SYNTHETIC` information everywhere relevant.
2. **Do not call an approximate optimizer “HyDE” unless it faithfully implements the team's original published/thesis algorithm.** Obtain original pseudocode/source and parameter settings. Until then name it `Experimental hybrid (unverified)` and make the production UI disclose this.
3. **Do not claim a route is safe for actual astronauts.** Say `modeled traversability` / `estimated mission feasibility`, with spatial resolution and uncertainty disclosed.
4. **Do not invent NASA scientific targets, geological scores, real-time radiation, astronaut consumable rates, or verified safety thresholds.** User-defined assumptions are permitted if tagged and editable.
5. **Do not fabricate evaluation results.** Generate benchmarks from executable code, record exact input configuration, dataset IDs, seeds, and code revision.
6. **Hard constraints must never be silently traded for a higher science score.** If return-to-base, resource reserves, known impassable terrain or data-coverage constraints fail, report `INFEASIBLE`, not a recommended mission.
7. **Do not equate a smaller number of “fitness evaluations” with superior efficiency without wall-clock and evaluation-cost evidence.** Algorithms must be compared on equivalent workload/problem definitions.
8. **Keep the interface map-first and low-text.** Prefer clear layers, three or four KPI cards, icon actions, a collapsible itinerary, and a compact method/data provenance panel. No oversized essay-like UI panels.
9. **Implement a small complete vertical slice before adding more algorithms or visual polish.** A single well-sourced Jezero area with a working map, one optimized mission, and honest comparisons beats a feature-rich fabricated planet.
10. **Ship runnable code and automated tests**, not just mockups. Record unsupported/unfinished components in a `LIMITATIONS.md` and show relevant notices in-app.

**First actions in the repository**

- Inspect any existing prototype only as a visual/reference artifact. The earlier browser MVP has **procedural terrain, synthetic science sites, hypothetical resource coefficients, and an unverified HyDE-style solver**. **Do not reuse its scientific outputs as ground truth.**
- Establish the new Tauri/Rust project structure and tests.
- Select and **actually ingest one real Mars elevation product** before describing the map as NASA-backed.
- Request the team's **HyDE source, thesis or exact pseudocode** if not present; proceed with clearly labeled classical baseline while preserving a plug-in interface for HyDE.
- Report honestly what is implemented, what was validated, and what remains assumed.

---

## 1. Executive summary

**One-sentence product:** HYDE is an interactive Mars map and resource-aware science excursion planner that combines traceable orbital observations with constrained mission optimization to explain *what science objectives can be visited, in what order, using which route, and within which hypothetical mission resource limits*.

**Challenge alignment:** The official Space Apps challenge calls for a layered Martian mapping experience integrating information from multiple Mars missions to help future astronauts plan safe and scientifically valuable Marswalks. HYDE must do **data integration and interpretation first**; mission scheduling, optimization and resource accounting are an added decision-support layer. A generic route finder alone is not an adequate interpretation of the entire challenge.

**Core user story:** A mission designer explores an actual region on Mars, reviews NASA-sourced imagery and elevation layers, marks candidate research locations, sets EVA time / energy / consumable assumptions, and generates a *feasible round-trip itinerary*. HYDE explains its trade-offs and shows how a reference planner compares with a candidate HyDE method.

**Primary research opportunity:** Test whether **HyDE — Hybrid Differential Evolution with warm-started increasing-population CMA-ES (IPOP-CMA-ES)** — improves the *quality or robustness of continuous/mixed mission-planning decisions* under a constrained evaluation budget relative to appropriate classical methods. **This is a hypothesis, not a demonstrated fact.**

**Important correction:** HyDE is an **evolutionary/derivative-free optimization method**, **not a quantum computer or quantum algorithm**. Do not brand the application “quantum-powered” without independently implementing and evaluating a genuine quantum component.

### Project identity

| Field | Decision |
|---|---|
| Working name | **HYDE** |
| NASA Space Apps 2026 category | **Challenge #11 — Interplanetary Survival Guide: Martian Map** |
| Related areas | Mars, human exploration, planetary mapping, geospatial science, software, operations research |
| Main task | Layered Mars map + constrained multi-stop science excursion planning |
| App | Offline-capable **Tauri v2** desktop software |
| Core computation | **Rust**: data model, raster sampling, terrain metrics, routing, mission evaluation, solvers, benchmarking |
| Frontend | **React + TypeScript**; focused 2D map + compact control panes; optional 3D later |
| Starting location | **Jezero Crater** (choose an actual DTM-covered local bounding box) |
| Prototype readiness | **Research prototype**, not operational mission planning |

---

## 2. The actual problem and its boundaries

### 2.1 Problem statement

Mars surface exploration requires planners to reconcile **spatial information** (terrain, slopes, hazards, geology) with **operational decisions** (which scientific observations to complete, when, and in what order) under limited **time, energy, and life-support consumables**. Relevant data come from different instruments, spatial resolutions, coverage extents, data products and reference frames. An integrated map is useful, but it does not automatically produce feasible or scientifically efficient activity plans.

**HYDE should solve the bounded engineering problem:**

> For one documented Mars region and a declared, approximate mission-resource model, produce and compare feasible round-trip science itineraries while exposing the geospatial evidence, modeled assumptions, algorithmic trade-offs, and uncertainty behind each recommendation.

### 2.2 What HYDE is **not**

- Not a NASA-approved mission planning system, certified traverse planner, or substitute for astronaut/rover hazard assessment.
- Not a live Mars weather, radiation, oxygen or life-support monitor.
- Not an assertion that HyDE is superior to A*, MILP, CP-SAT, or established mission-planning methods.
- Not a global, footstep-safe Mars map. Coarse global MOLA products **cannot** establish local astronaut-scale traversability.
- Not a claim that a location has scientifically quantified “value 94/100” unless the score is explicitly derived from a documented metric or mission-designer preference model.
- Not a claim that a terrain photo itself contains elevation, radiation, or mineral abundance measurements.

### 2.3 Distinguish four separate technical questions

1. **Mapping:** Where are features, what instrument observed them, and how reliable is the coverage/alignment?
2. **Routing:** Which connected paths are traversable under a declared terrain/hazard model?
3. **Mission scheduling / resource allocation:** Which objectives should be completed, how much activity time/resources should be allocated, and in what order?
4. **Optimizer benchmarking:** Under equivalent budgets and problem definitions, when (if ever) does HyDE improve outcomes?

Treat them as separate Rust modules and separate validation claims. Do not conflate A* shortest-path performance with full mission-scheduling performance.

---

## 3. Research questions, hypotheses, and contribution

**RQ1 — Integration:** Can heterogeneous NASA/USGS Mars products be aligned into one traceable, region-specific layered view with clearly disclosed coverage and uncertainty?

**RQ2 — Feasibility:** Can HYDE construct a round-trip science mission plan that respects declared EVA time, energy, consumables, terrain and reserve constraints?

**RQ3 — Algorithmic value:** Compared against resource-constrained scheduling and routing baselines, does the team's faithfully reproduced HyDE improve feasible mission utility, convergence, robustness, or runtime under defined evaluation budgets?

**RQ4 — Sensitivity:** How do the preferred itinerary and solver rankings change when assumed traversal speed, consumable rates, terrain hazard thresholds, or science priorities vary?

**Candidate hypotheses (must be tested)**

- H1: A hybrid DE + warm-start IPOP-CMA-ES method can achieve higher **feasible science utility** than simpler stochastic heuristics on selected continuous/mixed decision scenarios.
- H2: The advantage, if present, will vary with dimensionality, nonlinearity, resource tightness and objective-evaluation cost.
- H3: Explicit uncertainty and reserve constraints reduce brittle plans compared to naive unconstrained score maximization.

**Contribution boundaries:** HYDE may contribute a **validated integration workflow**, **transparent simulation-based decision support**, and **empirical evidence about algorithm applicability**. Avoid claiming to have discovered a previously unsolved NASA problem. NASA has prior related work on astronaut traverse planning and metabolic workload using **Hybrid A*** (see sources).

---

## 4. Official NASA challenge — scope check

**Official challenge:** https://www.spaceappschallenge.org/2026/challenges/interplanetary-survival-guide-martian-map/

The accessible search-indexed challenge summary identifies a **layered map using data from multiple Mars missions** to support astronaut safety and scientifically useful Marswalks. The full challenge page intermittently returned a retrieval error during preparation of this brief. **The coding agent must reopen the official challenge page and inspect the exact full statement, resources, rules and submission rubric before final submission.** This document does not pretend to quote an unverified full rubric.

### HYDE challenge-coverage checklist

- [ ] Map displays an actual named region on Mars with verified spatial coordinates.
- [ ] At least **two distinct NASA-mission/instrument source layers** are visible and attributable (e.g., MRO CTX imagery + MGS MOLA topography); **prefer three** including a local MRO HiRISE DTM or CRISM science data.
- [ ] All visual layers are aligned under an explicit local projection and have coverage boundaries.
- [ ] User can inspect a location and see underlying instrument/product, resolution, and observation date where available.
- [ ] User can select a base, science objectives, mission preferences and resources.
- [ ] Planner gives an itinerary that **returns to base**, with cumulative costs, reserves, limits and route geometry.
- [ ] Hazard or data-deficient zones remain distinguished from traversable zones.
- [ ] The app explains which facts are measured/derived and which are modeled/assumed.
- [ ] Demo shows why *integrating multiple NASA data products* changes planning decisions.
- [ ] Submission materials include code, data citations, limitations, and reproducible evidence.

---

## 5. Data sources — verified candidates and correct usage

**Source hierarchy:** archived raw/derived NASA PDS/USGS products with metadata > official NASA Trek layer services for visual context > peer-reviewed derived products with method/DOI > explicitly labeled user interpretation > synthetic demo data. A visualization basemap is **not** automatically a numeric scientific raster.

| Priority | Instrument/source | Supported use | Resolution / caveat | Verified source |
|---|---|---|---|---|
| P0 | **MRO HiRISE stereo DTM**, Jezero | Local elevation, slope, roughness proxy, terrain cross-section | Product-specific; a documented Jezero product reports **1 m/pixel**; coverage limited to footprint | https://hirise.lpl.arizona.edu/dtm/ESP_023524_1985 |
| P0 | **NASA Mars Trek, MRO CTX / HiRISE** | Registered visual imagery, regional context, science-target inspection | Imagery is not a DEM; some mosaics may be uncontrolled | https://trek.nasa.gov/tiles/apidoc/trekAPI.html?body=mars |
| P0/P1 | **MGS MOLA MEGDR topography**, PDS4 | Broad elevation and regional context | 4–128 pixels/degree general maps; not local footstep-scale assessment | https://pds-geosciences.wustl.edu/missions/mgs/megdr.html |
| P1 | **MRO CRISM** map-projected targeted products | Spectral/mineral indicators at covered sites; science-interest evidence | Interpretation depends on product, noise, viewing geometry and expert judgment | https://pds.nasa.gov/ds-view/pds/viewBundle.jsp?identifier=urn%3Anasa%3Apds%3Amro_crism_mtrdr&version=1.0 |
| P1 | **USGS Mars 2020 Jezero TRN DTM/orthoimagery** | Independently managed high-resolution local terrain/map products | Check dataset version and co-registration; good alternative to individual stereo DTM | https://doi.org/10.5066/P9REJ9JN |
| P2 | **Curiosity RAD** radiation observations | Historical reference and scenario parameter bounds where scientifically justifiable | Measurements from **Curiosity's location** cannot be presented as a measured radiation map at Jezero | https://science.nasa.gov/mission/msl-curiosity/science-instruments/ |

**Concrete starter product:** HiRISE DTM `DTEEC_023524_1985_023379_1985_U01` is identified on the HiRISE Jezero landing-site page; this is a real product, not a made-up file ID. It is a large original archive (~700 MB shown on its page), so download a verified subset or pre-process into an appropriately small local derivative for the demo. Another documented Jezero DTM is `DTEEC_048842_1985_048908_1985_U01` (see sources).

**Important distinction:** Mars Trek's **MOLA color hillshade** is a *visualization*; use the numeric MOLA MEGDR or a local DTM for slope/height computation. CTX/HiRISE image mosaics are *imagery*; they do not establish height unless paired with independently derived terrain data.

### 5.1 Spatial reference and registration (mandatory)

- Canonical internal geographic input: **Mars planetocentric latitude, positive-East longitude, degrees, 0–360 domain**. Persist metadata for any source that uses a different convention.
- Canonical **local optimization coordinates:** projected planar `x_m`, `y_m` **in meters**, relative to the chosen ROI map CRS/origin; do not use raw lat/lon Euclidean distance.
- Maintain and record source projection WKT/PROJ and reference-body radius/datum/vertical reference; do not assume a terrestrial WGS84 CRS or standard Earth haversine radius.
- **Never simply overlay two products based on image dimensions**. Reproject/resample using their metadata and check registration using documented control points or known tie points.
- Specify handling for longitude wrapping, no-data, projection distortion, local raster cell size, raster edges, and interpolation.
- Elevation values must have an explicit vertical reference (e.g. MOLA areoid-relative or DTM product's reference); avoid mixing height datums silently.
- Use a single DTM-covered ROI. If a route leaves verified elevation coverage, classify the corresponding path segment as `UNKNOWN` / blocked under conservative mode.

For planetary projection conventions, see: https://astrogeology.usgs.gov/docs/concepts/camera-geometry-and-projections/learning-about-map-projections/ and https://planetarynames.wr.usgs.gov/TargetCoordinates.

### 5.2 Dataset provenance model

Every imported raster, vector layer, site or derived metric must include:

```json
{
  "id": "hirise-jezero-local-dtm",
  "display_name": "Jezero HiRISE DTM",
  "origin_type": "OBSERVED_OR_ARCHIVED_DERIVED",
  "provider": "NASA/JPL-Caltech/University of Arizona",
  "instrument": "HiRISE",
  "product_id": "DTEEC_023524_1985_023379_1985_U01",
  "source_url": "https://hirise.lpl.arizona.edu/dtm/ESP_023524_1985",
  "license_and_credit": "Check product attribution/usage page",
  "retrieved_utc": null,
  "observation_date": null,
  "source_crs": "POPULATE_FROM_ACTUAL_LABEL",
  "output_crs": "POPULATE_FROM_PREPROCESSING",
  "vertical_datum": "POPULATE_FROM_ACTUAL_LABEL",
  "pixel_size_m": null,
  "bbox_original": null,
  "bbox_projected_m": null,
  "nodata_value": null,
  "sha256_source": null,
  "sha256_derived": null,
  "processing_steps": [],
  "quality_notes": [],
  "is_real_source_verified": false
}
```

All null placeholders **must** be filled from downloaded product metadata for real-data mode; do not fabricate them. The product name and official product page above are verified identifiers, not proof that the bytes are downloaded or aligned in the application.

### 5.3 Reproducible import pipeline

1. Download verified source products from official archives or trusted mirrors; record final URL, retrieval time and SHA-256.
2. Read PDS4 XML/PDS3 labels; validate dimensions, data type, no-data, scale/offset, coordinate reference and vertical datum.
3. Use **GDAL / rasterio / ISIS** as a documented build-time preprocessing tool if needed. Scientific calculations in the running app remain in Rust. Do not try to write a new planetary projection library under hackathon time pressure.
4. Clip an actual **covered** local ROI; align data layers to a declared local metric projection and store a small compressed derivative. Preserve original source metadata/transform in the manifest.
5. Compute derived slope/relief using calibrated raster meters and neighborhood operators. Track null/low-confidence cells separately from low-risk cells.
6. Package a georeferenced raster plus compact imagery for the MVP. NASA Trek WMTS can be an optional visual layer, but the app should work from cached/local imported data.
7. Save a machine-readable `data_manifest.json` and a human-readable `DATA_CATALOG.md` with citation and credits for every dataset.
8. Reject datasets with unknown transforms or incompatible alignment; show an actionable import error rather than silently displaying incorrect maps.

**Physical-realism warning:** A 1 m DTM can still fail to resolve hazards smaller than its effective resolution; orbital imagery cannot certify all boulders, dust, terrain strength or suit traversability. The application produces scenario plans only.

---

## 6. Product scope and user interaction

### MVP workflow (must work end-to-end)

1. **Open** a small packaged real-data Jezero region. A badge shows `REAL DATA · HiRISE / CTX` only if manifests/checksums and raster loading succeed.
2. **Explore** map with `Imagery`, `Elevation`, `Slope/Unknown`, and optional `Science` overlays. Click to inspect data provenance and coverage.
3. **Create scenario:** place base inside valid terrain, select 3–8 candidate science sites **inside data coverage**, and set mission assumptions/time/resources/reserves.
4. **Run baseline:** calculate a feasible mission using explicit route and budget constraints. If infeasible, show why and which constraint failed.
5. **Run optimization:** optionally execute exact original HyDE if supplied; otherwise use labeled simple baseline or standalone DE. Record seed, evaluation budget, solver, inputs and runtime.
6. **Compare:** show route geometry, visited sites, science objective coverage, resource consumption, reserves, solver runtime, and feasibility.
7. **Inspect evidence:** selecting a route segment shows associated terrain source, effective cell resolution, slope estimate, modeled risk, or unknown coverage.
8. **Export reproducible mission report** (`JSON`, optional `CSV`) with source IDs, scenario, parameter provenance, algorithm config, decision vector, feasibility, metrics and warnings.

### UX direction (from explicit user feedback)

**The old prototype contained too much text.** Build a map-dominant desktop interface, not a research paper on screen.

Suggested layout at 1440×900:

- **Top bar (48–56px):** HYDE / dataset status / region / `Run mission`.
- **Map (65–75% viewport width):** NASA geospatial layer; route, sites, scale, north indicator, concise legend; proper pan/zoom; no procedural decorative map if real data is available.
- **Right rail (300–360px):** Resource inputs (oxygen/energy/time), mission goal, compact objectives list, action button.
- **Bottom dock or collapsible detail:** 3–4 KPIs (`Science objectives`, `Time used`, `Resource reserve`, `Plan status`) and short itinerary; optional **Compare** tab.
- **Data / Methods drawer:** full source IDs, spatial coverage, warnings, solver settings and assumptions. Not visible by default but always accessible.

UI states: `No real data`, `Loading data`, `Real data loaded`, `Scenario needs configuration`, `Optimizing`, `Feasible plan`, `No feasible plan`, `Method unverified`, `Unknown terrain`. Never show fake validated metrics simply to fill empty state.

**Accessibility:** keyboard-operable site selection, legible contrast, text legend for map colors, non-color hazard coding, responsive minimum desktop window size.

---

## 7. Mission planning mathematical model

### 7.1 Objects

- `B`: habitat/base position (must return to B).
- `S = {s_1...s_n}`: candidate science sites with coordinates and provenance.
- `e_ij`: route leg between site `i` and `j`, generated by an independent terrain-aware routing solver.
- `z_i in {0,1}`: whether to visit site `i`.
- `pi`: ordering of the selected sites (a permutation).
- `tau_i`: continuous planned activity time allocated to site `i`, constrained to a valid interval.
- `r`: resources (EVA duration, consumables, power etc.) with available capacities and required return reserves.
- `q_i(tau_i)`: documented mission science utility function — **user-defined scenario preference unless independently validated**.

**Planning goal:** select a feasible ordered subset of science sites and task allocations that maximizes declared science utility after considering route cost/risk and resource limits. This is related to **orienteering / prize-collecting routing with resource constraints**, not merely shortest-path routing.

### 7.2 Example objective for an experimental scalar solver

```text
maximize  U(plan) = Σ_i q_i(tau_i)
                    − λ_d * normalized_total_distance
                    − λ_t * normalized_total_time
                    − λ_r * normalized_modeled_risk
```

Subject to **hard** constraints:

```text
start(plan) = base
end(plan)   = base
all_selected_sites_have_valid_paths = true
covered_and_traversable(each route segment) = true
EVA_time(plan) <= EVA_time_limit − time_reserve
power(plan)    <= power_budget − power_reserve
consumables(plan) <= consumable_budget − consumable_reserve
activity_min_i <= tau_i <= activity_max_i
all declared safety/hazard scenario rules are satisfied
```

All terms must have explicit units, definitions, normalization, and coefficients stored with the scenario. The user should be able to compare science-first vs risk-aware plans, but **must not be able to override hard constraints through weights**. If no candidate satisfies all constraints, produce an infeasibility report.

### 7.3 Routing subproblem

For each candidate leg:

1. Build a graph over valid DTM cells or a coarser safe planning lattice.
2. Exclude no-data and user-declared prohibited regions under conservative mode.
3. Compute slope and surface-distance estimates using local metric coordinates.
4. Apply **parameterized**, clearly labeled traversal cost/risk models. **Do not present an arbitrary slope threshold as a certified astronaut safety limit.**
5. Use a baseline pathfinder (A* or Dijkstra). Verify shortest-path behavior on known graphs.
6. Cache legal pairwise leg candidates by dataset, region, grid resolution, scenario constraints and planner config. Invalidate when those change.
7. Sum return leg **back to base** as part of time/energy/consumables. An itinerary missing the return leg is invalid.

**Why not A* alone?** A* is well suited to a specified source-to-destination graph path, but the larger task includes choosing which science sites to visit and allocating constrained activities. Fair mission-planning comparisons require algorithms for that **larger** task (e.g., CP-SAT/MILP, orienteering heuristics), not only A*.

### 7.4 Resource modeling — research prototype, not physiologically validated

Use dimensioned quantities and show their epistemic status:

- Travel time `t_ij`: route distance and a **scenario-specific speed function** affected by slope if justified.
- Activity time `tau_i`: required/optional science-work time.
- EVA time: travel + activities + explicitly modeled breaks/overhead.
- Power `E`: per-activity equipment loads and optional traversal costs, **declared model**.
- Oxygen or life-support usage: **scenario-level, parameterized surrogate model**; never silently assume NASA certified astronaut rates.
- Thermal/radiation: **omit from v1 objective** unless valid spatially and temporally relevant data/model is actually imported. Show as contextual observation/uncertainty instead.
- Scientific value: use **mission-designer preference or documented geological indicators** and label which. Do not claim universal ground-truth science scores.

Implement provenance on every coefficient: `value`, `unit`, `source_type`, `citation_or_assumption`, `range`, `version`. When data is absent, **make unknown explicit** rather than defaulting to a reassuring zero.

### 7.5 Uncertainty

A route may look feasible under assumed speed or power use and become infeasible when those assumptions change. Provide configurable scenario ranges and a lightweight robust evaluation:

- Worst-case / sensitivity sweeps for walking speed, activity duration, energy coefficients and hazards.
- Optional seeded Monte Carlo propagation (e.g., 100–500 draws for demo) on declared distributions.
- Report estimated feasibility rate **under specified modeled assumptions**, not actual astronaut survival probability.
- Fail conservative when required terrain data is missing.

---

## 8. HyDE: precise role and integration contract

### 8.1 What is known / not known

**Known from the team's study title and discussion:** HyDE is a hybrid of **Differential Evolution** and **warm-started IPOP-CMA-ES**, originally developed for **continuous parametric optimization**. The team's study must be consulted for the precise initialization, transfer, switching, restarts, population scheduling, termination and constraint handling.

**Not verified here:** exact source code, pseudocode, DE mutation variant, crossover rate, CMA-ES covariance adaptation formulas, switching criterion, warm-start details, treatment of box/hard constraints, and original benchmark results. **Do not invent these and call the result a faithful reproduction.**

### 8.2 How to encode HYDE for a continuous optimizer

Science-site selection/order is **discrete**; waypoint placement, dwell time and allocation are **continuous**. Two options:

**Option A — preferred MVP (research-conservative):**

- Use a validated classical mission scheduler/routing baseline for discrete **site selection and order**.
- Run authentic HyDE on a **fixed selected itinerary** for continuous values, e.g., activity durations, permitted local waypoint offsets, speed/energy strategy coefficients, or other real, physically meaningful continuous controls.
- Revalidate connectivity and all constraints after each candidate decode.
- Compare against standalone DE, CMA-ES and a deterministic/convex or nonlinear solver (when applicable) **on the exact same fixed-itinerary problem**.

**Option B — research extension (mixed problem):**

- Encode task priority keys and continuous dwell-time allocations as real variables.
- Deterministically decode sorted priority keys into an ordered subset; reject candidates violating hard constraints.
- Recognize that decoding introduces discontinuities and may favor other optimizers; explicitly benchmark against **orienteering / resource-constrained mission scheduling solvers**.

**Do not assume that HyDE will outperform the discrete-task baseline.** The purpose is to test suitability, not to force algorithmic victory.

### 8.3 Rust solver interface

```rust
pub trait MissionOptimizer: Send + Sync {
    fn name(&self) -> &'static str;
    fn optimize(
        &self,
        problem: &MissionProblem,
        config: &SolverConfig,
        progress: &mut dyn FnMut(OptimizationProgress),
        cancel: &std::sync::atomic::AtomicBool,
    ) -> Result<OptimizationResult, PlannerError>;
}

pub struct SolverConfig {
    pub seed: u64,
    pub max_objective_evaluations: u64,
    pub max_wall_time_ms: Option<u64>,
    // Additional solver-specific config must be versioned.
}
```

Use one canonical evaluation function and a consistent definition of an **objective evaluation**. Store an immutable scenario snapshot and dataset manifest hash with every run. Return exact feasibility/rejection details, route legs, resource totals, best-so-far history, evaluation count, runtime and algorithm config.

**Recommended initial implementations:**

1. `GreedyPlanner` — transparent, feasible mission baseline.
2. `AStarLegRouter` — terrain-aware pairwise routing **component**, not a complete full-mission competitor.
3. `ExactSmallPlanner` — exhaustive enumeration or CP-SAT/MILP for small instances to establish known/near-known optima.
4. `StandaloneDE` — optimization reference.
5. `StandaloneCMAES` — optimization reference (if authentic implementation available).
6. `HyDE` — **only after porting and testing the real original algorithm**.

### 8.4 Evaluation budgets and fairness

- Same mission datasets, objectives, constraints, hyperparameter tuning protocol and seed sets.
- Count objective evaluations consistently. With route caching, record **cache hits/misses and preprocessing time**; do not hide expensive route creation outside one solver but inside another.
- Record **wall-clock runtime, CPU/memory, evaluations, best feasible utility, feasibility ratio and constraint violations**.
- Separate up-front preprocessing from solve runtime, but report both.
- Across repeated randomized runs report **median, interquartile range, 95% bootstrap confidence interval**, and raw run data.
- Use a predeclared success criterion rather than retrofitting one to a favorable run.
- If tests do not show HyDE superiority, report that faithfully and explain where it was competitive or weaker.

---

## 9. Desktop application architecture

### 9.1 Stack

- **Tauri v2** with safe, narrow IPC command surface.
- **Rust stable toolchain** for scientific domain core; keep core independent of Tauri for unit and headless benchmark tests.
- **React + TypeScript + Vite** for frontend, strict type-checking.
- CSS/Tailwind optional. UI clarity takes precedence over framework choices.
- Local **Canvas/WebGL** or a 2D GIS-capable frontend with a **correct custom planetary/local map projection**. Do **not** silently configure an Earth-specific basemap/CRS for Mars.
- Data packaging: versioned manifest + raster derivatives + sidecar metadata; SQLite optional for scenarios and experiment indexing.
- GDAL/ISIS/rasterio preprocessing **outside the running application** is acceptable if documented and reproducible. All mission logic and algorithms belong in Rust.

### 9.2 Suggested repository layout

```text
hyde/
  README.md
  LICENSE
  LIMITATIONS.md
  DATA_CATALOG.md
  docs/
    HYDE_PROJECT_CONTEXT_AND_VALIDATION.md
    SCIENTIFIC_METHOD.md
    BENCHMARK_PROTOCOL.md
    SUBMISSION_CHECKLIST.md
  src/                       # React/TS frontend
    app/
    components/
      MarsMap.tsx
      ResourceControls.tsx
      ScienceSitePanel.tsx
      MissionResults.tsx
      DataProvenance.tsx
    features/
      map/
      planner/
      benchmarks/
    lib/
      tauri.ts
      types.ts
  src-tauri/
    tauri.conf.json
    capabilities/
    src/
      main.rs
      lib.rs
      commands.rs
  crates/
    ares-core/
      src/
        lib.rs
        model.rs
        geo.rs
        terrain.rs
        data.rs
        provenance.rs
        route.rs
        resources.rs
        planning.rs
        uncertainty.rs
        optimizers/
          mod.rs
          greedy.rs
          exact_small.rs
          differential_evolution.rs
          hyde.rs
        benchmark.rs
    ares-cli/
      src/main.rs          # Headless import validation + experiments
  tools/
    preprocess_data.py     # optional reproducible GDAL pipeline
    verify_manifest.py
  datasets/
    README.md
    jezero-small/
      manifest.json
      elevation.bin
      imagery/             # georeferenced local assets
      targets.json         # curated targets with provenance
  tests/
    fixtures/
    validation/
  results/
    .gitkeep
```

**Note:** This is a target structure, not a claim these files already exist. Prefer a manageable subset if time is limited. No external API keys should be required for the packaged offline demo.

### 9.3 Rust core types (suggested, not final serialization contract)

```rust
#[derive(Clone, Copy, Debug, serde::Serialize, serde::Deserialize)]
pub struct LocalPoint { pub x_m: f64, pub y_m: f64 }

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub enum EvidenceKind { Observed, Derived, Modeled, UserDefined, Synthetic }

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct ResourceBudget {
    pub eva_limit_s: f64,
    pub eva_reserve_s: f64,
    pub energy_budget_wh: Option<f64>,
    pub energy_reserve_wh: Option<f64>,
    pub consumable_budget: Option<f64>,
    pub consumable_reserve: Option<f64>,
    pub consumable_unit: Option<String>,
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct ScientificSite {
    pub id: String,
    pub position: LocalPoint,
    pub science_rationale: String,
    pub source_product_ids: Vec<String>,
    pub evidence_kind: EvidenceKind,
    pub activity_min_s: f64,
    pub activity_max_s: f64,
    pub preference_weight: f64, // user scenario preference, NOT NASA science truth
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub enum PlanStatus { FeasibleModeled, Infeasible, UnknownDataCoverage }
```

Use `Option` for unavailable numerical measurements; do not replace missing measurements with zero. Include dataset/checksum and model version in any full serialized `MissionScenario` and `MissionResult`. Use metric SI units internally and conversions only in presentation.

### 9.4 Tauri command contract

Start with these typed commands; use Rust async for I/O and offload CPU-heavy optimization to worker threads:

```text
list_datasets() -> DatasetSummary[]
open_dataset(dataset_id) -> DatasetHandle + ProvenanceSummary
inspect_map_point(dataset_id, local_x_m, local_y_m) -> PointInspection
list_science_sites(dataset_id) -> ScientificSite[]
validate_scenario(scenario) -> ValidationReport
solve_mission(scenario, solver_config) -> JobId
get_job_status(job_id) -> JobStatus
cancel_job(job_id) -> Result
compare_plans(run_ids[]) -> ComparisonReport
export_mission_report(run_id, path) -> Result
run_benchmark(benchmark_config) -> JobId
```

Emit structured progress events with cancellation and final status. Never freeze the frontend during optimization. Avoid broad filesystem permissions; restrict dataset selection/import and output paths, validate input files and sizes, and avoid unbounded memory allocations.

### 9.5 Reproducibility and error handling

- Repeated runs with the same seed, solver version, dataset hash and scenario must be reproducible within documented platform tolerances.
- Errors must identify failures such as `UnsupportedProjection`, `MissingNoDataMetadata`, `InvalidResourceBudget`, `RouteCrossesUnknownTerrain`, `DataAlignmentFailure`, `OptimizerMissingOriginalDefinition`.
- Persist a run as `scenario.json`, `result.json`, `manifest.json`, `environment.json`, `convergence.csv` and optional map snapshot.
- Expose a read-only provenance chain from result → route/site → raster/product ID → archive URL.

---

## 10. Benchmark design and scientific validation requirements

**Build the experiment harness before claiming algorithm performance.**

### 10.1 Baselines — compare equivalent problems

| Level | Comparison | Proper interpretation |
|---|---|---|
| Routing only | Dijkstra vs A* | Checks path correctness and efficiency under the *same edge costs* |
| Small mission-selection cases | Exhaustive enumeration / MILP / CP-SAT vs greedy | Establishes optimality gaps / feasible scheduling quality |
| Continuous fixed-itinerary optimization | DE vs CMA-ES vs authentic HyDE vs simple local search | Tests the algorithm on a problem aligned with its continuous design |
| Mixed selection/scheduling (optional) | Greedy, orienteering heuristic, CP-SAT/MILP if applicable, decoded DE/HyDE | Tests overall mission utility; avoid direct A* as full-mission baseline |

### 10.2 Metrics

**Primary:** fraction of solutions satisfying *all* hard constraints; science utility of feasible plans; objective optimality gap on known-optimum small instances; total runtime to reach a target feasible utility; remaining reserves on return.

**Secondary:** route distance, ascent, estimated traversal time, modeled hazard exposure, sensitivity to uncertainty, evaluations, best-so-far curves, CPU, peak memory, preprocessing time, cache-hit counts, and reproducibility.

**Important:** Present optimization utility as **modeled preference value** (unless independently calibrated), not as a scientifically measured discovery outcome.

### 10.3 Test scenarios

1. **Synthetic unit fixture:** flat grid, 1 science site, obvious out-and-back route, known optimum.
2. **Synthetic trap fixture:** shorter path crosses high-cost/blocked cell; route should avoid it.
3. **Resource-binding fixture:** high-science site unreachable within reserve; solver must exclude it.
4. **Unknown-data fixture:** no-data terrain barrier; solver must report unavailable route.
5. **Small exhaustive fixture:** 3–6 sites with analytically/algorithmically known optimum.
6. **Real-data Jezero site scenario:** at least 3 NASA-provenance science-context or user-curated targets within verified DTM coverage.
7. **Sensitivity fixture:** vary traversal speed/consumption by ±10–30% **as a hypothetical stress test**, not an empirical confidence interval.
8. **Scalability fixture:** increase candidate sites and waypoints; report runtime and budget trends.

For statistical comparison, target **at least 20–30 reproducible independent seeds per stochastic method** and a documented set of multiple scenario instances when practical. These are proposed experiment design targets, **not NASA challenge rules**. Where hackathon time is tight, run fewer experiments, disclose the sample size, and avoid significance claims.

### 10.4 Pass/fail acceptance criteria

**Data integrity — must pass**

- [ ] At least one numeric Mars DTM from a documented NASA/USGS product is successfully read and sampled; **no synthetic elevation is used in real-data mode**.
- [ ] Image and DTM georeferencing validated: a documented test point maps to a matching location within **one output grid cell or a justified registration tolerance**; record empirical offset where known.
- [ ] Raster min/max, cell spacing, no-data handling and units match source metadata or a trusted independent GIS tool on sample points.
- [ ] Every displayed data layer has source ID, citation, resolution and coverage; unknown cells are visually distinct.

**Planning — must pass**

- [ ] All feasible plans begin/end at base and contain valid routes between successive sites.
- [ ] Every budget includes outbound, task and return costs; reserves enforced.
- [ ] Planning fails safely on impossible resource budgets, isolated sites, negative inputs and incomplete data.
- [ ] Deterministic seed + inputs reproduce deterministic baseline and stable stochastic runs.
- [ ] Exported report exactly matches rendered plan metrics to within documented float tolerance.

**Algorithm validation — must pass before claiming HyDE**

- [ ] Original HyDE source/pseudocode obtained and versioned; source is cited.
- [ ] Implementation matches original equations, state transitions, restart schedule and stopping rules.
- [ ] Original benchmark functions or known test cases reproduced to the extent necessary for a credible port; discrepancies explained.
- [ ] Same budget/constraints for competitors; no hidden extra tuning or dataset-specific advantages.
- [ ] Headless benchmark produces raw outputs, convergence histories and aggregate statistics.

**Product usability — must pass**

- [ ] Map first, compact UI; one example scenario can be planned from app launch without reading instructions.
- [ ] Clear `DATA VERIFIED` vs `SIMULATION / ASSUMPTION` status.
- [ ] User can inspect relevant data and resource assumptions; explanations are concise but discoverable.
- [ ] App launches without Python or GIS software installed at runtime when using the packaged dataset.
- [ ] Build/test instructions work on a clean supported OS environment; unsupported OS stated.

### 10.5 Formal validation artifact

For each release produce `validation_report.md` with:

```text
Release / git commit / UTC date
Dataset titles, product IDs, source URLs, hashes, original/derived extents
Projection + vertical datum + output cell size + sample georeferencing checks
Mission scenario and model coefficients (with observed/modeled provenance)
Algorithm exact implementation status and versions
Comparison problem definition, seeds, budgets, hardware, runtime accounting
Raw result file links + aggregate metrics + uncertainty/sensitivity results
Failed cases and known limitations
What claims the evidence supports, and explicitly what it does NOT support
```

---

## 11. Development plan, prioritized

### Phase 0 — evidence and scaffolding (P0)

- [ ] Confirm full official Challenge #11 text and assessment/submission requirements.
- [ ] Initialize Tauri v2 / Rust core / React + TS with strict typing and tests.
- [ ] Obtain one **real Jezero DTM** (the verified HiRISE product above is one candidate), record manifest, crop to a real covered region.
- [ ] Convert/project and verify a numeric elevation tile plus matching real imagery.
- [ ] Deliver first screenshot of the **actual Mars-derived** map and inspection readout.

**Gate:** No map or launch screen says NASA-data-backed before this phase passes.

### Phase 1 — correct decision-support MVP (P0)

- [ ] Implement local raster inspection and elevation/slope/unknown overlays.
- [ ] Add 3–8 traceable target locations (or explicitly `USER_DEFINED` candidate locations) and a base.
- [ ] Implement graph-based terrain-aware A* leg routing and round-trip route validation.
- [ ] Implement deterministic feasible greedy itinerary, resources and reserves.
- [ ] Implement clean map-first mission UI, short itinerary and JSON report.
- [ ] Add unit/integration tests covering coordinate conversion, no-data, return trip and resource accounting.

**Gate:** One complete, feasible real-terrain scenario and one correctly explained infeasible scenario.

### Phase 2 — optimization research (P1)

- [ ] Define exact math problem, hard constraints and science-preference function in `SCIENTIFIC_METHOD.md`.
- [ ] Implement small-instance exhaustive or optimization-solver baseline for site selection/order.
- [ ] Port original HyDE **only with authentic study specification**; validate reproduction.
- [ ] Compare identical continuous fixed-itinerary problems with standalone DE/CMA-ES/local-search; report runtime/evaluation budget.
- [ ] Optionally implement mixed-variable priority-key decoder as an **explicit experiment**.
- [ ] Build deterministic benchmark CLI and export raw results/convergence curves.

**Gate:** A reproducible evaluation supports every stated algorithm performance claim.

### Phase 3 — credibility and demo polish (P1)

- [ ] Add third justified Mars dataset or science layer (e.g., CRISM), if aligned to ROI and time permits.
- [ ] Show layer coverage, source metadata and method assumptions on demand.
- [ ] Add sensitivity/reliability panel with modeled uncertainties and clear caveat.
- [ ] Create 60–90-second live demo/storyboard emphasizing NASA data → decision → trade-off, not algorithm jargon.
- [ ] Complete limitations, data credits, screenshots, builds and public repository setup.

### Phase 4 — future work (P2, not required for hackathon)

- [ ] Time-dependent mission conditions using scientifically supported models and timestamps.
- [ ] Full multi-objective Pareto front and interactive plan trade-off exploration.
- [ ] 3D elevation mesh / immersive astronaut-view map.
- [ ] Better terrain-hazard extraction with uncertainty calibration.
- [ ] Actual EVA metabolic/consumable parameter calibration with domain literature and expert review.
- [ ] More regions and scalable tile streaming.

**Do not let Phase 4 postpone a credible Phase 1.**

---

## 12. Common failure modes to prevent

| Failure | Why it is damaging | Required correction |
|---|---|---|
| Procedural terrain labeled “NASA map” | Misrepresents evidence | Synthetic watermark; switch to verified local DTM |
| Real imagery with fake hazard/slope overlay | Appearance implies unearned validity | Derive from georeferenced DTM; mark model assumptions |
| Static “science = 90/100” displayed as fact | Invented scientific value | Make preference user-defined, explain geological evidence |
| Radiation from Gale shown at Jezero as observed | Incorrect transfer across geography/time | Remove map layer or explicitly present hypothetical scenario |
| HyDE-style approximation called the original HyDE | False research reproduction | Require original algorithm spec + replication tests |
| Comparing A* to full HyDE itinerary and declaring a winner | Different mathematical problems | Match problem formulation and baselines |
| Fitness evaluations compared without costs | Computational comparison invalid | Wall-clock + precompute/cache costs + evals |
| Weighted penalty permits exhausted oxygen | Potentially misleading recommendation | Hard feasibility gate + reserves |
| Routes cross gaps in DTM coverage | Unsupported risk classification | Unknown/no-data mask, conservative block |
| Map uses Earth CRS or mismatched Mars lon conventions | Spatially wrong recommendations | Planetary CRS/metadata and sample alignment tests |
| Large text-heavy dashboard | Poor usability | Map-first compact controls, details on demand |
| Feature-complete UI with no real data | Challenge fit and credibility weak | Prioritize NASA data vertical slice |

---

## 13. Deliverables and definition of done

**Minimum handoff**

```text
[ ] Runnable Tauri desktop application with Rust scientific core
[ ] Small, verified, georeferenced real Mars elevation product plus real imagery
[ ] Dataset provenance manifest and correct source credits
[ ] Terrain/imagery/slope/unknown interactive layers
[ ] Science objective selection and scenario resource configuration
[ ] Feasible round-trip mission baseline and resource accounting
[ ] Clear solution/infeasibility UI and exported JSON report
[ ] Unit/integration tests and a reproducible one-command smoke test
[ ] LIMITATIONS.md and scientific-method notes
```

**Research-ready handoff adds**

```text
[ ] Exact thesis-faithful HyDE implementation with source/pseudocode linked
[ ] Standalone DE/CMA-ES reference solvers
[ ] Small exact solution and strong comparable mission-planning baseline
[ ] Benchmark CLI with repeated seeds, matched budgets, raw results and plots
[ ] Validation report separating observed data from assumptions and modeled outputs
```

**A complete project is *not* one with the most panels.** It is one in which the viewer can select a real Martian location, inspect its provenance, create a physically interpretable modeled mission, see meaningful constraints enforced, and independently reproduce the reported result.

---

## 14. Demonstration script and credible claims

**Demo story (under ~90 seconds):**

1. “This is a specific area of Jezero Crater. The imagery and terrain come from named NASA Mars mission products.” Show data product IDs and a slope/coverage overlay.
2. “We want to visit these science sites, but the expedition has an assumed 6-hour time allowance and limited equipment energy.” Show **scenario assumptions** rather than pretending these are flight-certified consumable budgets.
3. “Our baseline finds a round-trip plan and rejects activities or segments that violate constraints.” Click a blocked or impossible example.
4. “We can optionally optimize allocation/route parameters and compare its results against a fair baseline.” If original HyDE is not verified, say **experimental optimizer**.
5. “Here are the datasets, uncertainties, exact assumptions, seeds and benchmark results. This is a decision-support research prototype, not astronaut-certified navigation.”

**Permissible claims if supported by the app:**

- “We integrated archived NASA/USGS Mars imagery and topographic products for this specific region.”
- “We built a constraint-checked, modeled science excursion planner using georeferenced Mars terrain data.”
- “Our experiment observed [measured outcome] on [specific test instances/budgets] relative to [specified baseline].”

**Claims that require substantially more evidence and must NOT appear by default:**

- “Our system predicts astronaut survival,” “NASA uses our route,” “HyDE beats NASA,” “95% safe,” “real-time radiation map,” “fully NASA-verified resource usage,” or “quantum-powered.”

---

## 15. Source register (primary and supporting references)

These links support project context, **not** an assertion that their datasets have been installed. Actual local files, hashes and layer IDs still need verification.

**NASA Space Apps / official program**

1. NASA Space Apps 2026 — Martian Map challenge: https://www.spaceappschallenge.org/2026/challenges/interplanetary-survival-guide-martian-map/
2. NASA Space Apps 2026 — event and submission timing: https://www.spaceappschallenge.org/2026/
3. NASA's Space Apps 2026 overview: https://science.nasa.gov/universe/nasa-welcomes-all-ages-experience-levels-for-space-apps-challenge/

**NASA mission data and planetary cartography**

4. NASA Mars Trek WMTS / layer API: https://trek.nasa.gov/tiles/apidoc/trekAPI.html?body=mars
5. HiRISE Jezero DTM `DTEEC_023524_1985_023379_1985_U01`: https://hirise.lpl.arizona.edu/dtm/ESP_023524_1985
6. Alternative Jezero DTM `DTEEC_048842_1985_048908_1985_U01`: https://hirise.lpl.arizona.edu/dtm/ESP_048842_1985
7. HiRISE DTM scientific overview: https://hirise.lpl.arizona.edu/dtm/about.php
8. NASA PDS Geosciences MOLA MEGDR (maintained PDS4 archive): https://pds-geosciences.wustl.edu/missions/mgs/megdr.html
9. PDS CRISM MTRDR bundle: https://pds.nasa.gov/ds-view/pds/viewBundle.jsp?identifier=urn%3Anasa%3Apds%3Amro_crism_mtrdr&version=1.0
10. Mars 2020 Jezero TRN HiRISE terrain mosaic: https://doi.org/10.5066/P9REJ9JN
11. USGS Mars coordinate conventions: https://planetarynames.wr.usgs.gov/TargetCoordinates
12. USGS projection and planetary GIS guidance: https://astrogeology.usgs.gov/docs/concepts/camera-geometry-and-projections/learning-about-map-projections/
13. NASA/JPL Mars Trek explanatory page: https://trek.nasa.gov/mars/jpl/config/textAbout.html
14. NASA Curiosity RAD context: https://science.nasa.gov/mission/msl-curiosity/science-instruments/

**Prior mission-planning research and limitations**

15. Kim et al., **A Consolidated Tool for Planning and Analyzing Simulated Exploration Traverses and Associated Metabolic Workload**, NASA NTRS (2024/2025 records): https://ntrs.nasa.gov/citations/20250006519
16. Jezero DTM research and registration discussion, *Earth and Space Science* (2023), DOI 10.1029/2023EA003045: https://doi.org/10.1029/2023EA003045

**Research-team source required before authentic HyDE port**

17. **The user's original HyDE thesis/paper, pseudocode and working source implementation — NOT PROVIDED IN THIS BRIEF.** Obtain these directly from the team. Do not substitute assumptions from the algorithm name.

---

## 16. Agent completion report format

At the end of each implementation phase, report only:

```markdown
## Implemented
- What works and how to run it

## Real NASA data in use
- Product ID / source URL / local file / hash / coordinate system

## Verified
- Commands executed and actual test results

## Research status
- Which algorithms are authentic, which are approximations, baselines and metrics

## Limitations
- Specific unsupported data, models, safety claims or broken behavior

## Next highest-priority task
- One concrete action
```

**Final directive:** Optimize for **scientific honesty + functional Mars data integration + reproducible decision support**. Never replace missing evidence with attractive visualizations, invented scores, or a claim that HyDE has solved a problem it has not yet been tested on.
