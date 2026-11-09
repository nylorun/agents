package substrate

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	ateapi "go.ate.dev/substrate/api/ateapi/v1"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/encoding/protojson"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes/fake"

	"github.com/nylorun/agents/sandboxes/internal/driver"
)

const (
	space = "nylorun-shop"
	ns    = "nylorun-sbx-shop"
	sbx   = "sbx-ub6g5m7mvjlct6r7-g0"
)

func settings() Settings {
	return Settings{Atespace: space, HarnessURL: "https://edge.shop.nylorun.internal:8793", GatesURL: "https://edge.shop.nylorun.internal:8794",
		EdgeHost: "edge.shop.nylorun.internal", EdgePorts: []int{8793, 8794}, EdgeCA: "-----BEGIN CERTIFICATE-----\nx\n-----END CERTIFICATE-----"}
}

func spec(op, mode string) driver.Spec {
	return driver.Spec{OpID: op, Mode: mode, Image: "python:3.13-slim", HarnessImage: "ghcr.io/nylorun/runtime:0.45.0-beta",
		JoinToken: "join-token-1", Env: map[string]string{"NYLORUN_SANDBOX_ID": "local/probe"},
		Network: &driver.SpecNetwork{Preset: "dev", Hosts: []string{"pypi.org"}, Suffixes: []string{".example.com"}}}
}

type rig struct {
	api  *fakeAPI
	kube *fake.Clientset
	res  *fakeResolver
	d    *Driver
	now  time.Time
}

func newRig(t *testing.T) *rig {
	t.Helper()
	r := &rig{api: newFakeAPI(), kube: fake.NewClientset(), res: &fakeResolver{}, now: time.Date(2026, 11, 9, 10, 0, 0, 0, time.UTC)}
	r.api.atespaces[space] = true
	r.d = New(r.api, Options{Settings: settings(), Namespace: ns, Kube: r.kube, Resolver: r.res,
		Now: func() time.Time { return r.now }, PollInterval: 5 * time.Millisecond, CallTimeout: 5 * time.Second})
	return r
}

func (r *rig) wait(t *testing.T, want string) driver.Status {
	t.Helper()
	s, met, err := r.d.Wait(context.Background(), sbx, want, 2*time.Second)
	if err != nil || !met {
		t.Fatalf("wait %s: met=%v err=%v status=%+v", want, met, err, s)
	}
	return s
}

func TestPutCreatesTemplateActorPolicyAndResumes(t *testing.T) {
	r := newRig(t)
	s, err := r.d.Put(context.Background(), sbx, spec("op-1", "Running"))
	if err != nil {
		t.Fatal(err)
	}
	if !s.Exists || s.OpID != "op-1" || s.Volume != "present" {
		t.Fatalf("status after put: %+v", s)
	}
	ready := r.wait(t, "ready")
	if ready.PodUID == "" || ready.PodPhase != "Running" || !strings.Contains(ready.ImageID, "python:3.13-slim@sha256:") {
		t.Fatalf("ready status: %+v", ready)
	}
	actor := r.api.actors[space+"/"+sbx]
	tmpl := r.api.templates[space+"/"+actor.GetActorTemplate().GetName()]
	if tmpl == nil || !strings.HasPrefix(actor.GetActorTemplate().GetName(), sbx+"-t") {
		t.Fatalf("template %q", actor.GetActorTemplate().GetName())
	}
	if joinTokenOf(tmpl) != "join-token-1" {
		t.Fatalf("join token not in the template")
	}
	policy := r.api.policies[space+"/"+sbx]
	raw, _ := protojson.Marshal(policy)
	for _, want := range []string{"edge.shop.nylorun.internal", "pypi.org", "*.example.com", "8793", "8794"} {
		if !strings.Contains(string(raw), want) {
			t.Fatalf("egress policy lacks %s: %s", want, raw)
		}
	}
	cm, err := r.kube.CoreV1().ConfigMaps(ns).Get(context.Background(), sbx+"-state", metav1.GetOptions{})
	if err != nil || cm.Data["opId"] != "op-1" || cm.Data["mode"] != "Running" {
		t.Fatalf("state: %v %v", cm, err)
	}
}

func TestPutRepeatedOpIsNoop(t *testing.T) {
	r := newRig(t)
	if _, err := r.d.Put(context.Background(), sbx, spec("op-1", "Running")); err != nil {
		t.Fatal(err)
	}
	r.wait(t, "ready")
	before := len(r.api.calls)
	if _, err := r.d.Put(context.Background(), sbx, spec("op-1", "Running")); err != nil {
		t.Fatal(err)
	}
	if len(r.api.calls) != before {
		t.Fatalf("a repeated opId called Substrate: %v", r.api.calls[before:])
	}
}

