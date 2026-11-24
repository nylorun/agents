// Package computer is the computer agent: what runs in an Agent Substrate
// actor that is a computer, in place of the engine's `--service computer`
// (runtime/server/src/harness/computer.ts). It serves the same routes with the same tickets and
// the same answers, which the contract test (testdata/contract.json) holds both to:
//
//   - GET /ready (no ticket: the template's wake-up probe) is 200 while the workspace is writable;
//   - every other route needs X-Nylorun-Ticket, a compact JWS core signs with Ed25519, with aud
//     nylorun-computer, sub this actor's name and exp ahead (401 unauthorized);
//   - GET /v1/info; POST /v1/exec starts command id, or joins it while it runs, and answers within
//     waitMs (at most 50 s) running or done; POST /v1/exec/{id}/attach waits again, and
//     /v1/exec/{id}/cancel kills it (130); a result is kept 10 minutes after the command ends;
//   - GET and PUT /v1/files?path= (maxBytes: 413 too_large), GET /v1/list?dir=&maxEntries=;
//   - POST /v1/disk: one operation of core's disk versions on the computer's own disk, its
//     workspace and HarnessRoot (disk.go): list, read, clear or put.
//
// Where the engine's answer comes from JavaScript (Number(), JSON.parse, Node's fs errors), the
// agent gives the same where it can; a JSON syntax error's message is Go's.
package computer

import (
	"bytes"
	"crypto/ed25519"
	"encoding/json"
	"errors"
	"io"
	"math"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"sync"
	"syscall"
	"time"
	"unicode/utf8"

	"github.com/nylorun/agents/sandboxes/internal/ticket"
)

// Version is the agent's version, its protocol's (`-ldflags -X …/computer.Version=1.0`).
var Version = "dev"

// MaxWait is the longest a start or an attach waits before it answers running.
const MaxWait = 50 * time.Second

// Keep is how long a command's result is kept after it ends.
const Keep = 10 * time.Minute

// Workspace is a computer's workspace.
const Workspace = "/workspace"

// Options configure the routes.
type Options struct {
	// Workspace is where commands run by default (Workspace).
	Workspace string
	// HarnessRoot, when set, is a disk root beside the workspace (/harness): /v1/info reports it,
	// and /v1/disk lists, clears and writes it.
	HarnessRoot string
	// Public is the ticket key's public half.
	Public ed25519.PublicKey
	// Name is this actor's name, every ticket's sub.
	Name string
	// Runner runs the commands.
	Runner *Runner
	// Ready reports whether the workspace is writable; default, access(2) W_OK on it.
	Ready func() bool
	// Now is the clock; default time.Now.
	Now func() time.Time
}

// Server is the computer's HTTP handler.
type Server struct {
	o        Options
	commands *Commands
}

// New is the routes on o.
func New(o Options) *Server {
	if o.Workspace == "" {
		o.Workspace = Workspace
	}
	if o.Now == nil {
		o.Now = time.Now
	}
	if o.Ready == nil {
		workspace := o.Workspace
		o.Ready = func() bool { return syscall.Access(workspace, 2 /* W_OK */) == nil }
	}
	return &Server{o: o, commands: NewCommands(o.Runner.Exec, o.Now)}
}

var commandRoute = regexp.MustCompile(`^/v1/exec/([^/]+)/(attach|cancel)$`)

type failure struct {
	status        int
	code, message string
}

func (f *failure) Error() string { return f.message }

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if err := s.serve(w, r); err != nil {
		var f *failure
		var tooLarge *TooLargeError
		switch {
		case errors.As(err, &f):
			fail(w, f.status, f.code, f.message)
		case errors.As(err, &tooLarge):
			fail(w, http.StatusRequestEntityTooLarge, "too_large", tooLarge.Error())
		default:
			fail(w, http.StatusInternalServerError, "computer_error", err.Error())
		}
	}
}

