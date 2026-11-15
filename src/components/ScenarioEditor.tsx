import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api, errorText } from "@/lib/api";
import { editCoefficient, type CoefficientKey, type MissionState } from "@/lib/mission";
import type { MissionScenario, PlanSummary, ResourceBudget } from "@/lib/types";

function NumberField({ label, value, onChange, scale = 1, optional = false }: {
  label: string;
  value: number | null;
  onChange: (value: number) => void;
  scale?: number;
  optional?: boolean;
}) {
  return <label className="grid gap-1 text-xs text-muted-foreground">
    {label}
    <Input type="number" min={0} step="any" required={!optional}
      value={value !== null && Number.isFinite(value) ? value / scale : ""}
      onChange={(event) => onChange(event.currentTarget.valueAsNumber * scale)} />
  </label>;
}

const COEFFICIENTS: [CoefficientKey, string, number][] = [
  ["max_slope_deg", "Slope limit", 1],
  ["flat_speed_m_s", "Flat-ground speed", 1],
  ["slope_time_penalty", "Slope time penalty", 1],
  ["overhead_s", "EVA overhead", 60],
  ["base_power_w", "Base power", 1],
  ["consumable_rate_travel_per_h", "Travel consumable rate", 1],
  ["consumable_rate_activity_per_h", "Activity consumable rate", 1],
];

interface ScenarioEditorProps {
  state: MissionState;
  placingBase: boolean;
  datasetId: string;
  /** True while a simulation holds a frozen copy of the scenario. */
  locked: boolean;
  onPlaceBase: () => void;
  onChange: (scenario: MissionScenario) => void;
  onSavePlan: () => void;
  onLoadPlan: (scenario: MissionScenario) => void;
  onRun: () => void;
}

