import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Fallbacks for pxpipe-proxy's cost-model constants (dist/core/transform.js:61,67,71).
// The canonical values are module-level exports of transform.js that simply are not
// on the package's public exports map, so loadCostModel() deep-imports them from the
// installed copy at runtime. These literals apply only when that import fails and
// carry NO semver guarantee — they may drift from the installed version.
const FALLBACK_COST_MODEL = {
  REPORT_CHARS_PER_TOKEN: 3.7,
  ANTHROPIC_PIXELS_PER_TOKEN: 750,
  IMAGE_COST_SAFETY_MARGIN: 1.10,
};
const NOT_PROFITABLE_EXIT_CODE = 2; // keep in sync with both wrapper scripts
const CONTENT_LOSS_EXIT_CODE = 3; // keep in sync with both wrapper scripts

// Prefer the readable candidate unless dense beats it by at least this factor.
// Cheapest-wins would pick dense on virtually every input (it typically costs
// ~40% of readable), which makes the advertised legibility bias dead code;
// requiring a ≥15% win keeps readable in play where dense barely helps.
const DENSE_ADVANTAGE = 0.85;

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
  console.error("");
  console.error("Exit codes: 0 success, 1 usage/input error, 2 declined (not profitable),");
  console.error("            3 declined (too many unrenderable characters)");
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function loadPxpipe() {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const roots = [process.cwd(), os.homedir(), scriptDir];

  for (const root of roots) {
    const nodeModules = path.join(root, "node_modules");
    const candidate = path.join(nodeModules, "pxpipe-proxy", "dist", "core", "index.js");
    try {
      await access(candidate, constants.R_OK);
    } catch {
      continue; // Try the next likely npm install location.
    }
    return { core: await import(pathToFileURL(candidate).href), nodeModules };
  }

  return { core: await import("pxpipe-proxy"), nodeModules: null };
}

async function loadCostModel(nodeModules) {
  if (nodeModules) {
    try {
      const transform = await import(
        pathToFileURL(path.join(nodeModules, "pxpipe-proxy", "dist", "core", "transform.js")).href
      );
      const live = {
        REPORT_CHARS_PER_TOKEN: transform.REPORT_CHARS_PER_TOKEN,
        ANTHROPIC_PIXELS_PER_TOKEN: transform.ANTHROPIC_PIXELS_PER_TOKEN,
        IMAGE_COST_SAFETY_MARGIN: transform.IMAGE_COST_SAFETY_MARGIN,
      };
      if (Object.values(live).every((v) => Number.isFinite(v) && v > 0)) return live;
    } catch {
      // Fall through to the pinned literals.
    }
  }
  return FALLBACK_COST_MODEL;
}

// Real tokenizer for the text side of the gate. The chars/3.7 heuristic
// under-counts digit-heavy content (JSON, logs) by up to ~40%, skewing both
// the gate and the reported savings; gpt-tokenizer is already installed as
// pxpipe-proxy's own dependency. o200k is OpenAI's encoding, not Anthropic's —
// it generally counts fewer tokens than Claude's for the same text, so using
// it keeps the gate on the conservative (decline-more) side.
async function loadTokenizer(nodeModules) {
  if (!nodeModules) return null;
  const candidates = [
    path.join(nodeModules, "gpt-tokenizer"),
    path.join(nodeModules, "pxpipe-proxy", "node_modules", "gpt-tokenizer"),
  ];
  for (const pkg of candidates) {
    try {
      const mod = await import(
        pathToFileURL(path.join(pkg, "esm", "encoding", "o200k_base.js")).href
      );
      if (typeof mod.encode === "function") return mod.encode;
    } catch {
      // Try the next install layout.
    }
  }
  return null;
}

// Per-page ceil, summed — matches pxpipe-proxy's export.js report method (runExportCore),
// NOT the internal proxy gate's single-ceil-over-total-pixels method. Do not substitute
// renderTextToImages()'s returned `pixels` field here; it uses the other aggregation and
// would silently under-count multi-page candidates relative to real per-image billing.
function imageTokenCost(pages, costModel) {
  let total = 0;
  for (const { width, height } of pages) {
    total += Math.ceil(
      (width * height / costModel.ANTHROPIC_PIXELS_PER_TOKEN) * costModel.IMAGE_COST_SAFETY_MARGIN
    );
  }
  return total;
}

const args = process.argv.slice(2);
let denseOnly = false;
let force = false;
let stdinMode = false;
let dryRun = false;
let maxDropRatio = null;
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
const [costModel, encode] = await Promise.all([
  loadCostModel(nodeModules),
  loadTokenizer(nodeModules),
]);

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
  const readableProfitable = readableCost < textTokens;
  // Legibility bias: readable wins unless dense clears DENSE_ADVANTAGE, or
  // readable is not itself profitable and dense is at least cheaper.
  if (denseCost < readableCost * DENSE_ADVANTAGE || (!readableProfitable && denseCost < readableCost)) {
    chosenLabel = "dense";
    chosen = dense;
  } else {
    chosenLabel = "readable";
    chosen = readable;
  }
}

const chosenCost = imageTokenCost(chosen.pages, costModel);

if (!force && chosenCost >= textTokens) {
  console.error(
    `NOT_PROFITABLE: text ~${textTokens} tokens (${tokenBasis}), image ~${chosenCost} tokens ` +
    `(mode: ${chosenLabel}) — leaving clipboard unchanged.`
  );
  process.exit(NOT_PROFITABLE_EXIT_CODE);
}

const dropRatio = text.length > 0 ? chosen.droppedChars / text.length : 0;
if (chosen.droppedChars > 0) {
  console.error(
    `Warning: ${chosen.droppedChars} character(s) (~${(dropRatio * 100).toFixed(1)}%) have no ` +
    `glyph in the atlas and render as blank cells (emoji are the usual cause).`
  );
}
if (!force && maxDropRatio !== null && dropRatio > maxDropRatio) {
  console.error(
    `CONTENT_LOSS: drop ratio ${(dropRatio * 100).toFixed(1)}% exceeds the ` +
    `--max-drop-ratio limit of ${(maxDropRatio * 100).toFixed(1)}% — leaving clipboard unchanged.`
  );
  process.exit(CONTENT_LOSS_EXIT_CODE);
}

const percentSaved = textTokens > 0
  ? Math.round(((textTokens - chosenCost) / textTokens) * 1000) / 10
  : 0;
const summary =
  `Mode: ${chosenLabel}. Dropped chars: ${chosen.droppedChars}. ` +
  `Tokens: text ~${textTokens} (${tokenBasis}) vs image ~${chosenCost} (${percentSaved}% saved).`;

if (dryRun) {
  console.error(`DRY_RUN: would render ${chosen.pages.length} page(s). ${summary}`);
  process.exit(0);
}

await mkdir(outDir, { recursive: true });

for (let i = 0; i < chosen.pages.length; i += 1) {
  const filename = path.join(outDir, `page-${String(i + 1).padStart(2, "0")}.png`);
  await writeFile(filename, chosen.pages[i].png);
  console.log(filename);
}

console.error(`Rendered ${chosen.pages.length} page(s). ${summary}`);
