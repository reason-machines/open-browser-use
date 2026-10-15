#!/usr/bin/env python3
"""Which sites are logged in, per browser? Read-only: opens each site's landing page in a new tab,
looks at the final URL and a few logged-in markers, and closes the tab. Never reads cookies or storage.

Targets: Chrome "Profile 1" (ours) and Aside.app's profile (via the OBU extension installed there).
Writes results/<run>/logins.json; tasks with requires_login only count where BOTH sides are logged in.
"""
import json, subprocess, sys, time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import runner  # noqa: E402

# url, JS returning true when logged in (evaluated after load; DOM/URL only)
SITES = {
    "x": ("https://x.com/home", "location.pathname.startsWith('/home') && !!document.querySelector('[data-testid=SideNav_AccountSwitcher_Button],[data-testid=AppTabBar_Profile_Link]')"),
    "linkedin": ("https://www.linkedin.com/feed/", "location.pathname.startsWith('/feed') && !document.querySelector('a[href*=\"/login\"].nav__button-secondary, form.join-form')"),
    "gmail": ("https://mail.google.com/mail/u/0/", "location.host === 'mail.google.com'"),
    "github": ("https://github.com/", "!!(document.querySelector('meta[name=user-login]')||{}).content"),
    "reddit": ("https://www.reddit.com/", "!!document.querySelector('#expand-user-drawer-button, faceplate-tracker[noun=user_menu], [data-testid=user-drawer-button]') && !document.querySelector('a[href*=\"/login\"]#login-button')"),
    "bluesky": ("https://bsky.app/", "!!document.querySelector('[aria-label=\"New post\"], [data-testid=composeFAB], a[href*=\"/notifications\"]') && !document.querySelector('[data-testid=signInButton]')"),
}


def obu(target, *args, timeout=40):
    r = subprocess.run(["obu", *target, *args, "--timeout", "30s"], capture_output=True, text=True, timeout=timeout)
    return json.loads(r.stdout) if r.stdout.strip().startswith("{") else {"error": (r.stderr or r.stdout)[-300:]}


def check(target, label):
    sid = f"bench-logins-{label}-{int(time.time())}"
    out = {}
    for name, (url, js) in SITES.items():
        try:
            tab = obu(target, "open-tab", "--session-id", sid, "--url", url)["tab"]["id"]
            time.sleep(6)  # SPA shells (x, bsky, reddit) render their auth UI late
            r = obu(target, "cdp", "--session-id", sid, "--tab-id", str(tab), "--method", "Runtime.evaluate",
                    "--params", json.dumps({"expression": f"JSON.stringify({{ok: !!({js}), url: location.href}})", "returnByValue": True}))
            v = json.loads(r["result"]["result"]["value"])
            out[name] = {"logged_in": v["ok"], "final_url": v["url"].split("?")[0]}
        except Exception as e:
            out[name] = {"logged_in": None, "error": str(e)[:200]}
    obu(target, "finalize-tabs", "--session-id", sid, "--keep", "[]")
    return out


def main(run):
    before = {app: runner.tab_snapshot(app) for app in ("Google Chrome", "Aside")}
    res = {"chrome:" + runner.CHROME_PROFILE: check(["--profile", runner.CHROME_PROFILE], "chrome"),
           "aside.app": check(["--socket", runner.resolve_aside_socket()], "aside")}
    for app, b in before.items():  # tab hygiene: close anything this check left behind
        after = runner.tab_snapshot(app) or {}
        runner.close_tabs(app, [i for i in after if b is not None and i not in b and runner.attributable(after[i], {
            "x.com", "linkedin.com", "google.com", "github.com", "reddit.com", "bsky.app"})])
    d = runner.BENCH / "results" / run
    d.mkdir(parents=True, exist_ok=True)
    (d / "logins.json").write_text(json.dumps(res, indent=1))
    print(json.dumps(res, indent=1))


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "logins")
