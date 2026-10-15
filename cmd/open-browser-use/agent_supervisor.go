package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/ifuryst/open-browser-use/internal/host"
)

// agentRestartBackoff is the delay before each consecutive restart of a
// crashed obu-agent. It resets once an agent stays up for agentStableAfter.
var agentRestartBackoff = []time.Duration{0, 250 * time.Millisecond, 750 * time.Millisecond, 1500 * time.Millisecond, 3000 * time.Millisecond}

const (
	agentStableAfter = 30 * time.Second
	agentAdoptPoll   = 250 * time.Millisecond
	agentStopGrace   = 2 * time.Second
)

// agentRecord is <socketDir>/agents/<profile>.json, the per-profile lookup for
// clients that want the daemon socket of a given Chrome profile.
type agentRecord struct {
	Profile     string    `json:"profile"`
	AgentSocket string    `json:"agentSocket"`
	AgentPID    int       `json:"agentPid,omitempty"`
	Adopted     bool      `json:"adopted,omitempty"`
	RelaySocket string    `json:"relaySocket"`
	RelayPID    int       `json:"relayPid"`
	TokenPath   string    `json:"tokenPath,omitempty"`
	UpdatedAt   time.Time `json:"updatedAt"`
}

// agentSupervisor spawns one obu-agent for the Chrome profile this native
// host serves, restarts it with backoff, and adopts an agent that is already
// listening (e.g. left running by a previous host).
type agentSupervisor struct {
	relay     *host.Relay
	socketDir string
	logger    *slog.Logger

	// Overridable in tests.
	resolveProfile func(ctx context.Context) string
	agentCommand   func(profile, agentSocket string) (*exec.Cmd, error)
	agentSocket    func(profile string) string

	mu      sync.Mutex
	current *exec.Cmd
	stopped bool
	done    chan struct{}
}

func newAgentSupervisor(relay *host.Relay, socketDir string) *agentSupervisor {
	s := &agentSupervisor{
		relay:     relay,
		socketDir: socketDir,
		logger:    slog.New(slog.NewTextHandler(os.Stderr, nil)),
		done:      make(chan struct{}),
	}
	s.resolveProfile = s.defaultResolveProfile
	s.agentCommand = defaultAgentCommand
	s.agentSocket = agentSocketPath
	return s
}

func (s *agentSupervisor) run(ctx context.Context) {
	defer close(s.done)
	if strings.EqualFold(os.Getenv("OBU_AGENT"), "off") {
		return
	}
	if _, err := s.agentCommand("probe", "probe"); err != nil {
		s.logger.Info("obu-agent supervisor disabled", "reason", err)
		return
	}
	select {
	case <-s.relay.Ready():
	case <-ctx.Done():
		return
	}
	profile := s.resolveProfile(ctx)
	if ctx.Err() != nil {
		return
	}
	agentSocket := s.agentSocket(profile)
	_ = host.UpdateActiveSocketRecord(s.socketDir, s.relay.SocketPath(), func(r *host.ActiveSocketRecord) {
		r.Profile = profile
		r.AgentSocket = agentSocket
	})

	attempt := 0
	for ctx.Err() == nil && !s.isStopped() {
		if agentListening(agentSocket) {
			s.writeRecord(profile, agentSocket, 0, true)
			s.logger.Info("adopted running obu-agent", "profile", profile, "socket", agentSocket)
			for ctx.Err() == nil && agentListening(agentSocket) {
				sleepCtx(ctx, agentAdoptPoll)
			}
			attempt = 0
			continue
		}
		cmd, err := s.agentCommand(profile, agentSocket)
		if err != nil {
			s.logger.Warn("cannot build obu-agent command", "error", err)
			return
		}
		env := cmd.Env
		if env == nil {
			env = os.Environ()
		}
		cmd.Env = append(env,
			"OBU_PROFILE="+profile,
			"OBU_AGENT_SOCKET="+agentSocket,
			"OBU_RELAY_SOCKET="+s.relay.SocketPath(),
			"OBU_RELAY_TOKEN_PATH="+s.relay.TokenPath(),
			"OBU_AGENT_SUPERVISED=1",
		)
		// Detached process group: the agent is resident and outlives a host
		// crash; the next host adopts it.
		detachProcessGroup(cmd)
		cmd.Stdin = nil
		// Never inherit stdout: it is the native messaging channel. With no
		// log file, nil means /dev/null.
		logFile := openAgentLog(agentSocket)
		if logFile != nil {
			cmd.Stdout = logFile
			cmd.Stderr = logFile
		}
		started := time.Now()
		s.mu.Lock()
		if s.stopped {
			s.mu.Unlock()
			closeQuietly(logFile)
			return
		}
		err = cmd.Start()
		if err == nil {
			s.current = cmd
		}
		s.mu.Unlock()
		if err != nil {
			s.logger.Warn("obu-agent start failed", "error", err)
		} else {
			s.writeRecord(profile, agentSocket, cmd.Process.Pid, false)
			s.logger.Info("obu-agent started", "pid", cmd.Process.Pid, "profile", profile)
			err = cmd.Wait()
			s.mu.Lock()
			s.current = nil
			s.mu.Unlock()
			s.logger.Warn("obu-agent exited", "error", err, "uptime", time.Since(started))
		}
		closeQuietly(logFile)
		if time.Since(started) >= agentStableAfter {
			attempt = 0
		}
		delay := agentRestartBackoff[min(attempt, len(agentRestartBackoff)-1)]
		attempt++
		sleepCtx(ctx, delay)
	}
}

