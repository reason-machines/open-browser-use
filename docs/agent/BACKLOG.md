# Cross-stream backlog

One line per item: `- [owner] item (raised by <stream>, <date>)`.

- [WS-C] Wire WS-E hooks: call `deliverSystemEvent(cdp, ev)` (wait/index) for every tab SystemEvent and `takePendingDialogAction(cdp)` before auto-answering dialogs; `configureDownloads({resolvePath})` with chrome.downloads correlation; route `navigate`→`actions.navigate`, `wait`→`wait.waitFor`; make `PageContext.emit` param a distributive Omit (download events need a cast); keep focus emulation on during act — CDP mouse/key input is dropped on truly hidden tabs (WS-E falls back to synthesized events/insertText) (raised by WS-E, 2026-10-15)
