import { expect, test } from "bun:test";
import { mapShortcut } from "./mapInteraction";

const key = { key: "b", altKey: false, ctrlKey: false, metaKey: false, repeat: false, isComposing: false, defaultPrevented: false };

test("focused-map shortcuts choose placement modes and cancel", () => {
  expect(mapShortcut(key)).toBe("base");
  expect(mapShortcut({ ...key, key: "C" })).toBe("site");
  expect(mapShortcut({ ...key, key: "Escape" })).toBe("cancel");
  expect(mapShortcut({ ...key, key: "x" })).toBeNull();
});

test("browser shortcuts, held keys, IME and handled events never place points", () => {
  for (const flag of ["altKey", "ctrlKey", "metaKey", "repeat", "isComposing", "defaultPrevented"] as const) {
    expect(mapShortcut({ ...key, [flag]: true })).toBeNull();
  }
});
