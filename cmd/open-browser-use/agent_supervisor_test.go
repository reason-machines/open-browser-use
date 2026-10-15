package main

import (
	"context"
	"encoding/json"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/ifuryst/open-browser-use/internal/host"
)

// TestHelperFakeAgent is re-executed as a fake obu-agent: it listens on
// --socket until killed.
func TestHelperFakeAgent(t *testing.T) {
	if os.Getenv("OBU_TEST_FAKE_AGENT") != "1" {
		t.Skip("helper process")
	}
	socket := ""
	for i, arg := range os.Args {
		if arg == "--socket" && i+1 < len(os.Args) {
			socket = os.Args[i+1]
		}
	}
	_ = os.Remove(socket)
	ln, err := net.Listen("unix", socket)
	if err != nil {
		os.Exit(3)
	}
	for {
		conn, err := ln.Accept()
		if err != nil {
			os.Exit(0)
		}
		_ = conn.Close()
	}
}

func fakeAgentCommand(profile, agentSocket string) (*exec.Cmd, error) {
	cmd := exec.Command(os.Args[0], "-test.run=TestHelperFakeAgent", "--", "--profile", profile, "--socket", agentSocket)
	cmd.Env = append(os.Environ(), "OBU_TEST_FAKE_AGENT=1")
	return cmd, nil
}

type supervisorHarness struct {
	sup         *agentSupervisor
	relay       *host.Relay
	socketDir   string
	agentSocket string
	cancel      context.CancelFunc
}

