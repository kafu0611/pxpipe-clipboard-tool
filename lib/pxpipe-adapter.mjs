// Single point of coupling to the installed pxpipe-proxy package. Every access
// to its files — public barrel, cost-model internals, bundled tokenizer — goes
// through this module so an upstream layout change is a one-file fix here.
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Fallbacks for pxpipe-proxy's cost-model constants (dist/core/transform.js:61,67,71).
// The canonical values are module-level exports of transform.js that simply are not
// on the package's public exports map, so loadCostModel() deep-imports them from the
// installed copy at runtime. These literals apply only when that import fails and
// carry NO semver guarantee — they may drift from the installed version.
export const FALLBACK_COST_MODEL = {
  REPORT_CHARS_PER_TOKEN: 3.7,
  ANTHROPIC_PIXELS_PER_TOKEN: 750,
  IMAGE_COST_SAFETY_MARGIN: 1.10,
};

function defaultRoots() {
  // lib/ sits one level below the repo root where node_modules lives.
  const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
  return [process.cwd(), os.homedir(), repoRoot];
}

export async function loadPxpipe({ roots = defaultRoots() } = {}) {
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

export async function loadCostModel(nodeModules) {
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
      if (Object.values(live).every((v) => Number.isFinite(v) && v > 0)) {
        return { values: live, costModelSource: "live" };
      }
    } catch {
      // Fall through to the pinned literals.
    }
  }
  return { values: FALLBACK_COST_MODEL, costModelSource: "fallback" };
}

// Real tokenizer for the text side of the gate. The chars/3.7 heuristic
// under-counts digit-heavy content (JSON, logs) by up to ~40%, skewing both
// the gate and the reported savings; gpt-tokenizer is already installed as
// pxpipe-proxy's own dependency. o200k is OpenAI's encoding, not Anthropic's —
// it generally counts fewer tokens than Claude's for the same text, so using
// it keeps the gate on the conservative (decline-more) side.
export async function loadTokenizer(nodeModules) {
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
