// Anchor-token extraction: pulls precision-critical identifiers (hashes, UUIDs,
// paths, URLs, versions, long numbers) out of text so they can travel as plain
// text next to a rendered image. Best-effort recovery assistance only — exact
// values remain authoritative solely in the original text; extraction can and
// will miss identifiers it has no pattern for.
//
// Pattern ideas credit teamchong/pxpipe's src/core/factsheet.ts (unexported and
// not in the published 0.8.0). The API here is kept upstream-shaped on purpose
// so this module can be swapped for the upstream extractor if it is published.

// Rough conservative token estimate for budgeting (identifiers tokenize badly,
// closer to 3 chars/token than prose's ~4).
function estimateTokens(value) {
  return Math.ceil(value.length / 3) + 1;
}

// Ordered by tier: lower tier = more valuable = evicted last. Opaque short
// identifiers (a mis-OCR is silent and unrecoverable) outrank paths/versions,
// which outrank URLs (often reconstructable from context).
const CATEGORIES = [
  {
    kind: "uuid",
    tier: 0,
    re: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
  },
  {
    // Git SHAs and other opaque hex: 7-40 hex chars containing at least one
    // digit (pure-letter words like "deadface" are more often prose).
    kind: "hex",
    tier: 0,
    re: /\b(?=[0-9a-fA-F]*\d)[0-9a-fA-F]{7,40}\b/g,
  },
  {
    kind: "ticket",
    tier: 1,
    re: /\b[A-Z][A-Z0-9]{1,9}-\d{1,6}\b/g,
  },
  {
    kind: "windows-path",
    tier: 1,
    re: /\b[A-Za-z]:\\[^\s"'<>|*?]+/g,
  },
  {
    kind: "posix-path",
    tier: 1,
    re: /(?<![\w:])\/?(?:[\w.@+-]+\/)+[\w.@+-]+/g,
  },
  {
    kind: "const-case",
    tier: 2,
    re: /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g,
  },
  {
    kind: "version",
    tier: 2,
    re: /\bv?\d+\.\d+(?:\.\d+)+(?:-[\w.]+)?\b/g,
  },
  {
    kind: "cli-flag",
    tier: 3,
    re: /(?<=^|\s)--?[a-zA-Z][\w-]+/g,
  },
  {
    // Ports and other long plain numbers (4+ digits).
    kind: "number",
    tier: 3,
    re: /\b\d[\d,_]{3,}\b/g,
  },
  {
    kind: "url",
    tier: 4,
    re: /\bhttps?:\/\/[^\s"'<>)\]]+/gi,
    cap: 8,
  },
];

// Trailing punctuation that is almost always sentence context, not identifier.
const TRAILING_JUNK = /[.,;:!?]+$/;

// Guard against pathological single tokens; every pattern above is linear-time,
// so a cap on the unbroken run length is all the ReDoS safety needed.
const MAX_CHUNK_LENGTH = 512;

export function extractAnchorTokens(text, { maxTokens = 96 } = {}) {
  const chunks = String(text)
    .split(/\s+/)
    .filter(Boolean)
    .map((c) => (c.length > MAX_CHUNK_LENGTH ? c.slice(0, MAX_CHUNK_LENGTH) : c));

  const seen = new Set();
  const found = [];
  for (const category of CATEGORIES) {
    let kept = 0;
    for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex += 1) {
      if (category.cap !== undefined && kept >= category.cap) break;
      for (const match of chunks[chunkIndex].matchAll(category.re)) {
        const value = match[0].replace(TRAILING_JUNK, "");
        if (!value || seen.has(value)) continue;
        seen.add(value);
        found.push({ value, kind: category.kind, tier: category.tier, order: chunkIndex });
        kept += 1;
        if (category.cap !== undefined && kept >= category.cap) break;
      }
    }
  }

  // Substring collapse: a token contained in a longer kept token (a path
  // fragment inside a URL, a version inside a path) adds nothing.
  const collapsed = found.filter(
    (t) => !found.some((other) => other !== t && other.value.includes(t.value))
  );

  // Deterministic order: most valuable tier first, then first appearance.
  collapsed.sort((a, b) => a.tier - b.tier || a.order - b.order || (a.value < b.value ? -1 : 1));

  // Budget: evict from the tail (least valuable) until the estimate fits.
  const result = [];
  let budget = maxTokens;
  for (const token of collapsed) {
    const cost = estimateTokens(token.value);
    if (cost > budget) continue;
    budget -= cost;
    result.push({ value: token.value, kind: token.kind });
  }
  return result;
}

export function formatAnchorBlock(tokens) {
  if (!tokens.length) return "";
  const lines = tokens.map((t) => (typeof t === "string" ? t : t.value));
  // One short line, not a paragraph: this file may itself be read by a model,
  // so its own boilerplate should not dwarf the one or two identifiers it
  // carries. Full context lives in the README, not repeated in every output.
  return ["# pxpipe anchors — best-effort, original text is authoritative", ...lines, ""].join("\n");
}
