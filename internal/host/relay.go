package host

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"sync"
	"sync/atomic"
	"time"

	"github.com/ifuryst/open-browser-use/internal/wire"
)

const NativeHostName = "com.ifuryst.open_browser_use.extension"

var DefaultSocketDir = defaultSocketDir()

// hostIDPrefix marks ids the relay assigned; extension responses carrying
// any other id are broadcast as notifications.
const hostIDPrefix = "obu:"

// relayTimeoutGrace is added to a request's params.timeoutMs before the relay
// gives up on the extension, so the extension's own timeout error (which is
// more specific) wins whenever it arrives.
const relayTimeoutGrace = 2 * time.Second

type Config struct {
	SocketDir  string
	SocketPath string
	Logger     *slog.Logger

	// RequireToken makes every client send {"auth":"<token>"} as its first
	// frame. The token lives in TokenPath (default <socketDir>/relay.token,
	// 0600) and is recorded in active.json as tokenPath.
	RequireToken bool
	TokenPath    string
	// AuthTimeout bounds how long a client may take to send its auth frame.
	AuthTimeout time.Duration
	// SkipPeerCheck disables the same-uid peer credential check.
	SkipPeerCheck bool
}

type Relay struct {
	config Config
	logger *slog.Logger

	stdin  io.Reader
	stdout io.Writer

	listener net.Listener
	token    []byte
	chunks   *wire.Reassembler

	mu        sync.Mutex
	clients   map[int64]*clientConn
	pending   map[string]*pendingRequest
	nextID    atomic.Int64
	nextReqID atomic.Int64
	writeMu   sync.Mutex

	ready     chan struct{}
	readyOnce sync.Once
}

type clientConn struct {
	id   int64
	conn net.Conn
	mu   sync.Mutex
}

type pendingRequest struct {
	client     *clientConn // nil for host-originated calls
	originalID []byte      // raw JSON of the client's id
	method     string
	timer      *time.Timer
	reply      chan []byte // host-originated calls only
}

type ActiveSocketRecord struct {
	SocketPath string    `json:"socketPath"`
	PID        int       `json:"pid"`
	StartedAt  time.Time `json:"startedAt"`
	// TokenPath is set when the relay requires {"auth":"<token>"}.
	TokenPath string `json:"tokenPath,omitempty"`
	// Profile and AgentSocket are filled in by the obu-agent supervisor.
	Profile     string `json:"profile,omitempty"`
	AgentSocket string `json:"agentSocket,omitempty"`
}

var (
	errNotUnix         = errors.New("peer credentials need a Unix socket")
	errPeerUnsupported = errors.New("peer credentials unsupported on this platform")
	// ErrUnauthorized is returned to clients that fail the auth handshake.
	ErrUnauthorized = errors.New("unauthorized: send {\"auth\":\"<token>\"} from the relay token file as the first frame")
)

func NewRelay(config Config, stdin io.Reader, stdout io.Writer) *Relay {
	logger := config.Logger
	if logger == nil {
		logger = slog.New(slog.NewTextHandler(os.Stderr, nil))
	}
	if config.AuthTimeout <= 0 {
		config.AuthTimeout = 5 * time.Second
	}
	return &Relay{
		config:  config,
		logger:  logger,
		stdin:   stdin,
		stdout:  stdout,
		chunks:  wire.NewReassembler(),
		clients: make(map[int64]*clientConn),
		pending: make(map[string]*pendingRequest),
		ready:   make(chan struct{}),
	}
}

func (r *Relay) SocketPath() string {
	if r.config.SocketPath != "" {
		return r.config.SocketPath
	}
	r.config.SocketPath = filepath.Join(socketDir(r.config.SocketDir), fmt.Sprintf("%s.sock", randomID()))
	return r.config.SocketPath
}

// TokenPath returns the token file path (empty when tokens are not required).
func (r *Relay) TokenPath() string {
	if !r.config.RequireToken {
		return ""
	}
	if r.config.TokenPath != "" {
		return r.config.TokenPath
	}
	return RelayTokenPath(r.config.SocketDir)
}

// Ready is closed once the relay is listening.
func (r *Relay) Ready() <-chan struct{} { return r.ready }

