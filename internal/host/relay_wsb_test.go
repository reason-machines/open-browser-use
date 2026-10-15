package host

import (
	"bytes"
	"context"
	"encoding/json"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/ifuryst/open-browser-use/internal/wire"
)

type relayHarness struct {
	relay      *Relay
	socketPath string
	toExt      net.Conn // read what the relay sends to the extension
	fromExt    net.Conn // write what the extension sends to the relay
	cancel     context.CancelFunc
}

func startRelay(t *testing.T, cfg Config) *relayHarness {
	t.Helper()
	hostToExtR, hostToExtW := net.Pipe()
	extToHostR, extToHostW := net.Pipe()
	dir := shortSocketDir(t)
	cfg.SocketDir = dir
	cfg.SocketPath = filepath.Join(dir, "obu.sock")
	relay := NewRelay(cfg, extToHostR, hostToExtW)
	ctx, cancel := context.WithCancel(context.Background())
	go func() { _ = relay.Serve(ctx) }()
	<-relay.Ready()
	t.Cleanup(func() {
		cancel()
		_ = hostToExtR.Close()
		_ = hostToExtW.Close()
		_ = extToHostR.Close()
		_ = extToHostW.Close()
	})
	return &relayHarness{relay: relay, socketPath: cfg.SocketPath, toExt: hostToExtR, fromExt: extToHostW, cancel: cancel}
}

func (h *relayHarness) dial(t *testing.T) net.Conn {
	t.Helper()
	conn, err := net.Dial("unix", h.socketPath)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	return conn
}

// readExtMessage reads one logical message from the relay's extension side,
// reassembling chunk envelopes.
func (h *relayHarness) readExtMessage(t *testing.T) ([]byte, int) {
	t.Helper()
	r := wire.NewReassembler()
	frames := 0
	for {
		payload, err := wire.ReadFrame(h.toExt, wire.DefaultMaxFrame)
		if err != nil {
			t.Fatal(err)
		}
		frames++
		if len(payload) > 1024*1024 {
			t.Fatalf("frame of %d bytes exceeds Chrome's 1 MB host→extension limit", len(payload))
		}
		if !wire.IsChunk(payload) {
			return payload, frames
		}
		whole, err := r.Add(payload)
		if err != nil {
			t.Fatal(err)
		}
		if whole != nil {
			return whole, frames
		}
	}
}

func readClientJSON(t *testing.T, conn net.Conn) map[string]any {
	t.Helper()
	_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	var out map[string]any
	if err := wire.ReadJSON(conn, &out); err != nil {
		t.Fatal(err)
	}
	return out
}

func TestRelayPreservesRawIDsOfEveryKind(t *testing.T) {
	h := startRelay(t, Config{})
	client := h.dial(t)
	for _, rawID := range []string{`7`, `"cli-1"`, `1.0e2`, `{"k":[1,"}"]}`, `"esc\"aped"`} {
		req := []byte(`{"jsonrpc":"2.0","id":` + rawID + `,"method":"getInfo","params":{}}`)
		if err := wire.WriteFrame(client, req); err != nil {
			t.Fatal(err)
		}
		forwarded, _ := h.readExtMessage(t)
		span, ok, err := wire.FindKey(forwarded, "id")
		if err != nil || !ok {
			t.Fatalf("forwarded has no id: %s", forwarded)
		}
		hostID := forwarded[span.Start:span.End]
		if !bytes.HasPrefix(hostID, []byte(`"obu:`)) {
			t.Fatalf("expected host id, got %s", hostID)
		}
		if !bytes.Equal(wire.Splice(forwarded, span, []byte(rawID)), req) {
			t.Fatalf("relay changed bytes other than id: %s", forwarded)
		}
		if err := wire.WriteFrame(h.fromExt, []byte(`{"jsonrpc":"2.0","id":`+string(hostID)+`,"result":{"ok":true}}`)); err != nil {
			t.Fatal(err)
		}
		_ = client.SetReadDeadline(time.Now().Add(5 * time.Second))
		resp, err := wire.ReadFrame(client, wire.DefaultMaxFrame)
		if err != nil {
			t.Fatal(err)
		}
		if want := `{"jsonrpc":"2.0","id":` + rawID + `,"result":{"ok":true}}`; string(resp) != want {
			t.Fatalf("got %s want %s", resp, want)
		}
	}
}

