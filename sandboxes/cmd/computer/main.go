// Command computer is the computer agent (ADR-154 decision 4): the one process of an Agent
// Substrate actor that is a computer, mounted from ghcr.io/nylorun/computer at /nylo and run as
// /nylo/computer in place of the engine's `--service computer`. It serves the computer's routes
// on NYLORUN_COMPUTER_PORT (internal/computer), runs as the actor's PID 1 (it reaps what
// commands leave behind), and stays up on SIGTERM on Substrate, where it means the worker is
// stopping and the sandboxes service will suspend the actor. `computer version` prints its
// version.
package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/nylorun/agents/sandboxes/internal/computer"
)

func main() {
	if len(os.Args) > 1 && os.Args[1] == "version" {
		fmt.Println(computer.Version)
		return
	}
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err.Error())
		os.Exit(1)
	}
}

// logLine writes one line as the engine's host logger does: {level, message, time, …fields}.
func logLine(level, message string, fields ...any) {
	line := map[string]any{"level": level, "message": message, "time": time.Now().UTC().Format("2006-01-02T15:04:05.000Z")}
	for i := 0; i+1 < len(fields); i += 2 {
		line[fields[i].(string)] = fields[i+1]
	}
	raw, _ := json.Marshal(line)
	fmt.Println(string(raw))
}

func run() error {
	cfg, err := computer.LoadConfig(os.Getenv)
	if err != nil {
		return err
	}
	// What the template's wrapper did before the engine (umask 022, the workspace's dirs, cd
	// /workspace), so starting the agent needs no shell. /skills is a volume of its own.
	syscall.Umask(0o022)
	for _, dir := range []string{filepath.Join(cfg.HarnessRoot, "home"), cfg.Workspace} {
		if err := os.MkdirAll(dir, 0o777); err != nil {
			logLine("warn", "computer_mkdir_failed", "dir", dir, "error", err.Error())
		}
	}
	_ = os.Chdir(cfg.Workspace)

	trust, err := computer.TrustEnvironment(cfg.EgressCAFile, cfg.TrustFile, computer.SystemRootFiles)
	if err != nil {
		return fmt.Errorf("write the trust bundle: %w", err)
	}
	rawName, err := os.ReadFile(cfg.NameFile)
	if err != nil {
		return err
	}
	name := strings.TrimSpace(string(rawName))
	runner := &computer.Runner{
		Shell: computer.CommandShell(),
		Base:  computer.BaseEnv(computer.BaselineFrom(os.Environ()), cfg.Workspace),
		Trust: trust,
	}
	handler := computer.New(computer.Options{
		Workspace: cfg.Workspace, HarnessRoot: cfg.HarnessRoot, Public: cfg.Public, Name: name, Runner: runner,
	})
	listener, err := net.Listen("tcp", net.JoinHostPort("0.0.0.0", strconv.Itoa(cfg.Port)))
	if err != nil {
		return err
	}
	// No request or write timeout: an attach waits up to 50 s, and a file is as long as it is.
	server := &http.Server{Handler: handler, ReadHeaderTimeout: 30 * time.Second, IdleTimeout: 5 * time.Minute}
	errs := make(chan error, 1)
	go func() { errs <- server.Serve(listener) }()
	logLine("info", "computer_ready", "name", name, "port", cfg.Port, "version", computer.Version)

	signals := make(chan os.Signal, 2)
	signal.Notify(signals, syscall.SIGINT, syscall.SIGTERM)
	for {
		select {
		case err := <-errs:
			if errors.Is(err, http.ErrServerClosed) {
				return nil
			}
			return err
		case sig := <-signals:
			// On Agent Substrate, SIGTERM means the worker pod is stopping: the actor has 30 minutes
			// to be suspended, and the sandboxes service suspends it (Substrate's eviction contract).
			if sig == syscall.SIGTERM && cfg.Substrate {
				logLine("info", "computer_worker_stopping", "name", name)
				continue
			}
			_ = server.Close()
			return nil
		}
	}
}
