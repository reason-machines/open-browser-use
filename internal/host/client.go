package host

import (
	"net"
	"os"
	"path/filepath"
	"time"

	"github.com/ifuryst/open-browser-use/internal/wire"
)

// ResolveRelayTokenPath picks the token file a client should authenticate
// with: none when OBU_RELAY_AUTH=uid, else OBU_RELAY_TOKEN_PATH, else the
// explicit path (e.g. active.json's tokenPath), else <socket dir>/relay.token.
func ResolveRelayTokenPath(socketPath, explicit string) string {
	if os.Getenv("OBU_RELAY_AUTH") == "uid" {
		return ""
	}
	if env := os.Getenv("OBU_RELAY_TOKEN_PATH"); env != "" {
		return env
	}
	if explicit != "" {
		return explicit
	}
	return filepath.Join(filepath.Dir(socketPath), RelayTokenFile)
}

// DialRelay connects to a relay socket and, when the socket's directory holds
// a relay token, sends the {"auth":...} handshake frame. Relays that do not
// require a token drop that frame, so sending it is always safe.
func DialRelay(socketPath string, timeout time.Duration) (net.Conn, error) {
	return DialRelayWithToken(socketPath, "", timeout)
}

// DialRelayWithToken is DialRelay with an explicit token path (see
// ResolveRelayTokenPath for precedence). A missing token file means "relay
// runs without token auth" and no handshake is sent.
func DialRelayWithToken(socketPath, tokenPath string, timeout time.Duration) (net.Conn, error) {
	conn, err := net.DialTimeout("unix", socketPath, timeout)
	if err != nil {
		return nil, err
	}
	path := ResolveRelayTokenPath(socketPath, tokenPath)
	if path == "" {
		return conn, nil
	}
	token, err := ReadToken(path)
	if err != nil {
		return conn, nil
	}
	_ = conn.SetWriteDeadline(time.Now().Add(timeout))
	if err := wire.WriteFrame(conn, AuthFrame(token)); err != nil {
		_ = conn.Close()
		return nil, err
	}
	_ = conn.SetWriteDeadline(time.Time{})
	return conn, nil
}