func (r *Relay) Serve(ctx context.Context) error {
	socketPath := r.SocketPath()
	if err := os.MkdirAll(filepath.Dir(socketPath), 0o700); err != nil {
		return err
	}
	if r.config.RequireToken {
		token, err := EnsureToken(r.TokenPath())
		if err != nil {
			return fmt.Errorf("relay token: %w", err)
		}
		r.token = token
	}
	// The path is fresh (random UUID) unless the caller pinned it; only clear
	// a pinned path when nothing is listening there (never unlink a live socket).
	if err := removeIfStale(socketPath); err != nil {
		return err
	}
	listener, err := net.Listen("unix", socketPath)
	if err != nil {
		return fmt.Errorf("listen unix socket %q (path length %d): %w", socketPath, len(socketPath), err)
	}
	r.listener = listener
	if err := os.Chmod(socketPath, 0o600); err != nil {
		_ = listener.Close()
		return err
	}
	if err := WriteActiveSocketRecordFull(r.config.SocketDir, ActiveSocketRecord{
		SocketPath: socketPath,
		TokenPath:  r.TokenPath(),
	}); err != nil {
		_ = listener.Close()
		return err
	}
	r.logger.Info("open-browser-use native host listening", "socket", socketPath, "token", r.config.RequireToken)
	r.readyOnce.Do(func() { close(r.ready) })

	errCh := make(chan error, 2)
	go func() { errCh <- r.acceptLoop(ctx) }()
	go func() { errCh <- r.readExtensionLoop() }()
	go func() {
		<-ctx.Done()
		_ = listener.Close()
		r.closeClients()
	}()

	err = <-errCh
	_ = listener.Close()
	_ = os.Remove(socketPath)
	_ = RemoveActiveSocketRecord(r.config.SocketDir, socketPath)
	r.closeClients()
	if errors.Is(err, net.ErrClosed) || errors.Is(err, io.EOF) || errors.Is(err, context.Canceled) {
		return nil
	}
	return err
}

func (r *Relay) acceptLoop(ctx context.Context) error {
	for {
		conn, err := r.listener.Accept()
		if err != nil {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			return err
		}
		if !r.config.SkipPeerCheck {
			if err := checkPeer(conn); err != nil {
				r.logger.Warn("rejected socket client", "error", err)
				_ = wire.WriteFrame(conn, errorFrame(nil, -32001, "unauthorized: "+err.Error(), "unauthorized"))
				_ = conn.Close()
				continue
			}
		}
		id := r.nextID.Add(1)
		client := &clientConn{id: id, conn: conn}
		go r.readClientLoop(client)
	}
}

// checkPeer rejects connections from another uid. Platforms without peer
// credentials rely on the token alone.
func checkPeer(conn net.Conn) error {
	uid, err := peerUID(conn)
	if errors.Is(err, errPeerUnsupported) || errors.Is(err, errNotUnix) {
		return nil
	}
	if err != nil {
		return err
	}
	if want := uint32(os.Getuid()); uid != want {
		return fmt.Errorf("peer uid %d != %d", uid, want)
	}
	return nil
}

func (r *Relay) authenticate(client *clientConn) bool {
	if !r.config.RequireToken {
		return true
	}
	_ = client.conn.SetReadDeadline(time.Now().Add(r.config.AuthTimeout))
	payload, err := wire.ReadFrame(client.conn, 4096)
	_ = client.conn.SetReadDeadline(time.Time{})
	ok := false
	if err == nil {
		var frame struct {
			Auth string `json:"auth"`
		}
		if json.Unmarshal(payload, &frame) == nil && constantTimeEqual([]byte(frame.Auth), r.token) {
			ok = true
		}
	}
	if !ok {
		_ = client.write(errorFrame(nil, -32001, ErrUnauthorized.Error(), "unauthorized"))
	}
	return ok
}

func (r *Relay) readClientLoop(client *clientConn) {
	defer func() {
		_ = client.conn.Close()
		r.mu.Lock()
		delete(r.clients, client.id)
		for requestID, pending := range r.pending {
			if pending.client == client {
				if pending.timer != nil {
					pending.timer.Stop()
				}
				delete(r.pending, requestID)
			}
		}
		r.mu.Unlock()
	}()

	if !r.authenticate(client) {
		return
	}
	r.mu.Lock()
	r.clients[client.id] = client
	r.mu.Unlock()

	for {
		payload, err := wire.ReadFrame(client.conn, wire.DefaultMaxFrame)
		if err != nil {
			return
		}
		r.forwardClientRequest(client, payload)
	}
}

