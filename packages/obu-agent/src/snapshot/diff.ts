// WS-D: unified diff of two snapshot trees (line based). '' when equal or no previous.
//
// Myers O(ND) diff on lines, rendered as unified hunks with 1 line of context.
// Agents read the diff instead of the full tree after an action, so hunks stay
// small: refs on changed lines tell the agent exactly what moved.

const CONTEXT = 1;
/** Above this many edits the diff is no longer useful; the caller falls back to the tree. */
const MAX_EDIT_DISTANCE = 4000;

type Op = { kind: " " | "-" | "+"; line: string; a: number; b: number };

function myers(a: string[], b: string[]): Op[] | null {
  const n = a.length;
  const m = b.length;
  const max = Math.min(n + m, MAX_EDIT_DISTANCE);
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  let found = -1;
  for (let d = 0; d <= max; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) x = v[offset + k + 1];
      else x = v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        found = d;
        break;
      }
    }
    if (found >= 0) break;
  }
  if (found < 0) return null;
  // Backtrack.
  const ops: Op[] = [];
  let x = n;
  let y = m;
  for (let d = found; d > 0; d--) {
    const vd = trace[d];
    const k = x - y;
    const prevK = k === -d || (k !== d && vd[offset + k - 1] < vd[offset + k + 1]) ? k + 1 : k - 1;
    const prevX = vd[offset + prevK];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      x--;
      y--;
      ops.push({ kind: " ", line: a[x], a: x, b: y });
    }
    if (x === prevX) {
      y--;
      ops.push({ kind: "+", line: b[y], a: x, b: y });
    } else {
      x--;
      ops.push({ kind: "-", line: a[x], a: x, b: y });
    }
  }
  while (x > 0 && y > 0) {
    x--;
    y--;
    ops.push({ kind: " ", line: a[x], a: x, b: y });
  }
  return ops.reverse();
}

export function unifiedDiff(previous: string | undefined, next: string): string {
  if (previous === undefined || previous === next) return "";
  const a = previous.split("\n");
  const b = next.split("\n");
  // Trim common prefix/suffix first (the common case is a tiny local change).
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const midOps = myers(a.slice(pre, a.length - suf), b.slice(pre, b.length - suf));
  if (!midOps) return `@@ -1,${a.length} +1,${b.length} @@\n(page changed substantially; read the full tree)`;
  const ops: Op[] = [];
  for (let i = 0; i < pre; i++) ops.push({ kind: " ", line: a[i], a: i, b: i });
  for (const o of midOps) ops.push({ kind: o.kind, line: o.line, a: o.a + pre, b: o.b + pre });
  for (let i = suf; i > 0; i--) ops.push({ kind: " ", line: a[a.length - i], a: a.length - i, b: b.length - i });

  // Group into hunks.
  const out: string[] = [];
  let i = 0;
  while (i < ops.length) {
    while (i < ops.length && ops[i].kind === " ") i++;
    if (i >= ops.length) break;
    let start = Math.max(0, i - CONTEXT);
    let end = i;
    // Extend while changes are within 2*CONTEXT of each other.
    for (;;) {
      while (end < ops.length && ops[end].kind !== " ") end++;
      let j = end;
      while (j < ops.length && ops[j].kind === " " && j - end < 2 * CONTEXT + 1) j++;
      if (j < ops.length && ops[j].kind !== " " && j - end <= 2 * CONTEXT) end = j;
      else break;
    }
    const stop = Math.min(ops.length, end + CONTEXT);
    const slice = ops.slice(start, stop);
    const aStart = slice[0].a;
    const bStart = slice[0].b;
    const aLen = slice.filter((o) => o.kind !== "+").length;
    const bLen = slice.filter((o) => o.kind !== "-").length;
    out.push(`@@ -${aLen ? aStart + 1 : aStart},${aLen} +${bLen ? bStart + 1 : bStart},${bLen} @@`);
    for (const o of slice) out.push(`${o.kind}${o.line}`);
    i = stop;
    start = stop;
  }
  return out.join("\n");
}
