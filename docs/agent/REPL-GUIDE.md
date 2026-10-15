# Browser REPL guide (`browser_repl`)

You get a persistent JavaScript sandbox wired to your own Chrome tabs.
Variables survive between calls. Top-level `await` works. Only what you
`console.log` (plus the last expression) comes back.

## Globals

- `page`: your active tab, Playwright-style. `goto(url)`, `click/dblclick/hover/fill/type/press/check/uncheck/selectOption/setInputFiles(target, …)`, `dragAndDrop(a, b)`, `scroll('down')`, `innerText/textContent/inputValue(target)`, `evaluate(fn, arg)` (DOM access; add `{world:'page'}` for page JS globals), `waitForText/waitForSelector/waitForURL`, `waitForEvent('download'|'popup'|'dialog')`, `screenshot({path})`, `annotatedScreenshot()`, `pdf({path})`, `title()`, `url()`, `close()`.
- Targets: a ref from the latest snapshot (`'e12'`, `'f1e3'` inside iframe 1), a CSS selector, or a locator: `page.getByRole('button', {name: 'Save'})`, `page.getByText('Sign in')`, `page.getByLabel('Email')`, `page.getByPlaceholder('Search')`, `page.locator('li.item').nth(2)`.
- `snapshot()` / `page.snapshot({interactive: true})`: aria tree with refs, plus a diff against your previous snapshot.
- `context.newPage(url)`: another tab of yours, in the background.
- `display(buffer|path)`: show an image to yourself. `fs.readFile/writeFile/list`: files under `./artifacts` only.

## Rules

1. **Pack the work into one call.** Chain the actions you already know, then end with `console.log(await snapshot({interactive: true}))` to see the result. Split into a new call only when the next step depends on what you will see.
2. **Never sleep.** Every action and `goto` already waits for the page to settle. To wait for something specific, use `page.waitForText('…')` or `waitForSelector`.
3. **Refs are locators, not CSS.** Use `'e12'` alone; never build selectors like `'#e12'` or `'[ref=e12]'`. Refs come from your latest snapshot; after navigation take a new one.
4. **Verify with a fresh snapshot.** An action is only done when a new snapshot (or `innerText`) shows it. If it did not work, suspect a stale ref or the wrong element before blaming the site.
5. **Use fresh variable names** in each call (`const results2 = …`), since bindings persist.
6. **Always print.** Nothing is returned unless you `console.log` it or it is the last expression. Log compactly: interactive snapshots, `innerText` of the region you need.
7. **Popups, downloads, dialogs:** start the wait together with the click: `const [dl] = await Promise.all([page.waitForEvent('download'), page.click('e5')]); console.log(await dl.text())`. For a prompt: `page.waitForEvent('dialog', {accept: true, promptText: 'x'})` before the click.
8. **Errors come back as data** (`error.code`: `stale_ref`, `not_actionable`, `obscured`, `timeout`). Read the message; it says what to do next.
9. Your tabs are your own. Do not touch the user's tabs unless told to; close tabs you no longer need (`await p.close()`).
