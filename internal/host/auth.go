package host

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"syscall"
)

// RelayTokenFile is the token file name inside the socket dir.
const RelayTokenFile = "relay.token"

func RelayTokenPath(configuredDir string) string {
	return filepath.Join(socketDir(configuredDir), RelayTokenFile)
}

// EnsureToken returns the token stored at path, creating a fresh 256-bit
// token (0600) when the file does not exist. A token file readable by group
// or others is rejected.
func EnsureToken(path string) ([]byte, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, err
	}
	if token, err := ReadToken(path); err == nil {
		return token, nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	var raw [32]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return nil, err
	}
	token := []byte(hex.EncodeToString(raw[:]))
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if errors.Is(err, os.ErrExist) {
		// Another host created it concurrently.
		return ReadToken(path)
	}
	if err != nil {
		return nil, err
	}
	if _, err := file.Write(append(token, '\n')); err != nil {
		_ = file.Close()
		return nil, err
	}
	return token, file.Close()
}

// ReadToken reads a token file written by EnsureToken.
func ReadToken(path string) ([]byte, error) {
	info, err := os.Stat(path)
	if err != nil {
		return nil, err
	}
	if info.Mode().Perm()&0o077 != 0 && !isWindows() {
		return nil, fmt.Errorf("token file %s has mode %v; want 0600", path, info.Mode().Perm())
	}
	payload, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	token := strings.TrimSpace(string(payload))
	if token == "" {
		return nil, fmt.Errorf("token file %s is empty", path)
	}
	return []byte(token), nil
}

// AuthFrame is the first frame a client sends when the relay requires a token.
func AuthFrame(token []byte) []byte {
	return []byte(`{"auth":"` + string(token) + `"}`)
}

// IsStaleSocketError reports dial errors that prove nothing listens on the
// path (safe to unlink). Permission errors and timeouts are not stale
// (upstream #22: a sandboxed EPERM must never unlink a live socket).
func IsStaleSocketError(err error) bool {
	return errors.Is(err, syscall.ENOENT) || errors.Is(err, syscall.ECONNREFUSED)
}
