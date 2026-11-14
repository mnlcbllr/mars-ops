import { useEffect, useMemo, useRef, useState } from "react";
import { MissionResults } from "@/components/MissionResults";
import { ScenarioEditor } from "@/components/ScenarioEditor";
import { Terrain3D } from "@/components/Terrain3D";
import { Button } from "@/components/ui/button";
import { api, errorText } from "@/lib/api";
import { fmt, latLon } from "@/lib/format";
import { hazardRgba } from "@/lib/layers";
import { markersFor } from "@/lib/markers";
import { addedSite, useMission } from "@/lib/mission";
import type { LocalPoint, MissionScenario, PointInspection } from "@/lib/types";
import { canvas, rasterImage, type Workspace } from "@/lib/workspace";

export function MissionWorkspace({ workspace }: { workspace: Workspace }) {
  const mission = useMission(workspace.scenario);
  const { state } = mission;
  const { scenario, run, phase } = state;
  const [layer, setLayer] = useState<"imagery" | "heights">("imagery");
  const [showHazards, setShowHazards] = useState(true);
  const [placingBase, setPlacingBase] = useState(false);
  const [placingSite, setPlacingSite] = useState(false);
  const [inspected, setInspected] = useState<PointInspection | null>(null);
  const [mapError, setMapError] = useState<string | null>(null);
  const [legSelection, setLegSelection] = useState<{ runId: number; index: number } | null>(null);
  const inspection = useRef(0);
  const busy = phase !== "idle";
  const result = run?.report.result ?? null;
  const selectedLeg = run && legSelection?.runId === run.run_id ? legSelection.index : null;
  const geo = workspace.info.manifest.georeference;
  const grid = workspace.info.planning_grid;
  const maxSlope = scenario.model.max_slope_deg.value;

  useEffect(() => () => { inspection.current++; }, []);

  const hazards = useMemo(() => {
    if (!showHazards || !Number.isFinite(maxSlope)) return null;
    const overlay = hazardRgba(workspace.slope, grid.width, grid.height, maxSlope, 4);
    return rasterImage(overlay.data, overlay.width, overlay.height);
  }, [workspace.slope, grid.width, grid.height, maxSlope, showHazards]);

  const texture = useMemo(() => {
    const base = workspace[layer];
    if (!hazards) return base;
    const { image, context } = canvas(base.width, base.height);
    context.drawImage(base, 0, 0);
    context.drawImage(hazards, 0, 0, base.width, base.height);
    return image;
  }, [workspace, layer, hazards]);

  const markers = useMemo(() => markersFor(scenario, result)
    .filter((marker) => Number.isFinite(marker.x_m) && Number.isFinite(marker.y_m)), [scenario, result]);

  const edit = (updated: MissionScenario) => {
    inspection.current++;
    setInspected(null);
    setMapError(null);
    mission.edit(updated);
  };

  /** Apply a terrain-checked point to a placement mode; false means it was rejected. */
  const place = (mode: "base" | "site", value: PointInspection): boolean => {
    if (value.terrain !== "TRAVERSABLE") {
      setMapError(mode === "base"
        ? "Choose a base inside known terrain and within the declared slope limit."
        : "Choose a candidate site inside known terrain and within the declared slope limit.");
      return false;
    }
    mission.edit(mode === "base" ? { ...scenario, base: value.local } : addedSite(scenario, value.local));
    return true;
  };

  const pick = async (point: LocalPoint) => {
    if (!Number.isFinite(maxSlope)) { setMapError("Enter a valid slope limit before inspecting terrain."); return; }
    const request = ++inspection.current;
    try {
      const value = await api.inspect(point, maxSlope);
      if (request !== inspection.current) return;
      setInspected(value);
      setMapError(null);
      if (busy) return;
      const mode = placingBase ? "base" : placingSite ? "site" : null;
      if (mode && place(mode, value)) {
        if (mode === "base") setPlacingBase(false); else setPlacingSite(false);
      }
    } catch (failure) {
      if (request === inspection.current) setMapError(errorText(failure));
    }
  };

  // The two placement modes are exclusive: starting one cancels the other.
  // The click before the button counts: when a mode is switched on, the most
  // recently inspected point is re-checked and placed immediately. A newer
  // map click or toggle supersedes it, so only one placement can ever happen.
  const togglePlacing = (mode: "base" | "site") => {
    const request = ++inspection.current;
    setMapError(null);
    const enabling = mode === "base" ? !placingBase : !placingSite;
    setPlacingBase(mode === "base" ? enabling : false);
    setPlacingSite(mode === "site" ? enabling : false);
    if (enabling && !busy && inspected && Number.isFinite(maxSlope)) {
      void api.inspect(inspected.local, maxSlope).then((value) => {
        if (request !== inspection.current) return;
        setInspected(value);
        if (place(mode, value)) {
          if (mode === "base") setPlacingBase(false); else setPlacingSite(false);
        }
      }, (failure) => { if (request === inspection.current) setMapError(errorText(failure)); });
    }
  };

  const selectLeg = (index: number | null) => setLegSelection(run && index !== null ? { runId: run.run_id, index } : null);
  const runMission = () => {
    if (placingBase || placingSite) { setMapError("Finish or cancel placement on the map before running the mission."); return; }
    inspection.current++;
    setMapError(null);
    void mission.run();
  };

  return <main className="flex h-full flex-col bg-background text-foreground">
    <header className="flex min-h-14 shrink-0 items-center gap-4 border-b px-5">
      <h1 className="text-lg font-semibold tracking-widest">HYDE</h1>
      <span className="min-w-0 truncate text-sm text-muted-foreground">{workspace.info.manifest.display_name}</span>
      <span className="shrink-0 rounded border px-2 py-1 text-xs">{workspace.info.real_data_verified ? "Data verified" : "Data unverified"}</span>
      <span className="ml-auto text-xs text-muted-foreground">Research prototype · not flight software</span>
      <Button type="button" variant="outline" size="sm" disabled={busy || !run} onClick={() => void mission.exportReport()}>
        {phase === "exporting" ? "Exporting…" : "Export JSON"}
      </Button>
      <Button form="mission-scenario" type="submit" size="sm" disabled={busy || placingBase}>
        {phase === "validating" ? "Validating…" : phase === "solving" ? "Planning…" : "Run mission"}
      </Button>
    </header>
    <div className="flex min-h-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
        <nav aria-label="Map controls" className="flex shrink-0 items-center gap-2 border-b px-4 py-2">
          <Button size="sm" variant={layer === "imagery" ? "secondary" : "ghost"} aria-pressed={layer === "imagery"} onClick={() => setLayer("imagery")}>Imagery</Button>
          <Button size="sm" variant={layer === "heights" ? "secondary" : "ghost"} aria-pressed={layer === "heights"} onClick={() => setLayer("heights")}>Elevation</Button>
          <label className="ml-3 flex items-center gap-2 text-sm"><input type="checkbox" checked={showHazards} onChange={(event) => setShowHazards(event.target.checked)} />Slope / unknown</label>
        </nav>
        {placingBase && <p role="status" className="border-b px-4 py-2 text-xs">Click known terrain to place the base. Use “Cancel base placement” to exit, or edit the coordinates by keyboard.</p>}
        {placingSite && <p role="status" className="border-b px-4 py-2 text-xs">Click known terrain to add a candidate site. Use “Cancel site placement” to exit, or edit the coordinates by keyboard afterwards.</p>}
        {mapError && <p role="alert" className="border-b px-4 py-2 text-xs">{mapError}</p>}
        <section aria-label="Terrain map" className="relative min-h-40 flex-1">
          <Terrain3D
            elevation={workspace.elevation} width={geo.width} height={geo.height}
            dx={geo.cell_size_x_m} dy={geo.cell_size_y_m} step={4} texture={texture}
            lit={layer === "heights"} exaggeration={1} markers={markers} legs={result?.legs ?? []} selectedLeg={selectedLeg}
            inspected={inspected} placing={placingBase || placingSite} resetSignal={0} onPick={pick} onMesh={() => {}}
          />
          <div aria-live="polite" className="pointer-events-none absolute bottom-3 left-3 max-w-sm rounded-lg bg-background/90 px-3 py-2 text-xs shadow">
            {inspected ? <><p>{latLon(inspected.latlon)}</p>
              <p>{fmt(inspected.elevation_m, 1)} m · {fmt(inspected.slope_deg, 1)}° · {inspected.terrain.replaceAll("_", " ").toLowerCase()}</p></>
              : <p>Click the map to inspect elevation, slope and coverage.</p>}
          </div>
        </section>
        <MissionResults state={state} selectedLeg={selectedLeg} onSelectLeg={selectLeg} />
      </div>
      <aside aria-label="Mission configuration" className="w-[360px] shrink-0 space-y-5 overflow-y-auto border-l p-4 text-sm">
        <ScenarioEditor state={state} placingBase={placingBase} placingSite={placingSite}
          datasetId={workspace.info.manifest.dataset_id}
          onChange={edit}
          onPlaceBase={() => togglePlacing("base")} onTogglePlaceSite={() => togglePlacing("site")}
          onDeleteSite={(id) => { inspection.current++; setMapError(null); mission.edit({
            ...scenario, sites: scenario.sites.filter((site) => site.id !== id),
          }); }}
          onSavePlan={() => { setMapError(null); void mission.savePlan(); }}
          onLoadPlan={(loaded) => { inspection.current++; setMapError(null); mission.edit(loaded); }}
          onRun={runMission} />
        <details className="space-y-3 border-t pt-3">
          <summary className="cursor-pointer font-medium">Map key & data sources</summary>
          <p>{workspace.info.manifest.region_name}</p>
          <p className="text-xs text-muted-foreground">{workspace.info.real_data_verified ? "Verified source data" : "Source data not verified"} · {fmt(geo.cell_size_x_m, 1)} m raster · {fmt(grid.cell_x_m, 1)} m planning cells</p>
          <ul className="space-y-1 text-xs text-muted-foreground">
            <li>Square B — scenario base</li>
            <li>Rings — candidate sites; numbered discs — visit order; dashed rings — sites the plan left out</li>
            <li>Pink line — planned round trip</li>
            {showHazards && <><li>Orange / hatching — above {fmt(maxSlope, 1)}° slope limit</li><li>Dark \\ hatching — unknown terrain</li></>}
            {layer === "heights" && <li>Blue: dark = {fmt(workspace.info.elevation_min_m)} m; light = {fmt(workspace.info.elevation_max_m)} m</li>}
          </ul>
          {workspace.info.manifest.layers.map((source) => <div key={source.id} className="space-y-1 break-words text-xs text-muted-foreground">
            <p>{source.instrument} · {source.origin_type}</p><p>{source.product_id}</p><p>{source.observation_date}</p>
            <p>{source.license_and_credit}</p>
          </div>)}
        </details>
        <p className="text-xs text-muted-foreground">Slope limits, resource rates and candidate sites are scenario assumptions. Orbital data cannot establish astronaut safety.</p>
      </aside>
    </div>
  </main>;
}
