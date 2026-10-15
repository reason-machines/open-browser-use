from __future__ import annotations

import json
import os
import socket
import stat
import struct
import sys
import time
from dataclasses import dataclass
from typing import Any, Callable, Literal


JsonObject = dict[str, Any]
LoadState = Literal["domcontentloaded", "load"]
NotificationHandler = Callable[[JsonObject], None]
DEFAULT_NAVIGATION_TIMEOUT = 10.0


@dataclass
class OpenBrowserUseClient:
    socket_path: str
    session_id: str = "open-browser-use-python"
    turn_id: str | None = None
    timeout: float = 10.0
    # Relay token file. Precedence: OBU_RELAY_AUTH=uid (no token) >
    # OBU_RELAY_TOKEN_PATH > token_path > <socket dir>/relay.token.
    token_path: str | None = None

    def __post_init__(self) -> None:
        if self.turn_id is None:
            self.turn_id = f"turn-{time.time_ns()}"
        self._next_id = 1
        self._socket: socket.socket | None = None
        self._notification_handlers: list[NotificationHandler] = []
        self._chunks = ChunkAssembler()

    def connect(self) -> "OpenBrowserUseClient":
        if self._socket is None:
            sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            sock.settimeout(self.timeout)
            sock.connect(self.socket_path)
            token = read_relay_token(self.socket_path, self.token_path)
            if token:
                # Relays that don't require a token drop this frame.
                sock.sendall(encode_frame({"auth": token}))
            self._socket = sock
        return self

    def close(self) -> None:
        if self._socket is not None:
            self._socket.close()
            self._socket = None

    def on_notification(self, handler: NotificationHandler) -> Callable[[], None]:
        self._notification_handlers.append(handler)

        def remove() -> None:
            if handler in self._notification_handlers:
                self._notification_handlers.remove(handler)

        return remove

    def request(self, method: str, params: JsonObject | None = None) -> Any:
        self.connect()
        if self._socket is None:
            raise RuntimeError("Open Browser Use socket is not connected")
        request_id = self._next_id
        self._next_id += 1
        merged_params: JsonObject = {
            "session_id": self.session_id,
            "turn_id": self.turn_id,
        }
        if params:
            merged_params.update(params)
        request = {
            "jsonrpc": "2.0",
            "id": request_id,
            "method": method,
            "params": merged_params,
        }
        self._socket.sendall(encode_frame(request))
        while True:
            try:
                message = self._chunks.accept(read_frame(self._socket))
            except EOFError:
                self.close()
                raise
            if message is None:
                continue
            response = message
            if response.get("id") == request_id:
                if "error" in response:
                    message = response["error"].get("message", "Open Browser Use request failed")
                    raise RuntimeError(message)
                return response.get("result")
            if "id" not in response and isinstance(response.get("method"), str):
                self._dispatch_notification(response)
                continue
            if response.get("id") is None and isinstance(response.get("error"), dict):
                # Connection-level relay error (e.g. unauthorized); the relay
                # closes the socket after it.
                self.close()
                raise RuntimeError(f"Open Browser Use relay: {response['error'].get('message', 'error')}")
            raise RuntimeError(f"unexpected response id: {response.get('id')!r}")

    def _dispatch_notification(self, notification: JsonObject) -> None:
        for handler in list(self._notification_handlers):
            handler(notification)

    def get_info(self) -> Any:
        return self.request("getInfo")

    def create_tab(self) -> Any:
        return self.request("createTab")

    def get_tabs(self) -> Any:
        return self.request("getTabs")

    def get_user_tabs(self) -> Any:
        return self.request("getUserTabs")

    def get_user_history(self, **params: Any) -> Any:
        return self.request("getUserHistory", params)

    def claim_user_tab(self, tab_id: int) -> Any:
        return self.request("claimUserTab", {"tabId": tab_id})

    def finalize_tabs(self, keep: list[JsonObject]) -> Any:
        return self.request("finalizeTabs", {"keep": keep})

    def name_session(self, name: str) -> Any:
        return self.request("nameSession", {"name": name})

    def attach(self, tab_id: int) -> Any:
        return self.request("attach", {"tabId": tab_id})

    def detach(self, tab_id: int) -> Any:
        return self.request("detach", {"tabId": tab_id})

    def execute_cdp(self, tab_id: int, method: str, command_params: JsonObject | None = None) -> Any:
        return self.request(
            "executeCdp",
            {
                "target": {"tabId": tab_id},
                "method": method,
                "commandParams": command_params or {},
            },
        )

    def move_mouse(self, tab_id: int, x: float, y: float, wait_for_arrival: bool = True) -> Any:
        return self.request(
            "moveMouse",
            {
                "tabId": tab_id,
                "x": x,
                "y": y,
                "waitForArrival": wait_for_arrival,
            },
        )

    def wait_for_file_chooser(self, tab_id: int, timeout_ms: int | None = None) -> Any:
        params: JsonObject = {"tabId": tab_id}
        if timeout_ms is not None:
            params["timeoutMs"] = timeout_ms
        return self.request("waitForFileChooser", params)

    def set_file_chooser_files(self, file_chooser_id: str, files: list[str]) -> Any:
        return self.request(
            "setFileChooserFiles",
            {
                "fileChooserId": file_chooser_id,
                "files": files,
            },
        )

    def wait_for_download(self, tab_id: int, timeout_ms: int | None = None) -> Any:
        params: JsonObject = {"tabId": tab_id}
        if timeout_ms is not None:
            params["timeoutMs"] = timeout_ms
        return self.request("waitForDownload", params)

    def download_path(self, download_id: str, timeout_ms: int | None = None) -> Any:
        params: JsonObject = {"downloadId": download_id}
        if timeout_ms is not None:
            params["timeoutMs"] = timeout_ms
        return self.request("downloadPath", params)

    def browser_user_history(self, **params: Any) -> Any:
        return self.get_user_history(**params)

    def read_clipboard_text(self, tab_id: int) -> Any:
        return self.request("readClipboardText", {"tabId": tab_id})

    def write_clipboard_text(self, tab_id: int, text: str) -> Any:
        return self.request("writeClipboardText", {"tabId": tab_id, "text": text})

    def read_clipboard(self, tab_id: int) -> Any:
        return self.request("readClipboard", {"tabId": tab_id})

    def write_clipboard(self, tab_id: int, items: list[JsonObject]) -> Any:
        return self.request("writeClipboard", {"tabId": tab_id, "items": items})

    def turn_ended(self) -> Any:
        return self.request("turnEnded")


