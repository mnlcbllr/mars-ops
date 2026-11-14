import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { RouteTour } from "./RouteTour";
import type { MissionReport, PlannedLeg, ScientificSite } from "@/lib/types";

const site = {
  id: "S1", name: "Mound bench", position: { x_m: 1, y_m: 1 },
  science_rationale: "Photograph the light-toned bench.", preference_weight: 5,
} as ScientificSite;
const incoming = { from: "BASE", to: "S1", distance_m: 80, time_s: 180, max_slope_deg: 12 } as PlannedLeg;
const report = {
  scenario: { sites: [site], model: { max_slope_deg: { value: 20 } } },
  result: {
    stops: [{ site_id: "S1", arrive_s: 200, activity_s: 600, depart_s: 800, utility: 1 }],
    legs: [incoming, { ...incoming, from: "S1", to: "BASE" }],
    excluded: [],
  },
} as unknown as MissionReport;
const render = (active: number, onGlobe = false) => renderToStaticMarkup(<RouteTour report={report} active={active}
  geology={[{ symbol: "NHjf2", name: "Jezero fan 2 unit", color: "#ffffff",
    polygons: [[[[0, 0], [4, 0], [4, 4], [0, 4]]]] }]}
  focusedSite={undefined} playing={false} canPlay onGlobe={onGlobe}
  onPlay={() => {}} onClear={() => {}} onSelect={() => {}} />);

test("science stop presents the proposed task, regional context and modeled approach", () => {
  const html = render(0);
  expect(html).toContain("Stop 1: Mound bench");
  expect(html).toContain("Photograph the light-toned bench.");
  expect(html).toContain("Jezero fan 2 unit");
  expect(html).toContain("20.0° scenario limit");
});

test("the return leg explains reserves without inventing a science stop", () => {
  const html = render(1);
  expect(html).toContain("The round trip ends at the scenario base.");
  expect(html).not.toContain("Photograph the light-toned bench.");
});

test("the replay button reflects the active map view", () => {
  expect(render(0, true)).toContain("Play route on globe");
  expect(render(0)).toContain("Play route in 3D");
});