func (r *Relay) forwardClientRequest(client *clientConn, payload []byte) {
	idSpan, hasID, err := wire.FindKey(payload, "id")
	if err != nil {
		_ = client.write(errorFrame(nil, -32700, "parse error: "+err.Error(), ""))
		return
	}
	if !hasID {
		if err := r.writeExtension(payload, ""); err != nil {
			r.logger.Warn("failed to forward client notification", "error", err)
		}
		return
	}
	hostID := hostIDPrefix + strconv.FormatInt(r.nextReqID.Add(1), 10)
	originalID := bytes.Clone(payload[idSpan.Start:idSpan.End])
	forwarded := wire.Splice(payload, idSpan, []byte(strconv.Quote(hostID)))
	pending := &pendingRequest{client: client, originalID: originalID, method: rawMethod(payload)}
	r.mu.Lock()
	r.pending[hostID] = pending
	if timeout, ok := requestTimeout(payload); ok {
		pending.timer = time.AfterFunc(timeout+relayTimeoutGrace, func() { r.expire(hostID, timeout) })
	}
	r.mu.Unlock()
	if err := r.writeExtension(forwarded, hostID); err != nil {
		if p := r.takePending(hostID); p != nil {
			_ = client.write(errorFrame(originalID, -32000, err.Error(), ""))
		}
	}
}

// expire answers a request the extension never answered within its own
// params.timeoutMs (+ grace). A late response is then dropped.
func (r *Relay) expire(hostID string, timeout time.Duration) {
	p := r.takePending(hostID)
	if p == nil {
		return
	}
	message := fmt.Sprintf("timeout: extension did not answer %s within %s", p.method, timeout+relayTimeoutGrace)
	if p.reply != nil {
		p.reply <- errorFrame([]byte(strconv.Quote(hostID)), -32001, message, "timeout")
		return
	}
	_ = p.client.write(errorFrame(p.originalID, -32001, message, "timeout"))
}

func (r *Relay) takePending(hostID string) *pendingRequest {
	r.mu.Lock()
	defer r.mu.Unlock()
	p, ok := r.pending[hostID]
	if !ok {
		return nil
	}
	delete(r.pending, hostID)
	if p.timer != nil {
		p.timer.Stop()
	}
	return p
}

func (r *Relay) readExtensionLoop() error {
	for {
		payload, err := wire.ReadFrame(r.stdin, wire.DefaultMaxFrame)
		if err != nil {
			return err
		}
		if err := r.dispatchExtensionPayload(payload); err != nil {
			r.logger.Warn("failed to dispatch extension payload", "error", err)
		}
	}
}

func (r *Relay) dispatchExtensionPayload(payload []byte) error {
	if wire.IsChunk(payload) {
		whole, err := r.chunks.Add(payload)
		if err != nil || whole == nil {
			return err
		}
		payload = whole
	}
	idSpan, hasID, err := wire.FindKey(payload, "id")
	if err != nil {
		return err
	}
	if hasID {
		raw := payload[idSpan.Start:idSpan.End]
		if len(raw) > len(hostIDPrefix)+2 && bytes.HasPrefix(raw[1:], []byte(hostIDPrefix)) && raw[0] == '"' {
			if p := r.takePending(string(raw[1 : len(raw)-1])); p != nil {
				if p.reply != nil {
					p.reply <- payload
					return nil
				}
				return p.client.write(wire.Splice(payload, idSpan, p.originalID))
			}
			// Unknown host id: the client went away or the request expired.
			return nil
		}
	}
	r.broadcast(payload)
	return nil
}

