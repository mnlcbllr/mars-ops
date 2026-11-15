import { useMemo } from "react";
import { Button } from "@/components/ui/button";
import { clock, fmt, minutes } from "@/lib/format";
import { simPlanStale, type MissionState } from "@/lib/mission";
import type {
  CandidateInsight, ConstraintCheck, MissionResult, MissionScenario, PlanStatus,
  ResourceUse, ScientificSite, SimulationView,
} from "@/lib/types";

const STATUS: Record<PlanStatus, string> = {
  FEASIBLE_MODELED: "Feasible under declared model",
  INFEASIBLE: "No feasible plan",
  UNKNOWN_DATA_COVERAGE: "Unknown data coverage",
};

const SIM_PHASE: Record<SimulationView["state"]["phase"], string> = {
  TRAVEL: "traveling", ACTIVITY: "working", COMPLETE: "complete", INFEASIBLE: "no modeled return",
};

type ChartPoint = { label: string; value: number };

function resourceMeta(check: ConstraintCheck) {
  const scale = check.resource === "eva_time" ? 60 : 1;
  const unit = check.resource === "eva_time" ? "min" : check.unit;
  const label = check.resource === "eva_time" ? "EVA time" : check.resource === "energy" ? "Energy" : "Consumable";
  return { label, unit, scale };
}

function siteById(scenario: MissionScenario, id: string): ScientificSite | undefined {
  return scenario.sites.find((site) => site.id === id);
}

function statusLabel(status: string) {
  if (status === "SELECTED") return "Selected";
  if (status === "INFEASIBLE") return "Infeasible";
  return "Excluded";
}

function shortText(text: string, max = 120): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  return `${cut.slice(0, cut.lastIndexOf(" "))}…`;
}

/** Captured simulation consumption per run, feeding the usage line charts. */
type UsageSample = { t: number; eva: number; energy: number; consumable: number };
const usageHistory = new Map<number, UsageSample[]>();

function recordUsage(runId: number, elapsedS: number, consumed: ResourceUse): UsageSample[] {
  const prev = usageHistory.get(runId) ?? [];
  const last = prev[prev.length - 1];
  const kept = last && elapsedS < last.t ? prev.filter((p) => p.t < elapsedS) : prev;
  const next = kept.filter((p) => p.t !== elapsedS);
  next.push({ t: elapsedS, eva: consumed.eva_time_s / 60, energy: consumed.energy_wh, consumable: consumed.consumable });
  usageHistory.set(runId, next);
  return next;
}

function LineChart({ title, points, x, unit, color = "#dc2626", cap, ticks, ariaLabel }: {
  title: string;
  points: ChartPoint[];
  /** Optional x values aligned with points; ticks use the same units. */
  x?: number[];
  unit: string;
  color?: string;
  cap?: number | null;
  ticks?: { fx: number; title: string }[];
  ariaLabel: string;
}) {
  if (points.length === 0) return null;
  const W = 100, H = 40, PAD = 3;
  const timeX = x && x.length === points.length;
  const span = timeX ? Math.max(Math.max(...x!) - Math.min(...x!), 1e-9) : Math.max(points.length - 1, 1);
  const lo = timeX ? Math.min(...x!) : 0;
  const xAt = (i: number) => timeX
    ? PAD + ((x![i]! - lo) / span) * (W - 2 * PAD)
    : PAD + (i * (W - 2 * PAD)) / span;
  const top = Math.max(...points.map((p) => Math.max(0, p.value)), cap ?? 0, 0.0001) * 1.05;
  const yAt = (v: number) => H - PAD - (Math.max(0, v) / top) * (H - 2 * PAD);
  const path = points.map((p, i) => `${xAt(i).toFixed(2)},${yAt(p.value).toFixed(2)}`).join(" ");
  const area = `${path} ${xAt(points.length - 1).toFixed(2)},${H - PAD} ${xAt(0).toFixed(2)},${H - PAD}`;
  const last = points[points.length - 1]!;
  return <div className="rounded border p-2">
    <div className="flex items-baseline justify-between gap-2 text-[11px]">
      <span className="font-medium">{title}</span>
      <span className="tabular-nums text-muted-foreground">{fmt(last.value, 2)} {unit}</span>
    </div>
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="mt-1 h-14 w-full" role="img" aria-label={ariaLabel}>
      {cap != null && cap > 0 && <line x1={PAD} x2={W - PAD} y1={yAt(cap)} y2={yAt(cap)} className="text-muted-foreground" stroke="currentColor" strokeDasharray="3 3" vectorEffect="non-scaling-stroke" />}
      <polygon points={area} fill={color} opacity={0.12} />
      <polyline points={path} fill="none" stroke={color} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
      {ticks?.map((t, i) => (t.fx < 0 || t.fx > 1) ? null
        : <line key={i} x1={PAD + t.fx * (W - 2 * PAD)} x2={PAD + t.fx * (W - 2 * PAD)} y1={PAD} y2={H - PAD} className="text-status-warning" stroke="currentColor" strokeWidth={1} vectorEffect="non-scaling-stroke" />)}
      {points.length <= 16 && points.map((p, i) => <circle key={i} cx={xAt(i)} cy={yAt(p.value)} r={1.4} fill={color} />)}
    </svg>
    <div className="flex justify-between text-[10px] text-muted-foreground">
      <span>{points[0]!.label}</span>
      {points.length > 1 && <span>{last.label}</span>}
    </div>
  </div>;
}