def connect_open_browser_use(
    socket_path: str,
    session_id: str = "open-browser-use-python",
    turn_id: str | None = None,
    timeout: float = 10.0,
) -> "OpenBrowserUseBrowser":
    browser = OpenBrowserUseBrowser(
        OpenBrowserUseClient(
            socket_path=socket_path,
            session_id=session_id,
            turn_id=turn_id,
            timeout=timeout,
        )
    )
    browser.connect()
    return browser


class OpenBrowserUseBrowser:
    def __init__(self, client: OpenBrowserUseClient) -> None:
        self.client = client
        self.cdp = OpenBrowserUseCdp(client)

    def connect(self) -> "OpenBrowserUseBrowser":
        self.client.connect()
        return self

    def close(self) -> None:
        self.client.close()

    def new_tab(
        self,
        url: str | None = None,
        wait_until: LoadState = "load",
        timeout: float = DEFAULT_NAVIGATION_TIMEOUT,
    ) -> "OpenBrowserUseTab":
        result = self.client.create_tab()
        tab = self.tab(_tab_id_from_value(result, "create_tab response"))
        if url:
            tab.goto(url, wait_until=wait_until, timeout=timeout)
        return tab

    def tab(self, tab_id: int) -> "OpenBrowserUseTab":
        return OpenBrowserUseTab(self, tab_id)

    def get_tabs(self) -> Any:
        return self.client.get_tabs()


class OpenBrowserUseTab:
    def __init__(self, browser: OpenBrowserUseBrowser, tab_id: int) -> None:
        self.browser = browser
        self.id = tab_id
        self.playwright = OpenBrowserUseTabPlaywright(self)

    def goto(
        self,
        url: str,
        wait_until: LoadState = "load",
        timeout: float = DEFAULT_NAVIGATION_TIMEOUT,
    ) -> Any:
        return self.browser.cdp.navigate(self.id, url, wait_until=wait_until, timeout=timeout)

    def wait_for_load_state(
        self,
        state: LoadState = "load",
        timeout: float = DEFAULT_NAVIGATION_TIMEOUT,
    ) -> None:
        self.browser.cdp.wait_for_load_state(self.id, state=state, timeout=timeout)

    def dom_snapshot(self) -> str:
        value = self.browser.cdp.evaluate(self.id, "document.body?.innerText ?? ''")
        return "" if value is None else str(value)

    def evaluate(self, expression: str, await_promise: bool | None = None) -> Any:
        return self.browser.cdp.evaluate(self.id, expression, await_promise=await_promise)

    def title(self) -> str:
        value = self.evaluate("document.title ?? ''")
        return "" if value is None else str(value)

    def url(self) -> str:
        value = self.evaluate("location.href")
        return "" if value is None else str(value)

    def wait_for_timeout(self, timeout_ms: float) -> None:
        if timeout_ms < 0:
            raise ValueError("timeout_ms must be non-negative")
        time.sleep(timeout_ms / 1000)

    def locator(self, selector: str) -> "OpenBrowserUseLocator":
        return OpenBrowserUseLocator(self, selector)

    def close(self) -> Any:
        return self.browser.cdp.call(self.id, "Page.close")


