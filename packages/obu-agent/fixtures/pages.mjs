// Fixture page list (WS-G owns). `file` lives in fixtures/pages/. Golden snapshots (WS-D) key off `file`.
// `hard` marks the PLAN D6 hard cases; `probe` is the window.__fx state key e2e tests assert on.
// Helper-only pages (iframe-form, iframe-leaf, upload-frame, oauth-popup, fx.js, plain.txt) are not listed.
export const PAGES = [
  { file: "form.html", covers: "inputs, select, date/time/color/range, checkbox/radio with labels, submit", probe: "submitted" },
  { file: "table.html", covers: "data table, sortable headers", probe: "order" },
  { file: "iframes.html", covers: "nested same-origin + cross-origin (OOPIF) iframes with forms", hard: "oopif", probe: "inner-submit" },
  { file: "shadow.html", covers: "open + closed shadow DOM, slotted content, buttons inside shadow", hard: "shadow" },
  { file: "pointer-divs.html", covers: "cursor:pointer div buttons, onclick, tabindex, inherited pointer, hover menu" },
  { file: "aria-owns.html", covers: "aria-owns reparenting, listbox/combobox", probe: "picked" },
  { file: "hidden.html", covers: "display:none / visibility / aria-hidden subtrees, off-screen-below content" },
  { file: "dialogs.html", covers: "alert / confirm / prompt / beforeunload / <dialog>", hard: "dialogs", probe: "confirm" },
  { file: "long-list.html", covers: "2,000-node page", hard: "perf" },
  { file: "spa.html", covers: "pushState route change, slow XHR (2 s), infinite spinner", hard: "spa", probe: "route" },
  { file: "editable.html", covers: "contenteditable, textarea (Cmd+A/C/V), emoji + CJK, rich editor", probe: "ta" },
  { file: "select.html", covers: "native select, multi-select, custom listbox", probe: "ship" },
  { file: "upload.html", covers: "file input, hidden styled input, file input inside iframe, drop zone", hard: "upload", probe: "single" },
  { file: "download.html", covers: "Content-Disposition, download attr, blob, slow, location.assign downloads; ?tag= for per-tab", hard: "download" },
  { file: "popup.html", covers: "window.open popup, target=_blank, noopener, OAuth-style popup postMessage", hard: "popup", probe: "oauth" },
  { file: "canvas.html", covers: "canvas-only UI (screenshot / coordinate fallback)", probe: "picked" },
  { file: "obscured.html", covers: "overlay-covered button, transparent glass, disclosure, moving button", hard: "obscured" },
  { file: "infinite-scroll.html", covers: "IntersectionObserver feed, 10 pages x 20 posts, needle in post 137", hard: "scroll", probe: "pages" },
  { file: "datepicker.html", covers: "native date input + custom calendar dialog with month navigation", hard: "datepicker", probe: "checkout" },
  { file: "dragdrop.html", covers: "HTML5 DnD kanban + pointer-captured slider", hard: "drag", probe: "card-a" },
  { file: "viewport-probe.html", covers: "innerWidth/screen/outer/dpr/visibility coherence under metrics override", hard: "viewport", probe: "probe" },
  { file: "sentinel.html", covers: "user foreground tab recording blur/visibility (focus-theft sentinel)", hard: "focus" },
  { file: "detect.html", covers: "Runtime.enable / console-serialisation anti-bot probe (I8)", hard: "stealth", probe: "runtimeEnabled" },
  { file: "bench.html", covers: "micro-bench page: input, counter button, delayed mutation, 40 links" },
];
