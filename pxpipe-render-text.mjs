import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { loadPxpipe, loadCostModel, loadTokenizer } from "./lib/pxpipe-adapter.mjs";
import {
  chooseMode,
  evaluateGates,
  imageTokenCost,
} from "./lib/gates.mjs";

function usage() {
  console.error("Usage:");
  console.error("  node pxpipe-render-text.mjs [options] input.txt out-dir");
  console.error("  node pxpipe-render-text.mjs [options] --stdin out-dir");
  console.error("");
  console.error("  --dense               render only the dense/reflow candidate (still gated unless --force)");
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
let denseOnly = false;
let force = false;
let stdinMode = false;
let dryRun = false;
let maxDropRatio = null;
let reportJsonPath = null;
const positional = [];
for (let i = 0; i < args.length; i += 1) {
  const arg = args[i];
  if (arg === "--dense") denseOnly = true;
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

if (positional.length !== (stdinMode ? 1 : 2)) {
  usage();
  process.exit(1);
}
const inputPath = stdinMode ? null : positional[0];
const outDir = stdinMode ? positional[0] : positional[1];

const text = stdinMode ? await readStdin() : await readFile(inputPath, "utf8");
if (!text.trim()) {
  console.error("No text received.");
  process.exit(1);
}

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
const gate = evaluateGates({ textTokens, imageCost: chosenCost, dropRatio, maxDropRatio, force });

// Machine-readable decision record; stdout stays reserved for PNG paths only.
const report = {
  decision: gate.ok ? (dryRun ? "dry_run" : "rendered") : gate.reason,
  mode: chosenLabel,
  textTokens,
  imageTokens: chosenCost,
  dropRatio,
  droppedChars: chosen.droppedChars,
  pages: chosen.pages.length,
  anchors: [],
  costModelSource,
  tokenBasis,
};

async function writeReport() {
  if (!reportJsonPath) return;
  await writeFile(reportJsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

if (!gate.ok && gate.reason === "not_profitable") {
  console.error(
    `NOT_PROFITABLE: text ~${textTokens} tokens (${tokenBasis}), image ~${chosenCost} tokens ` +
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

await writeReport();
console.error(`Rendered ${chosen.pages.length} page(s). ${summary}`);