func startSupervisor(t *testing.T) *supervisorHarness {
	t.Helper()
	dir, err := os.MkdirTemp("/tmp", "obu-sup-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	extR, extW := net.Pipe()
	relay := host.NewRelay(host.Config{SocketDir: dir, SocketPath: filepath.Join(dir, "relay.sock")}, extR, extW)
	ctx, cancel := context.WithCancel(context.Background())
	go func() { _ = relay.Serve(ctx) }()
	agentSocket := filepath.Join(dir, "agent.sock")
	sup := newAgentSupervisor(relay, dir)
	sup.resolveProfile = func(context.Context) string { return "Profile 7" }
	sup.agentSocket = func(string) string { return agentSocket }
	sup.agentCommand = fakeAgentCommand
	go sup.run(ctx)
	h := &supervisorHarness{sup: sup, relay: relay, socketDir: dir, agentSocket: agentSocket, cancel: cancel}
	t.Cleanup(func() {
		sup.stop()
		cancel()
		_ = extR.Close()
		_ = extW.Close()
	})
	return h
}

func waitFor(t *testing.T, timeout time.Duration, what string, cond func() bool) time.Duration {
	t.Helper()
	start := time.Now()
	for time.Since(start) < timeout {
		if cond() {
			return time.Since(start)
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
	return 0
}

func readAgentRecord(t *testing.T, dir string) agentRecord {
	t.Helper()
	var record agentRecord
	payload, err := os.ReadFile(agentRecordPath(dir, "Profile 7"))
	if err != nil {
		return record
	}
	_ = json.Unmarshal(payload, &record)
	return record
}

func TestSupervisorSpawnsRecordsAndRestartsAgent(t *testing.T) {
	h := startSupervisor(t)
	waitFor(t, 5*time.Second, "agent listening", func() bool { return agentListening(h.agentSocket) })
	waitFor(t, 2*time.Second, "agent record", func() bool { return readAgentRecord(t, h.socketDir).AgentPID > 0 })
	record := readAgentRecord(t, h.socketDir)
	if record.Profile != "Profile 7" || record.AgentSocket != h.agentSocket || record.RelaySocket != h.relay.SocketPath() {
		t.Fatalf("unexpected record %+v", record)
	}
	active, err := host.ReadActiveSocketRecord(h.socketDir)
	if err != nil || active.Profile != "Profile 7" || active.AgentSocket != h.agentSocket {
		t.Fatalf("active.json %+v err=%v", active, err)
	}

	// kill -9 the agent → back within 1 s (first restart has no backoff).
	firstPID := record.AgentPID
	killedAt := time.Now()
	if err := syscall.Kill(firstPID, syscall.SIGKILL); err != nil {
		t.Fatal(err)
	}
	waitFor(t, time.Second, "agent restarted", func() bool {
		r := readAgentRecord(t, h.socketDir)
		return r.AgentPID != 0 && r.AgentPID != firstPID && agentListening(h.agentSocket)
	})
	took := time.Since(killedAt)
	if took > time.Second {
		t.Fatalf("agent back after %v, want < 1s", took)
	}
	t.Logf("agent back after %v", took)

	// stop() terminates the supervised agent.
	pid := readAgentRecord(t, h.socketDir).AgentPID
	h.sup.stop()
	waitFor(t, 3*time.Second, "agent terminated", func() bool { return syscall.Kill(pid, 0) != nil })
}

func TestSupervisorAdoptsRunningAgent(t *testing.T) {
	dir, err := os.MkdirTemp("/tmp", "obu-adopt-")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(dir)
	agentSocket := filepath.Join(dir, "agent.sock")
	ln, err := net.Listen("unix", agentSocket)
	if err != nil {
		t.Fatal(err)
	}
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			_ = c.Close()
		}
	}()
	extR, extW := net.Pipe()
	defer extR.Close()
	defer extW.Close()
	relay := host.NewRelay(host.Config{SocketDir: dir, SocketPath: filepath.Join(dir, "relay.sock")}, extR, extW)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() { _ = relay.Serve(ctx) }()
	spawned := make(chan struct{}, 4)
	sup := newAgentSupervisor(relay, dir)
	sup.resolveProfile = func(context.Context) string { return "Profile 7" }
	sup.agentSocket = func(string) string { return agentSocket }
	sup.agentCommand = func(profile, socket string) (*exec.Cmd, error) {
		if profile != "probe" {
			spawned <- struct{}{}
		}
		return fakeAgentCommand(profile, socket)
	}
	go sup.run(ctx)
	defer sup.stop()
	waitFor(t, 2*time.Second, "adopted record", func() bool { return readAgentRecord(t, dir).Adopted })
	select {
	case <-spawned:
		t.Fatal("supervisor spawned a second agent while one was listening")
	case <-time.After(300 * time.Millisecond):
	}
	// The adopted agent dies → the supervisor spawns its own.
	_ = ln.Close()
	select {
	case <-spawned:
	case <-time.After(2 * time.Second):
		t.Fatal("supervisor did not take over after adopted agent exited")
	}
}

func TestSupervisorDisabledWithoutBinary(t *testing.T) {
	t.Setenv("OBU_AGENT_BIN", "")
	t.Setenv("PATH", "/nonexistent")
	if _, err := defaultAgentCommand("p", "s"); err == nil && findExecutable("obu-agent") == "" {
		t.Fatal("expected not-found error")
	}
	t.Setenv("OBU_AGENT_BIN", "/x/obu-agent.mjs")
	t.Setenv("OBU_NODE", "/usr/bin/true")
	cmd, err := defaultAgentCommand("Profile 1", "/s/agent.sock")
	if err != nil {
		t.Fatal(err)
	}
	if got := strings.Join(cmd.Args, " "); got != "/usr/bin/true /x/obu-agent.mjs --profile Profile 1 --socket /s/agent.sock" {
		t.Fatalf("args %q", got)
	}
}

func TestAgentSocketPathAndProfileKey(t *testing.T) {
	t.Setenv("OBU_AGENT_SOCKET", "")
	t.Setenv("OBU_BRAND_DIR", "")
	path := agentSocketPath("Profile 1")
	if !strings.HasSuffix(path, filepath.Join("Reason", "browser", "Profile 1", "agent.sock")) {
		t.Fatalf("path %q", path)
	}
	if profileKey("chrome", "Default") != "Default" || profileKey("chrome-for-testing", "Default") != "chrome-for-testing-Default" {
		t.Fatal("profileKey")
	}
}

func TestApplyTimeoutDefault(t *testing.T) {
	params := map[string]any{}
	applyTimeoutDefault(params, 10*time.Second)
	if params["timeoutMs"] != int64(9750) {
		t.Fatalf("got %v", params["timeoutMs"])
	}
	explicit := map[string]any{"timeoutMs": 42}
	applyTimeoutDefault(explicit, 10*time.Second)
	if explicit["timeoutMs"] != 42 {
		t.Fatal("explicit timeoutMs overwritten")
	}
}
