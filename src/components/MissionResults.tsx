import { Button } from "@/components/ui/button";
import { clock, fmt, minutes } from "@/lib/format";
import type { MissionState } from "@/lib/mission";
import type { CandidateInsight, ConstraintCheck, MissionScenario, PlanStatus, ResourceUse, ScientificSite } from "@/lib/types";

const STATUS: Record<PlanStatus, string> = {
  FEASIBLE_MODELED: "Feasible under declared model",
  INFEASIBLE: "No feasible plan",
  UNKNOWN_DATA_COVERAGE: "Unknown data coverage",
};

type Seg = { label: string; value: number; color: string; title?: string };

function clampPct(v: number) {
  return Math.max(0, Math.min(100, v));
}

function resourceMeta(check: ConstraintCheck) {
  const scale = check.resource === "eva_time" ? 60 : 1;
  const unit = check.resource === "eva_time" ? "min" : check.unit;
  const label = check.resource === "eva_time" ? "EVA time" : check.resource === "energy" ? "Energy" : "Consumable";
  return { label, unit, scale };
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

function BarChart({ items, max, ariaLabel }: { items: Seg[]; max: number; ariaLabel: string }) {
  const m = Math.max(max, 0.0001);
  return (
    <div className="space-y-2" role="img" aria-label={ariaLabel}>
      {items.map((it, i) => {
        const pct = clampPct((Math.max(0, it.value) / m) * 100);
        return (
          <div key={`${it.label}-${i}`} className="space-y-0.5">
            <div className="flex items-center justify-between gap-2 text-[11px]">
              <span className="truncate">{it.label}</span>
              <span className="tabular-nums text-muted-foreground">{fmt(it.value, 2)}</span>
            </div>
            <div className="h-2.5 w-full overflow-hidden rounded bg-muted">
              <div className="h-full rounded" style={{ width: `${pct}%`, background: it.color }} title={it.title ?? `${it.label}: ${fmt(it.value, 2)}`} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

function Legend({ items }: { items: { label: string; color: string }[] }) {
  return <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
    {items.map((it) => <span key={it.label} className="inline-flex items-center gap-1"><span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: it.color }} />{it.label}</span>)}
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
  const totals = result?.totals;
  const leg = selectedLeg === null ? null : result?.legs[selectedLeg];
  const insights = (result?.candidate_insights ?? []) as CandidateInsight[];
  const breakdown = result ? missionTimeBreakdown(result) : null;
  const sim = state.simulation;

  const consumed = sim?.state.consumed;
  const simRemainingChecks = sim?.remaining_checks ?? [];
  const initial = run?.report.result;

  const timeItems: Seg[] = breakdown ? [
    { label: "Outbound travel", value: breakdown.outbound_s / 60, color: "#ef4444" },
    { label: "Travel between sites", value: breakdown.inter_site_s / 60, color: "#f87171" },
    { label: "Science activities", value: breakdown.activity_s / 60, color: "#dc2626" },
    { label: "Return to base", value: breakdown.return_s / 60, color: "#b91c1c" },
    { label: "EVA overhead (declared)", value: breakdown.overhead_s / 60, color: "#991b1b" },
  ] : [];

  const selectedCount = insights.filter((i) => i.status === "SELECTED").length;
  const excludedCount = insights.filter((i) => i.status === "EXCLUDED").length;
  const infeasibleCount = insights.filter((i) => i.status === "INFEASIBLE").length;

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
      {totals && <dl className="grid grid-cols-4 gap-2">
        <div className="rounded border p-2"><dt className="text-[11px] text-muted-foreground">Sites</dt><dd className="text-base font-medium">{result.stops.length}/{scenario.sites.length}</dd></div>
        <div className="rounded border p-2"><dt className="text-[11px] text-muted-foreground">Time (planned)</dt><dd className="text-base font-medium">{minutes(totals.eva_time_s, 1)}</dd></div>
        <div className="rounded border p-2"><dt className="text-[11px] text-muted-foreground">Distance</dt><dd className="text-base font-medium">{fmt(totals.distance_m, 0)} m</dd></div>
        <div className="rounded border p-2"><dt className="text-[11px] text-muted-foreground">Utility</dt><dd className="text-base font-medium">{fmt(result.utility, 2)}</dd></div>
      </dl>}

      {/* Graphs: time & resources */}
      {breakdown && totals && <details open className="rounded-lg border p-3">
        <summary className="cursor-pointer font-medium">Graphs: time & resources (modeled)</summary>
        <div className="mt-3 grid gap-4 md:grid-cols-2">
          <div className="space-y-2">
            <p className="text-xs font-medium">Mission time distribution (min)</p>
            <BarChart items={timeItems} max={Math.max(...timeItems.map((i) => i.value), 1)} ariaLabel="Mission time distribution" />
            <p className="text-[11px] text-muted-foreground">Total {minutes(breakdown.total_s, 1)} · Order: {result.stops.length ? `BASE→${result.stops.map((s) => s.site_id).join("→")}→BASE` : "BASE→BASE"}</p>
          </div>

          <div className="space-y-2">
            <p className="text-xs font-medium">Planned resource usage vs budget</p>
            <div className="space-y-3">
              {result.checks.map((check) => {
                const { label, unit, scale } = resourceMeta(check);
                const used = check.used / scale;
                const reserve = check.reserve / scale;
                const budget = check.budget / scale;
                const remain = Math.max(0, (check.budget - check.used) / scale);
                const items: Seg[] = [
                  { label: "Used", value: used, color: check.satisfied ? "#dc2626" : "#991b1b" },
                  { label: "Reserve", value: reserve, color: "#b91c1c" },
                  { label: "Remaining", value: remain, color: "#dc2626" },
                ];
                return <div key={check.resource} className="space-y-1">
                  <div className="flex justify-between text-[11px]"><span>{label}</span><span className={check.satisfied ? "text-muted-foreground" : "text-status-critical"}>{check.satisfied ? "OK" : "Violated"} · margin {fmt(check.margin / scale, 2)} {unit}</span></div>
                  <BarChart items={items} max={Math.max(budget, 1)} ariaLabel={`${label} planned usage`} />
                  <div className="text-[11px] text-muted-foreground">Used {fmt(used, 2)} / {fmt(budget, 2)} {unit} (reserve {fmt(reserve, 2)})</div>
                </div>;
              })}
              {scenario.budget.energy_budget_wh === null && <p className="text-[11px] text-muted-foreground">Energy: no budget limit (not plotted).</p>}
              {scenario.budget.consumable_budget === null && <p className="text-[11px] text-muted-foreground">Consumable: no budget limit (not plotted).</p>}
            </div>
            <Legend items={[{ label: "Used", color: "#ef4444" }, { label: "Reserve", color: "#b91c1c" }, { label: "Remaining", color: "#dc2626" }]} />
          </div>
        </div>

        {/* Simulation reduction graph */}
        {sim && consumed && <div className="mt-4 space-y-2 border-t pt-3">
          <p className="text-xs font-medium">Resource reduction during simulation (actual consumed vs available)</p>
          <p className="text-[11px] text-muted-foreground">Elapsed {minutes(sim.state.elapsed_s, 1)} · completed {sim.state.completed_sites.length} site(s). “Consumed” from simulation state; “remaining” from current checks.</p>
          <div className="grid gap-3 md:grid-cols-3">
            {([
              { key: "eva_time" as const, label: "EVA time", consumed: consumed.eva_time_s / 60, unit: "min", planned: (initial?.totals?.eva_time_s ?? 0) / 60, budget: (result.checks.find((c) => c.resource === "eva_time")?.budget ?? 0) / 60, remainingCheck: simRemainingChecks.find((c) => c.resource === "eva_time") },
              { key: "energy" as const, label: "Energy", consumed: consumed.energy_wh, unit: "Wh", planned: initial?.totals?.energy_wh ?? 0, budget: result.checks.find((c) => c.resource === "energy")?.budget ?? (scenario.budget.energy_budget_wh ?? 0), remainingCheck: simRemainingChecks.find((c) => c.resource === "energy") },
              { key: "consumable" as const, label: `Consumable${scenario.budget.consumable_unit ? ` (${scenario.budget.consumable_unit})` : ""}`, consumed: consumed.consumable, unit: scenario.budget.consumable_unit ?? "units", planned: initial?.totals?.consumable ?? 0, budget: result.checks.find((c) => c.resource === "consumable")?.budget ?? (scenario.budget.consumable_budget ?? 0), remainingCheck: simRemainingChecks.find((c) => c.resource === "consumable") },
            ]).map((r) => {
              if (r.budget <= 0 && r.consumed <= 0 && r.planned <= 0) return null;
              const max = Math.max(r.budget, r.planned, r.consumed, 1);
              const remaining = r.remainingCheck ? Math.max(0, r.remainingCheck.available - r.remainingCheck.used) : Math.max(0, r.budget - r.consumed);
              const items: Seg[] = [
                { label: "Consumed", value: r.consumed, color: "#ef4444" },
                { label: "Remaining (modeled)", value: remaining, color: "#dc2626" },
              ];
              const reductionPct = r.budget > 0 ? clampPct((r.consumed / r.budget) * 100) : (r.planned > 0 ? clampPct((r.consumed / r.planned) * 100) : 0);
              return <div key={r.key} className="rounded border p-2 space-y-1">
                <div className="flex justify-between text-[11px] font-medium"><span>{r.label}</span><span>{fmt(reductionPct, 1)}% used</span></div>
                <BarChart items={items} max={max} ariaLabel={`${r.label} consumed vs remaining`} />
                <div className="text-[11px] text-muted-foreground">Consumed {fmt(r.consumed, 2)} / planned {fmt(r.planned, 2)}{r.budget > 0 ? ` / budget ${fmt(r.budget, 2)}` : ""} {r.unit}</div>
              </div>;
            })}
          </div>
          <Legend items={[{ label: "Consumed", color: "#ef4444" }, { label: "Remaining", color: "#dc2626" }]} />
        </div>}

        {/* Per-destination and candidate distribution charts */}
        <div className="mt-4 grid gap-4 md:grid-cols-2 border-t pt-3">
          {result.stops.length > 0 && <div className="space-y-2">
            <p className="text-xs font-medium">Per-destination contribution (utility, modeled)</p>
            <BarChart items={result.stops.map((s) => ({ label: s.site_id, value: s.utility, color: "#7f1d1d", title: `${s.site_id}: ${fmt(s.utility, 3)} utility, ${minutes(s.activity_s, 0)} activity` }))} max={Math.max(...result.stops.map((x) => x.utility), 1)} ariaLabel="Per-destination utility" />
          </div>}
          <div className="space-y-2">
            <p className="text-xs font-medium">Travel time per leg (min)</p>
            <BarChart items={result.legs.map((l) => ({ label: `${l.from}→${l.to}`, value: l.time_s / 60, color: l.to === "BASE" ? "#b91c1c" : "#f87171", title: `${l.from}→${l.to}: ${fmt(l.time_s / 60, 2)} min, ${fmt(l.distance_m, 0)} m` }))} max={Math.max(...result.legs.map((x) => x.time_s / 60), 1)} ariaLabel="Travel time per leg" />
          </div>
        </div>

        {insights.length > 0 && <div className="mt-4 space-y-2 border-t pt-3">
          <p className="text-xs font-medium">Candidate selection distribution</p>
          <BarChart items={[
            { label: "Selected", value: selectedCount, color: "#dc2626" },
            { label: "Excluded (feasible)", value: excludedCount, color: "#b91c1c" },
            { label: "Infeasible", value: infeasibleCount, color: "#ef4444" },
          ]} max={Math.max(selectedCount + excludedCount + infeasibleCount, 1)} ariaLabel="Candidate selection distribution" />
          <Legend items={[
            { label: `Selected ${selectedCount}`, color: "#dc2626" },
            { label: `Excluded ${excludedCount}`, color: "#b91c1c" },
            { label: `Infeasible ${infeasibleCount}`, color: "#ef4444" },
          ]} />
        </div>}

        <p className="mt-3 text-[11px] text-muted-foreground">Graphs show modeled estimates from declared assumptions/planner results, not certified rates or observations.</p>
      </details>}

      {/* Condensed details */}
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
                : item.to === "BASE" && <span className="ml-2 text-muted-foreground">Return to base</span>}
            </li>;
          })}
        </ol>
        {leg && <p className="mt-2 text-xs text-muted-foreground">Selected leg {leg.from} → {leg.to}: ascent {fmt(leg.ascent_m, 1)} m · descent {fmt(leg.descent_m, 1)} m · max slope {fmt(leg.max_slope_deg, 1)}° · {fmt(run.report.planning_grid.cell_x_m, 1)} m cells (DTM-derived, not certified safe).</p>}
      </details>}

      {insights.length > 0 && <details className="rounded-lg border p-3">
        <summary className="cursor-pointer font-medium">Candidate insights (why selected/excluded)</summary>
        <p className="mt-2 text-[11px] text-muted-foreground">Engine-derived from routing/resource checks. Feasible-but-unselected: lower utility trade-off within limits.</p>
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
                {insight.standalone_eva_time_s != null && <p>Standalone round trip (min): {fmt(insight.standalone_distance_m, 0)} m, travel {minutes(insight.standalone_travel_time_s ?? 0, 1)}, EVA {minutes(insight.standalone_eva_time_s, 1)}.</p>}
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

      <details className="rounded-lg border p-3">
        <summary className="cursor-pointer font-medium">Mission insights (summary)</summary>
        <div className="mt-2 space-y-1 text-[11px] text-muted-foreground">
          <p><strong>Plan:</strong> {result.stops.length ? `${result.stops.length} stop(s) · utility ${fmt(result.utility, 3)} · ${STATUS[result.status]}` : `No stops · ${STATUS[result.status]}`}</p>
          <p><strong>Constraints:</strong> return-to-base required; limits/reserves enforced when declared; terrain must be known and within slope limit (model).</p>
          <p><strong>Basis:</strong> actual routing, resource, reserve checks and utility trade-offs (engine-derived).</p>
          <p><strong>Uncertainty:</strong> declared assumptions/DTM-derived estimates; not flight-certified safety guidance.</p>
          {result.status !== "FEASIBLE_MODELED" && <p className="text-status-critical"><strong>Infeasible:</strong> review reasons/insights before assuming mission is possible.</p>}
        </div>
      </details>

      <details className="text-xs text-muted-foreground"><summary className="cursor-pointer">Method & limitations</summary>
        <p className="mt-2">{result.solver.description}</p>
        {run.report.disclaimers.map((text, i) => <p key={i} className="mt-1">{text}</p>)}
      </details>
    </>}
  </section>;
}