/** Cumulative planned usage along the itinerary; endpoints match planner totals, shape from declared rates. */
function plannedResourceCharts(result: MissionResult, scenario: MissionScenario) {
  const totals = result.totals;
  if (!totals || result.stops.length === 0) return [];
  const model = scenario.model;
  const overheadS = totals.overhead_s ?? 0;
  const labels = ["start", ...result.stops.map((s) => s.site_id), "return"];
  const evaMin = [0, ...result.stops.map((s) => s.depart_s), totals.eva_time_s].map((s) => s / 60);

  const travelH = result.legs.map((l) => l.time_s / 3600);
  const totalTravelH = travelH.reduce((a, b) => a + b, 0) || 1;
  const energyAt: number[] = [0];
  const consAt: number[] = [0];
  const xAt: number[] = [0];
  result.legs.forEach((leg, i) => {
    const share = travelH[i]! / totalTravelH;
    const isLast = i === result.legs.length - 1;
    energyAt.push(energyAt[energyAt.length - 1]! + (leg.time_s * model.base_power_w.value + overheadS * share * model.base_power_w.value) / 3600);
    consAt.push(consAt[consAt.length - 1]! + (leg.time_s / 3600) * model.consumable_rate_travel_per_h.value + (overheadS / 3600) * share * model.consumable_rate_travel_per_h.value);
    xAt.push(isLast ? totals.eva_time_s : result.stops[i]!.arrive_s);
    const stop = result.stops[i];
    if (!stop) return;
    const site = siteById(scenario, stop.site_id);
    energyAt.push(energyAt[energyAt.length - 1]! + stop.activity_s * (site?.activity_power_w ?? model.base_power_w.value) / 3600);
    consAt.push(consAt[consAt.length - 1]! + (stop.activity_s / 3600) * model.consumable_rate_activity_per_h.value);
    xAt.push(stop.depart_s);
  });
  const xMin = xAt.map((s) => s / 60);

  const scaled = (series: number[], total: number) => {
    const end = series[series.length - 1] ?? 0;
    if (total <= 0) return series.map(() => 0);
    if (end <= 0) return series.map((_, i) => (total * i) / Math.max(series.length - 1, 1));
    return series.map((v) => (v / end) * total);
  };
  const charts: { title: string; unit: string; points: ChartPoint[]; x: number[]; cap: number | null; color: string }[] = [{
    title: "EVA time along route",
    unit: "min",
    points: evaMin.map((value, i) => ({ label: labels[i] ?? "", value })),
    x: evaMin, cap: (result.checks.find((c) => c.resource === "eva_time")?.budget ?? 0) / 60, color: "#dc2626",
  }];
  if (totals.energy_wh > 0) {
    const energy = scaled(energyAt, totals.energy_wh);
    charts.push({
      title: "Planned energy use",
      unit: "Wh",
      points: energy.map((value, i) => ({ label: labels[Math.min(i, labels.length - 1)] ?? "", value })),
      x: xMin, cap: result.checks.find((c) => c.resource === "energy")?.budget ?? scenario.budget.energy_budget_wh, color: "#b91c1c",
    });
  }
  if (totals.consumable > 0) {
    const cons = scaled(consAt, totals.consumable);
    charts.push({
      title: "Planned consumable use",
      unit: scenario.budget.consumable_unit ?? "units",
      points: cons.map((value, i) => ({ label: labels[Math.min(i, labels.length - 1)] ?? "", value })),
      x: xMin, cap: result.checks.find((c) => c.resource === "consumable")?.budget ?? scenario.budget.consumable_budget, color: "#ef4444",
    });
  }
  return charts;
}

