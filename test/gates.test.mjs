import test from "node:test";
import assert from "node:assert/strict";

import {
  CONTENT_LOSS_EXIT_CODE,
  DENSE_ADVANTAGE,
  NOT_PROFITABLE_EXIT_CODE,
  chooseMode,
  evaluateGates,
  imageTokenCost,
} from "../lib/gates.mjs";

const COST_MODEL = { ANTHROPIC_PIXELS_PER_TOKEN: 750, IMAGE_COST_SAFETY_MARGIN: 1.10 };

test("imageTokenCost sums per-page ceilings", () => {
  // 1000×2000 px → 2_000_000 / 750 × 1.10 = 2933.33… → 2934 per page.
  const pages = [
    { width: 1000, height: 2000 },
    { width: 1000, height: 2000 },
  ];
  assert.equal(imageTokenCost(pages, COST_MODEL), 5868);
});

test("imageTokenCost ceils per page, not over the total", () => {
  // Two 10×10 pages: each 100 / 750 × 1.10 ≈ 0.147 → ceil 1, so 2 total.
  // A single ceil over the summed pixels would give 1 — the per-image billing
  // difference this function exists to preserve.
  const pages = [
    { width: 10, height: 10 },
    { width: 10, height: 10 },
  ];
  assert.equal(imageTokenCost(pages, COST_MODEL), 2);
});

test("chooseMode keeps readable when dense is only marginally cheaper", () => {
  assert.equal(chooseMode({ readableCost: 100, denseCost: 86, textTokens: 200 }), "readable");
});

test("chooseMode picks dense when it clears DENSE_ADVANTAGE", () => {
  assert.equal(chooseMode({ readableCost: 100, denseCost: 84, textTokens: 200 }), "dense");
});

test("chooseMode boundary: dense exactly at the threshold stays readable", () => {
  const readableCost = 100;
  assert.equal(
    chooseMode({ readableCost, denseCost: readableCost * DENSE_ADVANTAGE, textTokens: 200 }),
    "readable"
  );
});

test("chooseMode falls back to dense when readable is unprofitable and dense is cheaper", () => {
  assert.equal(chooseMode({ readableCost: 100, denseCost: 99, textTokens: 50 }), "dense");
});

test("chooseMode keeps readable when both are unprofitable and dense is not cheaper", () => {
  assert.equal(chooseMode({ readableCost: 100, denseCost: 100, textTokens: 50 }), "readable");
});

test("evaluateGates declines when image cost equals text tokens", () => {
  const gate = evaluateGates({ textTokens: 10, imageCost: 10, dropRatio: 0, maxDropRatio: null, force: false });
  assert.deepEqual(gate, { ok: false, exitCode: NOT_PROFITABLE_EXIT_CODE, reason: "not_profitable" });
});

test("evaluateGates passes when image cost is below text tokens", () => {
  const gate = evaluateGates({ textTokens: 10, imageCost: 9, dropRatio: 0, maxDropRatio: null, force: false });
  assert.deepEqual(gate, { ok: true, exitCode: 0, reason: null });
});

test("evaluateGates declines on drop ratio above the limit", () => {
  const gate = evaluateGates({ textTokens: 10, imageCost: 5, dropRatio: 0.02, maxDropRatio: 0.01, force: false });
  assert.deepEqual(gate, { ok: false, exitCode: CONTENT_LOSS_EXIT_CODE, reason: "content_loss" });
});

test("evaluateGates allows drop ratio exactly at the limit", () => {
  const gate = evaluateGates({ textTokens: 10, imageCost: 5, dropRatio: 0.01, maxDropRatio: 0.01, force: false });
  assert.equal(gate.ok, true);
});

test("evaluateGates ignores drop ratio when no limit is set", () => {
  const gate = evaluateGates({ textTokens: 10, imageCost: 5, dropRatio: 0.9, maxDropRatio: null, force: false });
  assert.equal(gate.ok, true);
});

test("evaluateGates force overrides both gates", () => {
  const gate = evaluateGates({ textTokens: 10, imageCost: 99, dropRatio: 0.9, maxDropRatio: 0.01, force: true });
  assert.deepEqual(gate, { ok: true, exitCode: 0, reason: null });
});

test("profitability gate is checked before content loss", () => {
  const gate = evaluateGates({ textTokens: 10, imageCost: 99, dropRatio: 0.9, maxDropRatio: 0.01, force: false });
  assert.equal(gate.reason, "not_profitable");
});
