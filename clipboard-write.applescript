-- Pass an empty string as the second argument for image-only mode (no text flavor
-- written) — used when the target app's paste handler prefers text over image
-- whenever both are present on the clipboard.
on run argv
    set pngPath to item 1 of argv
    set textPath to item 2 of argv
    set pngData to read (POSIX file pngPath) as «class PNGf»
    if textPath is "" then
        set the clipboard to pngData
    else
        set textData to read (POSIX file textPath) as «class utf8»
        set the clipboard to {«class PNGf»:pngData, string:textData}
    end if
end run
