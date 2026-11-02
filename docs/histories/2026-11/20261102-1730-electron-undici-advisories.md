# Bump Electron and undici past open advisories

Request (condensed): resolve the dependency-sweep findings for Electron 44.7.0 (GHSA-jr5w-w6x2-84p9, high, fixed in 44.9.1) and undici 7.30.0 (four high and four moderate advisories, fixed in 7.30.1).

- **Electron dev dependency:** `examples/electron-iab` and `packages/open-browser-use-electron` pin `electron` 44.10.1, the latest 44.x patch. The package's `electron` peer range (`>=30 <45`) is unchanged, so consumers keep bringing their own Electron.
- **undici:** it reaches the tree only as an optional dependency of `@electron/get` (Electron's download helper), and the Electron bump alone still resolved 7.30.0. A root `pnpm.overrides` entry `undici: ^7.30.1` moves it to 7.30.1 and keeps it on the 7.x line `@electron/get` expects.
- `pnpm audit` goes from 5 high / 6 moderate to 0 high / 2 moderate. The two remaining moderates (minimatch 9.0.9 and glob 10.5.0 through `node-gyp`) are outside this change.

Files: `package.json`, `pnpm-lock.yaml`, `examples/electron-iab/package.json`, `packages/open-browser-use-electron/package.json`.
