import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  FALLBACK_COST_MODEL,
  loadCostModel,
  loadPxpipe,
  loadTokenizer,
} from "../lib/pxpipe-adapter.mjs";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(testDir, "..");
const fakeRoot = path.join(testDir, "fixtures", "fake-pxpipe");
const fakeNodeModules = path.join(fakeRoot, "node_modules");
const badNodeModules = path.join(testDir, "fixtures", "bad-pxpipe", "node_modules");
const realInstall = existsSync(path.join(repoRoot, "node_modules", "pxpipe-proxy"));

test("loadPxpipe resolves the package from an explicit root", async () => {
  const { core, nodeModules } = await loadPxpipe({ roots: [fakeRoot] });
  assert.equal(core.FIXTURE_MARKER, "fake-pxpipe");
  assert.equal(nodeModules, fakeNodeModules);
  assert.equal(typeof core.renderTextToImages, "function");
});

test("loadCostModel reads live constants from the installed layout", async () => {
  const { values, costModelSource } = await loadCostModel(fakeNodeModules);
  assert.equal(costModelSource, "live");
  assert.deepEqual(values, {
    REPORT_CHARS_PER_TOKEN: 5.5,
    ANTHROPIC_PIXELS_PER_TOKEN: 500,
    IMAGE_COST_SAFETY_MARGIN: 1.25,
  });
});

test("loadCostModel rejects non-finite constants and falls back", async () => {
  const { values, costModelSource } = await loadCostModel(badNodeModules);
  assert.equal(costModelSource, "fallback");
  assert.deepEqual(values, FALLBACK_COST_MODEL);
});

test("loadCostModel falls back when the package location is unknown", async () => {
  const { values, costModelSource } = await loadCostModel(null);
  assert.equal(costModelSource, "fallback");
  assert.deepEqual(values, FALLBACK_COST_MODEL);
});

test("loadCostModel falls back when transform.js is missing", async () => {
  const { costModelSource } = await loadCostModel(path.join(testDir, "does-not-exist"));
  assert.equal(costModelSource, "fallback");
});

test("loadTokenizer returns null when the package location is unknown", async () => {
  assert.equal(await loadTokenizer(null), null);
});

// Integration against the real published package: the fixture above proves the
// adapter's logic, but only this proves the layout npm actually ships still
// matches what the adapter expects. This is the compatibility gate to re-run
// whenever the pxpipe-proxy pin is bumped.
test("installed pxpipe-proxy exposes the layout the adapter depends on", { skip: !realInstall && "pxpipe-proxy not installed — run npm install" }, async () => {
  const { core, nodeModules } = await loadPxpipe({ roots: [repoRoot] });
  assert.equal(typeof core.renderTextToImages, "function");

  const { values, costModelSource } = await loadCostModel(nodeModules);
  assert.equal(costModelSource, "live", "cost constants no longer readable from dist/core/transform.js — update the adapter or the fallbacks");
  for (const [key, value] of Object.entries(values)) {
    assert.ok(Number.isFinite(value) && value > 0, `${key} should be a positive finite number, got ${value}`);
  }

  const encode = await loadTokenizer(nodeModules);
  assert.equal(typeof encode, "function", "gpt-tokenizer o200k encoder not found in the installed layout");
  assert.ok(encode("hello world").length > 0);
});
