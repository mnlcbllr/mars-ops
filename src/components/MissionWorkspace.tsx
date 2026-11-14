import { useEffect, useMemo, useRef, useState } from "react";
import { MissionResults } from "@/components/MissionResults";
import { ScenarioEditor } from "@/components/ScenarioEditor";
import { SimulationPanel } from "@/components/SimulationPanel";
import { Terrain3D } from "@/components/Terrain3D";
import { Button } from "@/components/ui/button";
import { api, errorText } from "@/lib/api";
import { fmt, latLon } from "@/lib/format";
import { hazardRgba } from "@/lib/layers";
import { markersFor } from "@/lib/markers";
import { addedSite, useMission } from "@/lib/mission";
import type { CellRef, LocalPoint, MissionScenario, PointInspection } from "@/lib/types";
import { canvas, rasterImage, type Workspace } from "@/lib/workspace";

export function MissionWorkspace({ workspace }: { workspace: Workspace }) {
  const mission = useMission(workspace.scenario);
  const { state } = mission;
  const { scenario, run, phase } = state;
  const sim = state.simulation?.mission;
  const [preview, setPreview] = useState<CellRef[]>([]);
  const [exact, setExact] = useState(false);
  const [layer, setLayer] = useState<"imagery" | "heights" | "infrared">("imagery");
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
    const base = workspace[layer] ?? workspace.imagery;
    if (!hazards && !sim && !preview.length) return base;
    const { image, context } = canvas(base.width, base.height);
    context.drawImage(base, 0, 0);
    if (hazards) context.drawImage(hazards, 0, 0, base.width, base.height);
    const scaleX = base.width / grid.width;
    const scaleY = base.height / grid.height;
    if (sim) {
      context.fillStyle = "rgba(230,70,35,0.85)";
      for (const e of sim.events) if (e.kind === "BLOCK_CELLS") for (const cell of e.cells) {
        context.fillRect(cell.col * scaleX, cell.row * scaleY, scaleX, scaleY);
        context.strokeStyle = "#151515"; context.beginPath();
        context.moveTo(cell.col * scaleX, cell.row * scaleY);
        context.lineTo((cell.col + 1) * scaleX, (cell.row + 1) * scaleY); context.stroke();
      }
    }
    context.strokeStyle = "#fff4aa"; context.lineWidth = 1;
    for (const cell of preview) context.strokeRect(cell.col * scaleX, cell.row * scaleY, scaleX, scaleY);
    return image;
  }, [workspace, layer, hazards, sim, preview, grid.width, grid.height]);

  const markers = useMemo(() => markersFor(scenario, sim?.plan ?? result)
    .filter((marker) => Number.isFinite(marker.x_m) && Number.isFinite(marker.y_m))
    .map((marker) => sim?.completed.includes(marker.id) ? { ...marker, kind: "visited" as const, glyph: "✓", label: `${marker.id} completed` } : marker), [scenario, result, sim]);

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
      if (busy || sim) return;
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
    void mission.run(exact);
  };

  return <main className="flex h-full flex-col bg-background text-foreground">
    <header className="flex min-h-14 shrink-0 items-center gap-4 border-b px-5">
      <h1 className="text-lg font-semibold tracking-widest">MARS-OPS</h1>
      <span className="min-w-0 truncate text-sm text-muted-foreground">{workspace.info.manifest.display_name}</span>
      <span className="shrink-0 rounded border px-2 py-1 text-xs">{workspace.info.real_data_verified ? "Data verified" : "Data unverified"}</span>
      <span className="ml-auto text-xs text-muted-foreground">Research prototype · not flight software</span>
      <Button type="button" variant="outline" size="sm" disabled={busy || !run} onClick={() => void mission.exportReport()}>
        {phase === "exporting" ? "Exporting…" : "Export JSON"}
      </Button>
      {!sim && <select aria-label="Mission solver" className="max-w-40 rounded border bg-background p-1 text-xs" disabled={busy} value={exact ? "exact" : "greedy"} onChange={(e) => setExact(e.target.value === "exact")}><option value="greedy">Greedy baseline</option><option value="exact">Fixed-duration optimizer</option></select>}
      {!sim && <Button size="sm" variant="outline" disabled={busy || result?.status !== "FEASIBLE_MODELED" || placingBase || placingSite} onClick={() => { inspection.current++; setPlacingBase(false); setPlacingSite(false); void mission.simulation(); }}>Start simulation</Button>}
      <Button form="mission-scenario" type="submit" size="sm" disabled={busy || !!sim || placingBase || placingSite}>
        {phase === "validating" ? "Validating…" : phase === "solving" ? "Planning…" : "Run mission"}
      </Button>
    </header>
    <div className="flex min-h-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
        <section aria-label="Terrain map" className="relative min-h-40 flex-1">
          <Terrain3D
            elevation={workspace.elevation} width={geo.width} height={geo.height}
            dx={geo.cell_size_x_m} dy={geo.cell_size_y_m} step={4} texture={texture}
            lit={layer === "heights"} exaggeration={1} markers={markers} legs={sim ? sim.plan_valid ? sim.plan.legs : [] : result?.legs ?? []} selectedLeg={sim ? null : selectedLeg}
            originalLegs={sim?.original_plan.legs} currentPosition={sim?.position}
            inspected={inspected} placing={placingBase || placingSite} resetSignal={0} onPick={pick} onMesh={() => {}}
          />
          {sim && <div role="status" className="pointer-events-none absolute bottom-20 left-3 rounded bg-background/85 px-3 py-2 text-xs shadow backdrop-blur-md">
            MODELED · {sim.completed.length} completed · {fmt(sim.used.eva_time_s / 60, 1)} min elapsed<br />
            Grey dashed: original · cyan: active · red ×: blocked · yellow outline: preview
          </div>}
          {/* HUD: status floats over the map, clear of the control cluster. */}
          <div className="pointer-events-none absolute left-1/2 top-14 z-10 flex w-[min(100%-1.5rem,28rem)] -translate-x-1/2 flex-col items-center gap-2">
            {(placingBase || placingSite) && <p role="status"
              className="rounded-md bg-background/85 px-3 py-1.5 text-center text-xs shadow backdrop-blur-md">
              {placingBase
                ? "Click known terrain to place the base. Use “Cancel base placement” to exit, or edit the coordinates by keyboard."
                : "Click known terrain to add a candidate site. Use “Cancel site placement” to exit, or edit the coordinates by keyboard afterwards."}
            </p>}
            {mapError && <p role="alert"
              className="rounded-md bg-background/85 px-3 py-1.5 text-center text-xs text-status-warning shadow backdrop-blur-md">{mapError}</p>}
          </div>
          <div role="group" aria-label="Map layers"
            className="pointer-events-auto absolute left-3 top-3 z-10 flex items-center gap-1 rounded-lg bg-background/80 p-1 shadow backdrop-blur-md">
            <Button size="sm" variant={layer === "imagery" ? "secondary" : "ghost"} aria-pressed={layer === "imagery"} onClick={() => setLayer("imagery")}>Imagery</Button>
            <Button size="sm" variant={layer === "heights" ? "secondary" : "ghost"} aria-pressed={layer === "heights"} onClick={() => setLayer("heights")}>Elevation</Button>
            {workspace.infrared && <Button size="sm" variant={layer === "infrared" ? "secondary" : "ghost"} aria-pressed={layer === "infrared"} onClick={() => setLayer("infrared")}>THEMIS · 100 m</Button>}
            <label className="ml-1 flex items-center gap-1.5 px-1.5 text-xs"><input type="checkbox" checked={showHazards} onChange={(event) => setShowHazards(event.target.checked)} />Hazards</label>
          </div>
          <div aria-live="polite" className="pointer-events-none absolute bottom-3 left-3 z-10 max-w-sm rounded-lg bg-background/85 px-3 py-2 text-xs shadow backdrop-blur-md">
            {inspected ? <><p>{latLon(inspected.latlon)}</p>
              <p>{fmt(inspected.elevation_m, 1)} m · {fmt(inspected.slope_deg, 1)}° · {inspected.terrain.replaceAll("_", " ").toLowerCase()}</p></>
              : <p>Click the map to inspect elevation, slope and coverage.</p>}
            {layer === "infrared" && <p>DERIVED · Odyssey infrared brightness, not temperature or hazards</p>}
          </div>
        </section>
        {!sim && <MissionResults state={state} selectedLeg={selectedLeg} onSelectLeg={selectLeg} />}
        {sim && state.error && <p role="alert" className="border-t p-3 text-xs text-status-critical">{state.error}</p>}
        {sim && state.exportPath && <p role="status" className="border-t p-3 text-xs">Exported: {state.exportPath}</p>}
      </div>
      <aside aria-label="Mission configuration" className="w-[360px] shrink-0 space-y-5 overflow-y-auto border-l p-4 text-sm">
        {sim ? <SimulationPanel mission={sim} busy={busy} picked={inspected?.local ?? null} onPreview={setPreview}
          onAction={(action) => { void mission.simulation(action); }} onReset={() => { setPreview([]); void mission.simulation("reset"); }} />
        : <ScenarioEditor state={state} placingBase={placingBase} placingSite={placingSite}
          datasetId={workspace.info.manifest.dataset_id}
          onChange={edit}
          onPlaceBase={() => togglePlacing("base")} onTogglePlaceSite={() => togglePlacing("site")}
          onDeleteSite={(id) => { inspection.current++; setMapError(null); mission.edit({
            ...scenario, sites: scenario.sites.filter((site) => site.id !== id),
          }); }}
          onSavePlan={() => { setMapError(null); void mission.savePlan(); }}
          onLoadPlan={(loaded) => { inspection.current++; setMapError(null); mission.edit(loaded); }}
          onRun={runMission} />}
        <details className="space-y-3 border-t pt-3">
          <summary className="cursor-pointer font-medium">Map key & data sources</summary>
          <p>{workspace.info.manifest.region_name}</p>
          <p className="text-xs text-muted-foreground">{workspace.info.real_data_verified ? "Verified source data" : "Source data not verified"} · {fmt(geo.cell_size_x_m, 1)} m raster · {fmt(grid.cell_x_m, 1)} m planning cells</p>
          <ul className="space-y-1 text-xs text-muted-foreground">
            <li>B square — base</li>
            <li>Rings — candidates · numbers — visit order · dashed — left out</li>
            <li>Pink line — planned route</li>
            {showHazards && <li>Orange — over the slope limit · dark hatch — unknown terrain</li>}
            {layer === "heights" && <li>Blue shading — low to high elevation</li>}
          </ul>
          {workspace.info.manifest.layers.map((source) => <div key={source.id} className="space-y-1 break-words text-xs text-muted-foreground">
            <p>{source.instrument} · {source.origin_type}</p><p>{source.product_id}</p><p>{source.observation_date}</p>
            <p>{source.license_and_credit}</p>
            <details><summary className="cursor-pointer">Coverage, processing & uncertainty</summary>
              <p>Source: {source.source_url}</p><p>SHA-256: {source.sha256_derived}</p>
              <p>Projected extent: {source.bbox_projected_m?.join(", ") ?? "unknown"}</p>
              {source.processing_steps.map((s, i) => <p key={i}>{s}</p>)}
              {source.quality_notes.map((s, i) => <p key={i}>{s}</p>)}
            </details>
          </div>)}
          <p className="text-xs text-muted-foreground">Archive only: CRISM spectral crop (not yet interpreted), global GMM-3 gravity (too coarse for local routing), MEDA sol 45 and PIXL sol 125 (no verified crop-local measurement positions). No radiation or weather hazard map.</p>
        </details>
        <p className="text-xs text-muted-foreground">Assumptions are user-defined. Orbital data cannot establish astronaut safety.</p>
      </aside>
    </div>
  </main>;
}
