import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

function usage() {
  console.error("Usage:");
  console.error("  node pxpipe-render-text.mjs input.txt out-dir");
  console.error("  node pxpipe-render-text.mjs --stdin out-dir");
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

const stdinMode = process.argv[2] === "--stdin";
const inputPath = stdinMode ? null : process.argv[2];
const outDir = stdinMode ? process.argv[3] : process.argv[3];

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
const { pages, droppedChars } = await renderTextToImages(text, { reflow: true });

await mkdir(outDir, { recursive: true });

for (let i = 0; i < pages.length; i += 1) {
  const filename = path.join(outDir, `page-${String(i + 1).padStart(2, "0")}.png`);
  await writeFile(filename, pages[i].png);
  console.log(filename);
}

console.error(`Rendered ${pages.length} page(s). Dropped chars: ${droppedChars}.`);