class OpenBrowserUseTabPlaywright:
    def __init__(self, tab: OpenBrowserUseTab) -> None:
        self.tab = tab

    def wait_for_load_state(
        self,
        state: LoadState = "load",
        timeout: float = DEFAULT_NAVIGATION_TIMEOUT,
    ) -> None:
        self.tab.wait_for_load_state(state=state, timeout=timeout)

    def dom_snapshot(self) -> str:
        return self.tab.dom_snapshot()

    def title(self) -> str:
        return self.tab.title()

    def url(self) -> str:
        return self.tab.url()

    def wait_for_timeout(self, timeout_ms: float) -> None:
        self.tab.wait_for_timeout(timeout_ms)

    def locator(self, selector: str) -> "OpenBrowserUseLocator":
        return self.tab.locator(selector)


class OpenBrowserUseLocator:
    def __init__(self, tab: OpenBrowserUseTab, selector: str) -> None:
        if not selector:
            raise ValueError("locator requires a selector")
        self.tab = tab
        self.selector = selector

    def inner_text(self, timeout_ms: int | None = None) -> str:
        value = self.tab.evaluate(
            _locator_inner_text_expression(self.selector, timeout_ms),
            await_promise=True,
        )
        return "" if value is None else str(value)


class OpenBrowserUseCdp:
    def __init__(self, client: OpenBrowserUseClient) -> None:
        self.client = client
        self._attached_tab_ids: set[int] = set()

    def call(
        self,
        tab_id: int,
        method: str,
        command_params: JsonObject | None = None,
        timeout_ms: int | None = None,
    ) -> Any:
        self.ensure_attached(tab_id)
        params: JsonObject = {
            "target": {"tabId": tab_id},
            "method": method,
            "commandParams": command_params or {},
        }
        if timeout_ms is not None:
            params["timeoutMs"] = timeout_ms
        return self.client.request("executeCdp", params)

    def evaluate(self, tab_id: int, expression: str, await_promise: bool | None = None) -> Any:
        command_params: JsonObject = {
            "expression": expression,
            "returnByValue": True,
        }
        if await_promise is not None:
            command_params["awaitPromise"] = await_promise
        result = self.call(tab_id, "Runtime.evaluate", command_params)
        if isinstance(result, dict) and isinstance(result.get("exceptionDetails"), dict):
            raise RuntimeError(str(result["exceptionDetails"].get("text", "Open Browser Use evaluation failed")))
        if isinstance(result, dict) and isinstance(result.get("result"), dict):
            return result["result"].get("value")
        return None

    def navigate(
        self,
        tab_id: int,
        url: str,
        wait_until: LoadState = "load",
        timeout: float = DEFAULT_NAVIGATION_TIMEOUT,
    ) -> Any:
        if not url:
            raise ValueError("goto requires a URL")
        _assert_supported_load_state(wait_until)
        self.call(tab_id, "Page.enable")
        result = self.call(tab_id, "Page.navigate", {"url": url}, timeout_ms=int(timeout * 1000))
        if isinstance(result, dict) and result.get("errorText"):
            raise RuntimeError(f"Browser failed to navigate tab {tab_id}: {result['errorText']}")
        self.wait_for_load_state(tab_id, state=wait_until, timeout=timeout)
        return result

    def wait_for_load_state(
        self,
        tab_id: int,
        state: LoadState = "load",
        timeout: float = DEFAULT_NAVIGATION_TIMEOUT,
    ) -> None:
        _assert_supported_load_state(state)
        self.call(tab_id, "Page.enable")
        deadline = time.monotonic() + timeout
        while True:
            if _document_state_matches(self.read_document_state(tab_id), state):
                return
            if time.monotonic() >= deadline:
                raise TimeoutError(f"Timed out waiting for {state} in tab {tab_id}")
            time.sleep(0.1)

    def read_document_state(self, tab_id: int) -> JsonObject | None:
        try:
            value = self.evaluate(tab_id, "({ href: window.location.href, readyState: document.readyState })")
        except Exception:
            return None
        return value if isinstance(value, dict) else None

    def ensure_attached(self, tab_id: int) -> None:
        if tab_id in self._attached_tab_ids:
            return
        self.client.attach(tab_id)
        self._attached_tab_ids.add(tab_id)


