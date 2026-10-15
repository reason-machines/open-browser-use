package host

import (
	"encoding/json"
	"fmt"
	"net"
	"os"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/ifuryst/open-browser-use/internal/wire"
)

// TestLiveRelay drives a real extension through a running native host.
// OBU_LIVE_SOCKET_DIR=<dir with active.json> go test ./internal/host -run TestLiveRelay -v
func TestLiveRelay(t *testing.T) {
	dir := os.Getenv("OBU_LIVE_SOCKET_DIR")
	if dir == "" {
		t.Skip("set OBU_LIVE_SOCKET_DIR")
	}
	record, err := ReadActiveSocketRecord(dir)
	if err != nil {
		t.Fatal(err)
	}
	conn, err := DialRelay(record.SocketPath, 2*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	next := 0
	call := func(method string, params map[string]any) (map[string]any, time.Duration) {
		next++
		params["session_id"] = "wsb-live"
		params["turn_id"] = fmt.Sprintf("wsb-%d", next)
		req, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": next, "method": method, "params": params})
		start := time.Now()
		if err := wire.WriteFrame(conn, req); err != nil {
			t.Fatal(err)
		}
		_ = conn.SetReadDeadline(time.Now().Add(30 * time.Second))
		for {
			payload, err := wire.ReadFrame(conn, wire.DefaultMaxFrame)
			if err != nil {
				t.Fatalf("%s: %v", method, err)
			}
			var resp map[string]any
			if err := json.Unmarshal(payload, &resp); err != nil {
				t.Fatal(err)
			}
			if id, ok := resp["id"].(float64); ok && int(id) == next {
				if resp["error"] != nil {
					t.Fatalf("%s error: %v", method, resp["error"])
				}
				return resp, time.Since(start)
			}
		}
	}
	info, _ := call("getInfo", map[string]any{})
	t.Logf("getInfo: %v", info["result"])
	tab, _ := call("createTab", map[string]any{})
	tabID := tab["result"].(map[string]any)["id"]
	defer call("finalizeTabs", map[string]any{"keep": []any{}})
	call("attach", map[string]any{"tabId": tabID})
	eval := func(expr string) (map[string]any, time.Duration) {
		return call("executeCdp", map[string]any{"target": map[string]any{"tabId": tabID}, "method": "Runtime.evaluate",
			"commandParams": map[string]any{"expression": expr, "returnByValue": true}, "timeoutMs": 10000})
	}
	measure := func(name string, n int, expr string, check func(map[string]any)) {
		samples := make([]time.Duration, 0, n)
		for i := 0; i < n+3; i++ {
			resp, d := eval(expr)
			if i == 0 {
				check(resp)
			}
			if i >= 3 {
				samples = append(samples, d)
			}
		}
		sort.Slice(samples, func(i, j int) bool { return samples[i] < samples[j] })
		fmt.Printf("LIVE %s p50=%.2fms p95=%.2fms n=%d\n", name,
			float64(samples[len(samples)/2].Microseconds())/1000, float64(samples[len(samples)*95/100].Microseconds())/1000, n)
	}
	measure("evaluate-small", 100, "1+1", func(resp map[string]any) {
		v := resp["result"].(map[string]any)["result"].(map[string]any)["value"]
		if v != float64(2) {
			t.Fatalf("1+1 = %v", v)
		}
	})
	measure("evaluate-2MB-response", 40, "'x'.repeat(2*1024*1024)", func(resp map[string]any) {
		v, _ := resp["result"].(map[string]any)["result"].(map[string]any)["value"].(string)
		if len(v) != 2*1024*1024 || strings.Trim(v, "x") != "" {
			t.Fatalf("2MB value len %d", len(v))
		}
	})
	if os.Getenv("OBU_LIVE_CHUNKED_REQUEST") == "1" {
		// Needs the WS-A extension (chunk reassembly); stock extensions drop >1 MB frames.
		measure("evaluate-2MB-request", 20, "'"+strings.Repeat("y", 2*1024*1024)+"'.length", func(resp map[string]any) {
			if v := resp["result"].(map[string]any)["result"].(map[string]any)["value"]; v != float64(2*1024*1024) {
				t.Fatalf("length %v", v)
			}
		})
		// 2.5 MB both directions with multi-byte text, quotes and escapes:
		// the request is split into JSON-text chunks on rune boundaries and
		// the extension's string join must restore it exactly.
		unit := "漢🙂\"\\\\n" // multi-byte runes, a quote and backslashes
		payload := strings.Repeat(unit, 2_500_000/len(unit))
		quoted, _ := json.Marshal(payload)
		measure("evaluate-2.5MB-unicode-roundtrip", 10, "(() => { const s = "+string(quoted)+"; return s + s.length; })()", func(resp map[string]any) {
			v, _ := resp["result"].(map[string]any)["result"].(map[string]any)["value"].(string)
			if !strings.HasPrefix(v, payload) {
				t.Fatalf("2.5MB unicode round trip corrupted (got %d bytes, want prefix of %d)", len(v), len(payload))
			}
		})
	}
	_ = net.ErrClosed
}

// TestLiveRustGate measures the PLAN D3 Rust gate on the live stack:
// transport-only round trip (getInfo: socket → relay → native messaging →
// extension service worker and back, no CDP) vs a raw CDP click round trip
// (mousePressed + mouseReleased through executeCdp), 500 runs each.
// OBU_LIVE_GATE=1 OBU_LIVE_SOCKET_DIR=… OBU_LIVE_FIXTURE=<url with #b button>
func TestLiveRustGate(t *testing.T) {
	dir, fixture := os.Getenv("OBU_LIVE_SOCKET_DIR"), os.Getenv("OBU_LIVE_FIXTURE")
	if os.Getenv("OBU_LIVE_GATE") != "1" || dir == "" || fixture == "" {
		t.Skip("set OBU_LIVE_GATE=1, OBU_LIVE_SOCKET_DIR, OBU_LIVE_FIXTURE")
	}
	record, err := ReadActiveSocketRecord(dir)
	if err != nil {
		t.Fatal(err)
	}
	conn, err := DialRelay(record.SocketPath, 2*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	next := 0
	call := func(method string, params map[string]any) map[string]any {
		next++
		params["session_id"] = "r2-gate"
		params["turn_id"] = "gate"
		req, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": next, "method": method, "params": params})
		if err := wire.WriteFrame(conn, req); err != nil {
			t.Fatal(err)
		}
		_ = conn.SetReadDeadline(time.Now().Add(30 * time.Second))
		for {
			payload, err := wire.ReadFrame(conn, wire.DefaultMaxFrame)
			if err != nil {
				t.Fatalf("%s: %v", method, err)
			}
			var resp map[string]any
			if err := json.Unmarshal(payload, &resp); err != nil {
				t.Fatal(err)
			}
			if id, ok := resp["id"].(float64); ok && int(id) == next {
				if resp["error"] != nil {
					t.Fatalf("%s error: %v", method, resp["error"])
				}
				return resp
			}
		}
	}
	tab := call("createTab", map[string]any{"url": fixture})
	tabID := tab["result"].(map[string]any)["id"]
	defer call("finalizeTabs", map[string]any{"keep": []any{}})
	cdp := func(method string, params map[string]any) map[string]any {
		return call("executeCdp", map[string]any{"target": map[string]any{"tabId": tabID}, "method": method, "commandParams": params, "timeoutMs": 10000})
	}
	// CDP mouse input is dropped on hidden tabs (WS-E); this throwaway
	// Chrome is ours, so foreground the tab — the gate measures transport.
	cdp("Page.bringToFront", map[string]any{})
	// Wait for the button to exist.
	for i := 0; i < 100; i++ {
		r := cdp("Runtime.evaluate", map[string]any{"expression": "!!document.getElementById('b')", "returnByValue": true})
		if r["result"].(map[string]any)["result"].(map[string]any)["value"] == true {
			break
		}
		time.Sleep(50 * time.Millisecond)
	}
	const runs, warm = 500, 20
	stats := func(samples []time.Duration) (float64, float64) {
		sort.Slice(samples, func(i, j int) bool { return samples[i] < samples[j] })
		ms := func(d time.Duration) float64 { return float64(d.Microseconds()) / 1000 }
		return ms(samples[len(samples)/2]), ms(samples[len(samples)*95/100])
	}
	transport := make([]time.Duration, 0, runs)
	for i := 0; i < runs+warm; i++ {
		start := time.Now()
		call("getInfo", map[string]any{})
		if i >= warm {
			transport = append(transport, time.Since(start))
		}
	}
	clicks := make([]time.Duration, 0, runs)
	for i := 0; i < runs+warm; i++ {
		start := time.Now()
		for _, typ := range []string{"mousePressed", "mouseReleased"} {
			cdp("Input.dispatchMouseEvent", map[string]any{"type": typ, "x": 100, "y": 50, "button": "left", "clickCount": 1})
		}
		if i >= warm {
			clicks = append(clicks, time.Since(start))
		}
	}
	got := cdp("Runtime.evaluate", map[string]any{"expression": "window.clicks|0", "returnByValue": true})
	count := got["result"].(map[string]any)["result"].(map[string]any)["value"]
	if count != float64(runs+warm) {
		dbg := cdp("Runtime.evaluate", map[string]any{"expression": "JSON.stringify({u:location.href,rs:document.readyState,vis:document.visibilityState,el:String(document.elementFromPoint(100,50)&&document.elementFromPoint(100,50).id),w:innerWidth,h:innerHeight})", "returnByValue": true})
		t.Logf("debug: %v", dbg["result"])
		t.Fatalf("page saw %v clicks, want %d", count, runs+warm)
	}
	tp50, tp95 := stats(transport)
	cp50, cp95 := stats(clicks)
	fmt.Printf("GATE transport(getInfo) p50=%.3fms p95=%.3fms n=%d\n", tp50, tp95, runs)
	fmt.Printf("GATE raw-click(2x executeCdp) p50=%.3fms p95=%.3fms n=%d\n", cp50, cp95, runs)
	// A click costs two transport round trips.
	fmt.Printf("GATE transport-share-of-raw-click p95=%.1f%%\n", 100*2*tp95/cp95)
}
