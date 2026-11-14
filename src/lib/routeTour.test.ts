import { expect, test } from "bun:test";
import { legTrack, routeSteps } from "./routeTour";
import type { MissionResult, PlannedLeg, ScientificSite } from "./types";

const leg: PlannedLeg = {
  from: "BASE", to: "S2", path: [{ x_m: 0, y_m: 0 }, { x_m: 6, y_m: 0 }, { x_m: 6, y_m: 2 }],
  elevation_m: [10, 16, 20], distance_m: 8, time_s: 20, ascent_m: 10, descent_m: 0, max_slope_deg: 10, cells_expanded: 5,
};

test("replay uses distance along the actual route and interpolates the supplied elevation", () => {
  const at = legTrack(leg);
  expect(at(0)).toEqual({ x_m: 0, y_m: 0, elevation_m: 10 });
  expect(at(0.5)).toEqual({ x_m: 4, y_m: 0, elevation_m: 14 });
  expect(at(0.875)).toEqual({ x_m: 6, y_m: 1, elevation_m: 18 });
  expect(at(2)).toEqual({ x_m: 6, y_m: 2, elevation_m: 20 });
  expect(legTrack({ ...leg, path: [] })(0.5)).toBeNull();
  expect(legTrack({ ...leg, elevation_m: [] })(0.5)).toBeNull();
});

test("the preview preserves visit order and includes the actual return leg", () => {
  const result = { legs: [leg, { ...leg, from: "S2", to: "BASE" }],
    stops: [{ site_id: "S2", arrive_s: 20, activity_s: 60, depart_s: 80, utility: 1 }] } as MissionResult;
  const site = { id: "S2", name: "Mound foot" } as ScientificSite;
  const steps = routeSteps(result, [site]);
  expect(steps.map(({ label, visit }) => [label, visit?.number])).toEqual([["Mound foot", 1], ["Return to base", undefined]]);
  expect(routeSteps(null, [])).toEqual([]);
});
