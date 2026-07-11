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

const SECRET = "correct horse battery staple";
const SHA = "ea6a025317e85f79b15b2cc559f00b113d8f54e7";
const IDENTIFIER_TEXT = [
  `commit ${SHA} touched src/core/transform.ts on port 47821`,
  `the passphrase is ${SECRET} and must never persist`,
  ...Array.from({ length: 300 }, (_, i) => `filler prose line ${i + 1} so the profitability gate passes`),
].join("\n");

function run(args, { input = "" } = {}) {
  return spawnSync(process.execPath, [renderer, ...args], { cwd: repoRoot, input, encoding: "utf8" });
}

let tmpDir;
let seq = 0;
function freshDir() {
  seq += 1;
  return path.join(tmpDir, `case-${seq}`);
}
test.before(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), "pxclip-profiles-"));
});
test.after(async () => {
  if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
});

test("--profile off exits 0 without rendering or reading input", { skip }, () => {
  const res = run(["--profile", "off", "--stdin", path.join(tmpDir, "never")]);
  assert.equal(res.status, 0);
  assert.equal(res.stdout, "");
  assert.match(res.stderr, /OFF: profile off/);
  assert.equal(existsSync(path.join(tmpDir, "never")), false);
});

test("--profile dense warns about verbatim recall", { skip }, () => {
  const res = run(["--profile", "dense", "--stdin", "--dry-run", freshDir()], { input: IDENTIFIER_TEXT });
  assert.equal(res.status, 0);
  assert.match(res.stderr, /dense pages are unreliable for verbatim recall/);
});

test("--dense still works as a deprecated alias", { skip }, () => {
  const res = run(["--dense", "--stdin", "--dry-run", freshDir()], { input: IDENTIFIER_TEXT });
  assert.equal(res.status, 0);
  assert.match(res.stderr, /--dense is deprecated; use --profile dense/);
  assert.match(res.stderr, /Mode: dense/);
});

test("--dense conflicts with a different explicit --profile", { skip }, () => {
  const res = run(["--dense", "--profile", "balanced", "--stdin", "--dry-run", freshDir()], { input: "hi" });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /--dense conflicts with --profile balanced/);
});

test("--profile rejects unknown values", { skip }, () => {
  const res = run(["--profile", "bogus", "--stdin", "--dry-run", freshDir()], { input: "hi" });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /--profile requires one of/);
});

test("hybrid detects anchors and reports them without persisting anything extra", { skip }, async () => {
  const outDir = freshDir();
  const reportPath = path.join(tmpDir, `report-${seq}.json`);
  const res = run(["--stdin", "--report-json", reportPath, outDir], { input: IDENTIFIER_TEXT });
  assert.equal(res.status, 0);
  assert.match(res.stderr, /anchor token\(s\) detected/);
  // stdout stays PNG-paths-only even in hybrid.
  for (const line of res.stdout.split(/\r?\n/).filter(Boolean)) {
    assert.match(line, /\.png$/);
  }
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  assert.equal(report.profile, "hybrid");
  assert.ok(report.anchors.includes(SHA));
  assert.equal(report.factsheetTokens, 0, "no factsheet requested, so its cost is zero");
  // Without --emit-factsheet / --keep-artifacts the out dir holds pages only.
  const written = await readdir(outDir);
  assert.ok(written.every((f) => f.endsWith(".png")), `unexpected non-PNG artifacts: ${written}`);
});

test("balanced skips anchor detection", { skip }, () => {
  const res = run(["--profile", "balanced", "--stdin", "--dry-run", freshDir()], { input: IDENTIFIER_TEXT });
  assert.equal(res.status, 0);
  assert.doesNotMatch(res.stderr, /anchor token/);
});

test("--emit-factsheet writes the anchor block and reports its token cost", { skip }, async () => {
  const outDir = freshDir();
  const factsheetPath = path.join(tmpDir, `factsheet-${seq}.txt`);
  const reportPath = path.join(tmpDir, `report-fs-${seq}.json`);
  const res = run(["--stdin", "--emit-factsheet", factsheetPath, "--report-json", reportPath, outDir], {
    input: IDENTIFIER_TEXT,
  });
  assert.equal(res.status, 0);
  assert.match(res.stderr, /^Factsheet: /m);
  const factsheet = await readFile(factsheetPath, "utf8");
  assert.ok(factsheet.includes(SHA));
  assert.ok(factsheet.includes("47821"));
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  assert.ok(report.factsheetTokens > 0, "reported cost must reflect the emitted file");
});

test("emitting a factsheet never turns a profitable render unprofitable", { skip }, async () => {
  // The factsheet is a separate, optional companion the user chooses to
  // transmit — its cost must be informational only, never charged against
  // the image-vs-text decision (regression: a fixed-size boilerplate header
  // used to be added to the gate for every hybrid render with any anchors,
  // which could flip small identifier-heavy renders to NOT_PROFITABLE even
  // though the image alone was clearly cheaper than the text).
  const withoutFactsheet = run(["--profile", "balanced", "--stdin", "--dry-run", freshDir()], {
    input: IDENTIFIER_TEXT,
  });
  const withFactsheet = run(
    ["--stdin", "--dry-run", "--emit-factsheet", path.join(tmpDir, `fs-parity-${seq}.txt`), freshDir()],
    { input: IDENTIFIER_TEXT }
  );
  assert.equal(withoutFactsheet.status, 0);
  assert.equal(withFactsheet.status, withoutFactsheet.status, "requesting a factsheet must not change the gate outcome");
});

test("--emit-factsheet skips the file when no anchors exist", { skip }, async () => {
  const factsheetPath = path.join(tmpDir, `factsheet-empty-${seq}.txt`);
  const prose = Array.from({ length: 300 }, () => "plain filler prose with nothing precise in it").join("\n");
  const res = run(["--stdin", "--emit-factsheet", factsheetPath, freshDir()], { input: prose });
  assert.equal(res.status, 0);
  assert.match(res.stderr, /No anchor tokens detected/);
  assert.equal(existsSync(factsheetPath), false);
});

// Privacy contract: the original clipboard text never lands on disk unless
// explicitly requested with --keep-artifacts.
test("secrets in the input are not persisted by default", { skip }, async () => {
  const outDir = freshDir();
  const factsheetPath = path.join(outDir, "factsheet.txt");
  const res = run(["--stdin", "--emit-factsheet", factsheetPath, outDir], { input: IDENTIFIER_TEXT });
  assert.equal(res.status, 0);
  for (const file of await readdir(outDir)) {
    if (file.endsWith(".png")) continue; // pixels, not text
    const content = await readFile(path.join(outDir, file), "utf8");
    assert.ok(!content.includes(SECRET), `${file} must not contain the original text`);
  }
});

test("--keep-artifacts persists the original text on request", { skip }, async () => {
  const outDir = freshDir();
  const res = run(["--stdin", "--keep-artifacts", outDir], { input: IDENTIFIER_TEXT });
  assert.equal(res.status, 0);
  const original = await readFile(path.join(outDir, "original.txt"), "utf8");
  assert.ok(original.includes(SECRET));
});

test("dry run writes neither factsheet nor original.txt", { skip }, async () => {
  const outDir = freshDir();
  const factsheetPath = path.join(tmpDir, `factsheet-dry-${seq}.txt`);
  const res = run(
    ["--stdin", "--dry-run", "--emit-factsheet", factsheetPath, "--keep-artifacts", outDir],
    { input: IDENTIFIER_TEXT }
  );
  assert.equal(res.status, 0);
  assert.equal(existsSync(factsheetPath), false);
  assert.equal(existsSync(outDir), false);
});
