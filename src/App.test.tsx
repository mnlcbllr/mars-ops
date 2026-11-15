import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { App } from "./App";
import { loadWorkspace } from "./lib/workspace";

test("the app renders its shell and loading status before native data is available", () => {
  const html = renderToStaticMarkup(<App />);
  expect(html).toContain("MARS-OPS");
  expect(html).toContain('role="status"');
  expect(html).toContain("Loading bundled Mars dataset");
  expect(html).toContain("Research prototype");
});

test("a regular browser gets an actionable native-runtime error", async () => {
  await expect(loadWorkspace()).rejects.toThrow("Open the MARS-OPS desktop app with bun tauri dev");
});

test("MARS-OPS branding preserves the installed-app identity", () => {
  const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
  const pkg = JSON.parse(read("../package.json"));
  const desktop = JSON.parse(read("../src-tauri/tauri.conf.json"));
  expect(pkg.name).toBe("mars-ops");
  expect(read("../index.html")).toContain("<title>MARS-OPS</title>");
  expect(desktop.productName).toBe("MARS-OPS");
  expect(desktop.app.windows[0].title).toStartWith("MARS-OPS —");
  expect(desktop.identifier).toBe("space.mars-ops.planner");
});
