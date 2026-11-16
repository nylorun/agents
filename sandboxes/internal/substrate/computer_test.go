package substrate

import (
	"context"
	"strings"
	"testing"

	"google.golang.org/protobuf/encoding/protojson"

	"github.com/nylorun/agents/sandboxes/internal/driver"
)

func computerSettings() Settings {
	return Settings{Atespace: space, ComputerPort: 8080, TicketKey: "-----BEGIN PUBLIC KEY-----\nx\n-----END PUBLIC KEY-----\n"}
}

func TestComputerTemplateRunsTheEngineWithoutAJoin(t *testing.T) {
	s := spec("op-1", "Running")
	s.JoinToken = ""
	s.Entrypoint = driver.EntrypointEngine
	rendered, err := RenderTemplate(computerSettings(), s, Resolved{Image: "python@sha256:1", Harness: "runtime@sha256:2"}, "")
	if err != nil {
		t.Fatal(err)
	}
	tmpl, err := ToProto(rendered, "t")
	if err != nil {
		t.Fatal(err)
	}
	c := tmpl.GetContainers()[0]
	cmd := strings.Join(c.GetCommand(), " ")
	if !strings.HasSuffix(cmd, "--service computer") || strings.Contains(cmd, "JOIN") {
		t.Fatalf("command %q", cmd)
	}
	probe := c.GetWakeupProbe().GetHttpGet()
	if probe.GetPath() != "/ready" || probe.GetPort() != 8080 {
		t.Fatalf("wake-up probe %+v", probe)
	}
	env := map[string]string{}
	for _, e := range c.GetEnv() {
		env[e.GetName()] = e.GetValue()
	}
	if env["NYLORUN_COMPUTER_PORT"] != "8080" || !strings.Contains(env["NYLORUN_COMPUTER_TICKET_KEY"], "PUBLIC KEY") {
		t.Fatalf("env %v", env)
	}
	for _, gone := range []string{"NYLORUN_JOIN_TOKEN", "NYLORUN_HARNESS_URL", "NYLORUN_EDGE_CA", "NYLORUN_TUNING"} {
		if _, ok := env[gone]; ok {
			t.Fatalf("a computer's template has %s", gone)
		}
	}
	s.Entrypoint = driver.EntrypointImage
	if _, err := RenderTemplate(computerSettings(), s, Resolved{Image: "x@sha256:1"}, ""); err == nil {
		t.Fatal("an image entrypoint rendered as a computer")
	}
}

// An image that runs as a user other than root (ghcr.io/nylorun/dev runs as 1000:1000) can't make
// /skills at the root: both templates mount it, as the pods driver does, so the wrapper's mkdir
// finds it there.
func TestTemplatesMountSkills(t *testing.T) {
	for _, computer := range []bool{true, false} {
		settings := Settings{Atespace: "a"}
		if computer {
			settings = computerSettings()
		}
		s := spec("op-1", "Running")
		s.Entrypoint = driver.EntrypointEngine
		rendered, err := RenderTemplate(settings, s, Resolved{Image: "ghcr.io/nylorun/dev@sha256:1", Harness: "runtime@sha256:2"}, "")
		if err != nil {
			t.Fatal(err)
		}
		tmpl, err := ToProto(rendered, "t")
		if err != nil {
			t.Fatal(err)
		}
		mounted := false
		for _, m := range tmpl.GetContainers()[0].GetVolumeMounts() {
			if m.GetMountPath() == "/skills" && m.GetName() == "skills" {
				mounted = true
			}
		}
		durable := false
		for _, v := range tmpl.GetVolumes() {
			if v.GetName() == "skills" && v.GetDurableDir() != nil {
				durable = true
			}
		}
		if !mounted || !durable {
			t.Fatalf("computer=%v: /skills mounted %v, a durable-dir volume %v", computer, mounted, durable)
		}
	}
}

func TestComputerEgressHasNoEdge(t *testing.T) {
	p, err := EgressPolicy(computerSettings(), Network{Hosts: []string{"pypi.org"}}, nil)
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := protojson.Marshal(p)
	if !strings.Contains(string(raw), "pypi.org") || strings.Contains(string(raw), "edge") {
		t.Fatalf("policy %s", raw)
	}
	none, err := EgressPolicy(computerSettings(), Network{}, nil)
	if err != nil || len(none.GetRules()) != 0 {
		t.Fatalf("no network: %v %v", none, err)
	}
}

func TestComputerCreateNeedsNoJoinToken(t *testing.T) {
	r := newRig(t)
	r.d.o.Settings = computerSettings()
	s := spec("op-1", "Running")
	s.JoinToken = ""
	if _, err := r.d.Put(context.Background(), sbx, s); err != nil {
		t.Fatal(err)
	}
	r.wait(t, "ready")
}