func (s *Server) serve(w http.ResponseWriter, r *http.Request) error {
	pathname := r.URL.EscapedPath()
	if r.Method == http.MethodGet && pathname == "/ready" {
		if s.o.Ready() {
			send(w, http.StatusOK, map[string]any{"status": "ok", "version": Version})
		} else {
			fail(w, http.StatusServiceUnavailable, "not_ready", s.o.Workspace+" is not writable")
		}
		return nil
	}
	token := ""
	if values := r.Header.Values("X-Nylorun-Ticket"); len(values) > 0 {
		token = values[0]
		for _, v := range values[1:] {
			token += ", " + v // as Node joins a repeated header
		}
	}
	if reason := ticket.Check(token, s.o.Public, s.o.Name, s.o.Now()); reason != "" {
		return &failure{http.StatusUnauthorized, "unauthorized", "Ticket refused: " + reason}
	}
	query := r.URL.Query()
	if r.Method == http.MethodGet && pathname == "/v1/info" {
		roots := map[string]string{"workspace": s.o.Workspace}
		if s.o.HarnessRoot != "" {
			roots["harness"] = s.o.HarnessRoot
		}
		send(w, http.StatusOK, info{Workspace: s.o.Workspace, DiskRoots: roots, Version: Version})
		return nil
	}
	if r.Method == http.MethodPost && pathname == "/v1/exec" {
		body, err := readJSON(r.Body)
		if err != nil {
			return err
		}
		if body == nil {
			return errors.New("Cannot read properties of null (reading 'id')")
		}
		fields, _ := body.(map[string]any)
		id, okID := fields["id"].(string)
		command, okCommand := fields["command"].(string)
		timeoutMs, okTimeout := fields["timeoutMs"].(float64)
		if !okID || !okCommand || !okTimeout {
			return &failure{http.StatusBadRequest, "invalid_request", "id, command and timeoutMs are required"}
		}
		request := ExecRequest{Command: command, TimeoutMs: timeoutMs, Cwd: s.o.Workspace}
		if cwd := fields["cwd"]; truthy(cwd) {
			request.Cwd = jsStringOf(cwd)
		}
		if env, ok := fields["env"].(map[string]any); ok {
			request.Env = map[string]string{}
			for k, v := range env {
				request.Env[k] = jsStringOf(v)
			}
		}
		wait, present := fields["waitMs"]
		send(w, http.StatusOK, s.commands.Start(id, request, waitOf(wait, present)))
		return nil
	}
	if m := commandRoute.FindStringSubmatch(pathname); r.Method == http.MethodPost && m != nil {
		id, err := url.PathUnescape(m[1])
		if err != nil || !utf8.ValidString(id) {
			return errors.New("URI malformed")
		}
		if m[2] == "cancel" {
			status := http.StatusOK
			if !s.commands.Cancel(id) {
				status = http.StatusNotFound
			}
			send(w, status, map[string]bool{"cancelled": true})
			return nil
		}
		body, err := readJSON(r.Body)
		if err != nil {
			return err
		}
		if body == nil {
			return errors.New("Cannot destructure property 'waitMs' of '(intermediate value)' as it is null.")
		}
		var wait any
		present := false
		if fields, ok := body.(map[string]any); ok {
			wait, present = fields["waitMs"]
		}
		answer, known := s.commands.Attach(id, waitOf(wait, present))
		if !known {
			return &failure{http.StatusNotFound, "unknown_command", "This computer doesn't know command " + id}
		}
		send(w, http.StatusOK, answer)
		return nil
	}
	if pathname == "/v1/files" {
		file := query.Get("path")
		if len(file) == 0 || file[0] != '/' {
			return &failure{http.StatusBadRequest, "invalid_request", "path must be absolute"}
		}
		switch r.Method {
		case http.MethodGet:
			raw := "0"
			if query.Has("maxBytes") {
				raw = query.Get("maxBytes")
			}
			max := jsNumber(raw)
			if max == 0 || math.IsNaN(max) {
				max = 9007199254740991 // Number.MAX_SAFE_INTEGER: no limit
			}
			content, err := readBytes(file, max)
			if err != nil {
				return err
			}
			if content == nil {
				return &failure{http.StatusNotFound, "not_found", file + " does not exist"}
			}
			w.Header().Set("Content-Type", "application/octet-stream")
			w.Header().Set("Content-Length", strconv.Itoa(len(content)))
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write(content)
			return nil
		case http.MethodPut:
			if err := writeFile(file, r.Body); err != nil {
				return err
			}
			send(w, http.StatusOK, map[string]bool{"written": true})
			return nil
		}
	}
	if r.Method == http.MethodPost && pathname == "/v1/disk" {
		return s.serveDisk(w, r)
	}
	if r.Method == http.MethodGet && pathname == "/v1/list" {
		dir := query.Get("dir")
		max := 10000.0
		if query.Has("maxEntries") {
			max = jsNumber(query.Get("maxEntries"))
		}
		listed, err := listFiles(dir, max)
		if err != nil {
			return err
		}
		if listed == nil {
			return &failure{http.StatusNotFound, "not_found", dir + " is not a directory"}
		}
		send(w, http.StatusOK, listed)
		return nil
	}
	return &failure{http.StatusNotFound, "not_found", "No route " + r.Method + " " + pathname}
}

type info struct {
	Workspace string            `json:"workspace"`
	DiskRoots map[string]string `json:"diskRoots"`
	Version   string            `json:"version"`
}

