import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("dashboard exposes Atlas controls and live-capital readiness", async () => {
  const [page, css, layout] = await Promise.all([
    readFile(new URL("app/page.tsx", root), "utf8"),
    readFile(new URL("app/globals.css", root), "utf8"),
    readFile(new URL("app/layout.tsx", root), "utf8"),
  ]);

  assert.match(page, /ATLAS/);
  assert.match(page, /LIVE-CAPITAL READINESS/);
  assert.match(page, /100 prospective closed trades/);
  assert.match(page, /30-trade frozen holdout/);
  assert.match(page, /wash-sale blacklist/i);
  assert.match(page, /simulated round-trip costs/i);
  assert.match(page, /crypto/i);
  assert.match(css, /\.readiness-gates/);
  assert.match(layout, /Project Atlas/i);
  assert.doesNotMatch(page, /SkeletonPreview/);
});
