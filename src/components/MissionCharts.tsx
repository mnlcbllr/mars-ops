import { clock, fmt, minutes } from "@/lib/format";
import type { CandidateInsight, ConstraintCheck, MissionResult, ScientificSite } from "@/lib/types";

export function ResourceBars({ checks, compact = false }: { checks: ConstraintCheck[]; compact?: boolean }) {
  return <div className={compact ? "space-y-2" : "space-y-4"} aria-label="Resource budget charts">
    {!compact && <div className="flex flex-wrap gap-3 text-[11px] text-muted-foreground">
      <span><i className="mr-1 inline-block size-2 rounded-sm bg-red-500" />Used</span>
      <span><i className="mr-1 inline-block size-2 rounded-sm bg-muted" />Free margin</span>
      <span><i className="mr-1 inline-block size-2 rounded-sm border border-dashed border-foreground/70" />Reserved</span>
    </div>}
    {checks.map((check) => {
      const scale = check.resource === "eva_time" ? 60 : 1;
      const unit = check.resource === "eva_time" ? "min" : check.unit;
      const label = check.resource === "eva_time" ? "EVA time" : check.resource === "energy" ? "Energy" : "Consumable";
      const span = Math.max(check.budget, check.used, 1e-9);
      const pct = (value: number) => `${Math.max(0, value) / span * 100}%`;
      const description = `${label}: used ${fmt(check.used / scale, 2)} of ${fmt(check.budget / scale, 2)} ${unit}; reserve ${fmt(check.reserve / scale, 2)}; margin ${fmt(check.margin / scale, 2)}; ${check.satisfied ? "Pass" : "Violated"}`;
      return <div key={check.resource} className="space-y-1.5">
        <div className="flex justify-between gap-2 text-xs">
          <span className="font-medium">{label}</span>
          <span className="tabular-nums text-muted-foreground">{fmt(check.used / scale, 2)} / {fmt(check.budget / scale, 2)} {unit}</span>
        </div>
        <div role="img" aria-label={description} title={description} className="relative h-5 overflow-hidden rounded bg-muted">
          <div className="absolute inset-y-0 left-0 bg-red-500" style={{ width: pct(check.used) }} />
          <div className="absolute inset-y-0 border border-dashed border-foreground/70"
            style={{ left: pct(check.available), width: pct(check.reserve) }} />
          {!check.satisfied && <div className="absolute inset-y-0 border-l-2 border-status-warning" style={{ left: pct(check.budget) }} />}
        </div>
        <div className="flex justify-between gap-2 text-[11px] text-muted-foreground">
          <span className={check.satisfied ? "" : "font-medium text-status-critical"}>
            {check.satisfied ? "Pass · margin" : "Violated · margin"} {fmt(check.margin / scale, 2)} {unit}
          </span>
          <span>Reserve {fmt(check.reserve / scale, 2)} {unit}</span>
        </div>
      </div>;
    })}
  </div>;
}

export function MissionCharts({ result, selectedLeg, onSelectLeg }: {
  result: MissionResult;
  selectedLeg: number | null;
  onSelectLeg: (index: number | null) => void;
}) {
  const totals = result.totals;
  if (!totals) return null;
  const span = Math.max(totals.eva_time_s, 1e-9);
  const pct = (value: number) => `${Math.max(0, value) / span * 100}%`;
  let elapsed = totals.overhead_s;
  return <div className="grid gap-3 lg:grid-cols-2">
    <section className="rounded-lg border p-3" aria-label="Planned resource budgets">
      <h3 className="mb-3 text-xs font-medium">Resource budgets · modeled</h3>
      <ResourceBars checks={result.checks} />
      {result.checks.length === 0 && <p className="text-xs text-muted-foreground">No resource checks reported.</p>}
    </section>
    <section className="rounded-lg border p-3" aria-label="Mission timeline chart">
      <div className="mb-3 flex items-baseline justify-between gap-2">
        <h3 className="text-xs font-medium">Mission timeline</h3>
        <span className="text-xs tabular-nums text-muted-foreground">{minutes(totals.eva_time_s, 1)}</span>
      </div>
      <div className="mb-3 flex flex-wrap gap-3 text-[11px] text-muted-foreground">
        <span><i className="mr-1 inline-block size-2 rounded-sm bg-red-500" />Travel {minutes(totals.travel_time_s, 1)}</span>
        <span><i className="mr-1 inline-block size-2 rounded-sm bg-rose-300" />Activity {minutes(totals.activity_time_s, 1)}</span>
        <span><i className="mr-1 inline-block size-2 rounded-sm bg-muted-foreground" />Overhead {minutes(totals.overhead_s, 1)}</span>
      </div>
      <div className="space-y-1.5">
        {totals.overhead_s > 0 && <div className="grid grid-cols-[7rem_1fr] items-center gap-2 px-1 text-[11px]">
          <span className="text-muted-foreground">Start overhead</span>
          <div role="img" aria-label={`Start overhead: ${minutes(totals.overhead_s, 1)}`} className="h-3 rounded bg-muted/40">
            <div className="h-full rounded bg-muted-foreground" style={{ width: pct(totals.overhead_s) }} />
          </div>
        </div>}
        {result.legs.map((leg, index) => {
          const start = elapsed;
          const stop = result.stops.find((s) => s.site_id === leg.to);
          const arrival = stop?.arrive_s ?? start + leg.time_s;
          elapsed = stop?.depart_s ?? arrival;
          const description = `${leg.from} → ${leg.to}: ${fmt(leg.distance_m)} m, travel ${minutes(leg.time_s, 1)}${stop ? `, activity ${minutes(stop.activity_s, 1)}` : ", return to base"}`;
          return <button key={index} type="button" aria-label={description} aria-pressed={selectedLeg === index}
            title={`${description} · ${clock(start)}–${clock(elapsed)}`}
            onClick={() => onSelectLeg(selectedLeg === index ? null : index)}
            className={`grid w-full grid-cols-[7rem_1fr] items-center gap-2 rounded p-1 text-left text-[11px] outline-none hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring ${selectedLeg === index ? "bg-muted ring-1 ring-foreground/40" : ""}`}>
            <span className="truncate">{leg.from} → {leg.to}</span>
            <span className="relative block h-5 rounded bg-muted/40" aria-hidden="true">
              <span className="absolute inset-y-0 rounded-sm bg-red-500" style={{ left: pct(start), width: pct(leg.time_s) }} />
              {stop && <span className="absolute inset-y-0 rounded-sm bg-rose-300" style={{ left: pct(arrival), width: pct(stop.activity_s) }} />}
            </span>
          </button>;
        })}
        <div className="ml-[7.75rem] flex justify-between text-[10px] tabular-nums text-muted-foreground">
          <span>0</span><span>{minutes(totals.eva_time_s / 2, 0)}</span><span>{minutes(totals.eva_time_s, 0)}</span>
        </div>
      </div>
    </section>
  </div>;
}