// waitOf is how long an answer may wait: the engine's Math.max(0, Math.min(waitMs, 50 s)), with
// a missing waitMs the full 50 s.
func waitOf(raw any, present bool) time.Duration {
	if !present {
		return MaxWait
	}
	ms := jsNumberOf(raw)
	if math.IsNaN(ms) || ms < 0 {
		ms = 0
	}
	ms = math.Min(ms, float64(MaxWait/time.Millisecond))
	return time.Duration(ms * float64(time.Millisecond))
}

// truthy is JavaScript's truthiness of a JSON value.
func truthy(v any) bool {
	switch x := v.(type) {
	case nil:
		return false
	case bool:
		return x
	case string:
		return x != ""
	case float64:
		return x != 0 && !math.IsNaN(x)
	}
	return true
}

// readJSON is the engine's body(): {} for an empty body, else the JSON it holds.
func readJSON(body io.Reader) (any, error) {
	raw, err := io.ReadAll(body)
	if err != nil {
		return nil, err
	}
	if len(raw) == 0 {
		return map[string]any{}, nil
	}
	var v any
	if err := json.Unmarshal(raw, &v); err != nil {
		return nil, err
	}
	return v, nil
}

func send(w http.ResponseWriter, status int, value any) {
	raw, err := marshal(value)
	if err != nil {
		status, raw = http.StatusInternalServerError, []byte(`{"error":{"code":"computer_error","message":"encoding the answer failed"}}`)
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = w.Write(raw)
}

// marshal is JSON.stringify's text where Go's would differ: no HTML escaping, no newline.
func marshal(value any) ([]byte, error) {
	var out bytes.Buffer
	encoder := json.NewEncoder(&out)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(value); err != nil {
		return nil, err
	}
	return bytes.TrimSuffix(out.Bytes(), []byte("\n")), nil
}

func fail(w http.ResponseWriter, status int, code, message string) {
	send(w, status, map[string]any{"error": map[string]string{"code": code, "message": message}})
}

// Answer is what a start or an attach answers.
type Answer struct {
	State   string  `json:"state"`
	Result  *Result `json:"result,omitempty"`
	Message *string `json:"message,omitempty"`
}

// Commands are the commands a computer runs, by id: start, join, attach, cancel.
type Commands struct {
	run func(ExecRequest, <-chan struct{}) (Result, error)
	now func() time.Time

	mu       sync.Mutex
	commands map[string]*command
}

type command struct {
	done      chan struct{}
	cancel    chan struct{}
	cancelled sync.Once
	// Set before done closes.
	result  *Result
	err     string
	endedAt time.Time
}

// NewCommands keeps the commands run starts.
func NewCommands(run func(ExecRequest, <-chan struct{}) (Result, error), now func() time.Time) *Commands {
	return &Commands{run: run, now: now, commands: map[string]*command{}}
}

// Start runs the command id, or joins the one it names, and waits up to wait for it.
func (c *Commands) Start(id string, request ExecRequest, wait time.Duration) Answer {
	c.mu.Lock()
	c.prune()
	cmd, ok := c.commands[id]
	if !ok {
		cmd = &command{done: make(chan struct{}), cancel: make(chan struct{})}
		c.commands[id] = cmd
		go func() {
			result, err := c.run(request, cmd.cancel)
			c.mu.Lock()
			if err != nil {
				cmd.err = err.Error()
			} else {
				cmd.result = &result
			}
			cmd.endedAt = c.now()
			c.mu.Unlock()
			close(cmd.done)
		}()
	}
	c.mu.Unlock()
	return c.wait(cmd, wait)
}

// Attach waits up to wait for command id; false when the computer doesn't know it.
func (c *Commands) Attach(id string, wait time.Duration) (Answer, bool) {
	c.mu.Lock()
	cmd, ok := c.commands[id]
	c.mu.Unlock()
	if !ok {
		return Answer{}, false
	}
	return c.wait(cmd, wait), true
}

// Cancel kills command id; false when the computer doesn't know it.
func (c *Commands) Cancel(id string) bool {
	c.mu.Lock()
	cmd, ok := c.commands[id]
	c.mu.Unlock()
	if ok {
		cmd.cancelled.Do(func() { close(cmd.cancel) })
	}
	return ok
}

func (c *Commands) wait(cmd *command, wait time.Duration) Answer {
	timer := time.NewTimer(wait)
	defer timer.Stop()
	select {
	case <-cmd.done:
	case <-timer.C:
	}
	select {
	case <-cmd.done:
		if cmd.result != nil {
			return Answer{State: "done", Result: cmd.result}
		}
		message := cmd.err
		return Answer{State: "failed", Message: &message}
	default:
		return Answer{State: "running"}
	}
}

// prune drops the commands that ended more than Keep ago; the caller holds mu.
func (c *Commands) prune() {
	now := c.now()
	for id, cmd := range c.commands {
		select {
		case <-cmd.done:
			if now.Sub(cmd.endedAt) > Keep {
				delete(c.commands, id)
			}
		default:
		}
	}
}