// Call sends a host-originated request to the extension and waits for its
// response frame (raw JSON-RPC response).
func (r *Relay) Call(ctx context.Context, method string, params any) (json.RawMessage, error) {
	hostID := hostIDPrefix + "h" + strconv.FormatInt(r.nextReqID.Add(1), 10)
	body, err := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": hostID, "method": method, "params": params})
	if err != nil {
		return nil, err
	}
	p := &pendingRequest{method: method, reply: make(chan []byte, 1)}
	r.mu.Lock()
	r.pending[hostID] = p
	r.mu.Unlock()
	if err := r.writeExtension(body, hostID); err != nil {
		r.takePending(hostID)
		return nil, err
	}
	select {
	case response := <-p.reply:
		return response, nil
	case <-ctx.Done():
		r.takePending(hostID)
		return nil, ctx.Err()
	}
}

// writeExtension writes one message, chunked when it exceeds Chrome's
// host→extension limit. Chunks of one message are never interleaved.
func (r *Relay) writeExtension(payload []byte, chunkID string) error {
	if chunkID == "" {
		chunkID = "n" + strconv.FormatInt(r.nextReqID.Add(1), 10)
	}
	frames := wire.SplitChunks(payload, chunkID)
	r.writeMu.Lock()
	defer r.writeMu.Unlock()
	for _, frame := range frames {
		if err := wire.WriteFrame(r.stdout, frame); err != nil {
			return err
		}
	}
	return nil
}

func (r *Relay) broadcast(payload []byte) {
	r.mu.Lock()
	clients := make([]*clientConn, 0, len(r.clients))
	for _, client := range r.clients {
		clients = append(clients, client)
	}
	r.mu.Unlock()
	for _, client := range clients {
		_ = client.write(payload)
	}
}

func (r *Relay) closeClients() {
	r.mu.Lock()
	clients := make([]*clientConn, 0, len(r.clients))
	for _, client := range r.clients {
		clients = append(clients, client)
	}
	for _, p := range r.pending {
		if p.timer != nil {
			p.timer.Stop()
		}
	}
	r.clients = make(map[int64]*clientConn)
	r.pending = make(map[string]*pendingRequest)
	r.mu.Unlock()
	for _, client := range clients {
		_ = client.conn.Close()
	}
}

func (c *clientConn) write(payload []byte) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	return wire.WriteFrame(c.conn, payload)
}

// errorFrame builds a JSON-RPC error without a map round trip. id is raw JSON
// (nil → null). errType, when set, goes to error.data.type.
func errorFrame(id []byte, code int, message string, errType string) []byte {
	if id == nil {
		id = []byte("null")
	}
	var b bytes.Buffer
	b.WriteString(`{"jsonrpc":"2.0","id":`)
	b.Write(id)
	b.WriteString(`,"error":{"code":`)
	b.WriteString(strconv.Itoa(code))
	b.WriteString(`,"message":`)
	quoted, _ := json.Marshal(message)
	b.Write(quoted)
	if errType != "" {
		b.WriteString(`,"data":{"type":`)
		b.WriteString(strconv.Quote(errType))
		b.WriteString(`}`)
	}
	b.WriteString(`}}`)
	return b.Bytes()
}

func rawMethod(payload []byte) string {
	span, ok, err := wire.FindKey(payload, "method")
	if err != nil || !ok {
		return "request"
	}
	var method string
	if json.Unmarshal(payload[span.Start:span.End], &method) != nil || method == "" {
		return "request"
	}
	return method
}

// requestTimeout reads params.timeoutMs (the extension's own timeout).
func requestTimeout(payload []byte) (time.Duration, bool) {
	span, ok, err := wire.FindPath(payload, "params", "timeoutMs")
	if err != nil || !ok {
		return 0, false
	}
	ms, err := strconv.ParseFloat(string(payload[span.Start:span.End]), 64)
	if err != nil || ms <= 0 {
		return 0, false
	}
	return time.Duration(ms * float64(time.Millisecond)), true
}

func constantTimeEqual(a, b []byte) bool {
	if len(a) != len(b) || len(b) == 0 {
		return false
	}
	var v byte
	for i := range a {
		v |= a[i] ^ b[i]
	}
	return v == 0
}

