package computer

import (
	"fmt"
	"io"
	"os"
	"os/signal"
	"strings"
	"sync"
	"syscall"
	"time"
)

// StreamBytes is the most of each output stream a result keeps, head first: the engine's
// `harness.commandStreamBytes` (4 MiB, which a computer's engine never tunes).
const StreamBytes = 4 << 20

// ExecRequest is one command to run.
type ExecRequest struct {
	Command string
	Cwd     string
	// TimeoutMs is the request's timeoutMs, as given; Node's setTimeout bounds apply.
	TimeoutMs float64
	Env       map[string]string
}

// Result is what a command ended with, as the engine's ExecResult.
type Result struct {
	ExitCode int    `json:"exitCode"`
	Stdout   string `json:"stdout"`
	Stderr   string `json:"stderr"`
	// Killed says the process was stopped (a timeout or a cancel).
	Killed   bool `json:"killed"`
	TimedOut bool `json:"timedOut"`
}

// Runner runs commands as the engine's local backend does: the shell's `-c` in its own session
// (so its own process group), stdin from /dev/null, the baseline environment, then the request's,
// then the trust variables; the group is killed with SIGKILL on a timeout (124) or a cancel (130).
type Runner struct {
	// Shell is /bin/bash where the image has it, else /bin/sh (CommandShell).
	Shell string
	// Base is the baseline environment (BaseEnv), HOME included.
	Base map[string]string
	// Trust are the trust variables, which win over the request's.
	Trust map[string]string
	// StreamBytes caps each stream; 0 is StreamBytes.
	StreamBytes int
}

// CommandShell is the shell commands run under: bash, as the bash tool says, where the image has
// it; /bin/sh only in an image without it.
func CommandShell() string {
	if syscall.Access("/bin/bash", 1 /* X_OK */) == nil {
		return "/bin/bash"
	}
	return "/bin/sh"
}

// Exec runs one command until it ends; closing cancel kills it. An error is a command that
// could not start (`spawn /bin/bash ENOENT`).
func (r *Runner) Exec(req ExecRequest, cancel <-chan struct{}) (Result, error) {
	env := map[string]string{}
	for _, layer := range []map[string]string{r.Base, req.Env, r.Trust} {
		for k, v := range layer {
			env[k] = v
		}
	}
	list := make([]string, 0, len(env))
	for k, v := range env {
		list = append(list, k+"="+v)
	}
	devnull, err := os.Open(os.DevNull)
	if err != nil {
		return Result{}, err
	}
	defer devnull.Close()
	outR, outW, err := os.Pipe()
	if err != nil {
		return Result{}, err
	}
	errR, errW, err := os.Pipe()
	if err != nil {
		outR.Close()
		outW.Close()
		return Result{}, err
	}
	reaper.start()
	reaper.mu.Lock()
	process, err := os.StartProcess(r.Shell, []string{r.Shell, "-c", req.Command}, &os.ProcAttr{
		Dir:   req.Cwd,
		Env:   list,
		Files: []*os.File{devnull, outW, errW},
		// Its own process group, so a timeout or a cancel kills everything it started.
		Sys: &syscall.SysProcAttr{Setsid: true},
	})
	var exited chan syscall.WaitStatus
	if err == nil {
		exited = reaper.expect(process.Pid)
	}
	reaper.mu.Unlock()
	outW.Close()
	errW.Close()
	if err != nil {
		outR.Close()
		errR.Close()
		return Result{}, spawnError(err, r.Shell)
	}
	pid := process.Pid
	limit := r.StreamBytes
	if limit <= 0 {
		limit = StreamBytes
	}
	stdout, stderr := &collector{limit: limit}, &collector{limit: limit}
	outDone, errDone := drain(outR, stdout), drain(errR, stderr)

	timer := time.NewTimer(time.Duration(setTimeoutMs(req.TimeoutMs) * float64(time.Millisecond)))
	defer timer.Stop()
	killed, timedOut := false, false
	kill := func() {
		if killed {
			return
		}
		killed = true
		if syscall.Kill(-pid, syscall.SIGKILL) != nil {
			_ = syscall.Kill(pid, syscall.SIGKILL)
		}
	}
	var status syscall.WaitStatus
	for exited != nil || outDone != nil || errDone != nil {
		select {
		case status = <-exited:
			exited = nil
		case <-outDone:
			outDone = nil
		case <-errDone:
			errDone = nil
		case <-timer.C:
			timedOut = true
			kill()
		case <-cancel:
			cancel = nil
			kill()
		}
	}
	_ = process.Release()
	code := 1
	switch {
	case killed && timedOut:
		code = 124
	case killed:
		code = 130
	case status.Exited():
		code = status.ExitStatus()
	case status.Signaled():
		code = 128 // the engine's: a signal it didn't send is 128, whichever
	}
	return Result{ExitCode: code, Stdout: stdout.text(), Stderr: stderr.text(), Killed: killed, TimedOut: timedOut}, nil
}

