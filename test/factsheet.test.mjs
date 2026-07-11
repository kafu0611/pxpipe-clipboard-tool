import test from "node:test";
import assert from "node:assert/strict";

import { extractAnchorTokens, formatAnchorBlock } from "../lib/factsheet.mjs";

function values(tokens) {
  return tokens.map((t) => t.value);
}

test("extracts UUIDs", () => {
  const tokens = extractAnchorTokens("session 4542cc41-1315-4d64-98e2-7b4ce0f5be6c expired");
  assert.deepEqual(values(tokens), ["4542cc41-1315-4d64-98e2-7b4ce0f5be6c"]);
  assert.equal(tokens[0].kind, "uuid");
});

test("extracts git SHAs but not all-letter hex-ish words", () => {
  const tokens = extractAnchorTokens("commit ea6a025317e85f79b15b2cc559f00b113d8f54e7 vs deadface feedbeef");
  assert.deepEqual(values(tokens), ["ea6a025317e85f79b15b2cc559f00b113d8f54e7"]);
});

test("extracts short SHAs of 7+ chars", () => {
  const tokens = extractAnchorTokens("see 8b525a1 and 1c100a3 but not abc123");
  assert.deepEqual(values(tokens).sort(), ["1c100a3", "8b525a1"]);
});

test("extracts Windows and POSIX paths", () => {
  const tokens = extractAnchorTokens(
    String.raw`copy D:\Codex\pxpipe_clip\lib\gates.mjs over src/core/transform.ts please`
  );
  assert.deepEqual(values(tokens), [
    String.raw`D:\Codex\pxpipe_clip\lib\gates.mjs`,
    "src/core/transform.ts",
  ]);
});

test("extracts versions, ports, CLI flags, CONST_CASE, tickets, URLs", () => {
  const text =
    "pxpipe-proxy v0.8.0 listens on 47821; set PXPIPE_MODELS or pass --max-drop-ratio; " +
    "see PROJ-1482 and https://github.com/teamchong/pxpipe#roadmap";
  const kinds = Object.fromEntries(extractAnchorTokens(text).map((t) => [t.kind, t.value]));
  assert.equal(kinds.version, "v0.8.0");
  assert.equal(kinds.number, "47821");
  assert.equal(kinds["cli-flag"], "--max-drop-ratio");
  assert.equal(kinds["const-case"], "PXPIPE_MODELS");
  assert.equal(kinds.ticket, "PROJ-1482");
  assert.equal(kinds.url, "https://github.com/teamchong/pxpipe#roadmap");
});

test("ignores plain prose and short numbers", () => {
  assert.deepEqual(extractAnchorTokens("the quick brown fox jumped over 42 lazy dogs"), []);
});

test("strips trailing sentence punctuation", () => {
  const tokens = extractAnchorTokens("visit https://example.com/docs.");
  assert.deepEqual(values(tokens), ["https://example.com/docs"]);
});

test("dedupes repeated tokens", () => {
  const tokens = extractAnchorTokens("8b525a1 mentioned twice: 8b525a1");
  assert.deepEqual(values(tokens), ["8b525a1"]);
});

test("collapses tokens contained in a longer kept token", () => {
  const tokens = extractAnchorTokens("https://github.com/teamchong/pxpipe is the repo");
  // The posix-path fragment github.com/teamchong/pxpipe must not appear next
  // to the URL that contains it.
  assert.deepEqual(values(tokens), ["https://github.com/teamchong/pxpipe"]);
});

test("orders opaque identifiers before paths before URLs", () => {
  const tokens = extractAnchorTokens(
    "https://example.com/x then src/lib/a.ts then ea6a025317e85f79b15b2cc559f00b113d8f54e7"
  );
  assert.deepEqual(
    tokens.map((t) => t.kind),
    ["hex", "posix-path", "url"]
  );
});

test("caps URLs at 8", () => {
  const text = Array.from({ length: 12 }, (_, i) => `https://example.com/page-${i}`).join(" ");
  const urls = extractAnchorTokens(text, { maxTokens: 10_000 }).filter((t) => t.kind === "url");
  assert.equal(urls.length, 8);
});

test("token budget evicts low-tier tokens, keeps opaque identifiers", () => {
  const sha = "ea6a025317e85f79b15b2cc559f00b113d8f54e7";
  const filler = Array.from({ length: 50 }, (_, i) => `https://example.com/very/long/path/number/${i}`);
  const tokens = extractAnchorTokens(`${filler.join(" ")} ${sha}`, { maxTokens: 20 });
  assert.ok(values(tokens).includes(sha), "SHA must survive the budget");
  assert.ok(tokens.length < 9, "most URLs must be evicted");
});

test("is deterministic", () => {
  const text = String.raw`v1.2.3 D:\a\b.txt 8b525a1 https://x.example --flag PORT_NUMBER 47821 AB-12`;
  const a = JSON.stringify(extractAnchorTokens(text));
  const b = JSON.stringify(extractAnchorTokens(text));
  assert.equal(a, b);
});

test("handles pathological unbroken tokens without hanging", () => {
  const start = Date.now();
  extractAnchorTokens("a".repeat(5_000_000));
  assert.ok(Date.now() - start < 5_000);
});

test("formatAnchorBlock renders a one-line header plus one token per line", () => {
  const block = formatAnchorBlock([{ value: "8b525a1", kind: "hex" }, { value: "src/a.ts", kind: "posix-path" }]);
  const lines = block.split("\n");
  // Kept to a single short line on purpose: this file may itself be read by a
  // model, so its own boilerplate should not dwarf one or two identifiers —
  // see the regression where a two-sentence header inflated factsheetTokens
  // enough to tip small identifier-heavy renders into NOT_PROFITABLE.
  assert.match(lines[0], /^# pxpipe anchors/);
  assert.match(lines[0], /original text is authoritative/);
  assert.equal(lines[1], "8b525a1");
  assert.equal(lines[2], "src/a.ts");
});

test("formatAnchorBlock returns empty string for no tokens", () => {
  assert.equal(formatAnchorBlock([]), "");
});
