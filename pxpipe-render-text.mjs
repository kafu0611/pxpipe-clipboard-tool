import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { loadPxpipe, loadCostModel, loadTokenizer } from "./lib/pxpipe-adapter.mjs";
import {
  chooseMode,
  evaluateGates,
  imageTokenCost,
} from "./lib/gates.mjs";
import { extractAnchorTokens, formatAnchorBlock } from "./lib/factsheet.mjs";

const PROFILES = ["hybrid", "balanced", "dense", "off"];

function usage() {
  console.error("Usage:");
  console.error("  node pxpipe-render-text.mjs [options] input.txt out-dir");
  console.error("  node pxpipe-render-text.mjs [options] --stdin out-dir");
  console.error("");
  console.error("  --profile P           hybrid (default): adaptive render + anchor-token detection");
  console.error("                        balanced: adaptive render only");
  console.error("                        dense: dense/reflow candidate only (explicitly lossy)");
  console.error("                        off: render nothing, exit 0");
  console.error("  --emit-factsheet PATH write detected anchor tokens as plain text to PATH");
  console.error("                        (hybrid only; skipped when no anchors are found)");
  console.error("  --keep-artifacts      also persist the original text as original.txt in out-dir");
  console.error("  --dense               deprecated alias for --profile dense");
  console.error("  --force               write output even when gated (unprofitable or lossy)");
  console.error("  --dry-run             report the estimate and decision without writing any files");
  console.error("  --max-drop-ratio R    decline (exit 3) when more than fraction R of the characters");
  console.error("                        have no glyph in the atlas and would render as blank cells");
  console.error("  --report-json PATH    also write the decision and estimates as JSON to PATH");
  console.error("");
  console.error("Exit codes: 0 success, 1 usage/input error, 2 declined (not profitable),");
  console.error("            3 declined (too many unrenderable characters)");
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

const args = process.argv.slice(2);
let profileArg = null;
let denseAlias = false;
let force = false;
let stdinMode = false;
let dryRun = false;
let maxDropRatio = null;
let reportJsonPath = null;
let emitFactsheetPath = null;
let keepArtifacts = false;
const positional = [];
for (let i = 0; i < args.length; i += 1) {
  const arg = args[i];
  if (arg === "--dense") denseAlias = true;
  else if (arg === "--profile") {
    i += 1;
    profileArg = args[i];
    if (!PROFILES.includes(profileArg)) {
      console.error(`--profile requires one of: ${PROFILES.join(", ")}.`);
      usage();
      process.exit(1);
    }
  } else if (arg === "--emit-factsheet") {
    i += 1;
    emitFactsheetPath = args[i];
    if (!emitFactsheetPath) {
      console.error("--emit-factsheet requires a file path.");
      usage();
      process.exit(1);
    }
  } else if (arg === "--keep-artifacts") keepArtifacts = true;
  else if (arg === "--force") force = true;
  else if (arg === "--stdin") stdinMode = true;
  else if (arg === "--dry-run") dryRun = true;
  else if (arg === "--max-drop-ratio") {
    i += 1;
    maxDropRatio = Number(args[i]);
    if (!Number.isFinite(maxDropRatio) || maxDropRatio < 0) {
      console.error("--max-drop-ratio requires a non-negative number.");
      usage();
      process.exit(1);
    }
  } else if (arg === "--report-json") {
    i += 1;
    reportJsonPath = args[i];
    if (!reportJsonPath) {
      console.error("--report-json requires a file path.");
      usage();
      process.exit(1);
    }
  } else if (arg.startsWith("-")) {
    console.error(`Unknown option: ${arg}`);
    usage();
    process.exit(1);
  } else {
    positional.push(arg);
  }
}

if (denseAlias && profileArg && profileArg !== "dense") {
  console.error(`--dense conflicts with --profile ${profileArg}; pass one or the other.`);
  process.exit(1);
}
if (denseAlias) {
  console.error("Note: --dense is deprecated; use --profile dense.");
}
const profile = profileArg ?? (denseAlias ? "dense" : "hybrid");

if (profile === "off") {
  console.error("OFF: profile off — nothing rendered, clipboard left unchanged.");
  process.exit(0);
}
if (profile === "dense") {
  console.error(
    "Warning: dense pages are unreliable for verbatim recall of identifiers " +
    "(upstream measured 0/15 on 12-char hex); prefer hybrid or balanced when exact strings matter."
  );
}

if (positional.length !== (stdinMode ? 1 : 2)) {
  usage();
  process.exit(1);
}
const inputPath = stdinMode ? null : positional[0];
const outDir = stdinMode ? positional[0] : positional[1];
const denseOnly = profile === "dense";

const rawText = stdinMode ? await readStdin() : await readFile(inputPath, "utf8");
if (!rawText.trim()) {
  console.error("No text received.");
  process.exit(1);
}
// Leading/trailing whitespace (including blank lines) contributes no meaning
// but still occupies real, billed rows in the rendered image — the renderer
// sizes each page to its actual line count, so blank edge lines are not free
// padding, they are paid pixels. Trimming here (not just at the presence
// check above) keeps the text-token count and the image consistent with what
// actually gets imaged.
const text = rawText.trim();

const { core, nodeModules } = await loadPxpipe();
const { renderTextToImages } = core;
const [{ values: costModel, costModelSource }, encode] = await Promise.all([
  loadCostModel(nodeModules),
  loadTokenizer(nodeModules),
]);
if (costModelSource === "fallback") {
  console.error(
    "Note: using pinned fallback cost constants (pxpipe-proxy internals not readable); " +
    "estimates may drift from the installed version."
  );
}

const textTokens = encode
  ? encode(text).length
  : Math.ceil(text.length / costModel.REPORT_CHARS_PER_TOKEN);
const tokenBasis = encode ? "o200k" : `chars/${costModel.REPORT_CHARS_PER_TOKEN}`;

const anchors = profile === "hybrid" ? extractAnchorTokens(text) : [];
const anchorBlock = anchors.length > 0 ? formatAnchorBlock(anchors) : "";
const willEmitFactsheet = Boolean(emitFactsheetPath) && anchors.length > 0;
// Honest accounting: an emitted factsheet rides alongside the image, so its
// tokens count against the savings — but only when it will actually be written.
const factsheetTokens = willEmitFactsheet
  ? (encode
      ? encode(anchorBlock).length
      : Math.ceil(anchorBlock.length / costModel.REPORT_CHARS_PER_TOKEN))
  : 0;
if (anchors.length > 0) {
  console.error(
    `${anchors.length} anchor token(s) detected — exact values stay authoritative only in ` +
    "the original text or an emitted factsheet, never in the image."
  );
}

let chosenLabel;
let chosen;
if (denseOnly) {
  chosenLabel = "dense";
  chosen = await renderTextToImages(text, { reflow: true });
} else {
  const [readable, dense] = await Promise.all([
    renderTextToImages(text, { reflow: false }),
    renderTextToImages(text, { reflow: true }),
  ]);
  const readableCost = imageTokenCost(readable.pages, costModel);
  const denseCost = imageTokenCost(dense.pages, costModel);
  chosenLabel = chooseMode({ readableCost, denseCost, textTokens });
  chosen = chosenLabel === "dense" ? dense : readable;
}

const chosenCost = imageTokenCost(chosen.pages, costModel);
const dropRatio = text.length > 0 ? chosen.droppedChars / text.length : 0;
const gate = evaluateGates({
  textTokens,
  imageCost: chosenCost + factsheetTokens,
  dropRatio,
  maxDropRatio,
  force,
});

// Machine-readable decision record; stdout stays reserved for PNG paths only.
const report = {
  decision: gate.ok ? (dryRun ? "dry_run" : "rendered") : gate.reason,
  profile,
  mode: chosenLabel,
  textTokens,
  imageTokens: chosenCost,
  factsheetTokens,
  dropRatio,
  droppedChars: chosen.droppedChars,
  pages: chosen.pages.length,
  anchors: anchors.map((a) => a.value),
  costModelSource,
  tokenBasis,
};

async function writeReport() {
  if (!reportJsonPath) return;
  await writeFile(reportJsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

if (!gate.ok && gate.reason === "not_profitable") {
  const factsheetNote = factsheetTokens > 0 ? ` + ~${factsheetTokens} factsheet` : "";
  console.error(
    `NOT_PROFITABLE: text ~${textTokens} tokens (${tokenBasis}), image ~${chosenCost}${factsheetNote} tokens ` +
    `(mode: ${chosenLabel}) — leaving clipboard unchanged.`
  );
  await writeReport();
  process.exit(gate.exitCode);
}

if (chosen.droppedChars > 0) {
  console.error(
    `Warning: ${chosen.droppedChars} character(s) (~${(dropRatio * 100).toFixed(1)}%) have no ` +
    `glyph in the atlas and render as blank cells (emoji are the usual cause).`
  );
}
if (!gate.ok && gate.reason === "content_loss") {
  console.error(
    `CONTENT_LOSS: drop ratio ${(dropRatio * 100).toFixed(1)}% exceeds the ` +
    `--max-drop-ratio limit of ${(maxDropRatio * 100).toFixed(1)}% — leaving clipboard unchanged.`
  );
  await writeReport();
  process.exit(gate.exitCode);
}

const percentSaved = textTokens > 0
  ? Math.round(((textTokens - chosenCost) / textTokens) * 1000) / 10
  : 0;
const summary =
  `Mode: ${chosenLabel}. Dropped chars: ${chosen.droppedChars}. ` +
  `Tokens: text ~${textTokens} (${tokenBasis}) vs image ~${chosenCost} (${percentSaved}% saved).`;

if (dryRun) {
  console.error(`DRY_RUN: would render ${chosen.pages.length} page(s). ${summary}`);
  await writeReport();
  process.exit(0);
}

await mkdir(outDir, { recursive: true });

for (let i = 0; i < chosen.pages.length; i += 1) {
  const filename = path.join(outDir, `page-${String(i + 1).padStart(2, "0")}.png`);
  await writeFile(filename, chosen.pages[i].png);
  console.log(filename);
}

if (willEmitFactsheet) {
  await writeFile(emitFactsheetPath, anchorBlock, "utf8");
  console.error(`Factsheet: ${emitFactsheetPath} (${anchors.length} token(s), ~${factsheetTokens} tokens).`);
} else if (emitFactsheetPath) {
  console.error("No anchor tokens detected — factsheet not written.");
}
if (keepArtifacts) {
  const originalPath = path.join(outDir, "original.txt");
  await writeFile(originalPath, text, "utf8");
  console.error(`Original text kept: ${originalPath}.`);
}

await writeReport();
console.error(`Rendered ${chosen.pages.length} page(s). ${summary}`);
