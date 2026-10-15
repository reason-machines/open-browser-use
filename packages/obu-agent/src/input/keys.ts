// WS-E: Playwright key syntax -> CDP Input.dispatchKeyEvent, incl. Mac editing
// `commands` (selectAll, copy, paste, cut, undo, redo, …) and ControlOrMeta ->
// Meta on darwin. Without `commands`, Cmd shortcuts do nothing through CDP on Mac.
import { ObuError } from "../errors.js";
import type { TabCdp } from "../seams.js";

export const MAC_EDITING_COMMANDS: Record<string, string> = {
  "Meta+A": "selectAll",
  "Meta+C": "copy",
  "Meta+V": "paste",
  "Meta+X": "cut",
  "Meta+Z": "undo",
  "Meta+Shift+Z": "redo",
  "Shift+ArrowLeft": "moveLeftAndModifySelection",
  "Shift+ArrowRight": "moveRightAndModifySelection",
  "Shift+ArrowUp": "moveUpAndModifySelection",
  "Shift+ArrowDown": "moveDownAndModifySelection",
  "Meta+ArrowLeft": "moveToBeginningOfLine",
  "Meta+ArrowRight": "moveToEndOfLine",
  "Meta+ArrowUp": "moveToBeginningOfDocument",
  "Meta+ArrowDown": "moveToEndOfDocument",
  "Meta+Shift+ArrowLeft": "moveToBeginningOfLineAndModifySelection",
  "Meta+Shift+ArrowRight": "moveToEndOfLineAndModifySelection",
  "Alt+ArrowLeft": "moveWordLeft",
  "Alt+ArrowRight": "moveWordRight",
  "Alt+Shift+ArrowLeft": "moveWordLeftAndModifySelection",
  "Alt+Shift+ArrowRight": "moveWordRightAndModifySelection",
  "Alt+Backspace": "deleteWordBackward",
  "Alt+Delete": "deleteWordForward",
  "Meta+Backspace": "deleteToBeginningOfLine",
};

export const MODIFIER_BITS = { Alt: 1, Control: 2, Meta: 4, Shift: 8 } as const;
export type Modifier = keyof typeof MODIFIER_BITS;

export interface KeyDef {
  key: string;
  code: string;
  keyCode: number;
  /** Text produced (unshifted). */
  text?: string;
  shiftKey?: string;
  shiftText?: string;
  location?: number;
}

const DEFS = new Map<string, KeyDef>();
function def(d: KeyDef): void {
  DEFS.set(d.key, d);
  if (d.shiftKey && !DEFS.has(d.shiftKey)) DEFS.set(d.shiftKey, { ...d, key: d.shiftKey, text: d.shiftText ?? d.shiftKey, shiftKey: undefined });
}

// Named keys.
const NAMED: [string, string, number, string?][] = [
  ["Backspace", "Backspace", 8], ["Tab", "Tab", 9, "\t"], ["Enter", "Enter", 13, "\r"], ["Escape", "Escape", 27],
  ["Space", "Space", 32, " "], ["PageUp", "PageUp", 33], ["PageDown", "PageDown", 34], ["End", "End", 35], ["Home", "Home", 36],
  ["ArrowLeft", "ArrowLeft", 37], ["ArrowUp", "ArrowUp", 38], ["ArrowRight", "ArrowRight", 39], ["ArrowDown", "ArrowDown", 40],
  ["Insert", "Insert", 45], ["Delete", "Delete", 46], ["CapsLock", "CapsLock", 20],
];
for (const [key, code, keyCode, text] of NAMED) def({ key, code, keyCode, text });
DEFS.set(" ", { key: " ", code: "Space", keyCode: 32, text: " " });
DEFS.set("\n", { key: "Enter", code: "Enter", keyCode: 13, text: "\r" });
DEFS.set("\r", { key: "Enter", code: "Enter", keyCode: 13, text: "\r" });
DEFS.set("\t", { key: "Tab", code: "Tab", keyCode: 9, text: "\t" });
for (let i = 1; i <= 12; i++) def({ key: `F${i}`, code: `F${i}`, keyCode: 111 + i });
// Modifiers (left location).
def({ key: "Shift", code: "ShiftLeft", keyCode: 16, location: 1 });
def({ key: "Control", code: "ControlLeft", keyCode: 17, location: 1 });
def({ key: "Alt", code: "AltLeft", keyCode: 18, location: 1 });
def({ key: "Meta", code: "MetaLeft", keyCode: 91, location: 1 });
// Letters.
for (let c = 0; c < 26; c++) {
  const lower = String.fromCharCode(97 + c);
  const upper = lower.toUpperCase();
  def({ key: lower, code: `Key${upper}`, keyCode: 65 + c, text: lower, shiftKey: upper, shiftText: upper });
}
// Digits and US punctuation: [unshifted, shifted, code, keyCode].
const SYMBOLS: [string, string, string, number][] = [
  ["1", "!", "Digit1", 49], ["2", "@", "Digit2", 50], ["3", "#", "Digit3", 51], ["4", "$", "Digit4", 52], ["5", "%", "Digit5", 53],
  ["6", "^", "Digit6", 54], ["7", "&", "Digit7", 55], ["8", "*", "Digit8", 56], ["9", "(", "Digit9", 57], ["0", ")", "Digit0", 48],
  ["-", "_", "Minus", 189], ["=", "+", "Equal", 187], ["[", "{", "BracketLeft", 219], ["]", "}", "BracketRight", 221],
  ["\\", "|", "Backslash", 220], [";", ":", "Semicolon", 186], ["'", "\"", "Quote", 222], [",", "<", "Comma", 188],
  [".", ">", "Period", 190], ["/", "?", "Slash", 191], ["`", "~", "Backquote", 192],
];
for (const [key, shiftKey, code, keyCode] of SYMBOLS) def({ key, code, keyCode, text: key, shiftKey, shiftText: shiftKey });