func TestSuspendAndResumeKeepTheUID(t *testing.T) {
	r := newRig(t)
	if _, err := r.d.Put(context.Background(), sbx, spec("op-1", "Running")); err != nil {
		t.Fatal(err)
	}
	first := r.wait(t, "ready")
	resume := spec("op-2", "Suspended")
	resume.JoinToken = ""
	if _, err := r.d.Put(context.Background(), sbx, resume); err != nil {
		t.Fatal(err)
	}
	if s := r.wait(t, "suspended"); s.PodPhase != "" || s.Ready {
		t.Fatalf("suspended status: %+v", s)
	}
	again := spec("op-3", "Running")
	again.JoinToken = ""
	if _, err := r.d.Put(context.Background(), sbx, again); err != nil {
		t.Fatal(err)
	}
	if second := r.wait(t, "ready"); second.PodUID != first.PodUID {
		t.Fatalf("uid changed across a resume: %s -> %s", first.PodUID, second.PodUID)
	}
	// The same spec without a token keeps the template (and so the token).
	names := map[string]bool{}
	for k := range r.api.templates {
		names[k] = true
	}
	if len(names) != 1 {
		t.Fatalf("templates: %v", names)
	}
}

func TestChangedSpecRepointsTheTemplate(t *testing.T) {
	r := newRig(t)
	if _, err := r.d.Put(context.Background(), sbx, spec("op-1", "Running")); err != nil {
		t.Fatal(err)
	}
	r.wait(t, "ready")
	old := r.api.actors[space+"/"+sbx].GetActorTemplate().GetName()
	changed := spec("op-2", "Running")
	changed.JoinToken = ""
	changed.Image = "node:24-slim"
	if _, err := r.d.Put(context.Background(), sbx, changed); err != nil {
		t.Fatal(err)
	}
	r.wait(t, "ready")
	actor := r.api.actors[space+"/"+sbx]
	now := actor.GetActorTemplate().GetName()
	if now == old {
		t.Fatal("the template did not change")
	}
	if joinTokenOf(r.api.templates[space+"/"+now]) != "join-token-1" {
		t.Fatal("the new template lost the join token")
	}
	calls := strings.Join(r.api.calls, "\n")
	if !strings.Contains(calls, "SuspendActor "+sbx+"\nUpdateActor "+sbx+" "+now) {
		t.Fatalf("expected a suspend then a repoint: %s", calls)
	}
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		r.api.mu.Lock()
		_, kept := r.api.templates[space+"/"+old]
		r.api.mu.Unlock()
		if !kept {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("the old template was not deleted")
}

func TestCreateNeedsAJoinToken(t *testing.T) {
	r := newRig(t)
	s := spec("op-1", "Running")
	s.JoinToken = ""
	_, err := r.d.Put(context.Background(), sbx, s)
	var refusal *driver.Error
	if !errors.As(err, &refusal) || refusal.Status != 400 {
		t.Fatalf("err = %v", err)
	}
}

func TestUnresolvableImageIsInvalid(t *testing.T) {
	r := newRig(t)
	r.res.fail = errors.New("MANIFEST_UNKNOWN")
	_, err := r.d.Put(context.Background(), sbx, spec("op-1", "Running"))
	var refusal *driver.Error
	if !errors.As(err, &refusal) || refusal.Code != "invalid_spec" {
		t.Fatalf("err = %v", err)
	}
}

func TestDeleteRemovesActorStateAndTemplate(t *testing.T) {
	r := newRig(t)
	if _, err := r.d.Put(context.Background(), sbx, spec("op-1", "Running")); err != nil {
		t.Fatal(err)
	}
	r.wait(t, "ready")
	s, err := r.d.Delete(context.Background(), sbx)
	if err != nil || !s.Deleting {
		t.Fatalf("delete: %+v %v", s, err)
	}
	r.wait(t, "gone")
	if _, err := r.kube.CoreV1().ConfigMaps(ns).Get(context.Background(), sbx+"-state", metav1.GetOptions{}); err == nil {
		t.Fatal("state kept")
	}
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		r.api.mu.Lock()
		n := len(r.api.templates)
		r.api.mu.Unlock()
		if n == 0 {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if len(r.api.templates) != 0 {
		t.Fatalf("templates left: %d", len(r.api.templates))
	}
	if _, err := r.d.Delete(context.Background(), sbx); err != nil {
		t.Fatalf("deleting a gone sandbox: %v", err)
	}
}

func TestSweepExpiresOrDeletes(t *testing.T) {
	r := newRig(t)
	s := spec("op-1", "Running")
	s.ShutdownTime = r.now.Add(time.Minute).Format(time.RFC3339)
	if _, err := r.d.Put(context.Background(), sbx, s); err != nil {
		t.Fatal(err)
	}
	r.wait(t, "ready")
	r.d.Sweep(context.Background())
	if st, _ := r.d.Status(sbx); st.Expired {
		t.Fatal("expired early")
	}
	r.now = r.now.Add(2 * time.Minute)
	r.d.Sweep(context.Background())
	st := r.wait(t, "expired")
	if !st.Suspended || st.Reason != "SandboxExpired" {
		t.Fatalf("expired status: %+v", st)
	}

	other := "sbx-ub6g5m7mvjlct6r7-g1"
	s2 := spec("op-9", "Running")
	s2.ShutdownTime = r.now.Add(-time.Minute).Format(time.RFC3339)
	s2.ShutdownPolicy = "Delete"
	if _, err := r.d.Put(context.Background(), other, s2); err != nil {
		t.Fatal(err)
	}
	r.d.Sweep(context.Background())
	if _, met, _ := r.d.Wait(context.Background(), other, "gone", 2*time.Second); !met {
		t.Fatal("a Delete policy past its time was not deleted")
	}
}

func TestComputeCrashed(t *testing.T) {
	a := &ateapi.Actor{Metadata: &ateapi.ResourceMetadata{Uid: "u"}, Status: &ateapi.ActorStatus{State: ateapi.ActorState_ACTOR_STATE_CRASHED}}
	s := Compute(sbx, a, &state{Mode: "Running"})
	if s.Ready || s.Reason != "Crashed" || !s.Exists {
		t.Fatalf("%+v", s)
	}
}

func TestPingMarksSynced(t *testing.T) {
	r := newRig(t)
	if r.d.Synced() {
		t.Fatal("synced before a ping")
	}
	if err := r.d.Ping(context.Background()); err != nil || !r.d.Synced() {
		t.Fatalf("ping: %v", err)
	}
	r.d.o.Settings.Atespace = "missing"
	if err := r.d.Ping(context.Background()); err == nil {
		t.Fatal("a missing atespace pinged")
	}
}

func TestTemplateRendersForEachEntrypoint(t *testing.T) {
	images := Resolved{Image: "python@sha256:" + strings.Repeat("a", 64), Harness: "runtime@sha256:" + strings.Repeat("b", 64)}
	for _, entry := range []string{driver.EntrypointEngine, driver.EntrypointBuiltin, driver.EntrypointImage} {
		s := spec("op-1", "Running")
		s.Entrypoint = entry
		if entry != driver.EntrypointEngine {
			s.HarnessImage = ""
		}
		s.Env["NYLORUN_TUNING"] = `{"harness":{"reconnect":{"maxMs":500}},"engine":{"x":1}}`
		if err := s.Normalize(); err != nil {
			t.Fatal(err)
		}
		rendered, err := RenderTemplate(settings(), s, images, "tok")
		if err != nil {
			t.Fatal(entry, err)
		}
		tmpl, err := ToProto(rendered, sbx+"-tx")
		if err != nil {
			t.Fatal(entry, err)
		}
		c := tmpl.GetContainers()[0]
		env := map[string]string{}
		for _, e := range c.GetEnv() {
			env[e.GetName()] = e.GetValue()
		}
		var tuning map[string]any
		if err := json.Unmarshal([]byte(env["NYLORUN_TUNING"]), &tuning); err != nil {
			t.Fatal(err)
		}
		harness := tuning["harness"].(map[string]any)
		if harness["reconnectStopMs"].(float64) != 0 || harness["reconnect"].(map[string]any)["maxMs"].(float64) != 500 ||
			harness["reconnect"].(map[string]any)["minMs"].(float64) != 1 || tuning["engine"] == nil {
			t.Fatalf("%s tuning: %v", entry, tuning)
		}
		if env["RES_OPTIONS"] != ResolverOptions {
			t.Fatalf("%s RES_OPTIONS: %q", entry, env["RES_OPTIONS"])
		}
		if env["NYLORUN_SANDBOX_BLOCKED_PROBE"] != BlockedProbe || env["NYLORUN_JOIN_TOKEN"] != "tok" || env["NYLORUN_EDGE_CA"] == "" {
			t.Fatalf("%s env: %v", entry, env)
		}
		hasImageVolume := false
		for _, v := range tmpl.GetVolumes() {
			if v.GetName() == "nylo" {
				hasImageVolume = true
			}
		}
		command := strings.Join(c.GetCommand(), " ")
		switch entry {
		case driver.EntrypointEngine:
			if !hasImageVolume || !strings.Contains(command, "/nylo/engine/harness.mjs") {
				t.Fatalf("engine: volume=%v command=%s", hasImageVolume, command)
			}
		case driver.EntrypointBuiltin:
			if hasImageVolume || !strings.Contains(command, "/opt/nylorun/engine/harness.mjs") {
				t.Fatalf("builtin: volume=%v command=%s", hasImageVolume, command)
			}
		case driver.EntrypointImage:
			if hasImageVolume || len(c.GetCommand()) != 0 {
				t.Fatalf("image: volume=%v command=%s", hasImageVolume, command)
			}
		}
	}
}

func TestEgressPolicyOpenAndClosed(t *testing.T) {
	open, err := EgressPolicy(settings(), Network{Open: true})
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := protojson.Marshal(open)
	if !strings.Contains(string(raw), `"*"`) {
		t.Fatalf("open: %s", raw)
	}
	closed, err := EgressPolicy(settings(), Network{})
	if err != nil {
		t.Fatal(err)
	}
	if n := len(closed.GetRules()); n != 1 {
		t.Fatalf("a network with no hosts allows only the edge: %d rules", n)
	}
}

func TestTemplateNameFollowsTheSpec(t *testing.T) {
	a, _ := TemplateName(sbx, map[string]any{"x": 1})
	b, _ := TemplateName(sbx, map[string]any{"x": 1})
	c, _ := TemplateName(sbx, map[string]any{"x": 2})
	if a != b || a == c || len(a) > 63 {
		t.Fatalf("%s %s %s", a, b, c)
	}
}

func TestTemplateKeepsTheAgentsResolverOptions(t *testing.T) {
	s := spec("op-1", "Running")
	s.Env["RES_OPTIONS"] = "timeout:2"
	if err := s.Normalize(); err != nil {
		t.Fatal(err)
	}
	images := Resolved{Image: "python@sha256:" + strings.Repeat("a", 64), Harness: "runtime@sha256:" + strings.Repeat("b", 64)}
	rendered, err := RenderTemplate(settings(), s, images, "tok")
	if err != nil {
		t.Fatal(err)
	}
	tmpl, err := ToProto(rendered, sbx+"-tx")
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range tmpl.GetContainers()[0].GetEnv() {
		if e.GetName() == "RES_OPTIONS" && e.GetValue() != "timeout:2" {
			t.Fatalf("RES_OPTIONS = %q, want the Agent's", e.GetValue())
		}
	}
}

func resumeFailures(r *rig) int {
	r.api.mu.Lock()
	defer r.api.mu.Unlock()
	n := 0
	for _, c := range r.api.calls {
		if c == "ResumeActor failed" {
			n++
		}
	}
	return n
}

func TestResumeIsTriedAgainAfterATimeout(t *testing.T) {
	r := newRig(t)
	r.d.o.RetryWait = time.Millisecond
	r.api.mu.Lock()
	r.api.failResume, r.api.failResumeTimes = status.Error(codes.DeadlineExceeded, "context deadline exceeded"), 2
	r.api.mu.Unlock()
	if _, err := r.d.Put(context.Background(), sbx, spec("op-1", "Running")); err != nil {
		t.Fatal(err)
	}
	r.wait(t, "ready")
	if n := resumeFailures(r); n != 2 {
		t.Fatalf("failed resumes: %d, want 2", n)
	}
}

func TestResumeIsNotTriedAgainAfterAPermanentError(t *testing.T) {
	r := newRig(t)
	r.d.o.RetryWait = time.Millisecond
	r.api.mu.Lock()
	r.api.failResume, r.api.failResumeTimes = status.Error(codes.InvalidArgument, "bad"), -1
	r.api.mu.Unlock()
	if _, err := r.d.Put(context.Background(), sbx, spec("op-1", "Running")); err != nil {
		t.Fatal(err)
	}
	time.Sleep(100 * time.Millisecond)
	if n := resumeFailures(r); n != 1 {
		t.Fatalf("failed resumes: %d, want 1", n)
	}
}

func TestResumeStopsWhenTheModeChanges(t *testing.T) {
	r := newRig(t)
	r.d.o.RetryWait = 5 * time.Millisecond
	r.api.mu.Lock()
	r.api.failResume, r.api.failResumeTimes = status.Error(codes.Unavailable, "busy"), -1
	r.api.mu.Unlock()
	if _, err := r.d.Put(context.Background(), sbx, spec("op-1", "Running")); err != nil {
		t.Fatal(err)
	}
	time.Sleep(30 * time.Millisecond)
	if _, err := r.d.Put(context.Background(), sbx, spec("op-2", "Suspended")); err != nil {
		t.Fatal(err)
	}
	time.Sleep(30 * time.Millisecond)
	before := resumeFailures(r)
	time.Sleep(50 * time.Millisecond)
	if after := resumeFailures(r); after != before {
		t.Fatalf("resumed again after the mode changed: %d -> %d", before, after)
	}
}
