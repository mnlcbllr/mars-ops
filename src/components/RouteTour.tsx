import { Button } from "@/components/ui/button";
import { clock, fmt, minutes } from "@/lib/format";
import { geologyAt, type GeologicUnit } from "@/lib/geology";
import { routeSteps } from "@/lib/routeTour";
import type { MissionReport, ScientificSite } from "@/lib/types";

export function RouteTour({ report, geology, active, focusedSite, playing, onSelect, onPlay, onClear, canPlay, onGlobe = false }: {
  report: MissionReport | undefined;
  geology: GeologicUnit[];
  active: number | null;
  focusedSite: ScientificSite | undefined;
  playing: boolean;
  onSelect: (index: number) => void;
  onPlay: () => void;
  onClear: () => void;
  canPlay: boolean;
  onGlobe?: boolean;
}) {
  const steps = routeSteps(report?.result ?? null, report?.scenario.sites ?? []);
  const current = active == null ? undefined : steps[active];
  const site = focusedSite ?? current?.site;
  const unit = site ? geologyAt(geology, site.position) : undefined;
  const exclusion = site && report?.result.excluded.find((item) => item.site_id === site.id);
  if (!steps.length && !site) return null;

  return <section aria-label="Route preview" className="shrink-0 space-y-2 border-t bg-background px-4 py-2 text-xs">
    <div className="flex flex-wrap items-center gap-2">
      <h2 className="mr-1 text-sm font-semibold">Route preview</h2>
      {steps.length > 0 && <>
        <Button size="sm" variant="secondary" onClick={onPlay} disabled={!canPlay}>{playing ? "Stop playback" : onGlobe ? "Play route on globe" : "Play route in 3D"}</Button>
        <ol aria-label="Route stops" className="flex flex-wrap gap-1">
          {steps.map(({ index, label, visit }) => <li key={index}>
            <Button size="sm" variant={index === active ? "default" : "outline"} aria-pressed={index === active}
              onClick={() => onSelect(index)} title={label} aria-label={visit ? `Stop ${visit.number}: ${label}` : label}>
              {visit ? `Stop ${visit.number}` : label}
            </Button>
          </li>)}
        </ol>
      </>}
      {(current || focusedSite) && <Button size="sm" variant="ghost" className="ml-auto" onClick={onClear}>Clear selection</Button>}
    </div>
    {(current || site) && <div className="max-h-24 space-y-1 overflow-y-auto">
      <p className="font-medium">{site?.name ?? current?.label}</p>
      {site && <p>{site.science_rationale}</p>}
      {unit && <p><strong>Regional geology:</strong> {unit.name} ({unit.symbol}) · USGS SIM 3464, 1:75,000. Approximate map context.</p>}
      {exclusion && <p><strong>Not on this plan:</strong> {exclusion.reason}</p>}
      {current?.visit && <p><strong>In the modeled plan:</strong> arrival {clock(current.visit.stop.arrive_s)} · {minutes(current.visit.stop.activity_s, 1)} on site · scenario priority {fmt(current.site?.preference_weight, 1)}. The planner trades off priority and added EVA time within resource limits.</p>}
      {current?.leg.to === "BASE" && !focusedSite && <p>The round trip ends at the scenario base. Review resource checks below for the modeled reserves.</p>}
      {current && report && <p className="text-muted-foreground">{current.leg.from} → {current.leg.to} · {fmt(current.leg.distance_m)} m · {minutes(current.leg.time_s, 1)} travel · {fmt(current.leg.max_slope_deg, 1)}° max modeled slope / {fmt(report.scenario.model.max_slope_deg.value, 1)}° scenario limit</p>}
    </div>}
    {playing && <p className="text-muted-foreground">Illustrative playback · not real EVA timing</p>}
  </section>;
}
