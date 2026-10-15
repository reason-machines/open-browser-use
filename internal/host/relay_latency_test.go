package host

import (
	"bytes"
	"context"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/ifuryst/open-browser-use/internal/wire"
)

// TestRelayLatency measures client→relay→extension→relay→client round trips
// against an in-process echo extension. Run with OBU_RELAY_LATENCY=1.
func TestRelayLatency(t *testing.T) {
	if os.Getenv("OBU_RELAY_LATENCY") != "1" {
		t.Skip("set OBU_RELAY_LATENCY=1")
	}
	big := strings.Repeat("iVBORw0KGgo", 2<<20/11)
	cases := []struct {
		name          string
		req, respBody string
	}{
		{"small", `{"jsonrpc":"2.0","id":1,"method":"executeCdp","params":{"method":"Runtime.evaluate"}}`, `{"result":{"type":"number","value":2}}`},
		{"2MB-response", `{"jsonrpc":"2.0","id":1,"method":"executeCdp","params":{"method":"Page.captureScreenshot"}}`, `{"data":"` + big + `"}`},
		{"2MB-request", `{"jsonrpc":"2.0","id":1,"method":"executeCdp","params":{"blob":"` + big + `"}}`, `{}`},
	}
	for _, c := range cases {
		hostToExtR, hostToExtW := net.Pipe()
		extToHostR, extToHostW := net.Pipe()
		dir, _ := os.MkdirTemp("/tmp", "obu-lat-")
		socketPath := filepath.Join(dir, "r.sock")
		relay := NewRelay(Config{SocketDir: dir, SocketPath: socketPath}, extToHostR, hostToExtW)
		ctx, cancel := context.WithCancel(context.Background())
		go func() { _ = relay.Serve(ctx) }()
		for i := 0; i < 100; i++ {
			if _, err := os.Stat(socketPath); err == nil {
				break
			}
			time.Sleep(10 * time.Millisecond)
		}
		// echo extension: reassemble chunks, answer with respBody
		go func() {
			r := wire.NewReassembler()
			for {
				msg, err := wire.ReadFrame(hostToExtR, wire.DefaultMaxFrame)
				if err != nil {
					return
				}
				if bytes.HasPrefix(msg, []byte(`{"chunk":`)) {
					whole, _ := r.Add(msg)
					if whole == nil {
						continue
					}
					msg = whole
				}
				span, _, _ := wire.FindKey(msg, "id")
				resp := []byte(`{"jsonrpc":"2.0","id":` + string(msg[span.Start:span.End]) + `,"result":` + c.respBody + `}`)
				_ = wire.WriteFrame(extToHostW, resp)
			}
		}()
		conn, err := net.Dial("unix", socketPath)
		if err != nil {
			t.Fatal(err)
		}
		n := 300
		if strings.HasPrefix(c.name, "2MB") {
			n = 100
		}
		samples := make([]time.Duration, 0, n)
		for i := 0; i < n+10; i++ {
			start := time.Now()
			if err := wire.WriteFrame(conn, []byte(c.req)); err != nil {
				t.Fatal(err)
			}
			if _, err := wire.ReadFrame(conn, wire.DefaultMaxFrame); err != nil {
				t.Fatal(err)
			}
			if i >= 10 {
				samples = append(samples, time.Since(start))
			}
		}
		sort.Slice(samples, func(i, j int) bool { return samples[i] < samples[j] })
		fmt.Printf("RELAY_LATENCY %s p50=%.3fms p95=%.3fms\n", c.name,
			float64(samples[len(samples)/2].Microseconds())/1000, float64(samples[len(samples)*95/100].Microseconds())/1000)
		_ = conn.Close()
		cancel()
		_ = hostToExtR.Close()
		_ = extToHostW.Close()
		_ = os.RemoveAll(dir)
	}
}
