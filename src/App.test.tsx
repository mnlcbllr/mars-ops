import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { App } from "./App";

test("the app renders its shell and loading status before native data is available", () => {
  const html = renderToStaticMarkup(<App />);
  expect(html).toContain("ARES");
  expect(html).toContain('role="status"');
  expect(html).toContain("Loading bundled Mars dataset");
  expect(html).toContain("Research prototype");
});
