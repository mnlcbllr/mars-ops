import { Button } from "@/components/ui/button";
import { clock, fmt, minutes } from "@/lib/format";
import type { MissionState } from "@/lib/mission";
import type { ConstraintCheck, PlanStatus } from "@/lib/types";

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

export function MissionResults({ state, selectedLeg, onSelectLeg }: {
  state: MissionState;
  selectedLeg: number | null;
  onSelectLeg: (index: number | null) => void;
}) {
  const { run, phase, validation, error, exportPath } = state;
  const result = run?.report.result;
  const issues = result?.issues ?? validation?.issues ?? [];
  const totals = result?.totals;
  const leg = selectedLeg === null ? null : result?.legs[selectedLeg];

  return <section aria-label="Mission results" className="max-h-[42vh] shrink-0 space-y-3 overflow-y-auto border-t bg-background px-4 py-3 text-sm" aria-busy={phase !== "idle"}>
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
        <div><dt className="text-xs text-muted-foreground">Sites visited</dt><dd className="text-lg font-medium">{result.stops.length} / {run.report.scenario.sites.length}</dd></div>
        <div><dt className="text-xs text-muted-foreground">Round-trip distance</dt><dd className="text-lg font-medium">{fmt(totals.distance_m)} m</dd></div>
        <div><dt className="text-xs text-muted-foreground">EVA used</dt><dd className="text-lg font-medium">{minutes(totals.eva_time_s, 1)}</dd></div>
        <div><dt className="text-xs text-muted-foreground">Preference utility (modeled)</dt><dd className="text-lg font-medium">{fmt(result.utility, 2)}</dd></div>
      </dl>}
      {totals && <details>
        <summary className="cursor-pointer font-medium">Resource checks & itinerary</summary>
        <p className="my-2 text-xs text-muted-foreground">Travel {minutes(totals.travel_time_s, 1)} · activities {minutes(totals.activity_time_s, 1)} · overhead {minutes(totals.overhead_s, 1)} · energy {fmt(totals.energy_wh, 1)} Wh · consumable {fmt(totals.consumable, 3)} {run.report.scenario.budget.consumable_unit}</p>
        <div className="overflow-x-auto"><table className="w-full text-left text-xs">
          <caption className="sr-only">Resource constraints; margin is additional allowance after preserving the reserve</caption>
          <thead><tr>{["Resource", "Used", "Budget", "Reserved", "Margin after reserve", "Check"].map((title) => <th key={title} className="border-b py-1 pr-3">{title}</th>)}</tr></thead>
          <tbody>{result.checks.map((check) => {
            const { label, scale, unit } = resource(check);
            return <tr key={check.resource}>
              <th scope="row" className="py-1 pr-3 font-normal">{label} ({unit})</th>
              {[check.used, check.budget, check.reserve, check.margin].map((value, i) => <td key={i} className="pr-3 tabular-nums">{fmt(value / scale, 3)}</td>)}
              <td>{check.satisfied ? "Pass" : "Violated"}</td>
            </tr>;
          })}</tbody>
        </table></div>
        {run.report.scenario.budget.energy_budget_wh === null && <p className="mt-1 text-xs">Energy: no limit set (not constrained).</p>}
        {run.report.scenario.budget.consumable_budget === null && <p className="mt-1 text-xs">Consumable: no limit set (not constrained).</p>}
        <ol aria-label="Round-trip itinerary" className="mt-3 space-y-2">
          {result.legs.map((item, index) => {
            const stop = result.stops.find((stop) => stop.site_id === item.to);
            return <li key={index} className="text-xs">
              <Button type="button" size="sm" variant={selectedLeg === index ? "secondary" : "ghost"} aria-pressed={selectedLeg === index}
                onClick={() => onSelectLeg(selectedLeg === index ? null : index)}>
                {index + 1}. {item.from} → {item.to} · {fmt(item.distance_m)} m · {minutes(item.time_s, 1)}
              </Button>
              {stop ? <span className="ml-2 text-muted-foreground">Arrive {clock(stop.arrive_s)} · work {minutes(stop.activity_s, 1)} · depart {clock(stop.depart_s)}</span>
                : item.to === "BASE" && <span className="ml-2 text-muted-foreground">Return to base</span>}
            </li>;
          })}
        </ol>
      </details>}
      {leg && <p className="text-xs">Selected leg {leg.from} → {leg.to}: ascent {fmt(leg.ascent_m, 1)} m · descent {fmt(leg.descent_m, 1)} m · maximum derived slope {fmt(leg.max_slope_deg, 1)}° · {fmt(run.report.planning_grid.cell_x_m, 1)} m planning cells.</p>}
      {result.excluded.length > 0 && <details open={result.status !== "FEASIBLE_MODELED"}>
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
