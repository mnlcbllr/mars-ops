import { expect, test } from "bun:test";
import { geologyAt, type GeologicUnit } from "./geology";
import bundled from "../../datasets/jezero-small/geology.json";

const unit: GeologicUnit = {
  symbol: "unit", name: "Regional context", color: "#ffffff",
  polygons: [[[[0, 0], [10, 0], [10, 10], [0, 10]], [[4, 4], [6, 4], [6, 6], [4, 6]]]],
};

test("lookup respects polygon holes and outside points", () => {
  expect(geologyAt([unit], { x_m: 1, y_m: 1 })).toBe(unit);
  expect(geologyAt([unit], { x_m: 5, y_m: 5 })).toBeUndefined();
  expect(geologyAt([unit], { x_m: 12, y_m: 5 })).toBeUndefined();
});

test("the offline map includes Jezero floor and fan 2 units", () => {
  const units = bundled.units as GeologicUnit[];
  expect(units.map((unit) => unit.symbol).sort()).toEqual(["NHjf2", "Njf"]);
  expect(geologyAt(units, { x_m: 396.6, y_m: 654.3 })?.symbol).toBe("Njf");
  expect(geologyAt(units, { x_m: 1011.3, y_m: 977.4 })?.symbol).toBe("NHjf2");
  expect(geologyAt(units, { x_m: -1, y_m: 654.3 })).toBeUndefined();
});
