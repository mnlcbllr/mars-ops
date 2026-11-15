import { useMemo, useState } from "react";
import { TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { clock, fmt, minutes } from "@/lib/format";
import { simPlanStale, type MissionState } from "@/lib/mission";
import type {
  ConstraintCheck, ContingencyKind, LocalPoint, ResourceKind, SimulationView,
} from "@/lib/types";

const PHASE: Record<SimulationView["state"]["phase"], string> = {
  TRAVEL: "Walking the planned leg",
  ACTIVITY: "Science activity in progress",
  COMPLETE: "Back at base",
  INFEASIBLE: "INFEASIBLE: no modeled return",
};

const CHECK_LABEL: Record<string, string> = {
  eva_time: "EVA time",
  energy: "Energy",
  consumable: "Consumable",
};

const RESOURCE_LABEL: Record<ResourceKind, string> = {
  EVA_TIME: "EVA time (min)",
  ENERGY: "Energy (Wh)",
  CONSUMABLE: "Consumable (units)",
};

function checkValues(check: ConstraintCheck) {
  const scale = check.resource === "eva_time" ? 60 : 1;
  return {
    label: CHECK_LABEL[check.resource] ?? check.resource,
    unit: check.resource === "eva_time" ? "min" : check.unit,
    used: check.used / scale,
    available: check.available / scale,
    margin: check.margin / scale,
  };
}

function EventHistory({ view }: { view: SimulationView }) {
  const events = view.state.events;
  if (events.length === 0) return <p className="text-xs text-muted-foreground">No events injected.</p>;
  return <ol className="space-y-1 text-xs">
    {events.map((event) => <li key={event.id}>
      <span className="font-medium">#{event.id} · {clock(event.at_elapsed_s)}</span>{" "}
      {event.kind.type === "DELAY" ? `Delay ${minutes(event.kind.seconds, 1)}`
        : event.kind.type === "RESOURCE_LOSS" ? `Loss ${fmt(event.kind.amount, 1)} ${RESOURCE_LABEL[event.kind.resource].replace(/ \(.*\)/, "")}`
        : event.kind.type === "BLOCK_CORRIDOR" ? `Blocked corridor r=${fmt(event.kind.radius_m, 0)} m`
        : `Blocked ${event.kind.cells.length} cells`}
    </li>)}
  </ol>;
}

export function SimulationPanel({ state, blockCenter, pickingBlock, radius, onRadius, onPickBlockCenter, onCancelBlockPick, onStart, onAdvance, onAdvanceToStop, onReplan, onReset, onInject }: {
  state: MissionState;
  blockCenter: LocalPoint | null;
  pickingBlock: boolean;
  radius: number;
  onRadius: (radius: number) => void;
  onPickBlockCenter: () => void;
  onCancelBlockPick: () => void;
  onStart: () => void;
  onAdvance: (seconds: number) => void;
  onAdvanceToStop: () => void;
  onReplan: () => void;
  onReset: () => void;
  onInject: (kind: ContingencyKind) => void;
}) {
  const { run, simulation, phase, simulationBusy, error } = state;
  const [delayMin, setDelayMin] = useState(20);
  const [lossKind, setLossKind] = useState<ResourceKind>("EVA_TIME");
  const [lossAmount, setLossAmount] = useState(5);
  const busy = phase !== "idle" || simulationBusy;
  const settled = simulation !== null
    && (simulation.state.phase === "COMPLETE" || simulation.state.phase === "INFEASIBLE");
  const initial = run?.report.result;
  const view = simulation;
  const current = view?.state.plan;

  const lossSeconds = lossKind === "EVA_TIME" ? lossAmount * 60 : lossAmount;

  const dropped = initial?.stops
    .map((stop) => stop.site_id)
    .filter((id) => !view?.state.completed_sites.includes(id)
      && !current?.stops.some((stop) => stop.site_id === id)) ?? [];

  // Replan signals while the drill is still moving: a remaining check now
  // violates its limit, the modeled return to base is missing/unaffordable,
  // or a contingency was injected after the last plan (stale plan).
  const planStale = useMemo(
    () => (view && run ? simPlanStale(run.run_id, view.state) : false),
    [view, run],
  );
  const replanReasons = view && !settled ? [
    ...view.remaining_checks.filter((c) => !c.satisfied)
      .map((c) => `${CHECK_LABEL[c.resource] ?? c.resource} limit exceeded`),
    ...(view.return_margin_s === null ? ["no modeled return route"] : []),
    ...(view.return_margin_s !== null && view.return_margin_s < 0 ? ["return exceeds EVA limit"] : []),
    ...(planStale ? ["plan out of date — contingency since last plan"] : []),
  ] : [];

  return <section aria-label="Mission simulation" className="space-y-3 border-t pt-4">
    <div className="flex items-center justify-between gap-2">
      <h2 className="font-medium">Simulation</h2>
      {view && <span className="text-xs text-muted-foreground">{phase === "validating" ? "validating" : simulationBusy ? "working" : "session state"}</span>}
    </div>

    {!run && <p className="text-xs text-muted-foreground">Run the mission first; the drill locks the scenario.</p>}

    {run && !view && <>
      <p className="text-xs text-muted-foreground">Walk the route, inject events, replan from your position.</p>
      <Button type="button" size="sm" disabled={busy || !run} onClick={onStart}>Start simulation</Button>
    </>}

    {view && <>
      <div className={view.state.phase === "INFEASIBLE" ? "rounded-lg border border-status-critical p-2.5 text-xs" : "rounded-lg border p-2.5 text-xs"} role="status">
        <p className="font-medium">{PHASE[view.state.phase]}</p>
        <p className="mt-1 text-muted-foreground">{clock(view.state.elapsed_s)} elapsed · position {fmt(view.position.x_m, 1)} E, {fmt(view.position.y_m, 1)} N</p>
        <p className="text-muted-foreground">Progress on active leg {fmt(view.leg_progress * 100, 0)}% · {view.state.completed_sites.length} of {initial?.stops.length ?? 0} planned stops done · replans {view.state.replans}</p>
        <dl className="mt-2 grid grid-cols-2 gap-2">
          <div><dt className="text-muted-foreground">Modeled return margin</dt><dd className="font-medium">{view.return_margin_s === null ? "none modeled" : minutes(view.return_margin_s, 1)}</dd></div>
          <div><dt className="text-muted-foreground">Completed utility</dt><dd className="font-medium">{fmt(view.state.completed.reduce((sum, stop) => sum + stop.utility, 0), 2)} <span className="font-normal text-muted-foreground">USER_DEFINED</span></dd></div>
        </dl>
      </div>

      {replanReasons.length > 0 && <div role="alert" className="flex items-start gap-2 rounded-lg border border-status-warning bg-status-warning/10 p-2.5 text-xs">
        <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-status-warning" />
        <div>
          <p className="font-medium text-status-warning">Replan advised</p>
          <p className="text-muted-foreground">{replanReasons.join(" · ")}</p>
        </div>
      </div>}

      {error && <p role="alert" className="text-xs text-status-critical">{error}</p>}

      <div className="flex flex-wrap gap-1.5">
        <Button type="button" size="sm" variant="outline" disabled={busy || settled} onClick={() => onAdvance(15 * 60)}>+15 min</Button>
        <Button type="button" size="sm" variant="outline" disabled={busy || settled} onClick={() => onAdvance(30 * 60)}>+30 min</Button>
        <Button type="button" size="sm" disabled={busy || settled} onClick={onAdvanceToStop}
          title="Advance to the next arrival or activity completion">Next boundary</Button>
        <Button type="button" size="sm" variant="secondary" disabled={busy || settled} onClick={onReplan}>Replan from here</Button>
        <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={onReset}>Reset</Button>
      </div>

      {current && current.status !== "FEASIBLE_MODELED" && <div role="alert" className="space-y-1 rounded-lg border border-status-critical p-2.5 text-xs">
        <p className="font-medium">{current.status === "INFEASIBLE" ? "Replan reports INFEASIBLE" : "Replan lacks data coverage"}</p>
        <ul className="space-y-0.5 text-muted-foreground">
          {current.issues.filter((issue) => issue.severity === "ERROR").map((issue, i) => <li key={`${issue.code}-${i}`}>{issue.message}</li>)}
          {current.issues.every((issue) => issue.severity !== "ERROR") && <li>No route satisfies the declared time, energy, consumable and reserve limits from this position.</li>}
        </ul>
      </div>}

      <details className="text-xs">
        <summary className="cursor-pointer font-medium">Resources &amp; route comparison</summary>
        <table className="mt-2 w-full text-left text-xs">
          <caption className="sr-only">Consumption so far against the remaining modeled budget</caption>
          <thead><tr>{["Resource", "Used", "Available", "Margin", "Check"].map((title) => <th key={title} className="border-b py-1 pr-2">{title}</th>)}</tr></thead>
          <tbody>{view.remaining_checks.map((check) => {
            const value = checkValues(check);
            return <tr key={check.resource}>
              <th scope="row" className="py-1 pr-2 font-normal">{value.label} ({value.unit})</th>
              <td className="pr-2 tabular-nums">{fmt(value.used, 1)}</td>
              <td className="pr-2 tabular-nums">{fmt(value.available, 1)}</td>
              <td className="pr-2 tabular-nums">{fmt(value.margin, 1)}</td>
              <td>{check.satisfied ? "Pass" : "Violated"}</td>
            </tr>;
          })}</tbody>
        </table>
        <dl className="mt-2 grid grid-cols-2 gap-2">
          <div><dt className="text-muted-foreground">Initial plan utility</dt><dd>{fmt(initial?.utility, 2)} · {initial?.stops.length ?? 0} sites</dd></div>
          <div><dt className="text-muted-foreground">Current plan utility</dt><dd>{fmt(current?.utility, 2)} · {current?.stops.length ?? 0} sites</dd></div>
        </dl>
        <table className="mt-2 w-full text-left text-xs">
          <caption className="sr-only">Initial itinerary totals compared with the current remaining itinerary</caption>
          <thead><tr>{["Itinerary", "Distance", "EVA", "Energy"].map((title) => <th key={title} className="border-b py-1 pr-2">{title}</th>)}</tr></thead>
          <tbody>
            <tr>
              <th scope="row" className="py-1 pr-2 font-normal">Initial, whole mission</th>
              <td className="pr-2 tabular-nums">{fmt(initial?.totals?.distance_m)} m</td>
              <td className="pr-2 tabular-nums">{minutes(initial?.totals?.eva_time_s ?? Number.NaN, 1)}</td>
              <td className="tabular-nums">{fmt(initial?.totals?.energy_wh, 1)} Wh</td>
            </tr>
            <tr>
              <th scope="row" className="py-1 pr-2 font-normal">Current, remaining route</th>
              <td className="pr-2 tabular-nums">{fmt(current?.totals?.distance_m)} m</td>
              <td className="pr-2 tabular-nums">{minutes(current?.totals?.eva_time_s ?? Number.NaN, 1)}</td>
              <td className="tabular-nums">{fmt(current?.totals?.energy_wh, 1)} Wh</td>
            </tr>
          </tbody>
        </table>
        {dropped.length > 0 && <p className="mt-2"><strong>Dropped since the initial plan:</strong> {dropped.join(", ")}</p>}
        {view.state.completed_sites.length > 0 && <p className="mt-1"><strong>Completed:</strong> {view.state.completed_sites.join(", ")}</p>}
        {current && current.excluded.length > 0 && <ul className="mt-2 space-y-0.5 text-muted-foreground">
          {current.excluded.map((site) => <li key={`${site.site_id}-${site.code}`}><strong>{site.site_id}:</strong> {site.reason}</li>)}
        </ul>}
      </details>

      <details className="text-xs" open={view.state.phase === "INFEASIBLE"}>
        <summary className="cursor-pointer font-medium">Inject event</summary>
        <div className="mt-2 space-y-3">
          <fieldset className="space-y-1.5" disabled={busy || settled}>
            <legend className="text-muted-foreground">Blocked corridor (temporary)</legend>
            <div className="flex items-center gap-1.5">
              <Button type="button" size="sm" variant="outline" onClick={pickingBlock ? onCancelBlockPick : onPickBlockCenter}>
                {pickingBlock ? "Cancel map pick" : "Pick centre on map"}
              </Button>
              <span className="text-muted-foreground">{blockCenter ? `${fmt(blockCenter.x_m, 1)} E, ${fmt(blockCenter.y_m, 1)} N` : "no centre"}</span>
            </div>
            <label className="flex items-center gap-2 text-muted-foreground">Radius
              <Input type="number" min={1} max={1000} step="any" value={radius} className="w-24"
                onChange={(event) => onRadius(event.currentTarget.valueAsNumber)} /> m
            </label>
            <Button type="button" size="sm" variant="secondary"
              disabled={!blockCenter || !(radius > 0)}
              onClick={() => onInject({ type: "BLOCK_CORRIDOR", center: blockCenter!, radius_m: radius })}>
              Block corridor
            </Button>
            <p className="text-muted-foreground">Blocks cells for routing only; dataset unchanged.</p>
          </fieldset>

          <fieldset className="space-y-1.5 border-t pt-2" disabled={busy || settled}>
            <legend className="text-muted-foreground">Delay at the current position</legend>
            <label className="flex items-center gap-2 text-muted-foreground">Minutes
              <Input type="number" min={1} max={1440} step="any" value={delayMin} className="w-24"
                onChange={(event) => setDelayMin(event.currentTarget.valueAsNumber)} />
            </label>
            <Button type="button" size="sm" variant="secondary" disabled={!(delayMin > 0)}
              onClick={() => onInject({ type: "DELAY", seconds: delayMin * 60 })}>Add delay</Button>
          </fieldset>

          <fieldset className="space-y-1.5 border-t pt-2" disabled={busy || settled}>
            <legend className="text-muted-foreground">Reduce a modeled budget</legend>
            <label className="grid gap-1 text-muted-foreground">Resource
              <select className="h-8 rounded-lg border bg-transparent px-2 text-sm" value={lossKind}
                onChange={(event) => { const kind = event.currentTarget.value as ResourceKind; setLossKind(kind); setLossAmount(kind === "EVA_TIME" ? 5 : 25); }}>
                {(Object.keys(RESOURCE_LABEL) as ResourceKind[]).map((kind) => <option key={kind} value={kind}>{RESOURCE_LABEL[kind]}</option>)}
              </select>
            </label>
            <label className="flex items-center gap-2 text-muted-foreground">Amount
              <Input type="number" min={0} step="any" value={lossAmount} className="w-24"
                onChange={(event) => setLossAmount(event.currentTarget.valueAsNumber)} />
              {lossKind === "EVA_TIME" ? "min" : RESOURCE_LABEL[lossKind].replace(/.*\((.*)\)/, "$1")}
            </label>
            <Button type="button" size="sm" variant="secondary" disabled={!(lossAmount > 0)}
              onClick={() => onInject({ type: "RESOURCE_LOSS", resource: lossKind, amount: lossSeconds })}>
              Apply loss
            </Button>
            <p className="text-muted-foreground">Model input, not an observation. A reserve can make the rest infeasible.</p>
          </fieldset>
          <p className="text-[10px] text-muted-foreground">Stored as {fmt(lossSeconds, 1)} s.</p>
        </div>
      </details>

      <details className="text-xs">
        <summary className="cursor-pointer font-medium">Event history ({view.state.events.length})</summary>
        <div className="mt-2"><EventHistory view={view} /></div>
        <p className="mt-2 text-muted-foreground">Events are part of the exported record.</p>
      </details>
    </>}
  </section>;
}
