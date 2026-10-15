package obu

import (
	"context"
	"encoding/json"
	"net"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/ifuryst/open-browser-use/internal/host"
	"github.com/ifuryst/open-browser-use/internal/wire"
)

// startTokenRelay runs a real relay that requires the token handshake, with a
// fake extension answering every request with {"echo":<method>}.
func startTokenRelay(t *testing.T) string {
	t.Helper()
	dir, err := os.MkdirTemp("/tmp", "obu-go-auth-")
	if err != nil {
		t.Fatal(err)
	}
	hostToExtR, hostToExtW := net.Pipe()
	extToHostR, extToHostW := net.Pipe()
	relay := host.NewRelay(host.Config{SocketDir: dir, RequireToken: true}, extToHostR, hostToExtW)
	ctx, cancel := context.WithCancel(context.Background())
	go func() { _ = relay.Serve(ctx) }()
	<-relay.Ready()
	go func() {
		for {
			payload, err := wire.ReadFrame(hostToExtR, wire.DefaultMaxFrame)
			if err != nil {
				return
			}
			span, ok, _ := wire.FindKey(payload, "id")
			if !ok {
				continue
			}
			resp := `{"jsonrpc":"2.0","id":` + string(payload[span.Start:span.End]) + `,"result":{"echo":true}}`
			if err := wire.WriteFrame(extToHostW, []byte(resp)); err != nil {
				return
			}
		}
	}()
	t.Cleanup(func() {
		cancel()
		for _, c := range []net.Conn{hostToExtR, hostToExtW, extToHostR, extToHostW} {
			_ = c.Close()
		}
		_ = os.RemoveAll(dir)
	})
	return dir
}

func TestClientAuthenticatesToTokenRelay(t *testing.T) {
	dir := startTokenRelay(t)
	record, err := host.ReadActiveSocketRecord(dir)
	if err != nil {
		t.Fatal(err)
	}
	if record.TokenPath == "" {
		t.Fatal("relay did not record tokenPath in active.json")
	}
	// Via active.json (socket dir only).
	client := NewClient(Options{SocketDir: dir, Timeout: 2 * time.Second})
	defer client.Close()
	result, err := client.GetInfo()
	if err != nil {
		t.Fatalf("GetInfo via active.json: %v", err)
	}
	if m, _ := result.(map[string]any); m["echo"] != true {
		t.Fatalf("unexpected result %#v", result)
	}
	// Via explicit socket path (token found next to the socket).
	direct := NewClient(Options{SocketPath: record.SocketPath, Timeout: 2 * time.Second})
	defer direct.Close()
	if _, err := direct.GetInfo(); err != nil {
		t.Fatalf("GetInfo via socket path: %v", err)
	}
}

func TestClientHonoursUIDOnlyOptOut(t *testing.T) {
	dir := startTokenRelay(t)
	t.Setenv("OBU_RELAY_AUTH", "uid")
	client := NewClient(Options{SocketDir: dir, Timeout: 2 * time.Second})
	defer client.Close()
	_, err := client.GetInfo()
	if err == nil || !strings.Contains(err.Error(), "unauthorized") {
		t.Fatalf("expected unauthorized from a token relay without handshake, got %v", err)
	}
}

func TestClientReassemblesChunkedResponse(t *testing.T) {
	big := strings.Repeat("漢x\"", 600_000)
	socketPath, closeServer := startSDKServer(t, func(conn net.Conn) {
		request := readRequest(t, conn)
		id := request["id"]
		payload := []byte(`{"jsonrpc":"2.0","id":` + jsonNumber(id) + `,"result":{"data":` + quote(big) + `}}`)
		for _, frame := range wire.SplitChunks(payload, "r1") {
			if err := wire.WriteFrame(conn, frame); err != nil {
				t.Error(err)
				return
			}
		}
	})
	defer closeServer()
	client := NewClient(Options{SocketPath: socketPath, Timeout: 5 * time.Second})
	defer client.Close()
	result, err := client.GetInfo()
	if err != nil {
		t.Fatal(err)
	}
	if m, _ := result.(map[string]any); m["data"] != big {
		t.Fatal("chunked result not reassembled")
	}
}

func jsonNumber(v any) string {
	b, _ := json.Marshal(v)
	return string(b)
}

func quote(s string) string {
	b, _ := json.Marshal(s)
	return string(b)
}
