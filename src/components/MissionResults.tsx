import { Button } from "@/components/ui/button";
import { clock, fmt, minutes } from "@/lib/format";
import type { MissionState } from "@/lib/mission";
import type { CandidateInsight, ConstraintCheck, MissionScenario, PlanStatus, ResourceUse, ScientificSite } from "@/lib/types";

const STATUS: Record<PlanStatus, string> = {
  FEASIBLE_MODELED: "Feasible under declared model",
  INFEASIBLE: "No feasible plan",
  UNKNOWN_DATA_COVERAGE: "Unknown data coverage",
};

function resource(check: ConstraintCheck) {
  const scale = check.resource === "eva_time" ? 60 : 1;
  const unit = check.resource === "eva_time" ? "min" : check.unit;
  const label = check.resource === "eva_time" ? "EVA time" : check.resource === "energy" ? "Energy" : "Consumable";
  return { label, unit, scale };
}

function bar(used: number, budget: number) {
  if (!(budget > 0) || !Number.isFinite(used)) return 0;
  return Math.max(0, Math.min(100, (used / budget) * 100));
}

function missionTimeBreakdown(result: { legs: { from: string; to: string; time_s: number }[]; totals: ResourceUse | null; stops: { site_id: string; activity_s: number }[] }) {
  const legs = result.legs;
  const first = legs[0];
  const last = legs[legs.length - 1];
  const outbound = first && first.from === "BASE" && first.to !== "BASE" ? first : null;
  const ret = last && last.to === "BASE" ? last : null;
  const interSite = legs.filter((leg, i) => !(i === 0 && outbound) && !(i === legs.length - 1 && ret) && leg.from !== "BASE" && leg.to !== "BASE");
  const interTime = interSite.reduce((sum, leg) => sum + leg.time_s, 0);
  return {
    outbound_s: outbound?.time_s ?? 0,
    inter_site_s: interTime,
    activity_s: result.totals?.activity_time_s ?? result.stops.reduce((s, x) => s + x.activity_s, 0),
    return_s: ret?.time_s ?? 0,
    overhead_s: result.totals?.overhead_s ?? 0,
    total_s: result.totals?.eva_time_s ?? 0,
  };
}

function siteById(scenario: MissionScenario, id: string): ScientificSite | undefined {
  return scenario.sites.find((site) => site.id === id);
}