def read_relay_token(socket_path: str, token_path: str | None = None) -> str | None:
    """Resolve and read the relay token (see OpenBrowserUseClient.token_path).

    A missing file means the relay runs without token auth."""
    if os.environ.get("OBU_RELAY_AUTH") == "uid":
        return None
    path = os.environ.get("OBU_RELAY_TOKEN_PATH") or token_path or os.path.join(os.path.dirname(socket_path), "relay.token")
    try:
        mode = os.stat(path).st_mode
    except FileNotFoundError:
        return None
    if sys.platform != "win32" and stat.S_IMODE(mode) & 0o077:
        raise RuntimeError(f"relay token file {path} must be mode 0600")
    with open(path, encoding="utf-8") as handle:
        token = handle.read().strip()
    return token or None


class ChunkAssembler:
    """Reassembles {"chunk":{id,i,n,data}} envelopes (WIRE.md framing: data is
    the i-th slice of the message's JSON text). Other messages pass through."""

    def __init__(self, ttl: float = 60.0) -> None:
        self._ttl = ttl
        self._pending: dict[str, tuple[list[str | None], int, float]] = {}

    def accept(self, message: JsonObject) -> JsonObject | None:
        chunk = message.get("chunk") if isinstance(message, dict) else None
        if not isinstance(chunk, dict):
            return message
        cid, i, n, data = chunk.get("id"), chunk.get("i"), chunk.get("n"), chunk.get("data")
        if not (isinstance(cid, str) and isinstance(i, int) and isinstance(n, int) and isinstance(data, str) and 0 <= i < n):
            raise RuntimeError("Malformed Open Browser Use chunk frame")
        now = time.monotonic()
        for key in [k for k, (_, _, at) in self._pending.items() if now - at > self._ttl]:
            del self._pending[key]
        parts, received, at = self._pending.get(cid, ([None] * n, 0, now))
        if len(parts) != n:
            del self._pending[cid]
            raise RuntimeError(f"Open Browser Use chunk {cid} changed part count")
        if parts[i] is None:
            parts[i] = data
            received += 1
        if received < n:
            self._pending[cid] = (parts, received, at)
            return None
        self._pending.pop(cid, None)
        value = json.loads("".join(p for p in parts if p is not None))
        if not isinstance(value, dict):
            raise RuntimeError("Open Browser Use response must be a JSON object")
        return value


def encode_frame(value: JsonObject) -> bytes:
    payload = json.dumps(value, separators=(",", ":")).encode("utf-8")
    return struct.pack(_native_u32(), len(payload)) + payload


def read_frame(sock: socket.socket) -> JsonObject:
    header = _read_exact(sock, 4)
    (length,) = struct.unpack(_native_u32(), header)
    payload = _read_exact(sock, length)
    value = json.loads(payload.decode("utf-8"))
    if not isinstance(value, dict):
        raise RuntimeError("Open Browser Use response must be a JSON object")
    return value


def _read_exact(sock: socket.socket, length: int) -> bytes:
    chunks: list[bytes] = []
    remaining = length
    while remaining > 0:
        chunk = sock.recv(remaining)
        if not chunk:
            raise EOFError("Open Browser Use socket closed")
        chunks.append(chunk)
        remaining -= len(chunk)
    return b"".join(chunks)


def _native_u32() -> str:
    return "=I"


def _tab_id_from_value(value: Any, label: str) -> int:
    if not isinstance(value, dict):
        raise RuntimeError(f"{label} did not include a tab object")
    tab_id = value.get("id")
    if isinstance(tab_id, int) and tab_id > 0:
        return tab_id
    if isinstance(tab_id, str) and tab_id.isdigit() and int(tab_id) > 0:
        return int(tab_id)
    raise RuntimeError(f"{label} did not include a numeric tab id")


def _assert_supported_load_state(state: str) -> None:
    if state not in ("domcontentloaded", "load"):
        raise ValueError(f'Unsupported load state "{state}". Use "domcontentloaded" or "load".')


def _document_state_matches(document_state: JsonObject | None, state: LoadState) -> bool:
    ready_state = document_state.get("readyState") if isinstance(document_state, dict) else None
    return ready_state == "complete" or (state == "domcontentloaded" and ready_state == "interactive")


def _locator_inner_text_expression(selector: str, timeout_ms: int | None) -> str:
    timeout = DEFAULT_NAVIGATION_TIMEOUT * 1000 if timeout_ms is None else timeout_ms
    if timeout < 0:
        raise ValueError("timeout_ms must be non-negative")
    selector_json = json.dumps(selector)
    return f"""(async () => {{
  const selector = {selector_json};
  const deadline = performance.now() + {timeout};
  while (true) {{
    const element = document.querySelector(selector);
    if (element) {{
      return element.innerText ?? element.textContent ?? "";
    }}
    if (performance.now() >= deadline) {{
      throw new Error(`Timed out waiting for locator ${{selector}}`);
    }}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }}
}})()"""
