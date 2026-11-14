import { describe, expect, test } from "bun:test";
import { fitView, scaleBar, toLocal, toScreen, zoomAt } from "./view2d";

const viewport = { width: 800, height: 600 };
const view = { cx: 1000, cy: 500, scale: 0.4 };

describe("fitView", () => {
  test("centres the extent and uses the tighter axis", () => {
    expect(fitView({ width: 2000, height: 1000 }, viewport)).toEqual(view);
  });
  test("padding shrinks the usable viewport on both sides", () => {
    // min(700 / 2000, 500 / 1000)
    expect(fitView({ width: 2000, height: 1000 }, viewport, 50).scale).toBe(0.35);
  });
});

describe("screen and local coordinates", () => {
  test("the view centre lands on the viewport centre", () => {
    expect(toScreen(view, viewport, 1000, 500)).toEqual([400, 300]);
  });
  test("north is up: the north-west corner is above and left of centre", () => {
    expect(toScreen(view, viewport, 0, 1000)).toEqual([0, 100]);
  });
  test("toLocal undoes toScreen", () => {
    expect(toLocal(view, viewport, 0, 100)).toEqual([0, 1000]);
    expect(toLocal(view, viewport, 400, 300)).toEqual([1000, 500]);
  });
});

describe("zoomAt", () => {
  test("keeps the point under the cursor fixed", () => {
    // Cursor (200, 150) is over local (500, 875) before the zoom.
    const zoomed = zoomAt(view, viewport, 200, 150, 2, 0.01, 10);
    expect(zoomed).toEqual({ cx: 750, cy: 687.5, scale: 0.8 });
    expect(toScreen(zoomed, viewport, 500, 875)).toEqual([200, 150]);
  });
  test("clamps to the allowed scale range", () => {
    expect(zoomAt(view, viewport, 400, 300, 100, 0.01, 1).scale).toBe(1);
    expect(zoomAt(view, viewport, 400, 300, 0.001, 0.2, 1).scale).toBe(0.2);
  });
});

describe("scaleBar", () => {
  test("picks the largest 1-2-5 length that fits", () => {
    expect(scaleBar(0.4, 120)).toEqual({ metres: 200, px: 80 }); // 120 px = 300 m
    expect(scaleBar(3, 120)).toEqual({ metres: 20, px: 60 }); // 120 px = 40 m
    expect(scaleBar(0.0625, 120)).toEqual({ metres: 1000, px: 62.5 }); // 120 px = 1920 m
    expect(scaleBar(60, 120)).toEqual({ metres: 2, px: 120 }); // 120 px = 2 m
  });
});
