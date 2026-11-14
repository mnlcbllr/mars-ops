import { expect, test } from "bun:test";
import { clock, fmt, latLon, minutes } from "./format";

test("fmt groups thousands and uses a true minus sign", () => {
  expect(fmt(3964.2)).toBe("3,964");
  expect(fmt(-2527.935, 1)).toBe("−2,527.9");
  expect(fmt(0.4386, 2)).toBe("0.44");
});

test("fmt shows a dash for values the data does not have", () => {
  expect(fmt(Number.NaN)).toBe("—");
  expect(fmt(null)).toBe("—");
  expect(fmt(undefined, 2)).toBe("—");
});

test("minutes converts from seconds", () => {
  expect(minutes(18900)).toBe("315 min");
  expect(minutes(8568, 1)).toBe("142.8 min");
});

test("clock is elapsed hours and minutes since EVA start", () => {
  expect(clock(0)).toBe("T+0:00");
  expect(clock(7500)).toBe("T+2:05");
  expect(clock(3599)).toBe("T+1:00");
});

test("latLon labels hemispheres instead of signing the numbers", () => {
  expect(latLon({ lat_deg: 18.469091018, lon_east_deg: 77.497328496 })).toBe("18.46909°N 77.49733°E");
  expect(latLon({ lat_deg: -4.5, lon_east_deg: 137.4 })).toBe("4.50000°S 137.40000°E");
});
