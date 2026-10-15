// Deterministic code derivation shared by fixtures: fnv1a-32 -> base36, uppercased.
function benchCode(s) {
  let h = 0x811c9dc5;
  for (const c of s) { h ^= c.codePointAt(0); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(36).toUpperCase().padStart(7, "0");
}
function reveal(el, text) { el.textContent = text; el.setAttribute("data-revealed", "1"); }