// removeIfStale unlinks a socket path only when nothing accepts on it.
func removeIfStale(socketPath string) error {
	if _, err := os.Lstat(socketPath); errors.Is(err, os.ErrNotExist) {
		return nil
	}
	conn, err := net.DialTimeout("unix", socketPath, 500*time.Millisecond)
	if err == nil {
		_ = conn.Close()
		return fmt.Errorf("socket %q is in use by a live process", socketPath)
	}
	if IsStaleSocketError(err) {
		return os.Remove(socketPath)
	}
	return fmt.Errorf("socket %q is not usable and was preserved: %w", socketPath, err)
}

func socketDir(configured string) string {
	if configured != "" {
		return configured
	}
	return DefaultSocketDir
}

func defaultSocketDir() string {
	if runtime.GOOS == "windows" {
		return filepath.Join(os.TempDir(), "open-browser-use")
	}
	return "/tmp/open-browser-use"
}

func ActiveSocketRecordPath(configuredDir string) string {
	return filepath.Join(socketDir(configuredDir), "active.json")
}

func WriteActiveSocketRecord(configuredDir string, socketPath string) error {
	return WriteActiveSocketRecordFull(configuredDir, ActiveSocketRecord{SocketPath: socketPath})
}

// WriteActiveSocketRecordFull writes active.json atomically (temp + rename).
func WriteActiveSocketRecordFull(configuredDir string, record ActiveSocketRecord) error {
	dir := socketDir(configuredDir)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	if record.PID == 0 {
		record.PID = os.Getpid()
	}
	if record.StartedAt.IsZero() {
		record.StartedAt = time.Now().UTC()
	}
	payload, err := json.MarshalIndent(record, "", "  ")
	if err != nil {
		return err
	}
	return writeFileAtomic(ActiveSocketRecordPath(configuredDir), append(payload, '\n'), 0o600)
}

func writeFileAtomic(path string, payload []byte, mode os.FileMode) error {
	tmp, err := os.CreateTemp(filepath.Dir(path), "."+filepath.Base(path)+".*")
	if err != nil {
		return err
	}
	tmpPath := tmp.Name()
	if _, err := tmp.Write(payload); err != nil {
		_ = tmp.Close()
		_ = os.Remove(tmpPath)
		return err
	}
	if err := tmp.Close(); err != nil {
		_ = os.Remove(tmpPath)
		return err
	}
	if err := os.Chmod(tmpPath, mode); err != nil {
		_ = os.Remove(tmpPath)
		return err
	}
	return os.Rename(tmpPath, path)
}

func ReadActiveSocketRecord(configuredDir string) (ActiveSocketRecord, error) {
	payload, err := os.ReadFile(ActiveSocketRecordPath(configuredDir))
	if err != nil {
		return ActiveSocketRecord{}, err
	}
	var record ActiveSocketRecord
	if err := json.Unmarshal(payload, &record); err != nil {
		return ActiveSocketRecord{}, err
	}
	if record.SocketPath == "" {
		return ActiveSocketRecord{}, errors.New("active socket record has empty socketPath")
	}
	return record, nil
}

// UpdateActiveSocketRecord rewrites active.json if it still belongs to socketPath.
func UpdateActiveSocketRecord(configuredDir string, socketPath string, mutate func(*ActiveSocketRecord)) error {
	record, err := ReadActiveSocketRecord(configuredDir)
	if err != nil {
		return err
	}
	if record.SocketPath != socketPath {
		return nil
	}
	mutate(&record)
	return WriteActiveSocketRecordFull(configuredDir, record)
}

func RemoveActiveSocketRecord(configuredDir string, socketPath string) error {
	record, err := ReadActiveSocketRecord(configuredDir)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		return err
	}
	if record.SocketPath != socketPath {
		return nil
	}
	return os.Remove(ActiveSocketRecordPath(configuredDir))
}

func randomID() string {
	var bytes [16]byte
	if _, err := rand.Read(bytes[:]); err != nil {
		return fmt.Sprintf("%d-%d", os.Getpid(), time.Now().UnixNano())
	}
	bytes[6] = (bytes[6] & 0x0f) | 0x40
	bytes[8] = (bytes[8] & 0x3f) | 0x80
	return fmt.Sprintf(
		"%08x-%04x-%04x-%04x-%012x",
		bytes[0:4],
		bytes[4:6],
		bytes[6:8],
		bytes[8:10],
		bytes[10:16],
	)
}
