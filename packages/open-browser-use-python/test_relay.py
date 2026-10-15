import json
import os
import socket
import struct
import tempfile
import threading
import unittest
from pathlib import Path

from open_browser_use.client import ChunkAssembler, OpenBrowserUseClient, encode_frame, read_relay_token


def _read(conn: socket.socket) -> dict:
    header = b""
    while len(header) < 4:
        part = conn.recv(4 - len(header))
        if not part:
            raise EOFError
        header += part
    (length,) = struct.unpack("=I", header)
    payload = b""
    while len(payload) < length:
        payload += conn.recv(length - len(payload))
    return json.loads(payload)


def _split_chunks(text: str, cid: str, size: int) -> list[bytes]:
    parts = [text[i : i + size] for i in range(0, len(text), size)]
    return [encode_frame({"chunk": {"id": cid, "i": i, "n": len(parts), "data": p}}) for i, p in enumerate(parts)]


class FakeRelay:
    """Requires {"auth": token} first (like the Go relay with RequireToken)."""

    def __init__(self, directory: str, token: str | None, respond) -> None:
        self.socket_path = str(Path(directory) / "obu.sock")
        self.server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.server.bind(self.socket_path)
        self.server.listen(1)
        self.token = token
        self.respond = respond
        self.thread = threading.Thread(target=self._serve, daemon=True)
        self.thread.start()

    def _serve(self) -> None:
        conn, _ = self.server.accept()
        with conn:
            authed = self.token is None
            try:
                while True:
                    msg = _read(conn)
                    if not authed:
                        if msg.get("auth") == self.token:
                            authed = True
                            continue
                        conn.sendall(encode_frame({"jsonrpc": "2.0", "id": None, "error": {"code": -32001, "message": "unauthorized"}}))
                        return
                    if "auth" in msg:
                        continue
                    for frame in self.respond(msg):
                        conn.sendall(frame)
            except (EOFError, OSError):
                return

    def close(self) -> None:
        self.server.close()
        self.thread.join(timeout=1)


def _write_token(directory: str, token: str, mode: int = 0o600) -> str:
    path = str(Path(directory) / "relay.token")
    Path(path).write_text(token + "\n")
    os.chmod(path, mode)
    return path


class RelayAuthTest(unittest.TestCase):
    def test_sends_token_handshake(self) -> None:
        with tempfile.TemporaryDirectory(dir="/tmp") as directory:
            _write_token(directory, "secret")
            relay = FakeRelay(directory, "secret", lambda m: [encode_frame({"jsonrpc": "2.0", "id": m["id"], "result": {"m": m["method"]}})])
            client = OpenBrowserUseClient(socket_path=relay.socket_path, timeout=2)
            try:
                self.assertEqual(client.get_info(), {"m": "getInfo"})
            finally:
                client.close()
                relay.close()

    def test_uid_opt_out_and_relay_error(self) -> None:
        with tempfile.TemporaryDirectory(dir="/tmp") as directory:
            _write_token(directory, "secret")
            relay = FakeRelay(directory, "secret", lambda m: [])
            os.environ["OBU_RELAY_AUTH"] = "uid"
            client = OpenBrowserUseClient(socket_path=relay.socket_path, timeout=2)
            try:
                self.assertIsNone(read_relay_token(relay.socket_path))
                with self.assertRaisesRegex(RuntimeError, "unauthorized"):
                    client.get_info()
            finally:
                del os.environ["OBU_RELAY_AUTH"]
                client.close()
                relay.close()

    def test_rejects_loose_token_file(self) -> None:
        with tempfile.TemporaryDirectory(dir="/tmp") as directory:
            _write_token(directory, "t", 0o644)
            with self.assertRaisesRegex(RuntimeError, "0600"):
                read_relay_token(str(Path(directory) / "obu.sock"))

    def test_reassembles_chunked_response(self) -> None:
        big = '漢🙂x"\\' * 300_000
        with tempfile.TemporaryDirectory(dir="/tmp") as directory:
            relay = FakeRelay(
                directory,
                None,
                lambda m: _split_chunks(json.dumps({"jsonrpc": "2.0", "id": m["id"], "result": {"big": big}}, ensure_ascii=False), "r", 250_000),
            )
            client = OpenBrowserUseClient(socket_path=relay.socket_path, timeout=5)
            try:
                self.assertEqual(client.get_info(), {"big": big})
            finally:
                client.close()
                relay.close()

    def test_chunk_assembler(self) -> None:
        a = ChunkAssembler()
        self.assertEqual(a.accept({"id": 1}), {"id": 1})
        self.assertIsNone(a.accept({"chunk": {"id": "b", "i": 1, "n": 2, "data": "1}"}}))
        self.assertEqual(a.accept({"chunk": {"id": "b", "i": 0, "n": 2, "data": '{"x":'}}), {"x": 1})
        with self.assertRaises(RuntimeError):
            a.accept({"chunk": {"id": "c", "i": 5, "n": 2, "data": ""}})


if __name__ == "__main__":
    unittest.main()
