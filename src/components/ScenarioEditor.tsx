import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { editCoefficient, type CoefficientKey, type MissionState } from "@/lib/mission";
import type { MissionScenario, ResourceBudget, ScientificSite } from "@/lib/types";

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
  onPlaceBase: () => void;
  onChange: (scenario: MissionScenario) => void;
  onToggleSite: (id: string) => void;
  onRun: () => void;
}

export function ScenarioEditor({ state, placingBase, onPlaceBase, onChange, onToggleSite, onRun }: ScenarioEditorProps) {
  const { scenario, selected, phase } = state;
  const { budget } = scenario;
  const updateBudget = (values: Partial<ResourceBudget>) => onChange({ ...scenario, budget: { ...budget, ...values } });
  const updateSite = (id: string, values: Partial<ScientificSite>) => onChange({
    ...scenario, sites: scenario.sites.map((site) => site.id === id ? { ...site, ...values } : site),
  });
  const nullable = (value: number) => Number.isNaN(value) ? null : value;

  return <form id="mission-scenario" onSubmit={(event) => { event.preventDefault(); onRun(); }}
    onInvalidCapture={(event) => {
      // Native validation must be able to focus an invalid input in a collapsed section.
      let parent = (event.target as HTMLElement).parentElement;
      while (parent) {
        if (parent instanceof HTMLDetailsElement) parent.open = true;
        parent = parent.parentElement;
      }
    }}>
    <fieldset disabled={phase !== "idle"} className="space-y-5">
      <legend className="mb-2 font-medium">Mission scenario</legend>
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
        <p className="text-xs text-muted-foreground">To leave a resource unconstrained, clear both its budget and reserve. A blank reserve with a declared budget means zero.</p>
        {budget.energy_budget_wh === null && <p className="text-xs text-status-warning">{budget.energy_reserve_wh === null ? "No energy limit set." : "Energy reserve needs a budget."}</p>}
        {budget.consumable_budget === null && <p className="text-xs text-status-warning">{budget.consumable_reserve === null ? "No consumable limit set." : "Consumable reserve needs a budget."}</p>}
      </section>
      <section className="space-y-2" aria-label="Candidate science sites">
        <h2 className="font-medium">Candidate sites · {selected.size} selected</h2>
        <p className="text-xs text-muted-foreground">Selected sites are candidates, not required stops. The planner may exclude them.</p>
        {scenario.sites.map((site) => <div key={site.id} className="rounded-lg border p-2.5">
          <label className="flex items-start gap-2 text-sm">
            <input className="mt-1" type="checkbox" checked={selected.has(site.id)} onChange={() => onToggleSite(site.id)} />
            <span>{site.id} · {site.name}</span>
          </label>
          <details className="mt-2 text-xs">
            <summary className="cursor-pointer text-muted-foreground">Activity & priority · {site.evidence_kind}</summary>
            <fieldset disabled={!selected.has(site.id)} className="mt-2 grid grid-cols-2 gap-2">
              <NumberField label={`${site.id} minimum activity (min)`} value={site.activity_min_s} scale={60}
                onChange={(activity_min_s) => updateSite(site.id, { activity_min_s })} />
              <NumberField label={`${site.id} maximum activity (min)`} value={site.activity_max_s} scale={60}
                onChange={(activity_max_s) => updateSite(site.id, { activity_max_s })} />
              <NumberField label={`${site.id} preference weight`} value={site.preference_weight}
                onChange={(preference_weight) => updateSite(site.id, { preference_weight })} />
              <NumberField label={`${site.id} activity power (W)`} value={site.activity_power_w}
                onChange={(activity_power_w) => updateSite(site.id, { activity_power_w })} />
            </fieldset>
            <p className="mt-2 text-muted-foreground">{site.science_rationale}</p>
          </details>
        </div>)}
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
      <p className="text-xs text-muted-foreground">Preferences are modeled mission-designer priorities, not measured scientific value. Edits clear the previous plan and are session-only; export JSON to retain the solved scenario.</p>
    </fieldset>
  </form>;
}
