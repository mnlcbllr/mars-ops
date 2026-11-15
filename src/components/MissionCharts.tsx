import { clock, fmt, minutes } from "@/lib/format";
import { INK_DARK, INK_LIGHT, ROUTE, ROUTE_SOFT, WARNING } from "@/lib/theme";
import type {
  CandidateInsight, ConstraintCheck, LocalPoint, MissionResult, ScientificSite,
} from "@/lib/types";

export function ResourceBars({ checks, compact = false }: { checks: ConstraintCheck[]; compact?: boolean }) {
  return <div className={compact ? "space-y-2" : "space-y-4"} aria-label="Resource budget charts">
    {!compact && <div className="flex flex-wrap gap-3 text-[11px] text-muted-foreground">
      <span><i className="mr-1 inline-block size-2 rounded-sm bg-route" />Used</span>
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
          <div className="absolute inset-y-0 left-0 bg-route" style={{ width: pct(check.used) }} />
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
        <span><i className="mr-1 inline-block size-2 rounded-sm bg-route" />Travel {minutes(totals.travel_time_s, 1)}</span>
        <span><i className="mr-1 inline-block size-2 rounded-sm bg-route-soft" />Activity {minutes(totals.activity_time_s, 1)}</span>
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
              <span className="absolute inset-y-0 rounded-sm bg-route" style={{ left: pct(start), width: pct(leg.time_s) }} />
              {stop && <span className="absolute inset-y-0 rounded-sm bg-route-soft" style={{ left: pct(arrival), width: pct(stop.activity_s) }} />}
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
  SELECTED: "bg-route",
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
        {plannedPct > 0 && <div className="absolute inset-y-0 left-0 rounded-sm bg-route-soft" style={{ width: `${plannedPct}%` }} />}
      </div>
    </div>
    <div>
      <div className="flex justify-between gap-2 text-xs">
        <span className="font-medium">Priority</span>
        <span className="tabular-nums text-muted-foreground">{fmt(site.preference_weight, 2)}</span>
      </div>
      <div role="img" aria-label={priorityDescription} title={priorityDescription} className="relative mt-1 h-3 rounded bg-muted/40">
        <div className="absolute inset-y-0 left-0 rounded-sm bg-route/70"
          style={{ width: `${Math.min(Math.max(site.preference_weight / Math.max(maxPriority, 1e-9), 0), 1) * 100}%` }} />
      </div>
    </div>
  </div>;
}

/** Top-view schematic of the planned route: base square, numbered stops, hollow left-out sites. */
export function RouteGraph({ base, sites, result, dropped = [], selectedLeg, onSelectLeg, previewSiteId, onPreviewSite }: {
  base: LocalPoint;
  sites: ScientificSite[];
  result: MissionResult;
  /** Sites dropped mid-simulation, ringed in warning colour. */
  dropped?: readonly string[];
  selectedLeg: number | null;
  onSelectLeg: (index: number | null) => void;
  previewSiteId?: string | null;
  onPreviewSite?: (point: { x_m: number; y_m: number }, label: string) => void;
}) {
  const order = new Map(result.stops.map((stop, index) => [stop.site_id, index + 1]));
  const stopById = new Map(result.stops.map((stop) => [stop.site_id, stop]));
  const excluded = new Map(result.excluded.map((e) => [e.site_id, e.reason]));
  const droppedSet = new Set(dropped);
  type Node = { id: string; kind: "base" | "stop" | "left_out"; x_m: number; y_m: number; name: string; order: number; title: string };
  const nodes: Node[] = [{
    id: "BASE", kind: "base", x_m: base.x_m, y_m: base.y_m, name: "Base", order: 0, title: "Base",
  }];
  for (const site of sites) {
    const visit = order.get(site.id);
    const stop = stopById.get(site.id);
    if (visit !== undefined && stop) {
      nodes.push({ id: site.id, kind: "stop", x_m: site.position.x_m, y_m: site.position.y_m, name: site.name, order: visit,
        title: `${site.id} · ${site.name} · stop ${visit} · arrive ${clock(stop.arrive_s)} · work ${minutes(stop.activity_s, 1)} · depart ${clock(stop.depart_s)} · utility ${fmt(stop.utility, 2)}` });
    } else {
      const reason = excluded.get(site.id);
      nodes.push({ id: site.id, kind: "left_out", x_m: site.position.x_m, y_m: site.position.y_m, name: site.name, order: 0,
        title: `${site.id} · ${site.name} — not in the plan${reason ? `: ${reason}` : ""}` });
    }
  }
  const byId = new Map(nodes.map((node) => [node.id, node]));

  // Fit the site layout into a fixed box, north up, centred.
  const W = 320, H = 150, PAD = 16, GAP = 11;
  const xs = nodes.map((node) => node.x_m), ys = nodes.map((node) => node.y_m);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const scale = Math.min((W - 2 * PAD) / Math.max(maxX - minX, 1), (H - 2 * PAD) / Math.max(maxY - minY, 1), 2);
  const cx = (W - (maxX - minX) * scale) / 2;
  const cy = (H - (maxY - minY) * scale) / 2;
  const px = (x_m: number) => cx + (x_m - minX) * scale;
  const py = (y_m: number) => cy + (maxY - y_m) * scale;

  const description = result.stops.length === 0
    ? "Base with no stops"
    : ["Base", ...result.stops.map((stop) => stop.site_id), "Base"].join(" → ");
  return <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} aria-label={`Top-view route map: ${description}`}
    className="shrink-0 rounded border bg-muted/30">
    <defs>
      <marker id="route-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5.5" markerHeight="5.5" orient="auto-start-reverse">
        <path d="M0,0 L10,5 L0,10 z" fill={ROUTE} />
      </marker>
    </defs>
    {result.legs.map((leg, index) => {
      const a = byId.get(leg.from), b = byId.get(leg.to);
      if (!a || !b) return null;
      const ax = px(a.x_m), ay = py(a.y_m), bx = px(b.x_m), by = py(b.y_m);
      const dx = bx - ax, dy = by - ay;
      const length = Math.hypot(dx, dy) || 1;
      const x1 = ax + (dx / length) * GAP, y1 = ay + (dy / length) * GAP;
      const x2 = bx - (dx / length) * GAP, y2 = by - (dy / length) * GAP;
      const selected = selectedLeg === index;
      const title = `${leg.from} → ${leg.to}: ${fmt(leg.distance_m)} m · travel ${minutes(leg.time_s, 1)} · ascent ${fmt(leg.ascent_m, 0)} m`;
      return <g key={index}>
        <title>{title}</title>
        <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="transparent" strokeWidth={12} className="cursor-pointer"
          onClick={() => onSelectLeg(selected ? null : index)} />
        <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={ROUTE} strokeWidth={selected ? 3.5 : 2}
          markerEnd="url(#route-arrow)" className="pointer-events-none"
          opacity={selectedLeg === null || selected ? 1 : 0.5} />
      </g>;
    })}
    {nodes.map((node) => {
      const x = px(node.x_m), y = py(node.y_m);
      const preview = onPreviewSite && node.kind !== "base"
        ? () => onPreviewSite({ x_m: node.x_m, y_m: node.y_m }, `${node.id} · ${node.name}`) : undefined;
      return <g key={node.id} className={preview ? "cursor-pointer" : undefined} onClick={preview}>
        <title>{node.title}</title>
        {node.kind === "base" && <>
          <rect x={x - 8} y={y - 8} width={16} height={16} fill={INK_DARK} stroke={INK_LIGHT} strokeWidth={1} />
          <text x={x} y={y + 3.5} textAnchor="middle" fontSize={10} fontWeight={700} fill={INK_LIGHT}>B</text>
        </>}
        {node.kind === "stop" && <>
          <circle cx={x} cy={y} r={9} fill={ROUTE} stroke={previewSiteId === node.id ? WARNING : INK_LIGHT} strokeWidth={previewSiteId === node.id ? 2.5 : 1.5} />
          <text x={x} y={y + 3.5} textAnchor="middle" fontSize={10} fontWeight={700} fill={INK_LIGHT}>{node.order}</text>
          <text x={x + 13} y={y + 3.5} fontSize={10} fontWeight={600} fill={INK_LIGHT} stroke={INK_DARK} strokeWidth={3} paintOrder="stroke">{node.id}</text>
        </>}
        {node.kind === "left_out" && <>
          <circle cx={x} cy={y} r={8} fill="none" stroke={INK_LIGHT} strokeOpacity={0.65} strokeWidth={1.5} strokeDasharray="3 2" />
          <text x={x + 12} y={y + 3.5} fontSize={10} fill={INK_LIGHT} stroke={INK_DARK} strokeWidth={3} paintOrder="stroke" opacity={0.8}>{node.id}</text>
        </>}
        {droppedSet.has(node.id) && <circle cx={x} cy={y} r={12} fill="none" stroke={WARNING} strokeWidth={1.5} strokeDasharray="2 2" />}
      </g>;
    })}
    <text x={W - 6} y={H - 6} textAnchor="end" fontSize={9} fill={ROUTE_SOFT}>{fmt((maxX - minX) / 1000, 1)} × {fmt((maxY - minY) / 1000, 1)} km</text>
  </svg>;
}
