import { clock, fmt, minutes } from "@/lib/format";
import type { ConstraintCheck, MissionResult } from "@/lib/types";

export function ResourceBars({ checks }: { checks: ConstraintCheck[] }) {
  return <div className="space-y-4" aria-label="Resource budget charts">
    <div className="flex flex-wrap gap-3 text-[11px] text-muted-foreground">
      <span><i className="mr-1 inline-block size-2 rounded-sm bg-red-500" />Used</span>
      <span><i className="mr-1 inline-block size-2 rounded-sm bg-muted" />Free margin</span>
      <span><i className="mr-1 inline-block size-2 rounded-sm border border-dashed border-foreground/70" />Reserved</span>
    </div>
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