const ALIASES: Record<string, string> = {
  Return: "Enter", Esc: "Escape", Del: "Delete", Up: "ArrowUp", Down: "ArrowDown", Left: "ArrowLeft", Right: "ArrowRight",
  Ctrl: "Control", Cmd: "Meta", Command: "Meta", Option: "Alt", Opt: "Alt", Super: "Meta", Win: "Meta",
};

export function isMac(): boolean {
  return process.platform === "darwin";
}

/** Parse "ControlOrMeta+Shift+A" into modifiers + key. A lone "+" or trailing "++" means the plus key. */
export function parseShortcut(input: string, mac = isMac()): { modifiers: Modifier[]; key: string } {
  if (!input) throw new ObuError("invalid_params", "press needs `keys`, e.g. \"Enter\" or \"ControlOrMeta+A\".");
  const tokens: string[] = [];
  let rest = input;
  while (rest.length) {
    const i = rest.indexOf("+", 1);
    if (i < 0) { tokens.push(rest); break; }
    tokens.push(rest.slice(0, i));
    rest = rest.slice(i + 1);
  }
  const keyToken = tokens.pop()!;
  const modifiers: Modifier[] = [];
  for (const raw of tokens) {
    const name = raw === "ControlOrMeta" ? (mac ? "Meta" : "Control") : (ALIASES[raw] ?? raw);
    if (!(name in MODIFIER_BITS)) throw new ObuError("invalid_params", `Unknown modifier "${raw}" in "${input}". Use Alt, Control, Meta, Shift or ControlOrMeta.`);
    if (!modifiers.includes(name as Modifier)) modifiers.push(name as Modifier);
  }
  let key = keyToken === "ControlOrMeta" ? (mac ? "Meta" : "Control") : (ALIASES[keyToken] ?? keyToken);
  if (key.length === 1 && /[A-Z]/.test(key) && !modifiers.includes("Shift") && modifiers.length > 0) key = key.toLowerCase();
  return { modifiers, key };
}

export function modifierMask(mods: readonly string[] | undefined, mac = isMac()): number {
  let mask = 0;
  for (const m of mods ?? []) {
    const name = m === "ControlOrMeta" ? (mac ? "Meta" : "Control") : (ALIASES[m] ?? m);
    mask |= MODIFIER_BITS[name as Modifier] ?? 0;
  }
  return mask;
}

/** Canonical "Meta+Shift+Z"-style name for the MAC_EDITING_COMMANDS lookup. */
function commandName(modifiers: Modifier[], def: KeyDef): string {
  const order: Modifier[] = ["Control", "Alt", "Meta", "Shift"];
  const keyName = def.key.length === 1 ? def.key.toUpperCase() : def.key;
  const parts = order.filter((m) => modifiers.includes(m));
  // Canonical table uses Meta before Shift, Alt before Shift.
  return [...parts, keyName].join("+");
}

export function keyDefinition(key: string): KeyDef | undefined {
  return DEFS.get(key);
}

export interface KeyEventParams {
  type: "keyDown" | "rawKeyDown" | "keyUp" | "char";
  modifiers: number;
  key: string;
  code: string;
  windowsVirtualKeyCode: number;
  nativeVirtualKeyCode?: number;
  text?: string;
  unmodifiedText?: string;
  location?: number;
  autoRepeat: boolean;
  isKeypad: boolean;
  commands?: string[];
}

