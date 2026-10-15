# Python SDK against the real relay (token handshake).
import json
import os

from open_browser_use.client import OpenBrowserUseClient

record = json.load(open(os.path.join(os.environ["OBU_LIVE_SOCKET_DIR"], "active.json")))
client = OpenBrowserUseClient(socket_path=record["socketPath"], token_path=record.get("tokenPath"), session_id="r2-py-smoke", timeout=20)
try:
    info = client.get_info()
    assert isinstance(info, dict), info
    tab = client.request("createTab", {"url": os.environ["OBU_LIVE_FIXTURE"]})
    res = client.request("executeCdp", {"target": {"tabId": tab["id"]}, "method": "Runtime.evaluate", "commandParams": {"expression": "'z'.repeat(3*1024*1024)", "returnByValue": True}, "timeoutMs": 20000})
    assert len(res["result"]["value"]) == 3 * 1024 * 1024
    client.request("finalizeTabs", {"keep": []})
    print("Python SDK smoke: ok (auth + 3MB response)")
finally:
    client.close()
