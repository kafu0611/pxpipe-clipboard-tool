// Pure cost and gating math for the renderer — no I/O, no pxpipe imports —
// so the decisions that guard the clipboard can be unit-tested directly.

export const NOT_PROFITABLE_EXIT_CODE = 2; // keep in sync with both wrapper scripts
export const CONTENT_LOSS_EXIT_CODE = 3; // keep in sync with both wrapper scripts

// Prefer the readable candidate unless dense beats it by at least this factor.
// Cheapest-wins would pick dense on virtually every input (it typically costs
// ~40% of readable), which makes the advertised legibility bias dead code;
// requiring a ≥15% win keeps readable in play where dense barely helps.
export const DENSE_ADVANTAGE = 0.85;

// Per-page ceil, summed — matches pxpipe-proxy's export.js report method (runExportCore),
// NOT the internal proxy gate's single-ceil-over-total-pixels method. Do not substitute
// renderTextToImages()'s returned `pixels` field here; it uses the other aggregation and
// would silently under-count multi-page candidates relative to real per-image billing.
export function imageTokenCost(pages, costModel) {
  let total = 0;
  for (const { width, height } of pages) {
    total += Math.ceil(
      (width * height / costModel.ANTHROPIC_PIXELS_PER_TOKEN) * costModel.IMAGE_COST_SAFETY_MARGIN
    );
  }
  return total;
}

// Legibility bias: readable wins unless dense clears DENSE_ADVANTAGE, or
// readable is not itself profitable and dense is at least cheaper.
export function chooseMode({ readableCost, denseCost, textTokens }) {
  const readableProfitable = readableCost < textTokens;
  if (denseCost < readableCost * DENSE_ADVANTAGE || (!readableProfitable && denseCost < readableCost)) {
    return "dense";
  }
  return "readable";
}

// The two gates that decide whether the render may replace the clipboard.
// Message formatting stays in the CLI; this returns only the decision.
export function evaluateGates({ textTokens, imageCost, dropRatio, maxDropRatio, force }) {
  if (!force && imageCost >= textTokens) {
    return { ok: false, exitCode: NOT_PROFITABLE_EXIT_CODE, reason: "not_profitable" };
  }
  if (!force && maxDropRatio !== null && dropRatio > maxDropRatio) {
    return { ok: false, exitCode: CONTENT_LOSS_EXIT_CODE, reason: "content_loss" };
  }
  return { ok: true, exitCode: 0, reason: null };
}