function MissionBrief({ result, scenario, insights, sim, planStale, previewSiteId, onPreviewSite }: {
  result: MissionResult;
  scenario: MissionScenario;
  insights: CandidateInsight[];
  sim: SimulationView | null;
  planStale: boolean;
  previewSiteId?: string | null;
  onPreviewSite?: (point: { x_m: number; y_m: number }, label: string) => void;
}) {
  const counts = { selected: 0, excluded: 0, infeasible: 0 };
  for (const insight of insights) {
    if (insight.status === "SELECTED") counts.selected++;
    else if (insight.status === "INFEASIBLE") counts.infeasible++;
    else counts.excluded++;
  }
  const dropped = sim
    ? result.stops.map((s) => s.site_id).filter((id) => !sim.state.completed_sites.includes(id)
        && !sim.state.plan.stops.some((p) => p.site_id === id))
    : [];
  const replanAdvised = sim && sim.state.phase !== "COMPLETE" && sim.state.phase !== "INFEASIBLE"
    && (sim.remaining_checks.some((c) => !c.satisfied)
      || sim.return_margin_s === null
      || sim.return_margin_s < 0
      || planStale);
  const totals = result.totals;
  return <div className="space-y-2 rounded-lg border p-3">
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <h2 className="text-sm font-medium">Mission brief</h2>
      <span className="rounded bg-muted px-1.5 py-0.5">{STATUS[result.status]}</span>
      {insights.length > 0 && <span className="text-muted-foreground">{counts.selected} selected · {counts.excluded} excluded · {counts.infeasible} infeasible</span>}
      {sim && <span className="rounded bg-status-warning/20 px-1.5 py-0.5">Sim: {SIM_PHASE[sim.state.phase]} · {sim.state.replans} replan{sim.state.replans === 1 ? "" : "s"}</span>}
      {replanAdvised && <span className="rounded border border-status-warning bg-status-warning/10 px-1.5 py-0.5 text-status-warning">Replan advised</span>}
    </div>
    <p className="flex flex-wrap items-center gap-x-1 text-xs">
      Route: <span>BASE</span>
      {result.stops.map((stop) => {
        const site = siteById(scenario, stop.site_id);
        return <span key={stop.site_id} className="flex items-center gap-x-1">
          <span aria-hidden>→</span>
          <Button type="button" size="sm" variant={previewSiteId === stop.site_id ? "secondary" : "ghost"}
            className="h-5 px-1.5 text-xs" title={site ? `${site.id} · ${site.name}` : stop.site_id}
            onClick={() => site && onPreviewSite?.(site.position, `${site.id} · ${site.name}`)}>
            {stop.site_id}
          </Button>
        </span>;
      })}
      <span aria-hidden>→</span><span>BASE{result.stops.length === 0 ? " (no stops)" : ""}</span>
    </p>
    {sim && <p className="text-xs text-muted-foreground">
      {clock(sim.state.elapsed_s)} · {sim.state.completed_sites.length}/{result.stops.length} stops done
      {sim.return_margin_s !== null && ` · return margin ${minutes(sim.return_margin_s, 1)}`}
      {dropped.length > 0 && ` · dropped: ${dropped.join(", ")}`}
    </p>}
    {insights.length > 0 && <ul className="space-y-0.5 text-xs">
      {insights.map((insight) => {
        const site = siteById(scenario, insight.site_id);
        return <li key={insight.site_id} className="flex flex-wrap items-baseline gap-x-1.5">
          {site && onPreviewSite
            ? <button type="button" className="font-medium underline decoration-dotted" onClick={() => onPreviewSite(site.position, `${site.id} · ${site.name}`)}>{insight.site_id}</button>
            : <strong>{insight.site_id}</strong>}
          <span className={insight.status === "INFEASIBLE" ? "text-status-critical" : insight.status === "SELECTED" ? "" : "text-muted-foreground"}>{statusLabel(insight.status)}</span>
          <span className="min-w-0 text-muted-foreground">{shortText(insight.explanation)}{insight.reason_code ? ` (${insight.reason_code})` : ""}</span>
        </li>;
      })}
    </ul>}
    {totals && <dl className="grid grid-cols-4 gap-2 pt-1">
      <div className="rounded border p-2"><dt className="text-[11px] text-muted-foreground">Sites</dt><dd className="text-base font-medium">{result.stops.length}/{scenario.sites.length}</dd></div>
      <div className="rounded border p-2"><dt className="text-[11px] text-muted-foreground">Time (planned)</dt><dd className="text-base font-medium">{minutes(totals.eva_time_s, 1)}</dd></div>
      <div className="rounded border p-2"><dt className="text-[11px] text-muted-foreground">Distance</dt><dd className="text-base font-medium">{fmt(totals.distance_m, 0)} m</dd></div>
      <div className="rounded border p-2"><dt className="text-[11px] text-muted-foreground">Utility</dt><dd className="text-base font-medium">{fmt(result.utility, 2)}</dd></div>
    </dl>}
  </div>;
}

