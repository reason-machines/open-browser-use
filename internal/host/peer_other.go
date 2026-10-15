//go:build !darwin && !linux

package host

import "net"

// peerUID is unavailable on this platform (e.g. Windows AF_UNIX); the token
// check is the only authentication there.
func peerUID(net.Conn) (uint32, error) {
	return 0, errPeerUnsupported
}