func drain(r *os.File, c *collector) chan struct{} {
	done := make(chan struct{})
	go func() {
		defer close(done)
		defer r.Close()
		_, _ = io.Copy(c, r)
	}()
	return done
}

// collector keeps the head of a stream and counts what it drops.
type collector struct {
	limit   int
	kept    []byte
	dropped int64
}

func (c *collector) Write(p []byte) (int, error) {
	room := c.limit - len(c.kept)
	if room <= 0 {
		c.dropped += int64(len(p))
		return len(p), nil
	}
	if len(p) > room {
		c.kept = append(c.kept, p[:room]...)
		c.dropped += int64(len(p) - room)
		return len(p), nil
	}
	c.kept = append(c.kept, p...)
	return len(p), nil
}

func (c *collector) text() string {
	text := decodeUTF8(c.kept)
	if c.dropped > 0 {
		return fmt.Sprintf("%s\n… [%d bytes dropped]", text, c.dropped)
	}
	return text
}

// reaper waits for every child of this process: the agent is PID 1 in an actor (no init runs
// before it), so it also reaps what a command left behind. It hands a command's status to its
// Exec; it is the only waiter, so nothing else in the process may wait for children.
var reaper = &reaperState{waiting: map[int]chan syscall.WaitStatus{}}

type reaperState struct {
	once    sync.Once
	mu      sync.Mutex
	waiting map[int]chan syscall.WaitStatus
}

func (r *reaperState) start() {
	r.once.Do(func() {
		signals := make(chan os.Signal, 1)
		signal.Notify(signals, syscall.SIGCHLD)
		go func() {
			tick := time.NewTicker(time.Second)
			defer tick.Stop()
			for {
				select {
				case <-signals:
				case <-tick.C:
				}
				r.reap()
			}
		}()
	})
}

// expect registers pid; the caller holds mu from the start of the process, so its status can't
// be reaped before.
func (r *reaperState) expect(pid int) chan syscall.WaitStatus {
	c := make(chan syscall.WaitStatus, 1)
	r.waiting[pid] = c
	return c
}

func (r *reaperState) reap() {
	r.mu.Lock()
	defer r.mu.Unlock()
	for {
		var status syscall.WaitStatus
		pid, err := syscall.Wait4(-1, &status, syscall.WNOHANG, nil)
		if err == syscall.EINTR {
			continue
		}
		if pid <= 0 || err != nil {
			return
		}
		if c, ok := r.waiting[pid]; ok {
			delete(r.waiting, pid)
			c <- status
		}
	}
}

// BaselineFrom is what the engine keeps of its own environment for commands
// (`baselineEnvironment`): PATH, LANG, TZ and LC_*.
func BaselineFrom(environ []string) map[string]string {
	out := map[string]string{}
	for _, kv := range environ {
		k, v, ok := strings.Cut(kv, "=")
		if !ok || k == "NODE_OPTIONS" {
			continue
		}
		if k == "PATH" || k == "LANG" || k == "TZ" || strings.HasPrefix(k, "LC_") {
			out[k] = v
		}
	}
	return out
}

// BaseEnv is a command's environment before the request's (the local backend's `baseEnv`):
// PATH, LANG and TERM defaults, the baseline without NYLORUN_* and *_PROXY, then HOME the
// workspace.
func BaseEnv(baseline map[string]string, workspace string) map[string]string {
	out := map[string]string{"PATH": "/usr/local/bin:/usr/bin:/bin", "LANG": "C.UTF-8", "TERM": "dumb"}
	for k, v := range baseline {
		if strings.HasPrefix(k, "NYLORUN_") || strings.HasSuffix(strings.ToUpper(k), "_PROXY") {
			continue
		}
		out[k] = v
	}
	out["HOME"] = workspace
	return out
}