// stop terminates a supervised (not adopted) agent: SIGTERM, then SIGKILL.
func (s *agentSupervisor) stop() {
	s.mu.Lock()
	s.stopped = true
	cmd := s.current
	s.mu.Unlock()
	if cmd == nil || cmd.Process == nil {
		return
	}
	_ = cmd.Process.Signal(syscall.SIGTERM)
	select {
	case <-s.done:
	case <-time.After(agentStopGrace):
		_ = cmd.Process.Kill()
	}
}

func (s *agentSupervisor) isStopped() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.stopped
}

func (s *agentSupervisor) writeRecord(profile, agentSocket string, pid int, adopted bool) {
	record := agentRecord{
		Profile:     profile,
		AgentSocket: agentSocket,
		AgentPID:    pid,
		Adopted:     adopted,
		RelaySocket: s.relay.SocketPath(),
		RelayPID:    os.Getpid(),
		TokenPath:   s.relay.TokenPath(),
		UpdatedAt:   time.Now().UTC(),
	}
	path := agentRecordPath(s.socketDir, profile)
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return
	}
	payload, _ := json.MarshalIndent(record, "", "  ")
	tmp := path + ".tmp"
	if os.WriteFile(tmp, append(payload, '\n'), 0o600) == nil {
		_ = os.Rename(tmp, path)
	}
}

func agentRecordPath(socketDir, profile string) string {
	dir := socketDir
	if dir == "" {
		dir = host.DefaultSocketDir
	}
	return filepath.Join(dir, "agents", sanitizeProfileKey(profile)+".json")
}

func sanitizeProfileKey(profile string) string {
	return strings.Map(func(r rune) rune {
		if r == '/' || r == '\\' || r == 0 {
			return '_'
		}
		return r
	}, profile)
}

// defaultResolveProfile: OBU_PROFILE, else ask the extension for its instance
// id and map it to a Chrome profile directory, else "Default".
func (s *agentSupervisor) defaultResolveProfile(ctx context.Context) string {
	if profile := strings.TrimSpace(os.Getenv("OBU_PROFILE")); profile != "" {
		return profile
	}
	for i := 0; i < 10 && ctx.Err() == nil; i++ {
		callCtx, cancel := context.WithTimeout(ctx, time.Second)
		raw, err := s.relay.Call(callCtx, "getInfo", map[string]any{})
		cancel()
		if err != nil {
			sleepCtx(ctx, 500*time.Millisecond)
			continue
		}
		var response struct {
			Result struct {
				Metadata struct {
					ExtensionID         string `json:"extensionId"`
					ExtensionInstanceID string `json:"extensionInstanceId"`
				} `json:"metadata"`
			} `json:"result"`
		}
		if json.Unmarshal(raw, &response) != nil {
			break
		}
		meta := response.Result.Metadata
		if meta.ExtensionInstanceID == "" {
			break
		}
		if browserID, _, _, dir, _, ok := resolveProfileForInstanceID(meta.ExtensionID, meta.ExtensionInstanceID); ok {
			return profileKey(browserID, dir)
		}
		return "instance-" + meta.ExtensionInstanceID
	}
	return "Default"
}

