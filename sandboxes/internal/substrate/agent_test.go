package substrate

import (
	"context"
	"encoding/json"
	"flag"
	"os"
	"path/filepath"
	"strings"
	"testing"

	ateapi "go.ate.dev/substrate/api/ateapi/v1"

	"github.com/nylorun/agents/sandboxes/internal/driver"
)

var update = flag.Bool("update", false, "rewrite the golden files")

const agentImage = "ghcr.io/nylorun/computer:1.0"

// agentSettings are computers that run the computer agent (ADR-154 decision 4).
func agentSettings() Settings {
	s := computerSettings()
	s.ComputerAgent, s.ComputerImage = AgentGo, agentImage
	return s
}

func computerSpec(op, mode string) driver.Spec {
	s := spec(op, mode)
	s.JoinToken = ""
	s.Entrypoint = driver.EntrypointEngine
	return s
}

func TestComputerAgentTemplateGolden(t *testing.T) {
	s := computerSpec("op-1", "Running")
	if err := s.Normalize(); err != nil {
		t.Fatal(err)
	}
	rendered, err := RenderTemplate(agentSettings(), s,
		Resolved{Image: "python@sha256:" + strings.Repeat("1", 64), Computer: "ghcr.io/nylorun/computer@sha256:" + strings.Repeat("2", 64)}, "")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := ToProto(rendered, "t"); err != nil {
		t.Fatal(err)
	}
	got, err := json.MarshalIndent(rendered, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	golden := filepath.Join("testdata", "computer-agent.golden.json")
	if *update {
		if err := os.MkdirAll("testdata", 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(golden, append(got, '\n'), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	want, err := os.ReadFile(golden)
	if err != nil {
		t.Fatal(err)
	}
	if strings.TrimSpace(string(want)) != string(got) {
		t.Fatalf("rendered template differs from %s (go test ./... -update):\n%s", golden, got)
	}
}

// The agent changes the command and the nylo volume's image, and nothing else: the volumes, the
// mounts, the environment and the wake-up probe are the engine's.
func TestComputerAgentReplacesOnlyTheEngine(t *testing.T) {
	s := computerSpec("op-1", "Running")
	images := Resolved{Image: "python@sha256:1", Harness: "runtime@sha256:2", Computer: "computer@sha256:3"}
	engineRendered, err := RenderTemplate(computerSettings(), s, images, "")
	if err != nil {
		t.Fatal(err)
	}
	agentRendered, err := RenderTemplate(agentSettings(), s, images, "")
	if err != nil {
		t.Fatal(err)
	}
	engine, _ := ToProto(engineRendered, "t")
	agent, _ := ToProto(agentRendered, "t")
	if EngineReference(engine) != "runtime@sha256:2" || RunsAgent(engine) {
		t.Fatalf("engine template: %s, runs the agent %v", EngineReference(engine), RunsAgent(engine))
	}
	if EngineReference(agent) != "computer@sha256:3" || !RunsAgent(agent) {
		t.Fatalf("agent template: %s, runs the agent %v", EngineReference(agent), RunsAgent(agent))
	}
	e, a := engine.GetContainers()[0], agent.GetContainers()[0]
	if got := strings.Join(a.GetCommand(), " "); got != "/nylo/computer" {
		t.Fatalf("command %q", got)
	}
	if !strings.Contains(strings.Join(e.GetCommand(), " "), "--service computer") {
		t.Fatalf("the engine's command changed: %v", e.GetCommand())
	}
	same := func(what string, x, y any) {
		t.Helper()
		rx, _ := json.Marshal(x)
		ry, _ := json.Marshal(y)
		if string(rx) != string(ry) {
			t.Fatalf("%s differ:\n%s\n%s", what, rx, ry)
		}
	}
	same("env", e.GetEnv(), a.GetEnv())
	same("mounts", e.GetVolumeMounts(), a.GetVolumeMounts())
	same("probe", e.GetWakeupProbe(), a.GetWakeupProbe())
	if RepointRefusal(engine, agent) != "its volumes would change (changes nylo)" {
		t.Fatalf("refusal %q", RepointRefusal(engine, agent))
	}

	// builtin keeps the image's own engine, and a diagnostic command is left alone.
	builtin := s
	builtin.Entrypoint, builtin.HarnessImage = driver.EntrypointBuiltin, ""
	if r, err := RenderTemplate(agentSettings(), builtin, Resolved{Image: "x@sha256:1"}, ""); err != nil || RunsAgent(mustProto(t, r)) {
		t.Fatalf("builtin: %v", err)
	}
	command := s
	command.Command = []string{"sleep", "60"}
	if r, err := RenderTemplate(agentSettings(), command, Resolved{Image: "x@sha256:1"}, ""); err != nil || RunsAgent(mustProto(t, r)) {
		t.Fatalf("command: %v", err)
	}
	none := agentSettings()
	none.ComputerImage = ""
	if _, err := RenderTemplate(none, s, Resolved{Image: "x@sha256:1"}, ""); err == nil {
		t.Fatal("rendered the agent without its image")
	}
	// Settings without computers ignore the agent.
	notComputer := settings()
	notComputer.ComputerAgent, notComputer.ComputerImage = AgentGo, agentImage
	if notComputer.ComputerAgentGo() {
		t.Fatal("the agent without computers")
	}
}

func mustProto(t *testing.T, rendered map[string]any) *ateapi.ActorTemplate {
	t.Helper()
	p, err := ToProto(rendered, "t")
	if err != nil {
		t.Fatal(err)
	}
	return p
}

func TestComputerAgentPutMountsTheAgentNotTheRuntime(t *testing.T) {
	r := newRig(t)
	r.d.o.Settings = agentSettings()
	if _, err := r.d.Put(context.Background(), sbx, computerSpec("op-1", "Running")); err != nil {
		t.Fatal(err)
	}
	r.wait(t, "ready")
	tmpl := r.actorTemplate()
	if !RunsAgent(tmpl) || !strings.HasPrefix(EngineReference(tmpl), agentImage+"@sha256:") {
		t.Fatalf("template mounts %q", EngineReference(tmpl))
	}
	for _, ref := range r.res.refs {
		if strings.Contains(ref, "nylorun/runtime") {
			t.Fatalf("resolved the Runtime image %s for the agent", ref)
		}
	}
}

// A new agent image, like a Runtime upgrade for the engine, leaves an existing computer on the one
// it has: no repoint, no new volume.
func TestComputerAgentUpgradeKeepsTheActorsAgent(t *testing.T) {
	r := newRig(t)
	r.d.o.Settings = agentSettings()
	if _, err := r.d.Put(context.Background(), sbx, computerSpec("op-1", "Running")); err != nil {
		t.Fatal(err)
	}
	r.wait(t, "ready")
	uid, before := r.actorUID(), r.actorTemplate()
	r.d.o.Settings.ComputerImage = "ghcr.io/nylorun/computer:1.1"
	s, err := r.d.Put(context.Background(), sbx, computerSpec("op-2", "Running"))
	if err != nil || s.Reason != "" {
		t.Fatalf("put: %+v %v", s, err)
	}
	r.wait(t, "ready")
	after := r.actorTemplate()
	if r.actorUID() != uid || after.GetMetadata().GetName() != before.GetMetadata().GetName() {
		t.Fatalf("template %s, was %s", after.GetMetadata().GetName(), before.GetMetadata().GetName())
	}
}

// Moving a computer from the engine to the agent changes its nylo volume: Substrate can't repoint
// it, so the sandbox reports RepointRefused and the Runtime gives it a new volume from its latest
// disk version.
func TestComputerMovingToTheAgentIsRefused(t *testing.T) {
	r := newRig(t)
	r.d.o.Settings = computerSettings()
	if _, err := r.d.Put(context.Background(), sbx, computerSpec("op-1", "Running")); err != nil {
		t.Fatal(err)
	}
	r.wait(t, "ready")
	if RunsAgent(r.actorTemplate()) {
		t.Fatal("the engine's computer runs the agent")
	}
	r.d.o.Settings = agentSettings()
	s, err := r.d.Put(context.Background(), sbx, computerSpec("op-2", "Running"))
	if err != nil {
		t.Fatal(err)
	}
	if s.Ready || s.Reason != RepointRefused || !strings.Contains(s.Message, "changes nylo") {
		t.Fatalf("status: %+v", s)
	}
}
