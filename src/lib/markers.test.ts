import { expect, test } from "bun:test";
import { markersFor } from "./markers";
import type { MissionResult, MissionScenario, ScientificSite } from "./types";

const site = (id: string, x: number): ScientificSite => ({
  id,
  name: id,
  position: { x_m: x, y_m: 0 },
  science_rationale: "",
  source_product_ids: [],
  evidence_kind: "USER_DEFINED",
  activity_min_s: 0,
  activity_max_s: 1,
  activity_power_w: 0,
  preference_weight: 1,
});

const scenario = {
  base: { x_m: 5, y_m: 6 },
  sites: [site("S1", 1), site("S2", 2), site("S3", 3), site("S4", 4)],
} as MissionScenario;

const result = (stops: string[], excluded: string[]): MissionResult =>
  ({
    stops: stops.map((site_id) => ({ site_id, arrive_s: 0, activity_s: 0, depart_s: 0, utility: 0 })),
    excluded: excluded.map((site_id) => ({ site_id, code: "X", reason: "" })),
  }) as MissionResult;

const kinds = (markers: ReturnType<typeof markersFor>) =>
  Object.fromEntries(markers.map((m) => [m.id, `${m.kind}:${m.glyph}`]));

test("before a run, selected sites are candidates and the rest are unselected", () => {
  const markers = markersFor(scenario, new Set(["S1", "S2"]), null);
  expect(kinds(markers)).toEqual({
    S1: "candidate:",
    S2: "candidate:",
    S3: "unselected:",
    S4: "unselected:",
    BASE: "base:B",
  });
});

test("after a run, visited sites carry their visit order and the others are left out", () => {
  const markers = markersFor(scenario, new Set(["S1", "S2", "S3"]), result(["S3", "S1"], ["S2"]));
  expect(kinds(markers)).toEqual({
    S1: "visited:2",
    S2: "left_out:",
    S3: "visited:1",
    S4: "unselected:",
    BASE: "base:B",
  });
});

test("a run with no stops still marks the sites it rejected", () => {
  const markers = markersFor(scenario, new Set(["S1", "S2"]), result([], ["S1"]));
  expect(kinds(markers)).toMatchObject({ S1: "left_out:", S2: "candidate:" });
});

test("the base is drawn last, on top of everything", () => {
  const markers = markersFor(scenario, new Set(["S1"]), result(["S1"], []));
  expect(markers.at(-1)).toMatchObject({ kind: "base", x_m: 5, y_m: 6, label: "Base" });
  expect(markers[0]!.kind).toBe("unselected");
});
