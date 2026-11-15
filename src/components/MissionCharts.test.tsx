import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ResourceBars } from "./MissionCharts";
import type { ConstraintCheck } from "@/lib/types";

const check: ConstraintCheck = { resource: "eva_time", unit: "s", used: 315 * 60, budget: 360 * 60,
  reserve: 45 * 60, available: 315 * 60, margin: 0, satisfied: true };

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
