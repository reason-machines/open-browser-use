package host

import (
	"net"
	"testing"
	"time"

	"github.com/ifuryst/open-browser-use/internal/wire"
)

// claimSession makes conn known to the relay as the owner of sessionID by
// sending a request for it and answering it from the extension side.
func (h *relayHarness) claimSession(t *testing.T, conn net.Conn, sessionID string) {
	t.Helper()
	req := `{"jsonrpc":"2.0","id":1,"method":"getInfo","params":{"session_id":"` + sessionID + `","turn_id":"t"}}`
	if err := wire.WriteFrame(conn, []byte(req)); err != nil {
		t.Fatal(err)
	}
	forwarded, _ := h.readExtMessage(t)
	span, _, _ := wire.FindKey(forwarded, "id")
	if err := wire.WriteFrame(h.fromExt, []byte(`{"jsonrpc":"2.0","id":`+string(forwarded[span.Start:span.End])+`,"result":{}}`)); err != nil {
		t.Fatal(err)
	}
	readClientJSON(t, conn)
}

// nextMethod returns the method of the next frame on conn, or "" if none
// arrives within wait.
func nextMethod(t *testing.T, conn net.Conn, wait time.Duration) string {
	t.Helper()
	_ = conn.SetReadDeadline(time.Now().Add(wait))
	var msg struct {
		Method string `json:"method"`
	}
	if err := wire.ReadJSON(conn, &msg); err != nil {
		return ""
	}
	return msg.Method
}

func TestRelayRoutesNotificationsBySession(t *testing.T) {
	h := startRelay(t, Config{})
	a, b, legacy := h.dial(t), h.dial(t), h.dial(t)
	h.claimSession(t, a, "sess-a")
	h.claimSession(t, b, "sess-b")

	send := func(frame string) {
		t.Helper()
		if err := wire.WriteFrame(h.fromExt, []byte(frame)); err != nil {
			t.Fatal(err)
		}
	}
	const quiet = 150 * time.Millisecond

	// Subscribed CDP event: only a.
	send(`{"jsonrpc":"2.0","method":"onCDPEvent","params":{"source":{"tabId":1},"method":"Page.loadEventFired","params":{},"subscribers":["sess-a"]}}`)
	if got := nextMethod(t, a, time.Second); got != "onCDPEvent" {
		t.Fatalf("a got %q", got)
	}
	for name, c := range map[string]net.Conn{"b": b, "legacy": legacy} {
		if got := nextMethod(t, c, quiet); got != "" {
			t.Fatalf("%s unexpectedly got %q", name, got)
		}
	}

	// Subscribed by nobody connected: dropped.
	send(`{"jsonrpc":"2.0","method":"onCDPEvent","params":{"method":"X","subscribers":["gone"]}}`)
	for name, c := range map[string]net.Conn{"a": a, "b": b, "legacy": legacy} {
		if got := nextMethod(t, c, quiet); got != "" {
			t.Fatalf("%s unexpectedly got %q", name, got)
		}
	}

	// Session-scoped notification: owner only.
	send(`{"jsonrpc":"2.0","method":"leaseRevoked","params":{"tabId":3,"sessionId":"sess-b","reason":"group_exit"}}`)
	if got := nextMethod(t, b, time.Second); got != "leaseRevoked" {
		t.Fatalf("b got %q", got)
	}
	if got := nextMethod(t, a, quiet); got != "" {
		t.Fatalf("a unexpectedly got %q", got)
	}

	// Unclaimed session and legacy events: everyone.
	send(`{"jsonrpc":"2.0","method":"tabClosed","params":{"tabId":4,"sessionId":"unknown"}}`)
	send(`{"jsonrpc":"2.0","method":"onCDPEvent","params":{"method":"Y"}}`)
	for name, c := range map[string]net.Conn{"a": a, "b": b, "legacy": legacy} {
		if got := nextMethod(t, c, time.Second); got != "tabClosed" {
			t.Fatalf("%s first got %q", name, got)
		}
		if got := nextMethod(t, c, time.Second); got != "onCDPEvent" {
			t.Fatalf("%s second got %q", name, got)
		}
	}
}
