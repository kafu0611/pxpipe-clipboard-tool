// JXA (osascript -l JavaScript). Writes the given files to the general
// pasteboard as file URLs — one pasteboard item per file — so paste targets
// that accept file drops (Claude Code, Finder, Slack, ...) receive every page
// at once. Replaces the clipboard contents; no text flavor is written, since
// mixing a text item into a multi-item file list makes paste behavior
// app-dependent in ways a single-item PNG+text entry is not.
ObjC.import("AppKit");

function run(argv) {
  if (argv.length === 0) throw new Error("No files given.");
  const urls = argv.map((p) => $.NSURL.fileURLWithPath(p));
  const pasteboard = $.NSPasteboard.generalPasteboard;
  pasteboard.clearContents;
  if (!pasteboard.writeObjects($(urls))) throw new Error("Pasteboard write failed.");
}