func TestRelayChunksLargeRequestsAndReassemblesLargeResponses(t *testing.T) {
	h := startRelay(t, Config{})
	client := h.dial(t)
	big := strings.Repeat("Q", 5<<20)
	req := []byte(`{"jsonrpc":"2.0","id":1,"method":"executeCdp","params":{"blob":"` + big + `"}}`)
	go func() { _ = wire.WriteFrame(client, req) }()
	forwarded, frames := h.readExtMessage(t)
	if frames < 6 {
		t.Fatalf("expected >=6 chunk frames for 5 MB, got %d", frames)
	}
	span, _, _ := wire.FindKey(forwarded, "id")
	hostID := string(forwarded[span.Start:span.End])
	var unquoted string
	_ = json.Unmarshal([]byte(hostID), &unquoted)

	resp := []byte(`{"jsonrpc":"2.0","id":` + hostID + `,"result":{"data":"` + big + `"}}`)
	go func() {
		for _, f := range wire.SplitChunks(resp, unquoted) {
			_ = wire.WriteFrame(h.fromExt, f)
		}
	}()
	_ = client.SetReadDeadline(time.Now().Add(10 * time.Second))
	got, err := wire.ReadFrame(client, wire.DefaultMaxFrame)
	if err != nil {
		t.Fatal(err)
	}
	respSpan, _, _ := wire.FindKey(resp, "id")
	want := wire.Splice(resp, respSpan, []byte("1"))
	if !bytes.Equal(got, want) {
		t.Fatalf("response mismatch: len got %d want %d", len(got), len(want))
	}
}

func TestRelayTokenAuth(t *testing.T) {
	h := startRelay(t, Config{RequireToken: true, AuthTimeout: 500 * time.Millisecond})
	tokenPath := h.relay.TokenPath()
	info, err := os.Stat(tokenPath)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("token mode %v", info.Mode().Perm())
	}
	record, err := ReadActiveSocketRecord(filepath.Dir(h.socketPath))
	if err != nil || record.TokenPath != tokenPath {
		t.Fatalf("active.json tokenPath=%q err=%v", record.TokenPath, err)
	}

	// No token: first frame is a request → refused and closed.
	bad := h.dial(t)
	_ = wire.WriteFrame(bad, []byte(`{"jsonrpc":"2.0","id":1,"method":"getInfo"}`))
	resp := readClientJSON(t, bad)
	if errObj, _ := resp["error"].(map[string]any); errObj == nil || errObj["data"].(map[string]any)["type"] != "unauthorized" {
		t.Fatalf("expected unauthorized, got %v", resp)
	}
	if _, err := wire.ReadFrame(bad, 1024); err == nil {
		t.Fatal("expected connection closed after failed auth")
	}

	// Wrong token.
	wrong := h.dial(t)
	_ = wire.WriteFrame(wrong, AuthFrame([]byte("nope")))
	if resp := readClientJSON(t, wrong); resp["error"] == nil {
		t.Fatalf("expected error for wrong token, got %v", resp)
	}

	// Silent client times out.
	silent := h.dial(t)
	if resp := readClientJSON(t, silent); resp["error"] == nil {
		t.Fatalf("expected auth timeout error, got %v", resp)
	}

	// Right token: request flows.
	token, err := ReadToken(tokenPath)
	if err != nil {
		t.Fatal(err)
	}
	good := h.dial(t)
	_ = wire.WriteFrame(good, AuthFrame(token))
	_ = wire.WriteFrame(good, []byte(`{"jsonrpc":"2.0","id":5,"method":"ping"}`))
	forwarded, _ := h.readExtMessage(t)
	if !bytes.Contains(forwarded, []byte(`"method":"ping"`)) {
		t.Fatalf("unexpected forward %s", forwarded)
	}
}