export function ScenarioEditor({
  state, placingBase, datasetId, locked, onPlaceBase,
  onChange, onSavePlan, onLoadPlan, onRun,
}: ScenarioEditorProps) {
  const { scenario, phase } = state;
  const { budget } = scenario;
  const updateBudget = (values: Partial<ResourceBudget>) => onChange({ ...scenario, budget: { ...budget, ...values } });
  const nullable = (value: number) => Number.isNaN(value) ? null : value;

  // Saved plans are listed on demand: fresh on every open, so a just-saved plan shows up.
  const [plans, setPlans] = useState<PlanSummary[] | null>(null);
  const [planError, setPlanError] = useState<string | null>(null);
  const openPlanList = (open: boolean) => {
    if (!open) { setPlans(null); return; }
    setPlanError(null);
    void api.listPlans().then(setPlans, (failure) => setPlanError(errorText(failure)));
  };
  const load = (file: string) => {
    setPlanError(null);
    void api.loadPlan(file).then(onLoadPlan, (failure) => setPlanError(errorText(failure)));
  };

  return <form id="mission-scenario" onSubmit={(event) => { event.preventDefault(); onRun(); }}
    onInvalidCapture={(event) => {
      // Native validation must be able to focus an invalid input in a collapsed section.
      let parent = (event.target as HTMLElement).parentElement;
      while (parent) {
        if (parent instanceof HTMLDetailsElement) parent.open = true;
        parent = parent.parentElement;
      }
    }}>
    <fieldset disabled={phase !== "idle" || locked} className="space-y-5">
      <legend className="mb-2 font-medium">Mission scenario</legend>
      {locked && <p className="rounded-lg border border-status-warning/60 p-2 text-xs">Simulation active. The scenario is frozen; reset the simulation to edit it.</p>}
      <p className="text-xs text-muted-foreground">Resource values and science preferences are user-defined assumptions.</p>
      <label className="grid gap-1 text-xs text-muted-foreground">Scenario name
        <Input required value={scenario.name} onChange={(event) => onChange({ ...scenario, name: event.target.value })} />
      </label>
      <section className="space-y-2" aria-label="Base location">
        <div className="grid grid-cols-2 gap-2">
          <NumberField label="Base east (m)" value={scenario.base.x_m}
            onChange={(x_m) => onChange({ ...scenario, base: { ...scenario.base, x_m } })} />
          <NumberField label="Base north (m)" value={scenario.base.y_m}
            onChange={(y_m) => onChange({ ...scenario, base: { ...scenario.base, y_m } })} />
        </div>
        <Button type="button" size="sm" variant="outline" aria-pressed={placingBase} onClick={onPlaceBase}>
          {placingBase ? "Cancel base placement" : "Place base on map"}
        </Button>
      </section>
      <section className="space-y-2" aria-label="Resource budgets">
        <h2 className="font-medium">Budgets & reserves</h2>
        <div className="grid grid-cols-2 gap-2">
          <NumberField label="EVA limit (min)" value={budget.eva_limit_s} scale={60} onChange={(eva_limit_s) => updateBudget({ eva_limit_s })} />
          <NumberField label="EVA reserve (min)" value={budget.eva_reserve_s} scale={60} onChange={(eva_reserve_s) => updateBudget({ eva_reserve_s })} />
          <NumberField label="Energy budget (Wh, optional)" value={budget.energy_budget_wh} optional
            onChange={(value) => updateBudget({ energy_budget_wh: nullable(value) })} />
          <NumberField label="Energy reserve (Wh)" value={budget.energy_reserve_wh} optional
            onChange={(value) => updateBudget({ energy_reserve_wh: nullable(value) })} />
          <NumberField label={`Consumable budget (${budget.consumable_unit ?? "units"}, optional)`} value={budget.consumable_budget} optional
            onChange={(value) => updateBudget({ consumable_budget: nullable(value) })} />
          <NumberField label={`Consumable reserve (${budget.consumable_unit ?? "units"})`} value={budget.consumable_reserve} optional
            onChange={(value) => updateBudget({ consumable_reserve: nullable(value) })} />
        </div>
        <p className="text-xs text-muted-foreground">Clear both budget and reserve to leave a resource unconstrained; a blank reserve with a budget means zero.</p>
        {budget.energy_budget_wh === null && <p className="text-xs text-status-warning">{budget.energy_reserve_wh === null ? "No energy limit set." : "Energy reserve needs a budget."}</p>}
        {budget.consumable_budget === null && <p className="text-xs text-status-warning">{budget.consumable_reserve === null ? "No consumable limit set." : "Consumable reserve needs a budget."}</p>}
      </section>
      <section className="space-y-2" aria-label="Saved plans">
        <h2 className="font-medium">Save &amp; load plan</h2>
        <div className="flex items-center gap-2">
          <Button type="button" size="sm" variant="outline" onClick={onSavePlan}>Save plan</Button>
          {state.savePath && <span className="min-w-0 break-all text-xs text-muted-foreground">Saved to {state.savePath}</span>}
        </div>
        <details className="text-xs" onToggle={(event) => openPlanList(event.currentTarget.open)}>
          <summary className="cursor-pointer text-muted-foreground">Load a saved plan</summary>
          {planError && <p role="alert" className="mt-2 text-status-warning">{planError}</p>}
          {plans !== null && plans.length === 0 && <p className="mt-2 text-muted-foreground">No saved plans yet.</p>}
          <ul className="mt-2 space-y-1">
            {plans?.map((plan) => <li key={plan.file} className="flex items-center justify-between gap-2">
              <span className="min-w-0 break-all text-muted-foreground">{plan.name}</span>
              {plan.dataset_id === datasetId
                ? <Button type="button" size="sm" variant="ghost" onClick={() => load(plan.file)}>Load</Button>
                : <span className="shrink-0 text-muted-foreground">other dataset</span>}
            </li>)}
          </ul>
        </details>
        <p className="text-xs text-muted-foreground">A saved plan is the scenario only — load it, then run.</p>
      </section>
      <details className="space-y-2">
        <summary className="cursor-pointer font-medium">Model assumptions</summary>
        <p className="text-xs text-muted-foreground">User-defined, not certified astronaut rates. Editing a coefficient marks it USER_DEFINED and clears its original uncertainty range.</p>
        <div className="grid grid-cols-2 gap-2">
          {COEFFICIENTS.map(([key, label, scale]) => <div key={key}>
            <NumberField label={`${label} (${scale === 60 ? "min" : scenario.model[key].unit})`} value={scenario.model[key].value} scale={scale}
              onChange={(value) => onChange(editCoefficient(scenario, key, value))} />
            <p className="mt-1 text-[10px] text-muted-foreground">{scenario.model[key].source_type}</p>
          </div>)}
        </div>
        <details className="text-xs text-muted-foreground"><summary className="cursor-pointer">Assumption sources</summary>
          {COEFFICIENTS.map(([key, label]) => <p key={key} className="mt-2"><strong>{label}:</strong> {scenario.model[key].citation_or_assumption}</p>)}
        </details>
      </details>
      <p className="text-xs text-muted-foreground">Priorities are modeled preferences, not measured value. Edits clear the previous plan and are session-only; save or export JSON to keep them.</p>
    </fieldset>
  </form>;
}
