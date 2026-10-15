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
	}
	_ = net.ErrClosed
}