const GLANCE_FILL: Record<string, string> = {
  SELECTED: "bg-red-500",
  EXCLUDED: "bg-muted-foreground",
  INFEASIBLE: "bg-status-warning",
};

/** One bar per candidate: what a standalone round trip would cost against the EVA limit. */
export function CandidateGlance({ insights, evaLimitS }: { insights: CandidateInsight[]; evaLimitS: number }) {
  return <div className="space-y-1.5">
    <p className="text-[11px] font-medium">Candidates at a glance · standalone round-trip EVA vs limit</p>
    {insights.map((insight) => {
      const budgetMin = (insight.standalone_checks.find((check) => check.resource === "eva_time")?.budget ?? evaLimitS) / 60;
      const evaMin = insight.standalone_eva_time_s == null ? null : insight.standalone_eva_time_s / 60;
      const over = evaMin != null && evaMin > budgetMin;
      const width = evaMin == null || budgetMin <= 0 ? 0 : Math.min(evaMin / budgetMin, 1) * 100;
      const description = `${insight.site_id}: ${evaMin == null
        ? "no standalone route"
        : `standalone round trip ${fmt(evaMin, 1)} of ${fmt(budgetMin, 0)} min EVA${over ? " — over the limit" : ""}`}`;
      return <div key={insight.site_id} className="grid grid-cols-[2.75rem_1fr_auto] items-center gap-2 text-[11px]">
        <span className="font-medium">{insight.site_id}</span>
        <span className="relative h-2.5 rounded bg-muted/50" aria-hidden="true">
          {evaMin != null && <span className={`absolute inset-y-0 left-0 rounded ${over ? "bg-status-warning" : GLANCE_FILL[insight.status] ?? "bg-muted-foreground"}`}
            style={{ width: `${width}%` }} />}
        </span>
        <span className="tabular-nums text-muted-foreground" title={description}>
          {evaMin == null ? "no route" : `${fmt(evaMin, 1)} / ${fmt(budgetMin, 0)} min${over ? " · over limit" : ""}`}
          {insight.planned_utility > 0 && ` · ${fmt(insight.planned_utility, 2)} util`}
        </span>
      </div>;
    })}
  </div>;
}

/** Activity window and priority as proportional bars for one candidate site. */
export function ObjectiveBars({ site, plannedS, maxPriority }: {
  site: ScientificSite;
  plannedS: number;
  maxPriority: number;
}) {
  const span = Math.max(site.activity_max_s - site.activity_min_s, 1e-9);
  const plannedPct = plannedS > 0 ? Math.min(Math.max((plannedS - site.activity_min_s) / span, 0), 1) * 100 : 0;
  const windowLabel = `${fmt(site.activity_min_s / 60, 0)}–${fmt(site.activity_max_s / 60, 0)} min`;
  const activityDescription = `Activity window ${windowLabel}${plannedS > 0 ? `, planned ${minutes(plannedS, 1)}` : ""}`;
  const priorityDescription = `Priority ${fmt(site.preference_weight, 2)} against the highest candidate priority ${fmt(maxPriority, 2)}`;
  return <div className="space-y-2">
    <div>
      <div className="flex justify-between gap-2 text-xs">
        <span className="font-medium">Activity window</span>
        <span className="tabular-nums text-muted-foreground">{windowLabel}{plannedS > 0 ? ` · planned ${minutes(plannedS, 1)}` : ""}</span>
      </div>
      <div role="img" aria-label={activityDescription} title={activityDescription} className="relative mt-1 h-3 rounded bg-muted/40">
        {plannedPct > 0 && <div className="absolute inset-y-0 left-0 rounded-sm bg-rose-300" style={{ width: `${plannedPct}%` }} />}
      </div>
    </div>
    <div>
      <div className="flex justify-between gap-2 text-xs">
        <span className="font-medium">Priority</span>
        <span className="tabular-nums text-muted-foreground">{fmt(site.preference_weight, 2)}</span>
      </div>
      <div role="img" aria-label={priorityDescription} title={priorityDescription} className="relative mt-1 h-3 rounded bg-muted/40">
        <div className="absolute inset-y-0 left-0 rounded-sm bg-red-500/70"
          style={{ width: `${Math.min(Math.max(site.preference_weight / Math.max(maxPriority, 1e-9), 0), 1) * 100}%` }} />
      </div>
    </div>
  </div>;
}
