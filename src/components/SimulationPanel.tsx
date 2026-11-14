import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api, errorText } from "@/lib/api";
import { fmt, minutes } from "@/lib/format";
import type { CellRef, ContingencyEvent, LocalPoint, MissionAction, ResourceKind, SimulationMission } from "@/lib/types";

export function SimulationPanel({ mission: m, busy, picked, onAction, onReset, onPreview }: {
  mission: SimulationMission; busy: boolean; picked: LocalPoint | null;
  onAction: (action: MissionAction) => void; onReset: () => void; onPreview: (cells: CellRef[]) => void;
}) {
  const [kind, setKind] = useState<"BLOCK_CELLS" | "DELAY" | "RESOURCE_ADJUSTMENT">("BLOCK_CELLS");
  const [radius, setRadius] = useState(12);
  const [seconds, setSeconds] = useState(120);
  const [amount, setAmount] = useState(20);
  const [resource, setResource] = useState<ResourceKind>("ENERGY");
  const [reason, setReason] = useState("User-defined contingency");
  const [cells, setCells] = useState<CellRef[]>([]);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [centre, setCentre] = useState<LocalPoint | null>(picked);
  const [exact, setExact] = useState(true);
  const request = useRef(0);
  useEffect(() => { setCentre(picked); }, [picked]);
  useEffect(() => {
    const id = ++request.current;
    setCells([]); onPreview([]); setPreviewError(null);
    if (kind === "BLOCK_CELLS" && centre && Number.isFinite(radius)) {
      void api.previewBlockage(centre, radius).then((value) => {
        if (id !== request.current) return;
        setCells(value); onPreview(value);
      }, (e) => { if (id === request.current) setPreviewError(errorText(e)); });
    }
    return () => { request.current++; };
  }, [kind, centre, radius, onPreview]);

  const returned = m.phase.phase === "RETURNED";
  const pending = m.plan.stops.filter((s) => !m.completed.includes(s.site_id));
  const projectedUtility = m.utility_earned + pending.reduce((sum, s) => sum + s.utility, 0);
  const budget = m.adjusted_budget;
  const balance = [
    ["Time", m.used.eva_time_s / 60, (budget.eva_limit_s - m.used.eva_time_s) / 60, "min"],
    ["Energy", m.used.energy_wh, budget.energy_budget_wh === null ? null : budget.energy_budget_wh - m.used.energy_wh, "Wh"],
    ["Consumable", m.used.consumable, budget.consumable_budget === null ? null : budget.consumable_budget - m.used.consumable, budget.consumable_unit ?? "units"],
  ] as const;
  const inject = () => {
    let event: ContingencyEvent;
    if (kind === "BLOCK_CELLS") event = { kind, cells, reason };
    else if (kind === "DELAY") event = { kind, seconds, reason };
    else event = { kind, resource, amount, reason };
    onAction({ kind: "INJECT", dataset_id: m.scenario.dataset_id, event });
  };

  return <section aria-label="Mission simulation" className="space-y-4 text-sm">
    <div className="flex items-center justify-between"><h2 className="font-medium">Simulate · MODELED</h2>
      <Button size="sm" variant="outline" disabled={busy} onClick={onReset}>Reset simulation</Button></div>
    <p role="status" className={!m.plan_valid ? "font-semibold text-status-critical" : "text-xs"}>
      {returned ? "Returned to original base" : !m.plan_valid ? (m.plan.status === "INFEASIBLE" ? "INFEASIBLE — no modeled return" : "Plan invalidated — replan required")
        : m.phase.phase === "WORKING" ? `Activity at ${m.plan.stops[m.phase.leg_index]?.site_id}`
          : m.phase.phase === "OVERHEAD" ? "Start overhead pending" : m.phase.phase === "TRAVELING" ? `Travel to ${m.plan.legs[m.phase.leg_index]?.to}` : "Returned"}
    </p>
    <p className="text-xs">{m.completed.length} completed · {pending.length} remaining · elapsed {minutes(m.used.eva_time_s, 1)}<br />
      Current: {fmt(m.position.x_m, 1)} E / {fmt(m.position.y_m, 1)} N (m)</p>
    <div className="flex gap-2">
      <Button size="sm" disabled={busy || !m.plan_valid || returned} onClick={() => onAction({ kind: "ADVANCE", steps: 1 })}>Next waypoint / activity</Button>
      <Button size="sm" variant="outline" disabled={busy || !m.plan_valid || returned} onClick={() => onAction({ kind: "ADVANCE", steps: 25 })}>+25 steps</Button>
    </div>
    <p className="text-[11px] text-muted-foreground">One step walks one computed grid edge, or executes a whole activity/overhead. No off-route interpolation.</p>
    <table className="w-full text-left text-xs"><caption className="sr-only">Simulated spent and remaining physical balances before reserves</caption>
      <thead><tr><th>Resource</th><th>Spent</th><th>Left (before reserve)</th></tr></thead>
      <tbody>{balance.map(([name, spent, left, unit]) => <tr key={name}><th className="py-1 font-normal">{name}</th><td>{fmt(spent, 3)}</td><td>{left === null ? "No limit" : `${fmt(left, 3)} ${unit}`}</td></tr>)}</tbody>
    </table>
    <details open={!m.plan_valid} className="space-y-2">
      <summary className="cursor-pointer font-medium">Inject event · USER_DEFINED</summary>
      <fieldset disabled={busy || returned} className="mt-2 space-y-2">
        <label className="grid gap-1 text-xs">Event type<select className="rounded border bg-background p-2" value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
          <option value="BLOCK_CELLS">Block traversal cells</option><option value="DELAY">Delay at standing load</option><option value="RESOURCE_ADJUSTMENT">Resource loss</option>
        </select></label>
        {kind === "BLOCK_CELLS" ? <>
          <p className="text-xs text-muted-foreground">Click terrain to choose the centre; outlined cells are the exact Rust preview. Unknown, steep and occupied cells are rejected.</p>
          <div className="grid grid-cols-2 gap-2">{(["x_m", "y_m"] as const).map((key) => <label key={key} className="text-xs">{key === "x_m" ? "Centre east (m)" : "Centre north (m)"}
            <Input type="number" step="any" value={centre?.[key] ?? ""} onChange={(e) => setCentre({ ...(centre ?? m.position), [key]: e.currentTarget.valueAsNumber })} /></label>)}</div>
          <label className="grid gap-1 text-xs">Radius (m), 0–100<Input type="number" min={0} max={100} value={Number.isFinite(radius) ? radius : ""} onChange={(e) => setRadius(e.currentTarget.valueAsNumber)} /></label>
          <p className="text-xs">{cells.length} cells selected · temporary routing overlay only</p>
          {previewError && <p role="alert" className="text-xs text-status-warning">{previewError}</p>}
        </> : kind === "DELAY" ? <>
          <label className="grid gap-1 text-xs">Delay (seconds)<Input type="number" min={0} value={Number.isFinite(seconds) ? seconds : ""} onChange={(e) => setSeconds(e.currentTarget.valueAsNumber)} /></label>
          <p className="text-xs text-muted-foreground">Consumes time, declared base power and activity-rate consumable; no equipment activity load.</p>
        </> : <div className="grid grid-cols-2 gap-2">
          <label className="grid gap-1 text-xs">Resource<select className="rounded border bg-background p-2" value={resource} onChange={(e) => setResource(e.target.value as ResourceKind)}>
            <option value="ENERGY">Energy (Wh)</option><option value="CONSUMABLE">Consumable ({budget.consumable_unit ?? "no unit set"})</option><option value="EVA_TIME">Time allowance (s)</option>
          </select></label>
          <label className="grid gap-1 text-xs">Loss amount<Input type="number" min={0} step="any" value={Number.isFinite(amount) ? amount : ""} onChange={(e) => setAmount(e.currentTarget.valueAsNumber)} /></label>
        </div>}
        <label className="grid gap-1 text-xs">Reason<Input value={reason} onChange={(e) => setReason(e.target.value)} /></label>
        <Button size="sm" variant="outline" type="button" disabled={kind === "BLOCK_CELLS" ? !cells.length : kind === "DELAY" ? !Number.isFinite(seconds) || seconds <= 0 : !Number.isFinite(amount) || amount < 0} onClick={inject}>Confirm event</Button>
      </fieldset>
    </details>
    <div className="space-y-2 border-t pt-3"><label className="flex gap-2 text-xs"><input type="checkbox" checked={exact} disabled={busy} onChange={(e) => setExact(e.target.checked)} />Bounded fixed-duration optimizer</label>
      <Button disabled={busy || returned} onClick={() => onAction({ kind: "REPLAN", exact })}>Replan from here</Button></div>
    <details open={m.revisions.length > 0}><summary className="cursor-pointer font-medium">Before / after · USER_DEFINED utility</summary>
      <p className="mt-2 text-xs">Initial {fmt(m.original_plan.utility, 3)} → {m.plan_valid ? fmt(projectedUtility, 3) : "unavailable"} projected · earned {fmt(m.utility_earned, 3)}</p>
      <p className="text-xs">Completed: {m.completed.join(", ") || "none"}<br />Retained: {pending.filter((s) => m.original_plan.stops.some((p) => p.site_id === s.site_id)).map((s) => s.site_id).join(", ") || "none"}<br />Dropped: {m.revisions.at(-1)?.dropped.join(", ") || "none"}</p>
      <p className="mt-2 text-xs font-medium">Estimated return margins at last solve (after reserves)</p>
      {m.plan.checks.map((c) => <p key={c.resource} className="text-xs">{c.resource}: {fmt(c.margin, 3)} {c.unit} · {c.satisfied ? "modeled constraint met" : "VIOLATED"}</p>)}
      {m.plan.issues.map((i, n) => <p key={n} className="mt-1 text-xs text-status-warning">{i.message}</p>)}
      {m.plan.excluded.map((s) => <p key={s.site_id} className="mt-1 text-xs">{s.site_id}: {s.reason}</p>)}
    </details>
    <details className="text-xs"><summary className="cursor-pointer">Events & itinerary</summary>
      {m.events.map((e, i) => <p key={i} className="mt-1">{i + 1}. {e.kind}: {e.kind === "BLOCK_CELLS" ? `${e.cells.length} cells` : e.kind === "DELAY" ? `${e.seconds} s` : `${e.amount} ${e.resource}`} · {e.reason}</p>)}
      {m.plan.legs.map((l, i) => <p key={i} className="mt-1">{l.from} → {l.to} · {fmt(l.distance_m)} m</p>)}
      <p className="mt-2">{m.plan.solver.description}</p>
    </details>
  </section>;
}
