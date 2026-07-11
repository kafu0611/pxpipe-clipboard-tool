import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const renderer = path.join(repoRoot, "pxpipe-render-text.mjs");
const skip = !existsSync(path.join(repoRoot, "node_modules", "pxpipe-proxy"))
  && "pxpipe-proxy not installed — run npm install";

// A body large enough that imaging clearly wins the profitability gate.
const LARGE_TEXT = Array.from(
  { length: 400 },
  (_, i) => `line ${i + 1} of sample prose for the profitability gate to consider rendering`
).join("\n");

function run(args, { input = "" } = {}) {
  return spawnSync(process.execPath, [renderer, ...args], {
    cwd: repoRoot,
    input,
    encoding: "utf8",
  });
}

let tmpDir;
test.before(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), "pxclip-test-"));
});
test.after(async () => {
  if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
});

test("missing arguments exits 1 with usage", { skip }, () => {
  const res = run([]);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /Usage:/);
  assert.equal(res.stdout, "");
});

test("unknown option exits 1", { skip }, () => {
  const res = run(["--bogus", "in.txt", "out"]);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /Unknown option: --bogus/);
});

test("unprofitable input exits 2 and writes nothing", { skip }, () => {
  const res = run(["--stdin", "--dry-run", path.join(tmpDir, "unused")], { input: "x" });
  assert.equal(res.status, 2);
  assert.match(res.stderr, /NOT_PROFITABLE/);
  assert.equal(res.stdout, "");
});

test("profitable dry run exits 0 without writing files", { skip }, async () => {
  const outDir = path.join(tmpDir, "dry");
  const res = run(["--stdin", "--dry-run", outDir], { input: LARGE_TEXT });
  assert.equal(res.status, 0);
  assert.match(res.stderr, /DRY_RUN: would render \d+ page\(s\)/);
  assert.equal(res.stdout, "");
  assert.equal(existsSync(outDir), false);
});

test("excessive glyph loss exits 3 under --max-drop-ratio", { skip }, () => {
  const res = run(["--stdin", "--dry-run", "--max-drop-ratio", "0.01", path.join(tmpDir, "unused")], {
    input: "🙂 🙂 🙂",
  });
  assert.equal(res.status, 3);
  assert.match(res.stderr, /CONTENT_LOSS/);
});

test("--force overrides the content-loss gate", { skip }, () => {
  const res = run(["--stdin", "--dry-run", "--max-drop-ratio", "0.01", "--force", path.join(tmpDir, "unused")], {
    input: "🙂 🙂 🙂",
  });
  assert.equal(res.status, 0);
});

test("successful render emits only PNG paths on stdout", { skip }, async () => {
  const outDir = path.join(tmpDir, "render");
  const res = run(["--stdin", outDir], { input: LARGE_TEXT });
  assert.equal(res.status, 0);
  const lines = res.stdout.split(/\r?\n/).filter(Boolean);
  assert.ok(lines.length > 0, "expected at least one page path on stdout");
  for (const line of lines) {
    assert.match(line, /page-\d{2}\.png$/, `unexpected stdout line: ${line}`);
    assert.ok(existsSync(line), `stdout path does not exist: ${line}`);
  }
  const written = await readdir(outDir);
  assert.deepEqual(written.filter((f) => f.endsWith(".png")).sort(), lines.map((l) => path.basename(l)).sort());
});

test("--report-json records the decision and estimates", { skip }, async () => {
  const reportPath = path.join(tmpDir, "report.json");
  const res = run(["--stdin", "--dry-run", "--report-json", reportPath, path.join(tmpDir, "unused")], {
    input: LARGE_TEXT,
  });
  assert.equal(res.status, 0);
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  assert.equal(report.decision, "dry_run");
  assert.ok(["readable", "dense"].includes(report.mode));
  assert.ok(report.textTokens > report.imageTokens, "dry run passed the gate, so text must cost more");
  assert.equal(report.dropRatio, 0);
  assert.ok(report.pages >= 1);
  assert.ok(["live", "fallback"].includes(report.costModelSource));
});

test("leading/trailing blank lines are trimmed before tokenizing and rendering", { skip }, async () => {
  // Blank edge lines still occupy real, billed rows in the rendered image (the
  // renderer sizes each page to its actual line count) — they must not inflate
  // the reported cost or the persisted artifacts.
  const padded = `\n\n\n${LARGE_TEXT}\n\n\n\n\n\n\n\n\n\n`;
  const reportPadded = path.join(tmpDir, "report-padded.json");
  const reportBare = path.join(tmpDir, "report-bare.json");

  const paddedRes = run(["--stdin", "--dry-run", "--report-json", reportPadded, path.join(tmpDir, "unused1")], {
    input: padded,
  });
  const bareRes = run(["--stdin", "--dry-run", "--report-json", reportBare, path.join(tmpDir, "unused2")], {
    input: LARGE_TEXT,
  });
  assert.equal(paddedRes.status, 0);
  assert.equal(bareRes.status, 0);

  const padReport = JSON.parse(await readFile(reportPadded, "utf8"));
  const bareReport = JSON.parse(await readFile(reportBare, "utf8"));
  assert.equal(padReport.textTokens, bareReport.textTokens, "blank edge lines must not count as text tokens");
  assert.equal(padReport.imageTokens, bareReport.imageTokens, "blank edge lines must not inflate billed image pixels");
  assert.equal(padReport.pages, bareReport.pages);
});

test("--report-json is written on gated exits too", { skip }, async () => {
  const reportPath = path.join(tmpDir, "report-gated.json");
  const res = run(["--stdin", "--dry-run", "--report-json", reportPath, path.join(tmpDir, "unused")], {
    input: "x",
  });
  assert.equal(res.status, 2);
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  assert.equal(report.decision, "not_profitable");
});
