import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { App } from "./App";
import { loadWorkspace } from "./lib/workspace";

test("the app renders its shell and loading status before native data is available", () => {
  const html = renderToStaticMarkup(<App />);
  expect(html).toContain("HYDE");
  expect(html).toContain('role="status"');
  expect(html).toContain("Loading bundled Mars dataset");
  expect(html).toContain("Research prototype");
});

test("a regular browser gets an actionable native-runtime error", async () => {
  await expect(loadWorkspace()).rejects.toThrow("Open the HYDE desktop app with bun tauri dev");
});

test("web and desktop metadata use HYDE while installed-app identity stays compatible", () => {
  const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
  const pkg = JSON.parse(read("../package.json"));
  const desktop = JSON.parse(read("../src-tauri/tauri.conf.json"));
  expect(pkg.name).toBe("hyde");
  expect(read("../index.html")).toContain("<title>HYDE</title>");
  expect(desktop.productName).toBe("HYDE");
  expect(desktop.app.windows[0].title).toStartWith("HYDE —");
  expect(desktop.identifier).toBe("space.ares.planner");
});
