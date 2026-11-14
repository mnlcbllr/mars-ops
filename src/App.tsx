import { useEffect, useMemo, useRef, useState } from "react";
import { MapView } from "@/components/MapView";
import { Terrain3D } from "@/components/Terrain3D";
import { Button } from "@/components/ui/button";
import { api, errorText } from "@/lib/api";
import { fmt, latLon } from "@/lib/format";
import { ELEVATION_RAMP, elevationRgba, hazardRgba, rampLut } from "@/lib/layers";
import { markersFor } from "@/lib/markers";
import type { DatasetInfo, LocalPoint, MissionScenario, PointInspection } from "@/lib/types";

interface Workspace {
  info: DatasetInfo;
  scenario: MissionScenario;
  elevation: Float32Array;
  imagery: HTMLCanvasElement;
  heights: HTMLCanvasElement;
  hazards: HTMLCanvasElement;
}

function canvas(width: number, height: number) {
  const image = document.createElement("canvas");
  image.width = width;
  image.height = height;
  const context = image.getContext("2d");
  if (!context) throw new Error("The map could not start: a 2D canvas is unavailable.");
  return { image, context };
}

function rasterImage(data: Uint8ClampedArray<ArrayBuffer>, width: number, height: number) {
  const { image, context } = canvas(width, height);
  context.putImageData(new ImageData(data, width, height), 0, 0);
  return image;
}

function raster(bytes: ArrayBuffer, width: number, height: number) {
  if (bytes.byteLength !== width * height * 4) throw new Error("The dataset raster has unexpected dimensions.");
  const values = new Float32Array(width * height);
  const view = new DataView(bytes);
  for (let i = 0; i < values.length; i++) values[i] = view.getFloat32(i * 4, true);
  return values;
}

async function loadWorkspace(): Promise<Workspace> {
  const datasets = await api.listDatasets();
  const dataset = datasets[0];
  if (!dataset) throw new Error("No bundled datasets found. Check the app's datasets resource directory.");
  const info = await api.openDataset(dataset.dataset_id);
  const [scenario, elevationBytes, slopeBytes, imageryBytes] = await Promise.all([
    api.defaultScenario(), api.layer("elevation"), api.layer("slope"), api.layer("imagery"),
  ]);
  const geo = info.manifest.georeference;
  const grid = info.planning_grid;
  const elevation = raster(elevationBytes, geo.width, geo.height);
  const slope = raster(slopeBytes, grid.width, grid.height);
  const hazard = hazardRgba(slope, grid.width, grid.height, scenario.model.max_slope_deg.value, 4);
  const heights = rasterImage(
    elevationRgba(elevation, info.elevation_min_m ?? 0, info.elevation_max_m ?? 0, rampLut(ELEVATION_RAMP)),
    geo.width, geo.height,
  );
  const source = new Image();
  const url = URL.createObjectURL(new Blob([imageryBytes], { type: "image/png" }));
  let imagery: HTMLCanvasElement;
  try {
    source.src = url;
    await source.decode();
    const target = canvas(source.naturalWidth, source.naturalHeight);
    target.context.drawImage(source, 0, 0);
    imagery = target.image;
  } finally {
    URL.revokeObjectURL(url);
  }
  return { info, scenario, elevation, imagery, heights, hazards: rasterImage(hazard.data, hazard.width, hazard.height) };
}

