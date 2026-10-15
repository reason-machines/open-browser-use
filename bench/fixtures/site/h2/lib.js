// Shared helpers for hard2 fixtures (loaded after ../common.js).
async function sha12(file) {
  const h = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return [...new Uint8Array(h)].map(b => b.toString(16).padStart(2, "0")).join("").slice(0, 12);
}
function norm(s) { return s.replace(/ /g, " ").replace(/\s+/g, " ").trim(); }

// Mention typeahead for a contenteditable editor. `people` = [{handle, name}]; trigger "@" + >= minChars.
function attachMentions(editor, people, { minChars = 1, delay = 0, chipText = p => "@" + p.handle } = {}) {
  const pop = document.createElement("div");
  pop.setAttribute("role", "listbox");
  pop.className = "mention-pop";
  pop.style.cssText = "position:absolute;display:none;background:#fff;border:1px solid #999;box-shadow:0 4px 14px #0003;z-index:50;min-width:220px";
  document.body.appendChild(pop);
  let active = 0, matches = [], timer = null;
  function queryAtCaret() {
    const sel = getSelection();
    if (!sel.rangeCount || !editor.contains(sel.anchorNode) || sel.anchorNode.nodeType !== 3) return null;
    const before = sel.anchorNode.textContent.slice(0, sel.anchorOffset);
    const m = before.match(/@([\w ]{0,24})$/);
    return m ? { node: sel.anchorNode, start: sel.anchorOffset - m[0].length, end: sel.anchorOffset, q: m[1] } : null;
  }
  function choose(p) {
    const q = queryAtCaret(); if (!q) return;
    const r = document.createRange(); r.setStart(q.node, q.start); r.setEnd(q.node, q.end); r.deleteContents();
    const chip = document.createElement("span");
    chip.className = "mention"; chip.contentEditable = "false"; chip.dataset.handle = p.handle; chip.textContent = chipText(p);
    chip.style.cssText = "color:#1d6fe0;font-weight:600";
    r.insertNode(chip);
    const sp = document.createTextNode(" "); chip.after(sp);
    const sel = getSelection(); sel.removeAllRanges(); const r2 = document.createRange(); r2.setStart(sp, 1); r2.collapse(true); sel.addRange(r2);
    hide(); editor.dispatchEvent(new Event("input", { bubbles: true }));
  }
  function hide() { pop.style.display = "none"; matches = []; }
  function render() {
    pop.innerHTML = "";
    matches.forEach((p, i) => {
      const o = document.createElement("div"); o.setAttribute("role", "option"); o.setAttribute("aria-selected", i === active);
      o.style.cssText = "padding:8px 12px;cursor:pointer;" + (i === active ? "background:#e8f0fe" : "");
      o.innerHTML = `<b></b> <span style="color:#666"></span>`; o.querySelector("b").textContent = p.name; o.querySelector("span").textContent = "@" + p.handle;
      o.addEventListener("mousedown", e => { e.preventDefault(); choose(p); });
      pop.appendChild(o);
    });
    const sel = getSelection(); if (!sel.rangeCount) return;
    const rect = sel.getRangeAt(0).getBoundingClientRect();
    pop.style.left = rect.left + scrollX + "px"; pop.style.top = rect.bottom + scrollY + 4 + "px"; pop.style.display = matches.length ? "block" : "none";
  }
  editor.addEventListener("input", () => {
    clearTimeout(timer);
    const q = queryAtCaret();
    if (!q || q.q.length < minChars) return hide();
    const run = () => { const s = q.q.toLowerCase().trim(); matches = people.filter(p => p.handle.toLowerCase().startsWith(s) || p.name.toLowerCase().includes(s)).slice(0, 5); active = 0; render(); };
    if (delay) { pop.style.display = "block"; pop.textContent = "Searching…"; const sel = getSelection(); const rect = sel.getRangeAt(0).getBoundingClientRect(); pop.style.left = rect.left + scrollX + "px"; pop.style.top = rect.bottom + scrollY + 4 + "px"; timer = setTimeout(run, delay); } else run();
  });
  editor.addEventListener("keydown", e => {
    if (!matches.length || pop.style.display === "none") return;
    if (e.key === "ArrowDown") { active = (active + 1) % matches.length; render(); e.preventDefault(); }
    else if (e.key === "ArrowUp") { active = (active - 1 + matches.length) % matches.length; render(); e.preventDefault(); }
    else if (e.key === "Enter" || e.key === "Tab") { choose(matches[active]); e.preventDefault(); }
    else if (e.key === "Escape") hide();
  });
  editor.addEventListener("blur", () => setTimeout(hide, 150));
}
function mentionsIn(editor) { return [...editor.querySelectorAll(".mention")].map(c => c.dataset.handle); }
