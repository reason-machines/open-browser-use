package host

import (
	"net"
	"path/filepath"
	"time"

	"github.com/ifuryst/open-browser-use/internal/wire"
)

// DialRelay connects to a relay socket and, when the socket's directory holds
// a relay token, sends the {"auth":...} handshake frame. Relays that do not
// require a token drop that frame, so sending it is always safe.
func DialRelay(socketPath string, timeout time.Duration) (net.Conn, error) {
	conn, err := net.DialTimeout("unix", socketPath, timeout)
	if err != nil {
		return nil, err
	}
	token, err := ReadToken(filepath.Join(filepath.Dir(socketPath), RelayTokenFile))
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
