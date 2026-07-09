import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Re-declared from pxpipe-proxy's internal (non-exported) constants because they are
// not part of the package's public "exports" surface (dist/core/transform.js:61,67,71).
// pxpipe-proxy is pinned "^0.8.0"; these carry NO semver guarantee, even within 0.8.x,
// since they live outside the exports map. Re-verify against the installed version's
// dist/core/transform.js if renderer output or gate decisions look off after an upgrade.
const REPORT_CHARS_PER_TOKEN = 3.7;
const ANTHROPIC_PIXELS_PER_TOKEN = 750;
const IMAGE_COST_SAFETY_MARGIN = 1.10;
const NOT_PROFITABLE_EXIT_CODE = 2; // keep in sync with both wrapper scripts

function usage() {
  console.error("Usage:");
  console.error("  node pxpipe-render-text.mjs [--dense] [--force] input.txt out-dir");
  console.error("  node pxpipe-render-text.mjs [--dense] [--force] --stdin out-dir");
  console.error("");
  console.error("  --dense   render only the dense/reflow candidate (still gated unless --force)");
  console.error("  --force   write output even if it would cost more tokens than plain text");
  console.error("");
  console.error("Exit codes: 0 success, 1 usage/input error, 2 declined (not profitable)");
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function importPxpipe() {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const roots = [process.cwd(), os.homedir(), scriptDir];

  for (const root of roots) {
    const candidate = path.join(root, "node_modules", "pxpipe-proxy", "dist", "core", "index.js");
    try {
      await access(candidate, constants.R_OK);
      return import(pathToFileURL(candidate).href);
    } catch {
      // Try the next likely npm install location.
    }
  }

  return import("pxpipe-proxy");
}

// Per-page ceil, summed — matches pxpipe-proxy's export.js report method (runExportCore),
// NOT the internal proxy gate's single-ceil-over-total-pixels method. Do not substitute
// renderTextToImages()'s returned `pixels` field here; it uses the other aggregation and
// would silently under-count multi-page candidates relative to real per-image billing.
function imageTokenCost(pages) {
  let total = 0;
  for (const { width, height } of pages) {
    total += Math.ceil((width * height / ANTHROPIC_PIXELS_PER_TOKEN) * IMAGE_COST_SAFETY_MARGIN);
  }
  return total;
}

const args = process.argv.slice(2);
let denseOnly = false;
let force = false;
while (args[0] === "--dense" || args[0] === "--force") {
  if (args[0] === "--dense") denseOnly = true;
  if (args[0] === "--force") force = true;
  args.shift();
}

const stdinMode = args[0] === "--stdin";
const inputPath = stdinMode ? null : args[0];
const outDir = stdinMode ? args[1] : args[1];

if (!outDir || (!stdinMode && !inputPath)) {
  usage();
  process.exit(1);
}

const text = stdinMode ? await readStdin() : await readFile(inputPath, "utf8");
if (!text.trim()) {
  console.error("No text received.");
  process.exit(1);
}

const { renderTextToImages } = await importPxpipe();

const textTokens = Math.ceil(text.length / REPORT_CHARS_PER_TOKEN);

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
  const readableCost = imageTokenCost(readable.pages);
  const denseCost = imageTokenCost(dense.pages);
  // Tie goes to readable (legibility bias, matching the tool's stated design intent).
  if (denseCost < readableCost) {
    chosenLabel = "dense";
    chosen = dense;
  } else {
    chosenLabel = "readable";
    chosen = readable;
  }
}

const chosenCost = imageTokenCost(chosen.pages);

if (!force && chosenCost >= textTokens) {
  console.error(
    `NOT_PROFITABLE: text ~${textTokens} tokens, image ~${chosenCost} tokens ` +
    `(mode: ${chosenLabel}) — leaving clipboard unchanged.`
  );
  process.exit(NOT_PROFITABLE_EXIT_CODE);
}

await mkdir(outDir, { recursive: true });

for (let i = 0; i < chosen.pages.length; i += 1) {
  const filename = path.join(outDir, `page-${String(i + 1).padStart(2, "0")}.png`);
  await writeFile(filename, chosen.pages[i].png);
  console.log(filename);
}

const percentSaved = textTokens > 0
  ? Math.round(((textTokens - chosenCost) / textTokens) * 1000) / 10
  : 0;
console.error(
  `Rendered ${chosen.pages.length} page(s). Mode: ${chosenLabel}. ` +
  `Dropped chars: ${chosen.droppedChars}. ` +
  `Tokens: text ~${textTokens} vs image ~${chosenCost} (${percentSaved}% saved).`
);
