## [2026-10-15 21:00] | Task: WS-D snapshot engine

### 🤖 Execution Context

- **Agent ID**: `r1-snapshot fork`
- **Base Model**: `claude-opus-5-5`
- **Runtime**: `Claude Code (fork-rounds Round 1)`

### 📥 User Query

> Build best-in-class agent browser use on local Mac Chrome; WS-D = clean-room aria snapshot engine for obu-agent.

### 🛠 Changes Overview

**Scope:** `packages/obu-agent` (injected/, snapshot/, test/, scripts/), `docs/agent/contract.md`

**Key Actions:**

- **Injected runtime**: self-contained `installObu` (isolated world) — DOM walk with open shadow roots, slots, aria-owns, pseudo-element text; HTML-AAM roles incl. layout-table detection; accname-style names; refs only on interactive nodes, stable per (role, name); role+name+nth deref fallback; actionability/hit-test/pointer/editable/settle helpers; set-of-marks overlay.
- **Daemon side**: `takeSnapshot` (main frame ×3 retries, child frames in parallel, OOPIF owner mapping via `DOM.getFrameOwner` + `refOf`), `stitchFrames`, Myers `unifiedDiff`, `withAnnotations`, typed errors (`stale_ref`, `invalid_params`, `snapshot_too_large{advice}`).
- **Tests**: 14 golden pages × full/interactive, ref stability, one-line diff, scoping, OOPIF, redaction/visibility, helpers, latency budget; live in Chrome for Testing with a throwaway profile.

### 🧠 Design Intent (Why)

Agents need one cheap, stable, diffable read of the page per step. Walking the DOM in an isolated world (no `Runtime.enable`, no full AX tree) is ~10–50 ms on real sites and the YAML is 2–3% of the raw AX JSON.

### 📁 Files Modified

- `packages/obu-agent/src/injected/{api,index,runtime}.ts`
- `packages/obu-agent/src/snapshot/{index,diff,stitch,annotate}.ts`
- `packages/obu-agent/scripts/{build-injected,snap-dump,snap-bench}.mjs`
- `packages/obu-agent/test/snapshot.test.mjs`, `packages/obu-agent/test/golden/**`
- `packages/obu-agent/package.json`, `docs/agent/contract.md`