// profileKey names the agent dir: the Chrome profile directory for stable
// Chrome, prefixed with the browser id for other browsers (Chrome for
// Testing, Beta, Edge...) so their "Default" profiles don't collide.
func profileKey(browserID, dir string) string {
	if browserID == "" || browserID == "chrome" {
		return dir
	}
	return browserID + "-" + dir
}

// agentSocketPath mirrors packages/obu-agent/src/daemon/paths.ts.
func agentSocketPath(profile string) string {
	if path := strings.TrimSpace(os.Getenv("OBU_AGENT_SOCKET")); path != "" {
		return path
	}
	base, err := os.UserConfigDir()
	if err != nil {
		base = os.TempDir()
	}
	brand := os.Getenv("OBU_BRAND_DIR")
	if brand == "" {
		brand = "Reason"
	}
	return filepath.Join(base, brand, "browser", sanitizeProfileKey(profile), "agent.sock")
}

// defaultAgentCommand locates obu-agent: OBU_AGENT_BIN, next to this binary,
// or common install dirs (Chrome launches hosts with a minimal PATH). A .js
// or .mjs entry runs under node (OBU_NODE or found the same way).
func defaultAgentCommand(profile, agentSocket string) (*exec.Cmd, error) {
	bin := strings.TrimSpace(os.Getenv("OBU_AGENT_BIN"))
	if bin == "" {
		bin = findExecutable("obu-agent")
	}
	if bin == "" {
		return nil, errors.New("obu-agent not found (set OBU_AGENT_BIN)")
	}
	args := []string{"--profile", profile, "--socket", agentSocket}
	if strings.HasSuffix(bin, ".js") || strings.HasSuffix(bin, ".mjs") {
		node := strings.TrimSpace(os.Getenv("OBU_NODE"))
		if node == "" {
			node = findExecutable("node")
		}
		if node == "" {
			return nil, fmt.Errorf("node not found for %s (set OBU_NODE)", bin)
		}
		return exec.Command(node, append([]string{bin}, args...)...), nil
	}
	return exec.Command(bin, args...), nil
}

func findExecutable(name string) string {
	var dirs []string
	if self, err := os.Executable(); err == nil {
		dirs = append(dirs, filepath.Dir(self))
	}
	if home, err := os.UserHomeDir(); err == nil {
		dirs = append(dirs, filepath.Join(home, ".local", "bin"), filepath.Join(home, ".bun", "bin"))
	}
	dirs = append(dirs, "/opt/homebrew/bin", "/usr/local/bin")
	for _, dir := range dirs {
		candidate := filepath.Join(dir, name)
		if info, err := os.Stat(candidate); err == nil && !info.IsDir() && info.Mode()&0o111 != 0 {
			return candidate
		}
	}
	if path, err := exec.LookPath(name); err == nil {
		return path
	}
	return ""
}

func agentListening(socketPath string) bool {
	conn, err := net.DialTimeout("unix", socketPath, 200*time.Millisecond)
	if err != nil {
		return false
	}
	_ = conn.Close()
	return true
}

func openAgentLog(agentSocket string) *os.File {
	dir := filepath.Dir(agentSocket)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil
	}
	file, err := os.OpenFile(filepath.Join(dir, "agent.log"), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return nil
	}
	return file
}

func closeQuietly(file *os.File) {
	if file != nil {
		_ = file.Close()
	}
}

func sleepCtx(ctx context.Context, d time.Duration) {
	if d <= 0 {
		return
	}
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-ctx.Done():
	case <-timer.C:
	}
}
