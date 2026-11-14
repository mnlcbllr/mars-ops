import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { App } from "./App";
import { loadWorkspace } from "./lib/workspace";

test("the app renders its shell and loading status before native data is available", () => {
  const html = renderToStaticMarkup(<App />);
  expect(html).toContain("ARES");
  expect(html).toContain('role="status"');
  expect(html).toContain("Loading bundled Mars dataset");
  expect(html).toContain("Research prototype");
});

test("a regular browser gets an actionable native-runtime error", async () => {
  await expect(loadWorkspace()).rejects.toThrow("Open the ARES desktop app with bun tauri dev");
});