export function App() {
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [layer, setLayer] = useState<"imagery" | "heights">("imagery");
  const [view, setView] = useState<"2d" | "3d">("2d");
  const [showHazards, setShowHazards] = useState(true);
  const [inspected, setInspected] = useState<PointInspection | null>(null);
  // StrictMode replays effects; opening twice would race the shared backend session.
  const loading = useRef<Promise<Workspace> | null>(null);
  const inspection = useRef(0);

  useEffect(() => {
    let active = true;
    loading.current ??= loadWorkspace();
    loading.current.then(
      (loaded) => { if (active) setWorkspace(loaded); },
      (failure) => { if (active) setError(errorText(failure)); },
    );
    return () => { active = false; };
  }, [attempt]);

  const texture = useMemo(() => {
    if (!workspace) return null;
    const base = workspace[layer];
    if (!showHazards) return base;
    const { image, context } = canvas(base.width, base.height);
    context.drawImage(base, 0, 0);
    context.drawImage(workspace.hazards, 0, 0, base.width, base.height);
    return image;
  }, [workspace, layer, showHazards]);

  const markers = useMemo(() => workspace
    ? markersFor(workspace.scenario, new Set(workspace.scenario.sites.map((site) => site.id)), null)
    : [], [workspace]);

  const pick = async (point: LocalPoint) => {
    if (!workspace) return;
    const request = ++inspection.current;
    try {
      const result = await api.inspect(point, workspace.scenario.model.max_slope_deg.value);
      if (request === inspection.current) { setInspected(result); setError(null); }
    } catch (failure) {
      if (request === inspection.current) setError(errorText(failure));
    }
  };

  const geo = workspace?.info.manifest.georeference;

  return (
    <main className="flex h-full flex-col bg-background text-foreground">
      <header className="flex min-h-14 items-center gap-4 border-b px-5">
        <h1 className="text-lg font-semibold tracking-widest">ARES</h1>
        <span className="text-sm text-muted-foreground">{workspace?.info.manifest.display_name ?? "Mars excursion planner"}</span>
        <span className="ml-auto text-xs text-muted-foreground">Research prototype · not flight software</span>
      </header>
      {!workspace ? (
        <section className="grid flex-1 place-content-center gap-4 p-8 text-center">
          {error ? <>
            <h2 className="font-medium">Could not open the map</h2>
            <p role="alert" className="max-w-lg text-sm text-muted-foreground">{error}</p>
            <Button onClick={() => { loading.current = null; setError(null); setAttempt((n) => n + 1); }}>Retry</Button>
          </> : <p role="status">Loading bundled Mars dataset…</p>}
        </section>
      ) : <>
        <nav aria-label="Map controls" className="flex items-center gap-2 border-b px-5 py-2">
          <Button size="sm" variant={layer === "imagery" ? "secondary" : "ghost"} aria-pressed={layer === "imagery"} onClick={() => setLayer("imagery")}>Imagery</Button>
          <Button size="sm" variant={layer === "heights" ? "secondary" : "ghost"} aria-pressed={layer === "heights"} onClick={() => setLayer("heights")}>Elevation</Button>
          <label className="ml-3 flex items-center gap-2 text-sm"><input type="checkbox" checked={showHazards} onChange={(event) => setShowHazards(event.target.checked)} />Slope / unknown</label>
          <div className="ml-auto flex gap-1">
            <Button size="sm" variant={view === "2d" ? "secondary" : "ghost"} aria-pressed={view === "2d"} onClick={() => setView("2d")}>2D</Button>
            <Button size="sm" variant={view === "3d" ? "secondary" : "ghost"} aria-pressed={view === "3d"} onClick={() => setView("3d")}>3D</Button>
          </div>
        </nav>
        {error && <p role="alert" className="border-b px-5 py-2 text-sm">{error}</p>}
        <div className="flex min-h-0 flex-1">
          <section aria-label="Terrain map" className="relative min-w-0 flex-1">
            {texture && geo && (view === "2d" ? <MapView
              extent={{ width: geo.width * geo.cell_size_x_m, height: geo.height * geo.cell_size_y_m }}
              base={texture} hazard={null} markers={markers} legs={[]} selectedLeg={null}
              inspected={inspected?.local ?? null} placingBase={false} onPick={pick} onSelectLeg={() => {}}
            /> : <Terrain3D
              elevation={workspace.elevation} width={geo.width} height={geo.height}
              dx={geo.cell_size_x_m} dy={geo.cell_size_y_m} step={4} texture={texture}
              lit={layer === "heights"} exaggeration={1} markers={markers} legs={[]} selectedLeg={null}
              inspected={inspected} placingBase={false} resetSignal={0} onPick={pick} onMesh={() => {}}
            />)}
          </section>
          <aside aria-label="Map information" className="w-72 shrink-0 space-y-5 overflow-y-auto border-l p-4 text-sm">
            <div><h2 className="font-medium">{workspace.info.manifest.region_name}</h2>
              <p className="mt-1 text-muted-foreground">{workspace.info.real_data_verified ? "Verified source data" : "Source data not verified"}</p>
              <p className="text-muted-foreground">{fmt(geo?.cell_size_x_m, 1)} m raster · {fmt(workspace.info.planning_grid.cell_x_m)} m planning cells</p>
            </div>
            <div><h2 className="font-medium">Map key</h2><ul className="mt-2 space-y-1 text-muted-foreground">
              <li>Square B — scenario base</li><li>Rings — candidate sites (user-defined)</li>
              {showHazards && <><li>Orange / hatching — above {workspace.scenario.model.max_slope_deg.value}° slope limit</li><li>Dark \\ hatching — unknown terrain</li></>}
              {layer === "heights" && <li>Blue: dark = {fmt(workspace.info.elevation_min_m)} m; light = {fmt(workspace.info.elevation_max_m)} m</li>}
            </ul></div>
            <div><h2 className="font-medium">Inspect terrain</h2>{inspected ? <dl className="mt-2 space-y-1 text-muted-foreground">
              <dt>Location</dt><dd>{latLon(inspected.latlon)}</dd>
              <dt>Elevation / slope</dt><dd>{fmt(inspected.elevation_m, 1)} m / {fmt(inspected.slope_deg, 1)}°</dd>
              <dt>Modeled traversability</dt><dd>{inspected.terrain.replaceAll("_", " ").toLowerCase()}</dd>
            </dl> : <p className="mt-2 text-muted-foreground">Click the map to read elevation, slope and coverage.</p>}</div>
            <details><summary className="cursor-pointer font-medium">Data sources</summary>
              {workspace.info.manifest.layers.map((source) => <div key={source.id} className="mt-3 break-words text-xs text-muted-foreground">
                <p>{source.instrument} · {source.origin_type}</p><p>{source.product_id}</p><p>{source.license_and_credit}</p>
              </div>)}
            </details>
            <p className="text-xs text-muted-foreground">Slope limits and candidate sites are scenario assumptions. Orbital data cannot establish astronaut safety.</p>
          </aside>
        </div>
      </>}
    </main>
  );
}