function statusLabel(status: string) {
  if (status === "SELECTED") return "Selected";
  if (status === "INFEASIBLE") return "Infeasible";
  return "Excluded";
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
  const totals = result?.totals;
  const leg = selectedLeg === null ? null : result?.legs[selectedLeg];
  const insights = (result?.candidate_insights ?? []) as CandidateInsight[];
  const breakdown = result ? missionTimeBreakdown(result) : null;
  const sim = state.simulation;

  return <section aria-label="Mission results" className="max-h-[46vh] shrink-0 space-y-3 overflow-y-auto border-t bg-background px-4 py-3 text-sm" aria-busy={phase !== "idle"}>
    <div role="status" className="flex flex-wrap items-center gap-x-4 gap-y-1">
      <h2 className="font-medium">{phase === "validating" ? "Validating scenario…" : phase === "solving" ? "Planning round trip…" : phase === "exporting" ? "Exporting report…"
        : result ? STATUS[result.status] : validation && !validation.ok ? "Scenario needs attention" : "Configure a scenario, then run the mission"}</h2>
      {result && <span className="text-xs text-muted-foreground">{result.solver.name} v{result.solver.version} · routing {fmt(result.timing.routing_ms)} ms · planning {fmt(result.timing.planning_ms, 1)} ms</span>}
    </div>
    {error && <p role="alert" className="text-status-critical">{error}</p>}
    {exportPath && <p role="status" className="break-all text-xs">Report exported to {exportPath}</p>}
    {issues.length > 0 && <ul aria-label="Validation and planning issues" className="space-y-1 text-xs">
      {issues.map((issue, i) => <li key={`${issue.code}-${i}`}>
        <strong>{issue.severity === "ERROR" ? "Error" : "Warning"}{issue.site_id ? ` · ${issue.site_id}` : ""}:</strong> {issue.message}
      </li>)}
    </ul>}

    {result && <>
      {totals && <dl className="grid grid-cols-4 gap-3">
        <div><dt className="text-xs text-muted-foreground">Sites visited</dt><dd className="text-lg font-medium">{result.stops.length} / {scenario.sites.length}</dd></div>
        <div><dt className="text-xs text-muted-foreground">Total mission time (modeled)</dt><dd className="text-lg font-medium">{minutes(totals.eva_time_s, 1)}</dd></div>
        <div><dt className="text-xs text-muted-foreground">Round-trip distance</dt><dd className="text-lg font-medium">{fmt(totals.distance_m)} m</dd></div>
        <div><dt className="text-xs text-muted-foreground">Preference utility (modeled)</dt><dd className="text-lg font-medium">{fmt(result.utility, 2)}</dd></div>
      </dl>}

      {breakdown && totals && <details open className="rounded-lg border p-3">
        <summary className="cursor-pointer font-medium">Mission time & resource estimates (modeled)</summary>
        <p className="mt-2 text-xs text-muted-foreground">Estimates use declared scenario assumptions and the planner/resource model, not certified astronaut rates or observations.</p>
        <div className="mt-3 grid gap-3 md:grid-cols-2">
          <div className="space-y-2 text-xs">
            <p className="font-medium">Mission time breakdown</p>
            <ul className="space-y-1">
              <li>Outbound travel: <strong>{minutes(breakdown.outbound_s, 1)}</strong></li>
              <li>Travel between sites: <strong>{minutes(breakdown.inter_site_s, 1)}</strong></li>
              <li>Science activities: <strong>{minutes(breakdown.activity_s, 1)}</strong></li>
              <li>Return to base: <strong>{minutes(breakdown.return_s, 1)}</strong></li>
              <li>EVA overhead (declared): <strong>{minutes(breakdown.overhead_s, 1)}</strong></li>
              <li>Total estimated duration: <strong>{minutes(breakdown.total_s, 1)}</strong></li>
            </ul>
            <p className="text-muted-foreground">Visit order: {result.stops.length ? `BASE → ${result.stops.map((s) => s.site_id).join(" → ")} → BASE` : "BASE → BASE (no stops)"}</p>
          </div>
          <div className="space-y-2 text-xs">
            <p className="font-medium">Resources (planned, with reserves)</p>
            <div className="space-y-2">
              {result.checks.map((check) => {
                const { label, unit, scale } = resource(check);
                const pct = bar(check.used, check.budget);
                const remain = check.budget - check.used;
                return <div key={check.resource}>
                  <div className="flex justify-between gap-2"><span>{label}</span><span className={check.satisfied ? "" : "text-status-critical"}>{check.satisfied ? "Within limit" : "Violated"}</span></div>
                  <div className="mt-1 h-2 overflow-hidden rounded bg-muted"><div className="h-full bg-foreground/60" style={{ width: `${pct}%` }} /></div>
                  <div className="mt-1 text-muted-foreground">Used {fmt(check.used / scale, 2)} / {fmt(check.budget / scale, 2)} {unit} · reserve {fmt(check.reserve / scale, 2)} {unit} · remaining {fmt(remain / scale, 2)} {unit} · margin after reserve {fmt(check.margin / scale, 2)} {unit}</div>
                </div>;
              })}
              {scenario.budget.energy_budget_wh === null && <p className="text-muted-foreground">Energy: no limit set (not constrained).</p>}
              {scenario.budget.consumable_budget === null && <p className="text-muted-foreground">Consumable: no limit set (not constrained).</p>}
            </div>
          </div>
        </div>
        {sim && <div className="mt-3 rounded border p-2 text-xs">
          <p className="font-medium">Simulation state (distinct from planned estimate)</p>
          <p className="text-muted-foreground">Elapsed {minutes(sim.state.elapsed_s, 1)} · consumed EVA {minutes(sim.state.consumed.eva_time_s, 1)}, energy {fmt(sim.state.consumed.energy_wh, 1)} Wh, consumable {fmt(sim.state.consumed.consumable, 3)} {scenario.budget.consumable_unit ?? ""} · completed {sim.state.completed_sites.length} site(s). Remaining checks reflect the current simulated state and latest plan.</p>
        </div>}
        <details className="mt-3 text-xs">
          <summary className="cursor-pointer font-medium">Per-destination plan breakdown</summary>
          <div className="mt-2 overflow-x-auto">
            <table className="w-full text-left">
              <thead><tr>{["Stop", "Arrive", "Activity", "Depart", "Utility", "Incoming leg", "Leg slope"].map((h) => <th key={h} className="border-b py-1 pr-2">{h}</th>)}</tr></thead>
              <tbody>
                {result.stops.map((stop, i) => {
                  const inLeg = result.legs[i];
                  return <tr key={stop.site_id}>
                    <td className="py-1 pr-2 font-medium">{stop.site_id}</td>
                    <td className="pr-2 tabular-nums">{clock(stop.arrive_s)}</td>
                    <td className="pr-2 tabular-nums">{minutes(stop.activity_s, 1)}</td>
                    <td className="pr-2 tabular-nums">{clock(stop.depart_s)}</td>
                    <td className="pr-2 tabular-nums">{fmt(stop.utility, 3)}</td>
                    <td className="pr-2">{inLeg ? `${fmt(inLeg.distance_m)} m / ${minutes(inLeg.time_s, 1)}` : "—"}</td>
                    <td className="pr-2">{inLeg ? `${fmt(inLeg.max_slope_deg, 1)}° max` : "—"}</td>
                  </tr>;
                })}
                {result.legs.length > 0 && (() => {
                  const returnLeg = result.legs[result.legs.length - 1]!;
                  return <tr>
                    <td className="py-1 pr-2 font-medium">Return</td><td className="pr-2">—</td><td className="pr-2">—</td><td className="pr-2 tabular-nums">{clock(totals?.eva_time_s ?? 0)}</td><td className="pr-2">—</td>
                    <td className="pr-2">{fmt(returnLeg.distance_m)} m / {minutes(returnLeg.time_s, 1)}</td>
                    <td className="pr-2">{fmt(returnLeg.max_slope_deg, 1)}° max</td>
                  </tr>;
                })()}
              </tbody>
            </table>
          </div>
        </details>
      </details>}

      {totals && <details>
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
                : item.to === "BASE" && <span className="ml-2 text-muted-foreground">Return to base (required)</span>}
            </li>;
          })}
        </ol>
        {leg && <p className="mt-2 text-xs">Selected leg {leg.from} → {leg.to}: ascent {fmt(leg.ascent_m, 1)} m · descent {fmt(leg.descent_m, 1)} m · max derived slope {fmt(leg.max_slope_deg, 1)}° · {fmt(run.report.planning_grid.cell_x_m, 1)} m planning cells. Traversal is modeled from orbital DTM, not certified safe.</p>}
      </details>}

      {insights.length > 0 && <details open className="rounded-lg border p-3">
        <summary className="cursor-pointer font-medium">Candidate insights (engine-derived)</summary>
        <p className="mt-2 text-xs text-muted-foreground">Why each candidate was selected, excluded, or infeasible, based on actual planner/route/resource calculations under declared assumptions. Feasible-but-unselected sites were not chosen because another combination gave higher modeled utility within limits.</p>
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
                <p><strong>Terrain/traversability (modeled):</strong> {insight.terrain.replaceAll("_", " ").toLowerCase()}{insight.site_slope_deg != null ? ` · derived slope ${fmt(insight.site_slope_deg, 1)}°` : ""} · reachable from base: {insight.reachable_from_base ? "yes" : "no"} · feasible alone (min dwell, return): {insight.feasible_alone ? "yes" : "no"}</p>
                {site && <p><strong>Scientific objective (user-defined):</strong> priority {fmt(site.preference_weight, 2)}, activity {minutes(site.activity_min_s, 0)}–{minutes(site.activity_max_s, 0)}, power {fmt(site.activity_power_w, 0)} W. {site.science_rationale}</p>}
                {insight.planned_activity_s > 0 && <p><strong>Planned contribution:</strong> utility {fmt(insight.planned_utility, 3)} (modeled), activity {minutes(insight.planned_activity_s, 1)} in final plan.</p>}
                {insight.standalone_eva_time_s != null && <p><strong>Standalone round trip estimate (min activity):</strong> distance {fmt(insight.standalone_distance_m, 0)} m, travel {minutes(insight.standalone_travel_time_s ?? 0, 1)}, EVA {minutes(insight.standalone_eva_time_s, 1)}.</p>}
                {insight.standalone_checks.length > 0 && <p><strong>Standalone constraint checks:</strong> {insight.standalone_checks.map((c) => `${resource(c).label} ${c.satisfied ? "ok" : "violated"} (margin ${fmt(c.margin / (c.resource === "eva_time" ? 60 : 1), 2)} ${resource(c).unit})`).join("; ")}.</p>}
                {site && site.source_product_ids.length > 0 && <p><strong>Dataset provenance:</strong> {site.source_product_ids.join(", ")} ({site.evidence_kind}).</p>}
                {site && site.source_product_ids.length === 0 && <p><strong>Evidence label:</strong> {site.evidence_kind}.</p>}
              </div>
            </details>;
          })}
        </div>
      </details>}

      {result.excluded.length > 0 && insights.length === 0 && <details open={result.status !== "FEASIBLE_MODELED"}>
        <summary className="cursor-pointer font-medium">Excluded sites ({result.excluded.length})</summary>
        <ul className="mt-2 space-y-1 text-xs">{result.excluded.map((site) => <li key={`${site.site_id}-${site.code}`}><strong>{site.site_id}:</strong> {site.reason}</li>)}</ul>
      </details>}

      <details open className="rounded-lg border p-3">
        <summary className="cursor-pointer font-medium">Mission insights summary</summary>
        <div className="mt-2 space-y-1 text-xs text-muted-foreground">
          <p><strong>Scientific objectives (planned):</strong> {result.stops.length ? `${result.stops.length} site(s) visited in order ${result.stops.map((s) => s.site_id).join(", ")}, total modeled utility ${fmt(result.utility, 3)}.` : "No science stops included in the modeled plan."}</p>
          <p><strong>Recommendation basis:</strong> {STATUS[result.status]}. Selection/exclusion comes from actual routing, resource, reserve and return-to-base checks plus modeled utility trade-offs (not hardcoded text).</p>
          <p><strong>Key constraints:</strong> return to base required; EVA/energy/consumable limits and reserves enforced when declared; terrain must be known and within slope limit under the model.</p>
          <p><strong>Assumptions/uncertainty:</strong> resource rates, slopes, preferences and any injected events are declared inputs; DTM-derived terrain cannot resolve all hazards; this is a research decision-support estimate, not flight-certified safety guidance.</p>
          {result.status !== "FEASIBLE_MODELED" && <p className="text-status-critical"><strong>Feasibility:</strong> the current modeled plan does not satisfy all declared constraints. Review infeasibility reasons and candidate insights before assuming a mission is possible.</p>}
        </div>
      </details>

      <details className="text-xs text-muted-foreground"><summary className="cursor-pointer">Method & limitations</summary>
        <p className="mt-2">{result.solver.description}</p>
        {run.report.disclaimers.map((text, i) => <p key={i} className="mt-1">{text}</p>)}
      </details>
    </>}
  </section>;
}
