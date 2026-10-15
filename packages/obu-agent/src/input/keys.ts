// WS-E: Playwright key syntax -> CDP Input.dispatchKeyEvent, incl. Mac editing `commands`
// (selectAll, copy, paste, cut, undo, redo) and ControlOrMeta -> Meta on darwin.
export const MAC_EDITING_COMMANDS: Record<string, string> = {
  "Meta+A": "selectAll",
  "Meta+C": "copy",
  "Meta+V": "paste",
  "Meta+X": "cut",
  "Meta+Z": "undo",
  "Meta+Shift+Z": "redo",
};
