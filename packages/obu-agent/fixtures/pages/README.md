Fixture pages (WS-G). One file per entry in `../pages.mjs`, plus helper pages
(`iframe-form.html`, `iframe-leaf.html`, `upload-frame.html`, `oauth-popup.html`,
`plain.txt`) and the shared `fx.js` recorder.

Every page records outcomes in `window.__fx` (`events[]`, `state{}`, `last(type)`,
`count(type)`) so e2e tests verify results from the page itself, never from the
agent's own report. Pages avoid `requestAnimationFrame` for behaviour so they work
in background tabs.
