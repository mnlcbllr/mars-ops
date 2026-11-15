import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { ContextMenu } from "@base-ui/react/context-menu";
import { MissionResults } from "@/components/MissionResults";
import { ScenarioEditor } from "@/components/ScenarioEditor";
import { SimulationPanel } from "@/components/SimulationPanel";
import { Terrain3D } from "@/components/Terrain3D";
import { Button } from "@/components/ui/button";
import { api, errorText } from "@/lib/api";
import { fmt, latLon, minutes } from "@/lib/format";
import { blockedRgba, hazardRgba } from "@/lib/layers";
import { markersFor, type Marker } from "@/lib/markers";
import { mapShortcut, type PlacementMode } from "@/lib/mapInteraction";
import { addedSite, useMission } from "@/lib/mission";
import type { LocalPoint, MissionScenario, PlannedLeg, PointInspection } from "@/lib/types";

/** Results panel geometry: nav bar + minimum map area kept visible above it. */
const RESULTS_DEFAULT = 360;
const RESULTS_MIN = 140;
const MAP_KEEP = 260;
import { canvas, rasterImage, type Workspace } from "@/lib/workspace";

// Stable identities: new array literals here would rebuild the 3D overlay every render (visible blink).
const NO_LEGS: PlannedLeg[] = [];