func TestEnsureTokenStableAndRejectsLoosePerms(t *testing.T) {
	path := filepath.Join(t.TempDir(), "relay.token")
	a, err := EnsureToken(path)
	if err != nil {
		t.Fatal(err)
	}
	b, err := EnsureToken(path)
	if err != nil || !bytes.Equal(a, b) || len(a) != 64 {
		t.Fatalf("token not stable: %s %s %v", a, b, err)
	}
	if err := os.Chmod(path, 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := ReadToken(path); err == nil {
		t.Fatal("expected loose-permission token to be rejected")
	}
}

func TestPeerUIDMatchesSelf(t *testing.T) {
	dir := shortSocketDir(t)
	ln, err := net.Listen("unix", filepath.Join(dir, "p.sock"))
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	go func() {
		c, err := net.Dial("unix", filepath.Join(dir, "p.sock"))
		if err == nil {
			time.Sleep(100 * time.Millisecond)
			_ = c.Close()
		}
	}()
	conn, err := ln.Accept()
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	if err := checkPeer(conn); err != nil {
		t.Fatalf("same-uid peer rejected: %v", err)
	}
	uid, err := peerUID(conn)
	if err == nil && uid != uint32(os.Getuid()) {
		t.Fatalf("peer uid %d", uid)
	}
}

func TestRelayTimeoutPassthrough(t *testing.T) {
	h := startRelay(t, Config{})
	client := h.dial(t)
	start := time.Now()
	_ = wire.WriteFrame(client, []byte(`{"jsonrpc":"2.0","id":"t1","method":"executeCdp","params":{"timeoutMs":100}}`))
	forwarded, _ := h.readExtMessage(t)
	span, _, _ := wire.FindKey(forwarded, "id")
	resp := readClientJSON(t, client)
	elapsed := time.Since(start)
	errObj, _ := resp["error"].(map[string]any)
	if resp["id"] != "t1" || errObj == nil || errObj["data"].(map[string]any)["type"] != "timeout" {
		t.Fatalf("expected timeout error, got %v", resp)
	}
	if elapsed < 2*time.Second || elapsed > 4*time.Second {
		t.Fatalf("timeout fired after %v, want ~2.1s", elapsed)
	}
	// A late extension answer is dropped, not delivered.
	_ = wire.WriteFrame(h.fromExt, []byte(`{"jsonrpc":"2.0","id":`+string(forwarded[span.Start:span.End])+`,"result":{}}`))
	_ = client.SetReadDeadline(time.Now().Add(200 * time.Millisecond))
	if _, err := wire.ReadFrame(client, 1024); err == nil {
		t.Fatal("late response should be dropped")
	}
}

func TestRelayHostCall(t *testing.T) {
	h := startRelay(t, Config{})
	go func() {
		msg, _ := wire.ReadFrame(h.toExt, wire.DefaultMaxFrame)
		span, _, _ := wire.FindKey(msg, "id")
		_ = wire.WriteFrame(h.fromExt, []byte(`{"jsonrpc":"2.0","id":`+string(msg[span.Start:span.End])+`,"result":{"metadata":{"extensionInstanceId":"abc"}}}`))
	}()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	resp, err := h.relay.Call(ctx, "getInfo", map[string]any{})
	if err != nil || !bytes.Contains(resp, []byte(`"abc"`)) {
		t.Fatalf("resp=%s err=%v", resp, err)
	}
}

func TestRemoveIfStalePreservesLiveSocket(t *testing.T) {
	dir := shortSocketDir(t)
	path := filepath.Join(dir, "live.sock")
	ln, err := net.Listen("unix", path)
	if err != nil {
		t.Fatal(err)
	}
	if err := removeIfStale(path); err == nil {
		t.Fatal("expected live socket to be refused")
	}
	if _, err := os.Stat(path); err != nil {
		t.Fatal("live socket was unlinked")
	}
	// Close without unlinking → stale (ECONNREFUSED) → removed.
	if ul, ok := ln.(*net.UnixListener); ok {
		ul.SetUnlinkOnClose(false)
	}
	_ = ln.Close()
	if err := removeIfStale(path); err != nil {
		t.Fatalf("stale socket not removed: %v", err)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatal("stale socket still present")
	}
}