export function MissionResults({ state, selectedLeg, onSelectLeg, onPreviewSite, previewSiteId, onRequireSite }: {
  state: MissionState;
  selectedLeg: number | null;
  onSelectLeg: (index: number | null) => void;
  onPreviewSite?: (point: { x_m: number; y_m: number }, label: string) => void;
  previewSiteId?: string | null;
  onRequireSite?: (siteId: string, required: boolean) => void;
}) {
  const { run, phase, validation, error, exportPath } = state;
  const result = run?.report.result;
  const scenario = run?.report.scenario ?? state.scenario;
  const issues = result?.issues ?? validation?.issues ?? [];
  const leg = selectedLeg === null ? null : result?.legs[selectedLeg];
  const insights = (result?.candidate_insights ?? []) as CandidateInsight[];
  const sim = state.simulation;

  const usage = useMemo(() => {
    if (!sim || !run) return null;
    const samples = recordUsage(run.run_id, sim.state.elapsed_s, sim.state.consumed);
    const t = samples.map((s) => s.t / 60);
    const span = Math.max((t[t.length - 1] ?? 0) - (t[0] ?? 0), 1e-9);
    const ticks = sim.state.events.map((e) => ({ fx: (e.at_elapsed_s / 60 - (t[0] ?? 0)) / span, title: `T+${clock(e.at_elapsed_s)}` }));
    return { t, ticks, samples };
  }, [sim, run]);
  const planStale = useMemo(
    () => (sim && run ? simPlanStale(run.run_id, sim.state) : false),
    [sim, run],
  );

  const plannedCharts = result ? plannedResourceCharts(result, scenario) : [];

  return <section aria-label="Mission results" className="max-h-[46vh] shrink-0 space-y-3 overflow-y-auto border-t bg-background px-4 py-3 text-sm" aria-busy={phase !== "idle"}>
    <div role="status" className="flex flex-wrap items-center gap-x-4 gap-y-1">
      <h2 className="font-medium">{phase === "validating" ? "Validating scenario…" : phase === "solving" ? "Planning round trip…" : phase === "exporting" ? "Exporting report…"
        : result ? STATUS[result.status] : validation && !validation.ok ? "Scenario needs attention" : "Configure a scenario, then run the mission"}</h2>
      {result && <span className="text-xs text-muted-foreground">{result.solver.name} v{result.solver.version} · {fmt(result.timing.routing_ms)} ms + {fmt(result.timing.planning_ms, 1)} ms</span>}
    </div>
    {error && <p role="alert" className="text-status-critical">{error}</p>}
    {exportPath && <p role="status" className="break-all text-xs">Exported: {exportPath}</p>}
    {issues.length > 0 && <ul aria-label="Validation and planning issues" className="space-y-1 text-xs">
      {issues.map((issue, i) => <li key={`${issue.code}-${i}`}>
        <strong className={issue.severity === "ERROR" ? "text-status-critical" : ""}>{issue.severity}{issue.site_id ? ` · ${issue.site_id}` : ""}:</strong> {issue.message}
      </li>)}
    </ul>}

    {result && <>
      <MissionBrief result={result} scenario={scenario} insights={insights} sim={sim} planStale={planStale}
        previewSiteId={previewSiteId} onPreviewSite={onPreviewSite} />

      {plannedCharts.length > 0 && <details open className="rounded-lg border p-3">
        <summary className="cursor-pointer font-medium">Graphs (modeled estimates)</summary>
        <div className="mt-3 grid gap-2 md:grid-cols-2 xl:grid-cols-3">
          {plannedCharts.map((chart) => <LineChart key={chart.title} title={chart.title} points={chart.points}
            x={chart.x} unit={chart.unit} cap={chart.cap} color={chart.color} ariaLabel={chart.title} />)}
          <div className="rounded border p-2">
            <p className="text-[11px] font-medium">Travel time per leg</p>
            <LineChart title="Travel per leg" unit="min" color="#f87171"
              points={result.legs.map((l, i) => ({ label: `${i + 1}${l.from === "BASE" ? "↑" : l.to === "BASE" ? "↓" : ""}`, value: l.time_s / 60 }))}
              ariaLabel="Travel time per leg" />
          </div>
        </div>
        <p className="mt-2 text-[11px] text-muted-foreground">Resource endpoints match planner totals; shape from declared rates. Dashed line: budget limit.</p>
        <div className="mt-2 space-y-1 border-t pt-2">
          <p className="text-[11px] font-medium">Planned usage vs limits</p>
          {result.checks.map((check) => {
            const { label, unit, scale } = resourceMeta(check);
            return <div key={check.resource} className="flex flex-wrap justify-between gap-x-3 text-xs">
              <span>{label}</span>
              <span className={check.satisfied ? "tabular-nums text-muted-foreground" : "tabular-nums text-status-critical"}>
                {fmt(check.used / scale, 2)} / {fmt(check.budget / scale, 2)} {unit} · reserve {fmt(check.reserve / scale, 2)} · margin {fmt(check.margin / scale, 2)} · {check.satisfied ? "OK" : "Violated"}
              </span>
            </div>;
          })}
        </div>

        {usage && <div className="mt-3 grid gap-2 border-t pt-3 md:grid-cols-2 xl:grid-cols-3">
          {[
            { title: "Simulated EVA time used", points: usage.samples.map((s) => ({ label: clock(s.t), value: s.eva })), cap: result.checks.find((c) => c.resource === "eva_time")?.budget },
            { title: "Simulated energy used", points: usage.samples.map((s) => ({ label: clock(s.t), value: s.energy })), cap: result.checks.find((c) => c.resource === "energy")?.budget ?? scenario.budget.energy_budget_wh },
            { title: "Simulated consumable used", points: usage.samples.map((s) => ({ label: clock(s.t), value: s.consumable })), cap: result.checks.find((c) => c.resource === "consumable")?.budget ?? scenario.budget.consumable_budget },
          ].filter((chart) => (chart.points[chart.points.length - 1]?.value ?? 0) > 0 || (chart.cap ?? 0) > 0)
            .map((chart) => <LineChart key={chart.title} title={chart.title} points={chart.points} x={usage.t}
              unit={chart.title.includes("EVA") ? "min" : chart.title.includes("energy") ? "Wh" : scenario.budget.consumable_unit ?? "units"}
              cap={chart.cap} ticks={usage.ticks} color="#991b1b" ariaLabel={chart.title} />)}
          <p className="text-[11px] text-muted-foreground md:col-span-2 xl:col-span-3">Amber ticks: injected events.</p>
        </div>}
      </details>}

      {result.totals && <details>
        <summary className="cursor-pointer font-medium">Itinerary & route segments</summary>
        <ol aria-label="Round-trip itinerary" className="mt-2 space-y-2">
          {result.legs.map((item, index) => {
            const stop = result.stops.find((s) => s.site_id === item.to);
            return <li key={index} className="text-xs">
              <Button type="button" size="sm" variant={selectedLeg === index ? "secondary" : "ghost"} aria-pressed={selectedLeg === index}
                onClick={() => onSelectLeg(selectedLeg === index ? null : index)}>
                {index + 1}. {item.from} → {item.to} · {fmt(item.distance_m)} m · {minutes(item.time_s, 1)}
              </Button>
              {stop ? <span className="ml-2 text-muted-foreground">Arrive {clock(stop.arrive_s)} · work {minutes(stop.activity_s, 1)} · depart {clock(stop.depart_s)} · utility {fmt(stop.utility, 3)}</span>
                : item.to === "BASE" && <span className="ml-2 text-muted-foreground">Return to base</span>}
            </li>;
          })}
        </ol>
        {leg && <p className="mt-2 text-xs text-muted-foreground">Selected leg {leg.from} → {leg.to}: ascent {fmt(leg.ascent_m, 1)} m · descent {fmt(leg.descent_m, 1)} m · max slope {fmt(leg.max_slope_deg, 1)}° · {fmt(run.report.planning_grid.cell_x_m, 1)} m cells (DTM-derived, not certified safe).</p>}
      </details>}

      {insights.length > 0 && <details className="rounded-lg border p-3">
        <summary className="cursor-pointer font-medium">Candidate details & POV</summary>
        <div className="mt-3 space-y-2">
          {insights.map((insight) => {
            const site = siteById(scenario, insight.site_id);
            return <details key={insight.site_id} className="rounded border p-2 text-xs">
              <summary className="cursor-pointer">
                <strong>{insight.site_id}</strong>{site ? ` · ${site.name}` : ""}{site?.required ? <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-[10px]">Required</span> : null} — <span className={insight.status === "SELECTED" ? "text-foreground" : insight.status === "INFEASIBLE" ? "text-status-critical" : "text-muted-foreground"}>{statusLabel(insight.status)}</span>
                {insight.reason_code ? <span className="ml-2 text-muted-foreground">({insight.reason_code})</span> : null}
              </summary>
              {(site && (onPreviewSite || onRequireSite)) && <div className="mt-2 flex flex-wrap gap-2">
                {site && onPreviewSite && <Button type="button" size="sm" variant={previewSiteId === site.id ? "secondary" : "outline"}
                  onClick={() => onPreviewSite(site.position, `${site.id} · ${site.name}`)}>
                  {previewSiteId === site.id ? "Previewing (terrain-derived)" : "Preview destination"}
                </Button>}
                {site && onRequireSite && state.phase === "idle" && !state.simulation && !state.simulationBusy && <Button type="button" size="sm" variant="outline"
                  onClick={() => onRequireSite(site.id, !site.required)}>
                  {site.required ? "Make optional & replan" : "Require in plan & replan"}
                </Button>}
              </div>}
              <div className="mt-2 space-y-1 text-muted-foreground">
                <p className="text-foreground">{insight.explanation}</p>
                <p>Terrain: {insight.terrain.replaceAll("_", " ").toLowerCase()}{insight.site_slope_deg != null ? ` · ${fmt(insight.site_slope_deg, 1)}°` : ""} · reachable {insight.reachable_from_base ? "yes" : "no"} · feasible alone {insight.feasible_alone ? "yes" : "no"}</p>
                {site && <p>Objective: priority {fmt(site.preference_weight, 2)}, {minutes(site.activity_min_s, 0)}–{minutes(site.activity_max_s, 0)}, {fmt(site.activity_power_w, 0)} W · {site.evidence_kind}</p>}
                {insight.planned_activity_s > 0 && <p>Planned: utility {fmt(insight.planned_utility, 3)}, activity {minutes(insight.planned_activity_s, 1)}.</p>}
                {insight.standalone_eva_time_s != null && <p>Standalone round trip: {fmt(insight.standalone_distance_m, 0)} m, EVA {minutes(insight.standalone_eva_time_s, 1)}.</p>}
                {insight.standalone_checks.length > 0 && <p>Checks: {insight.standalone_checks.map((c) => `${resourceMeta(c).label} ${c.satisfied ? "ok" : "violated"} (${fmt(c.margin / (c.resource === "eva_time" ? 60 : 1), 2)} ${resourceMeta(c).unit})`).join("; ")}.</p>}
              </div>
            </details>;
          })}
        </div>
      </details>}

      {result.excluded.length > 0 && insights.length === 0 && <details open={result.status !== "FEASIBLE_MODELED"}>
        <summary className="cursor-pointer font-medium">Excluded sites ({result.excluded.length})</summary>
        <ul className="mt-2 space-y-1 text-xs">{result.excluded.map((site) => <li key={`${site.site_id}-${site.code}`}><strong>{site.site_id}:</strong> {site.reason}</li>)}</ul>
      </details>}

      <details className="text-xs text-muted-foreground"><summary className="cursor-pointer">Method & limitations</summary>
        <p className="mt-2">{result.solver.description}</p>
        {run.report.disclaimers.map((text, i) => <p key={i} className="mt-1">{text}</p>)}
      </details>
    </>}
  </section>;
}
