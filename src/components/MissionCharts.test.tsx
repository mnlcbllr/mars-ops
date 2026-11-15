import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { CandidateGlance, ObjectiveBars, ResourceBars, RouteGraph } from "./MissionCharts";
import type {
  CandidateInsight, ConstraintCheck, EvidenceKind, Exclusion, MissionResult,
  PlannedLeg, ScientificSite, Stop,
} from "@/lib/types";

const check: ConstraintCheck = { resource: "eva_time", unit: "s", used: 315 * 60, budget: 360 * 60,
  reserve: 45 * 60, available: 315 * 60, margin: 0, satisfied: true };

const insight: CandidateInsight = {
  site_id: "S1", status: "SELECTED", reachable_from_base: true, feasible_alone: true,
  explanation: "Selected: highest utility per EVA minute.", reason_code: null,
  terrain: "TRAVERSABLE", site_slope_deg: 3.4, standalone_distance_m: 2284,
  standalone_travel_time_s: 8136, standalone_eva_time_s: 135.6 * 60,
  standalone_checks: [{ resource: "eva_time", unit: "s", used: 135.6 * 60, budget: 360 * 60,
    reserve: 45 * 60, available: 315 * 60, margin: 179.42 * 60, satisfied: true }],
  planned_utility: 2.741, planned_activity_s: 32.9 * 60,
};

const site: ScientificSite = {
  id: "S1", name: "Delta West", position: { x_m: 120, y_m: -40 }, science_rationale: "clay exposure",
  source_product_ids: ["dtm"], evidence_kind: "OBSERVED" as EvidenceKind,
  activity_min_s: 30 * 60, activity_max_s: 60 * 60, activity_power_w: 60, preference_weight: 5,
};

test("budget bars keep the reserve separate and scale seconds to minutes", () => {
  const html = renderToStaticMarkup(<ResourceBars checks={[check]} />);
  expect(html).toContain("315.00 / 360.00 min");
  expect(html).toContain("Reserve 45.00 min");
  expect(html).toContain("Pass · margin 0.00 min");
  expect(html).toContain("width:87.5%");
  expect(html).toContain("left:87.5%;width:12.5%");
});

test("reserve violations remain visible, including a zero budget", () => {
  for (const row of [
    { ...check, used: 320 * 60, margin: -5 * 60, satisfied: false },
    { ...check, used: 60, budget: 0, reserve: 0, available: 0, margin: -60, satisfied: false },
  ]) {
    const html = renderToStaticMarkup(<ResourceBars checks={[row]} />);
    expect(html).toContain("Violated · margin −");
    expect(html).not.toContain("NaN");
    expect(html).not.toContain("Infinity");
  }
});

test("compact budget bars drop the legend but keep the numbers", () => {
  const html = renderToStaticMarkup(<ResourceBars checks={[check]} compact />);
  expect(html).toContain("315.00 / 360.00 min");
  expect(html).toContain("Reserve 45.00 min");
  expect(html).not.toContain(">Used</span>");
});

test("candidate glance ranks standalone round-trip cost against the EVA limit", () => {
  const noRoute: CandidateInsight = { ...insight, site_id: "S9", status: "INFEASIBLE",
    standalone_checks: [], standalone_eva_time_s: null, planned_utility: 0 };
  const html = renderToStaticMarkup(
    <CandidateGlance insights={[insight, noRoute]} evaLimitS={360 * 60} />);
  expect(html).toContain("135.6 / 360 min");
  expect(html).toContain("2.74 util");
  expect(html).toContain("no route");
  expect(html).not.toContain("NaN");
});

test("candidate objective bars show the activity window and priority", () => {
  const html = renderToStaticMarkup(
    <ObjectiveBars site={site} plannedS={32.9 * 60} maxPriority={5} />);
  expect(html).toContain("30–60 min · planned 32.9 min");
  expect(html).toContain("Priority");
  expect(html).toContain("5.00");
  expect(html).not.toContain("NaN");
});

const stop = (id: string, order: number): Stop => ({ site_id: id, arrive_s: 420 * order, activity_s: 60, depart_s: 480 * order, utility: 2.5 });

const leg = (from: string, to: string, distance: number): PlannedLeg => ({
  from, to, path: [], elevation_m: [], distance_m: distance, time_s: 600,
  ascent_m: 10, descent_m: 5, max_slope_deg: 8, cells_expanded: 42,
});

const routeResult: MissionResult = {
  status: "FEASIBLE_MODELED", solver: { name: "hyde", version: "1", description: "test" },
  stops: [stop("S1", 1), stop("S2", 2)], legs: [leg("BASE", "S1", 1200), leg("S1", "S2", 1500), leg("S2", "BASE", 900)],
  totals: null, checks: [], utility: 5, issues: [],
  excluded: [{ site_id: "S3", code: "TERRAIN", reason: "no traversable route" } as Exclusion],
  timing: { routing_ms: 1, planning_ms: 1, legs_routed: 3, cells_expanded: 42 },
};

test("route graph draws the planned loop, order numbers and left-out sites", () => {
  const html = renderToStaticMarkup(<RouteGraph base={{ x_m: 0, y_m: 0 }}
    sites={[
      site, { ...site, id: "S2", name: "Delta East", position: { x_m: 300, y_m: 200 } },
      { ...site, id: "S3", name: "Clay North", position: { x_m: -200, y_m: 400 } },
    ]}
    result={routeResult} selectedLeg={null} onSelectLeg={() => {}} />);
  expect(html).toContain("Top-view route map: Base → S1 → S2 → Base");
  expect(html).toContain("url(#route-arrow)");
  expect(html).toContain(">1</text>");
  expect(html).toContain(">2</text>");
  expect(html).toContain(">S3</text>");
  expect(html).toContain("no traversable route");
  expect(html).not.toContain("NaN");
});