export function MissionWorkspace({ workspace }: { workspace: Workspace }) {
  const mission = useMission(workspace.scenario);
  const { state } = mission;
  const { scenario, run, phase } = state;
  const [layer, setLayer] = useState<"imagery" | "heights" | "infrared">("imagery");
  const [showHazards, setShowHazards] = useState(true);
  const [placingBase, setPlacingBase] = useState(false);
  const [placingSite, setPlacingSite] = useState(false);
  const [contextPoint, setContextPoint] = useState<LocalPoint | null>(null);
  const [contextSiteId, setContextSiteId] = useState<string | null>(null);
  const [resultsHeight, setResultsHeight] = useState(RESULTS_DEFAULT);
  const rowRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<HTMLElement>(null);
  const [pickingBlock, setPickingBlock] = useState(false);
  const [blockCenter, setBlockCenter] = useState<LocalPoint | null>(null);
  const [blockRadius, setBlockRadius] = useState(40);
  const [inspected, setInspected] = useState<PointInspection | null>(null);
  const [mapError, setMapError] = useState<string | null>(null);
  const [legSelection, setLegSelection] = useState<{ runId: number; index: number } | null>(null);
  const [preview, setPreview] = useState<{ point: LocalPoint; label: string; siteId: string } | null>(null);
  const [viewReset, setViewReset] = useState(0);
  const [scrubS, setScrubS] = useState<number | null>(null);
  const [scrubbing, setScrubbing] = useState(false);
  const scrubSeek = useRef<{ timer: number; last: number | null; pending: number | null }>({ timer: 0, last: null, pending: null });
  const inspection = useRef(0);
  const busy = phase !== "idle" || state.simulationBusy;
  const simulation = state.simulation;
  const editingLocked = simulation !== null || state.simulationBusy;
  const result = run?.report.result ?? null;
  const selectedLeg = run && legSelection?.runId === run.run_id ? legSelection.index : null;
  const geo = workspace.info.manifest.georeference;
  const grid = workspace.info.planning_grid;
  const maxSlope = scenario.model.max_slope_deg.value;

  useEffect(() => () => { inspection.current++; }, []);
  // Discard terrain checks started before an edit, solve or simulation lock.
  useEffect(() => { inspection.current++; }, [scenario, busy, editingLocked]);

  const hazards = useMemo(() => {
    if (!showHazards || !Number.isFinite(maxSlope)) return null;
    const overlay = hazardRgba(workspace.slope, grid.width, grid.height, maxSlope, 4);
    return rasterImage(overlay.data, overlay.width, overlay.height);
  }, [workspace.slope, grid.width, grid.height, maxSlope, showHazards]);

  const blocked = simulation?.state.blocked;
  const blockedOverlay = useMemo(() => {
    if (!blocked || blocked.cells.length === 0) return null;
    const overlay = blockedRgba(blocked, grid.raster_cells_per_planning_cell);
    return rasterImage(overlay.data, overlay.width, overlay.height);
  }, [blocked, grid.raster_cells_per_planning_cell]);

  const texture = useMemo(() => {
    const base = workspace[layer] ?? workspace.imagery;
    if (!hazards && !blockedOverlay) return base;
    const { image, context } = canvas(base.width, base.height);
    context.drawImage(base, 0, 0);
    if (hazards) context.drawImage(hazards, 0, 0, base.width, base.height);
    if (blockedOverlay) context.drawImage(blockedOverlay, 0, 0, base.width, base.height);
    return image;
  }, [workspace, layer, hazards, blockedOverlay]);

  const shownScenario = simulation?.state.scenario ?? scenario;
  const shownPlan = simulation
    ? simulation.state.plan.status === "FEASIBLE_MODELED" ? simulation.state.plan : simulation.state.initial_plan
    : result;
  // The results panel only earns its space once it has content: a run, an
  // in-flight phase, an error, an export or validation issues.
  const showResults = state.run !== null || state.phase !== "idle" || state.error !== null
    || state.exportPath !== null || (state.validation !== null && !state.validation.ok);
  const markers = useMemo(() => {
    const base = markersFor(shownScenario, shownPlan, simulation?.state.completed_sites ?? [])
      .filter((marker) => Number.isFinite(marker.x_m) && Number.isFinite(marker.y_m));
    // Transient crosshair at the right-click point while the context menu is open.
    const target: Marker | null = contextPoint && Number.isFinite(contextPoint.x_m) && Number.isFinite(contextPoint.y_m)
      ? { kind: "target", id: "target", x_m: contextPoint.x_m, y_m: contextPoint.y_m, glyph: "", label: "" }
      : null;
    return target ? [...base, target] : base;
  }, [shownScenario, shownPlan, simulation?.state.completed_sites, contextPoint]);
  const pov = useMemo(() => preview ? { point: preview.point, label: preview.label } : null, [preview]);
  const blockPreview = useMemo(() => pickingBlock && blockCenter ? { center: blockCenter, radius_m: blockRadius } : null,
    [pickingBlock, blockCenter, blockRadius]);

  const edit = (updated: MissionScenario) => {
    if (busy) return;
    if (editingLocked) { setMapError("Reset the simulation before editing the scenario."); return; }
    inspection.current++;
    setInspected(null);
    setMapError(null);
    mission.edit(updated);
  };

  /** Remove a candidate site; the map right-click menu is the only delete affordance. */
  const deleteSite = (id: string) => {
    edit({ ...scenario, sites: scenario.sites.filter((site) => site.id !== id) });
  };

  /** Apply a terrain-checked point to a placement mode; false means it was rejected. */
  const place = (mode: PlacementMode, value: PointInspection): boolean => {
    if (busy || editingLocked) return false;
    if (value.terrain !== "TRAVERSABLE") {
      setMapError(mode === "base"
        ? "Choose a base inside known terrain and within the declared slope limit."
        : "Choose a candidate site inside known terrain and within the declared slope limit.");
      return false;
    }
    edit(mode === "base" ? { ...scenario, base: value.local } : addedSite(scenario, value.local));
    return true;
  };

  const pick = async (point: LocalPoint) => {
    if (pickingBlock) {
      setBlockCenter(point);
      setPickingBlock(false);
      setMapError(null);
      return;
    }
    if (!Number.isFinite(maxSlope)) { setMapError("Enter a valid slope limit before inspecting terrain."); return; }
    const request = ++inspection.current;
    try {
      const value = await api.inspect(point, maxSlope);
      if (request !== inspection.current) return;
      setInspected(value);
      setMapError(null);
      if (busy || editingLocked) return;
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
  const togglePlacing = (mode: PlacementMode, useInspected = true) => {
    if (busy) return;
    if (editingLocked) { setMapError("Reset the simulation before editing the scenario."); return; }
    setPickingBlock(false);
    const request = ++inspection.current;
    setMapError(null);
    const enabling = mode === "base" ? !placingBase : !placingSite;
    setPlacingBase(mode === "base" ? enabling : false);
    setPlacingSite(mode === "site" ? enabling : false);
    if (enabling && useInspected && inspected && Number.isFinite(maxSlope)) {
      void api.inspect(inspected.local, maxSlope).then((value) => {
        if (request !== inspection.current) return;
        setInspected(value);
        if (place(mode, value)) {
          if (mode === "base") setPlacingBase(false); else setPlacingSite(false);
        }
      }, (failure) => { if (request === inspection.current) setMapError(errorText(failure)); });
    }
  };

  const cancelPlacement = () => {
    inspection.current++;
    setPlacingBase(false);
    setPlacingSite(false);
    setPickingBlock(false);
    setMapError(null);
  };

  const placeAtContext = async (mode: PlacementMode) => {
    if (!contextPoint || busy || editingLocked) return;
    cancelPlacement();
    mapRef.current?.focus({ preventScroll: true });
    if (!Number.isFinite(maxSlope)) { setMapError("Enter a valid slope limit before placing a point."); return; }
    const request = ++inspection.current;
    try {
      const value = await api.inspect(contextPoint, maxSlope);
      if (request !== inspection.current) return;
      setInspected(value);
      place(mode, value);
    } catch (failure) {
      if (request === inspection.current) setMapError(errorText(failure));
    }
  };

  const selectLeg = (index: number | null) => setLegSelection(run && index !== null ? { runId: run.run_id, index } : null);
  const runMission = () => {
    if (editingLocked) { setMapError("Reset the simulation before running a new mission."); return; }
    if (placingBase || placingSite) { setMapError("Finish or cancel placement on the map before running the mission."); return; }
    inspection.current++;
    setMapError(null);
    void mission.run();
  };

  const toggleBlockPick = () => {
    if (pickingBlock) { setPickingBlock(false); return; }
    setPlacingBase(false);
    setPlacingSite(false);
    inspection.current++;
    setMapError(null);
    setPickingBlock(true);
  };

  const resetSimulation = () => {
    setPickingBlock(false);
    setBlockCenter(null);
    setMapError(null);
    void mission.clearSimulation();
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
      <Button form="mission-scenario" type="submit" size="sm" disabled={busy || placingBase || placingSite || editingLocked}>
        {phase === "validating" ? "Validating…" : phase === "solving" ? "Planning…" : "Run mission"}
      </Button>
    </header>
    <div ref={rowRef} className="flex min-h-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
        <nav aria-label="Map controls" className="flex shrink-0 items-center gap-2 border-b px-4 py-2">
          <Button size="sm" variant={layer === "imagery" ? "secondary" : "ghost"} aria-pressed={layer === "imagery"} onClick={() => setLayer("imagery")}>Imagery</Button>
          <Button size="sm" variant={layer === "heights" ? "secondary" : "ghost"} aria-pressed={layer === "heights"} onClick={() => setLayer("heights")}>Elevation</Button>
          {workspace.infrared && <Button size="sm" variant={layer === "infrared" ? "secondary" : "ghost"} aria-pressed={layer === "infrared"} onClick={() => setLayer("infrared")}>THEMIS · 100 m</Button>}
          <label className="ml-3 flex items-center gap-2 text-sm"><input type="checkbox" checked={showHazards} onChange={(event) => setShowHazards(event.target.checked)} />Slope / unknown</label>
          <div className="ml-auto flex gap-1">
            <Button type="button" size="sm" variant={placingBase ? "secondary" : "ghost"} aria-pressed={placingBase}
              disabled={busy || editingLocked} onClick={() => { togglePlacing("base", false); mapRef.current?.focus(); }}>Base <kbd className="text-[10px] text-muted-foreground">B</kbd></Button>
            <Button type="button" size="sm" variant={placingSite ? "secondary" : "ghost"} aria-pressed={placingSite}
              disabled={busy || editingLocked} onClick={() => { togglePlacing("site", false); mapRef.current?.focus(); }}>Candidate <kbd className="text-[10px] text-muted-foreground">C</kbd></Button>
          </div>
        </nav>
        {placingBase && <p role="status" className="border-b px-4 py-2 text-xs">Click known terrain to place the base. Esc to cancel.</p>}
        {placingSite && <p role="status" className="border-b px-4 py-2 text-xs">Click known terrain to add a candidate site. Esc to cancel.</p>}
        {pickingBlock && <p role="status" className="border-b px-4 py-2 text-xs">Click the map to set the blocked-corridor centre; confirm it in the simulation panel.</p>}
        {editingLocked && <p className="border-b px-4 py-2 text-xs">Simulation active — reset it to edit the scenario.</p>}
        {preview && <div className="flex items-center justify-between gap-2 border-b px-4 py-2 text-xs">
          <p><strong>Terrain-derived POV:</strong> {preview.label} — generated from the DTM, not a real photograph.</p>
          <Button type="button" size="sm" variant="outline" onClick={() => { setPreview(null); setViewReset((n) => n + 1); }}>Return to overview</Button>
        </div>}
        {mapError && <p role="alert" className="border-b px-4 py-2 text-xs">{mapError}</p>}
        <ContextMenu.Root onOpenChange={(open) => { if (!open) { setContextPoint(null); setContextSiteId(null); } }}>
        <ContextMenu.Trigger render={<section ref={mapRef} tabIndex={0} aria-label="Terrain map" aria-describedby="map-shortcuts"
          aria-keyshortcuts="B C Escape" className="relative min-h-40 flex-1 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring" />}
          onPointerDownCapture={(event) => { if (event.target instanceof HTMLCanvasElement) mapRef.current?.focus({ preventScroll: true }); }}
          onKeyDown={(event) => {
            if (event.target !== event.currentTarget) return;
            const action = mapShortcut({ ...event, isComposing: event.nativeEvent.isComposing });
            if (!action) return;
            event.preventDefault();
            if (action === "cancel") cancelPlacement();
            else togglePlacing(action, false);
          }}>
          <Terrain3D
            elevation={workspace.elevation} width={geo.width} height={geo.height}
            dx={geo.cell_size_x_m} dy={geo.cell_size_y_m} step={4} texture={texture}
            lit={layer === "heights"} exaggeration={1} markers={markers}
            legs={result?.legs ?? NO_LEGS}
            revisedLegs={simulation?.state.plan.status === "FEASIBLE_MODELED" ? simulation.state.plan.legs : NO_LEGS}
            position={simulation?.position ?? null}
            blockPreview={blockPreview}
            pov={pov}
            selectedLeg={selectedLeg}
            inspected={inspected} hideInspected={contextPoint !== null} placing={placingBase || placingSite || pickingBlock} resetSignal={viewReset} onPick={pick}
            onContextPick={(point) => {
              setContextPoint(point);
              if (!point) { setContextSiteId(null); return; }
              // A candidate within reach of the right-click target is the delete subject.
              const near = scenario.sites.find((site) =>
                Math.hypot(site.position.x_m - point.x_m, site.position.y_m - point.y_m) <= 30);
              setContextSiteId(near?.id ?? null);
            }} onMesh={() => {}}
          />
          <div aria-live="polite" className="pointer-events-none absolute bottom-3 left-3 max-w-sm rounded-lg bg-background/90 px-3 py-2 text-xs shadow">
            {inspected ? <><p>{latLon(inspected.latlon)}</p>
              <p>{fmt(inspected.elevation_m, 1)} m · {fmt(inspected.slope_deg, 1)}° · {inspected.terrain.replaceAll("_", " ").toLowerCase()}</p></>
              : <p>Click the map to inspect elevation, slope and coverage.</p>}
            {layer === "infrared" && <p>DERIVED · Odyssey infrared brightness, not temperature or hazards</p>}
          </div>
        </ContextMenu.Trigger>
        <ContextMenu.Portal>
          <ContextMenu.Positioner className="z-50" sideOffset={4}>
            <ContextMenu.Popup className="min-w-52 rounded-lg border bg-background p-1 text-sm shadow-xl outline-none">
              <ContextMenu.Item disabled={!contextPoint || busy || editingLocked}
                className="flex cursor-default items-center justify-between gap-6 rounded px-3 py-2 outline-none data-highlighted:bg-muted data-disabled:opacity-40"
                onClick={() => void placeAtContext("base")}>Place base here <kbd className="text-xs text-muted-foreground">B</kbd></ContextMenu.Item>
              <ContextMenu.Item disabled={!contextPoint || busy || editingLocked}
                className="flex cursor-default items-center justify-between gap-6 rounded px-3 py-2 outline-none data-highlighted:bg-muted data-disabled:opacity-40"
                onClick={() => void placeAtContext("site")}>Add candidate here <kbd className="text-xs text-muted-foreground">C</kbd></ContextMenu.Item>
              {contextSiteId && <ContextMenu.Item disabled={busy || editingLocked}
                className="flex cursor-default items-center justify-between gap-6 rounded px-3 py-2 outline-none text-status-critical data-highlighted:bg-muted data-disabled:opacity-40"
                onClick={() => deleteSite(contextSiteId)}>Delete candidate {contextSiteId}</ContextMenu.Item>}
              {(editingLocked || !contextPoint) && <p className="max-w-56 px-3 py-2 text-xs text-muted-foreground">
                {editingLocked ? "Reset the simulation to edit locations." : "Right-click the terrain to choose a location."}
              </p>}
            </ContextMenu.Popup>
          </ContextMenu.Positioner>
        </ContextMenu.Portal>
        </ContextMenu.Root>
        <p id="map-shortcuts" className="border-t px-4 py-1 text-[11px] text-muted-foreground">Right-click to place · With map focused: B base, C candidate, Esc cancel · Shift + drag to pan</p>
        {simulation && (() => {
          const plannedTotalS = Math.max(0, run?.report.result.totals?.eva_time_s ?? 0);
          const elapsedS = simulation.state.elapsed_s ?? 0;
          const sliderMax = Math.max(plannedTotalS, elapsedS, 1);
          const sliderValue = scrubbing && scrubS !== null ? scrubS : elapsedS;
          const clampTarget = (value: number) => Math.max(0, Math.min(sliderMax, value));
          /** Seek continuously while scrubbing, throttled so replays stay smooth. */
          const seekThrottled = (target: number) => {
            scrubSeek.current.pending = clampTarget(target);
            if (scrubSeek.current.timer || scrubSeek.current.pending === scrubSeek.current.last) return;
            scrubSeek.current.timer = window.setTimeout(() => {
              scrubSeek.current.timer = 0;
              const t = scrubSeek.current.pending ?? 0;
              scrubSeek.current.pending = null;
              scrubSeek.current.last = t;
              void mission.seekSimulation(t);
            }, 160);
          };
          const commitSeek = () => {
            const state = scrubSeek.current;
            if (state.timer) { window.clearTimeout(state.timer); state.timer = 0; }
            const target = state.pending;
            state.pending = null;
            setScrubbing(false);
            setScrubS(null);
            if (target !== null && target !== state.last) { state.last = target; void mission.seekSimulation(target); }
          };
          return <div className="shrink-0 border-t bg-background px-4 py-2 text-xs">
            <div className="flex items-center justify-between gap-2">
              <label htmlFor="sim-progress-slider-map" className="font-medium">Mission progress</label>
              <span className="tabular-nums text-muted-foreground">{minutes(sliderValue, 1)} / {minutes(plannedTotalS || sliderMax, 1)}</span>
            </div>
            <input
              id="sim-progress-slider-map"
              type="range"
              min={0}
              max={sliderMax}
              step={1}
              value={Math.min(sliderValue, sliderMax)}
              disabled={busy && !scrubbing}
              className="mt-1 w-full accent-foreground"
              aria-label="Mission progress timeline"
              onChange={(e) => { setScrubbing(true); setScrubS(Number(e.currentTarget.value)); seekThrottled(Number(e.currentTarget.value)); }}
              onPointerUp={commitSeek}
              onPointerCancel={commitSeek}
              onBlur={() => { if (scrubbing) commitSeek(); }}
            />
            <p className="mt-1 text-muted-foreground">The map follows while you drag. Seeking replays from the start; injected events/replans are not preserved.</p>
          </div>;
        })()}
        {showResults && <>
          <VResize height={resultsHeight} onHeight={setResultsHeight} min={RESULTS_MIN}
            containerRef={rowRef} defaultHeight={RESULTS_DEFAULT} />
          <div className="flex shrink-0 flex-col overflow-hidden" style={{ height: resultsHeight }}>
            <div className="min-h-0 flex-1 overflow-y-auto">
            <MissionResults
          state={state}
          selectedLeg={selectedLeg}
          onSelectLeg={selectLeg}
          previewSiteId={preview?.siteId ?? null}
          onPreviewSite={(point, label) => {
            const source = run?.report.scenario ?? scenario;
            const site = source.sites.find((s) => s.position.x_m === point.x_m && s.position.y_m === point.y_m);
            setPreview({ point, label, siteId: site?.id ?? label });
          }}
          onRequireSite={(siteId, required) => {
            if (editingLocked) { setMapError("Reset the simulation before changing requirements."); return; }
            const source = run?.report.scenario ?? scenario;
            const updated = { ...source, sites: source.sites.map((s) => s.id === siteId ? { ...s, required } : s) };
            mission.edit(updated);
            void mission.runWith(updated);
          }}
        />
            </div>
          </div>
        </>}
      </div>
      <aside aria-label="Mission configuration" className="w-[360px] shrink-0 space-y-5 overflow-y-auto border-l p-4 text-sm">
        <SimulationPanel
          state={state}
          blockCenter={blockCenter}
          pickingBlock={pickingBlock}
          radius={blockRadius}
          onRadius={setBlockRadius}
          onPickBlockCenter={toggleBlockPick}
          onCancelBlockPick={() => setPickingBlock(false)}
          onStart={() => { setMapError(null); void mission.startSimulation(); }}
          onAdvance={(seconds) => void mission.advanceSimulation(seconds)}
          onAdvanceToStop={() => void mission.advanceSimulationToStop()}
          onReplan={() => void mission.replanSimulation()}
          onReset={resetSimulation}
          onInject={(kind) => void mission.injectSimulationEvent(kind)} />
        <ScenarioEditor state={state} placingBase={placingBase}
          datasetId={workspace.info.manifest.dataset_id}
          locked={editingLocked}
          onChange={edit}
          onPlaceBase={() => togglePlacing("base")}
          onLoadPackaged={() => {
            if (editingLocked) { setMapError("Reset the simulation before loading a scenario."); return; }
            inspection.current++;
            setMapError(null);
            void api.defaultScenario().then((packaged) => edit(packaged), (failure) => setMapError(errorText(failure)));
          }}
          onSavePlan={() => { setMapError(null); void mission.savePlan(); }}
          onLoadPlan={(loaded) => { inspection.current++; setMapError(null); mission.edit(loaded); }}
          onRun={runMission} />
        <details className="space-y-3 border-t pt-3">
          <summary className="cursor-pointer font-medium">Map key & data sources</summary>
          <p>{workspace.info.manifest.region_name}</p>
          <p className="text-xs text-muted-foreground">{workspace.info.real_data_verified ? "Verified source data" : "Source data not verified"} · {fmt(geo.cell_size_x_m, 1)} m raster · {fmt(grid.cell_x_m, 1)} m planning cells</p>
          <ul className="space-y-1 text-xs text-muted-foreground">
            <li>Square B: base · rings: candidates · numbered discs: visit order · dashed rings: left out</li>
            <li>Pink line: planned route · amber line: replanned route</li>
            <li>Amber triangle: crew position · amber ring: corridor to block</li>
            <li>Red cells: temporarily blocked (simulation only)</li>
            {showHazards && <li>Orange: above {fmt(maxSlope, 1)}° slope limit · dark: unknown terrain</li>}
            {layer === "heights" && <li>Blue ramp: dark = {fmt(workspace.info.elevation_min_m)} m · light = {fmt(workspace.info.elevation_max_m)} m</li>}
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
        <p className="text-xs text-muted-foreground">Slope limits, resource rates and candidates are assumptions — orbital data cannot establish astronaut safety.</p>
      </aside>
    </div>
  </main>;
}

/** Horizontal drag handle that resizes the results panel below the map. */
function VResize({ height, onHeight, min, containerRef, defaultHeight }: {
  height: number;
  onHeight: (height: number) => void;
  min: number;
  containerRef: RefObject<HTMLDivElement | null>;
  defaultHeight: number;
}) {
  const start = useRef<{ y: number; h: number } | null>(null);
  const max = () => Math.max(min + 40, (containerRef.current?.clientHeight ?? 640) - MAP_KEEP);
  const clamp = (value: number) => Math.min(max(), Math.max(min, Math.round(value)));
  return <div role="separator" aria-orientation="horizontal" aria-label="Results panel height"
    aria-valuenow={height} aria-valuemin={min} aria-valuemax={max()}
    tabIndex={0} title="Drag to resize the results panel · double-click to reset"
    className="group flex h-3.5 shrink-0 cursor-row-resize touch-none items-center justify-center outline-none focus-visible:bg-muted/60"
    onPointerDown={(e) => {
      e.currentTarget.setPointerCapture(e.pointerId);
      start.current = { y: e.clientY, h: height };
    }}
    onPointerMove={(e) => {
      if (start.current) onHeight(clamp(start.current.h - (e.clientY - start.current.y)));
    }}
    onPointerUp={() => { start.current = null; }}
    onPointerCancel={() => { start.current = null; }}
    onDoubleClick={() => onHeight(defaultHeight)}
    onKeyDown={(e) => {
      if (e.key === "ArrowUp") { e.preventDefault(); onHeight(clamp(height + 24)); }
      if (e.key === "ArrowDown") { e.preventDefault(); onHeight(clamp(height - 24)); }
      if (e.key === "Home") { e.preventDefault(); onHeight(max()); }
      if (e.key === "End") { e.preventDefault(); onHeight(min); }
    }}>
    <span aria-hidden="true" className="h-1 w-24 rounded-full bg-muted-foreground/40 transition-colors group-hover:bg-muted-foreground/70" />
  </div>;
}
