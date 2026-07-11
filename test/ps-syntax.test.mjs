import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Windows PowerShell 5.1 (powershell.exe) is the wrapper's documented host.
// Parsing each script with its parser catches 7.x-only syntax (&&, ternary,
// null-coalescing) that would otherwise only fail on a user's machine.
const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const skip = process.platform !== "win32" && "powershell.exe only exists on Windows";

for (const script of ["pxpipe-clipboard.ps1"]) {
  test(`${script} parses under Windows PowerShell 5.1`, { skip }, () => {
    const scriptPath = path.join(repoRoot, script);
    const res = spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        // [scriptblock]::Create throws a ParseException on any syntax error.
        `$null = [scriptblock]::Create((Get-Content -Raw '${scriptPath.replace(/'/g, "''")}')); exit 0`,
      ],
      { encoding: "utf8" }
    );
    assert.equal(res.status, 0, `PowerShell 5.1 failed to parse ${script}:\n${res.stderr}`);
  });

  test(`${script} keeps user-visible strings ASCII-safe`, async () => {
    // PowerShell 5.1 reads BOM-less .ps1 files in the system ANSI codepage, so
    // any non-ASCII character in a string literal renders as mojibake on
    // non-Latin locales. Comments are exempt (never displayed).
    const source = await (await import("node:fs/promises")).readFile(path.join(repoRoot, script), "utf8");
    for (const [index, line] of source.split(/\r?\n/).entries()) {
      const beforeComment = line.split("#")[0];
      assert.match(beforeComment, /^[\x00-\x7F]*$/, `${script}:${index + 1} has non-ASCII outside a comment`);
    }
  });
}

test("pxpipe-clipboard-macos.sh passes bash -n", () => {
  const bash = spawnSync("bash", ["-n", path.join(repoRoot, "pxpipe-clipboard-macos.sh")], { encoding: "utf8" });
  if (bash.error) {
    // No bash on this machine — nothing to check here.
    return;
  }
  assert.equal(bash.status, 0, `bash -n failed:\n${bash.stderr}`);
});

test("pxpipe-clipboard-macos.sh rejects an unrecognized flag instead of treating it as the output dir", () => {
  // The argument-parsing loop runs before the pbpaste/macOS check, so this is
  // testable on any platform with bash — a typo like --images must not
  // silently become the output directory name (regression: it used to).
  const bash = spawnSync("bash", [path.join(repoRoot, "pxpipe-clipboard-macos.sh"), "--images"], {
    encoding: "utf8",
  });
  if (bash.error) return; // No bash on this machine.
  assert.equal(bash.status, 1);
  assert.match(bash.stderr, /Unknown option: --images/);
});
