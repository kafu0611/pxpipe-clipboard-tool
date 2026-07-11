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
}