/** CDP key events for one shortcut (modifier downs, key down/up, modifier ups). */
export function keyEvents(shortcut: string, mac = isMac()): KeyEventParams[] {
  const { modifiers, key } = parseShortcut(shortcut, mac);
  const d = DEFS.get(key);
  if (!d) {
    if ([...key].length === 1) {
      // Unknown single character (e.g. "é"): a keyDown with text inserts it.
      return [
        { type: "keyDown", modifiers: modifierMask(modifiers, mac), key, code: "", windowsVirtualKeyCode: 0, text: key, unmodifiedText: key, autoRepeat: false, isKeypad: false },
        { type: "keyUp", modifiers: modifierMask(modifiers, mac), key, code: "", windowsVirtualKeyCode: 0, autoRepeat: false, isKeypad: false },
      ];
    }
    throw new ObuError("invalid_params", `Unknown key "${key}" in "${shortcut}". Use names like Enter, Tab, Escape, ArrowDown, Backspace, a, A, F5.`);
  }
  const events: KeyEventParams[] = [];
  let mask = 0;
  for (const m of modifiers) {
    mask |= MODIFIER_BITS[m];
    const md = DEFS.get(m)!;
    events.push({ type: "rawKeyDown", modifiers: mask, key: md.key, code: md.code, windowsVirtualKeyCode: md.keyCode, location: md.location, autoRepeat: false, isKeypad: false });
  }
  const shifted = modifiers.includes("Shift") && d.shiftKey ? DEFS.get(d.shiftKey)! : d;
  // Text is produced unless Control/Meta is held (Alt on Mac may compose; keep text for Alt-only).
  const producesText = !!shifted.text && !modifiers.includes("Control") && !modifiers.includes("Meta");
  const down: KeyEventParams = {
    type: producesText ? "keyDown" : "rawKeyDown",
    modifiers: mask,
    key: shifted.key,
    code: d.code,
    windowsVirtualKeyCode: d.keyCode,
    text: producesText ? shifted.text : undefined,
    unmodifiedText: producesText ? d.text : undefined,
    location: d.location,
    autoRepeat: false,
    isKeypad: false,
  };
  if (mac) {
    const cmd = MAC_EDITING_COMMANDS[commandName(modifiers, d)];
    if (cmd) down.commands = [cmd];
  }
  events.push(down);
  events.push({ type: "keyUp", modifiers: mask, key: shifted.key, code: d.code, windowsVirtualKeyCode: d.keyCode, location: d.location, autoRepeat: false, isKeypad: false });
  for (const m of [...modifiers].reverse()) {
    mask &= ~MODIFIER_BITS[m];
    const md = DEFS.get(m)!;
    events.push({ type: "keyUp", modifiers: mask, key: md.key, code: md.code, windowsVirtualKeyCode: md.keyCode, location: md.location, autoRepeat: false, isKeypad: false });
  }
  return events;
}

/** Press a shortcut (or a sequence separated by spaces is NOT supported: one shortcut per call). */
export async function press(cdp: TabCdp, shortcut: string): Promise<void> {
  for (const ev of keyEvents(shortcut)) await cdp.send("Input.dispatchKeyEvent", ev as unknown as Record<string, unknown>);
}

/** Characters typed as real key events (so key handlers fire); everything else goes through insertText. */
function isKeyboardChar(ch: string): boolean {
  return ch.length === 1 && (DEFS.has(ch) || ch === "\n") && ch.charCodeAt(0) < 128;
}

/**
 * Type text: ASCII as key events (keydown/keypress/input/keyup fire), newline as
 * Enter, and runs of emoji / CJK / other non-ASCII via Input.insertText (exact).
 */
export async function typeText(cdp: TabCdp, text: string): Promise<void> {
  const chars = [...text];
  let i = 0;
  while (i < chars.length) {
    const ch = chars[i];
    if (ch === "\n" || ch === "\r") {
      await press(cdp, "Enter");
      i++;
      continue;
    }
    if (isKeyboardChar(ch)) {
      const d = DEFS.get(ch)!;
      const base = DEFS.get(ch.toLowerCase()) ?? d;
      const shift = ch !== ch.toLowerCase() || SYMBOLS.some(([, s]) => s === ch);
      const mask = shift ? MODIFIER_BITS.Shift : 0;
      await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", modifiers: mask, key: ch, code: base.code, windowsVirtualKeyCode: base.keyCode, text: ch, unmodifiedText: ch, autoRepeat: false, isKeypad: false });
      await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", modifiers: mask, key: ch, code: base.code, windowsVirtualKeyCode: base.keyCode, autoRepeat: false, isKeypad: false });
      i++;
      continue;
    }
    let j = i;
    while (j < chars.length && !isKeyboardChar(chars[j]) && chars[j] !== "\n" && chars[j] !== "\r") j++;
    await cdp.send("Input.insertText", { text: chars.slice(i, j).join("") });
    i = j;
  }
}
