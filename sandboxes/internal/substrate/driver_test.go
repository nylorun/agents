package substrate

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
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

func TestComputeCrashed(t *testing.T) {
	a := &ateapi.Actor{Metadata: &ateapi.ResourceMetadata{Uid: "u"}, Status: &ateapi.ActorStatus{State: ateapi.ActorState_ACTOR_STATE_CRASHED,
		Crash: &ateapi.ActorCrash{Message: "worker pod went away while hosting the actor"}}}
	s := Compute(sbx, a, &state{Mode: "Running"})
	if s.Ready || s.Reason != "Crashed" || !s.Exists || s.Message != "worker pod went away while hosting the actor" || s.PodPhase != "" {
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
		if _, ok := env["RES_OPTIONS"]; ok {
			t.Fatalf("%s sets RES_OPTIONS: the Agent's resolver is its own", entry)
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
	open, err := EgressPolicy(settings(), Network{Open: true}, nil)
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := protojson.Marshal(open)
	if !strings.Contains(string(raw), `"*"`) {
		t.Fatalf("open: %s", raw)
	}
	closed, err := EgressPolicy(settings(), Network{}, nil)
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

func TestResumeIsTriedAgainWhileSubstrateIsBusy(t *testing.T) {
	r := newRig(t)
	r.d.o.RetryWait = time.Millisecond
	r.api.mu.Lock()
	r.api.failResume, r.api.failResumeTimes = status.Error(codes.Unavailable, "busy"), 2
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

func TestTemplatePinsTheEdgeOnlyForAnAddress(t *testing.T) {
	images := Resolved{Image: "python@sha256:" + strings.Repeat("a", 64), Harness: "runtime@sha256:" + strings.Repeat("b", 64)}
	for _, tc := range []struct{ address, want string }{{"192.168.65.254", "192.168.65.254"}, {"", ""}, {"not-an-ip", ""}} {
		s := settings()
		s.EdgeAddress = tc.address
		sp := spec("op-1", "Running")
		if err := sp.Normalize(); err != nil {
			t.Fatal(err)
		}
		rendered, err := RenderTemplate(s, sp, images, "tok")
		if err != nil {
			t.Fatal(err)
		}
		tmpl, err := ToProto(rendered, sbx+"-tx")
		if err != nil {
			t.Fatal(err)
		}
		env := map[string]string{}
		for _, e := range tmpl.GetContainers()[0].GetEnv() {
			env[e.GetName()] = e.GetValue()
		}
		if env["NYLORUN_EDGE_ADDRESS"] != tc.want {
			t.Fatalf("address %q: NYLORUN_EDGE_ADDRESS = %q, want %q", tc.address, env["NYLORUN_EDGE_ADDRESS"], tc.want)
		}
		if tc.want != "" && env["NYLORUN_EDGE_HOST"] != s.EdgeHost {
			t.Fatalf("NYLORUN_EDGE_HOST = %q", env["NYLORUN_EDGE_HOST"])
		}
	}
}

// The wrapper itself, run by sh with its absolute paths moved into a temp directory: it pins the
// edge in a writable hosts file, and leaves an unwritable one alone without failing.
func TestWrapperPinsTheEdgeInHosts(t *testing.T) {
	sh, err := exec.LookPath("sh")
	if err != nil {
		t.Skip("no sh")
	}
	for _, writable := range []bool{true, false} {
		dir := t.TempDir()
		script := wrapper
		for _, p := range []string{"/etc/hosts", InfoDir, TrustDir, JoinFile, CAFile, "/harness/home", "/workspace", "/skills"} {
			script = strings.ReplaceAll(script, p, filepath.Join(dir, p))
		}
		hosts := filepath.Join(dir, "/etc/hosts")
		if err := os.MkdirAll(filepath.Dir(hosts), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(hosts, []byte("127.0.0.1 localhost\n"), 0o644); err != nil {
			t.Fatal(err)
		}
		if !writable {
			if err := os.Chmod(hosts, 0o444); err != nil {
				t.Fatal(err)
			}
		}
		for _, d := range []string{InfoDir, filepath.Dir(JoinFile)} {
			if err := os.MkdirAll(filepath.Join(dir, d), 0o755); err != nil {
				t.Fatal(err)
			}
		}
		if err := os.WriteFile(filepath.Join(dir, InfoDir, "actor-uid"), []byte("uid-1"), 0o644); err != nil {
			t.Fatal(err)
		}
		cmd := exec.Command(sh, "-c", script, "nylorun-engine", "true")
		cmd.Env = []string{"PATH=" + os.Getenv("PATH"), "NYLORUN_EDGE_ADDRESS=192.168.65.254", "NYLORUN_EDGE_HOST=edge.shop.nylorun.internal"}
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("writable=%v: wrapper failed: %v\n%s", writable, err, out)
		}
		got, err := os.ReadFile(hosts)
		if err != nil {
			t.Fatal(err)
		}
		pinned := strings.Contains(string(got), "192.168.65.254 edge.shop.nylorun.internal\n")
		if os.Geteuid() == 0 && !writable {
			continue // root writes a read-only file anyway
		}
		if pinned != writable {
			t.Fatalf("writable=%v: hosts = %q", writable, got)
		}
	}
}

func TestResumeWaitsForASuspendInFlight(t *testing.T) {
	r := newRig(t)
	r.d.o.RetryWait = time.Millisecond
	if _, err := r.d.Put(context.Background(), sbx, spec("op-1", "Suspended")); err != nil {
		t.Fatal(err)
	}
	r.wait(t, "suspended")
	for deadline := time.Now().Add(2 * time.Second); r.api.count("SuspendActor "+sbx) == 0; {
		if time.Now().After(deadline) {
			t.Fatal("the suspend was never sent")
		}
		time.Sleep(time.Millisecond)
	}
	r.api.setState(sbx, ateapi.ActorState_ACTOR_STATE_SUSPENDING)
	if _, err := r.d.Put(context.Background(), sbx, spec("op-2", "Running")); err != nil {
		t.Fatal(err)
	}
	time.Sleep(30 * time.Millisecond)
	if n := r.api.count("ResumeActor refused ACTOR_STATE_SUSPENDING"); n == 0 {
		t.Fatal("the resume was not refused while suspending")
	}
	r.api.setState(sbx, ateapi.ActorState_ACTOR_STATE_SUSPENDED)
	r.wait(t, "ready")
}

func TestACrashedActorIsRevertedOnceAndResumed(t *testing.T) {
	r := newRig(t)
	r.d.o.RetryWait = time.Millisecond
	r.api.mu.Lock()
	r.api.crashOnResume = 1
	r.api.mu.Unlock()
	if _, err := r.d.Put(context.Background(), sbx, spec("op-1", "Running")); err != nil {
		t.Fatal(err)
	}
	// The resume crashes the actor; it is reverted and resumed at once.
	r.wait(t, "ready")
	if n := r.api.count("RevertActor " + sbx); n != 1 {
		t.Fatalf("reverts: %d, want 1", n)
	}
}

func TestACrashLoopIsRevertedOnlyOnce(t *testing.T) {
	r := newRig(t)
	r.d.o.RetryWait = time.Millisecond
	r.api.mu.Lock()
	r.api.crashOnResume = 100
	r.api.mu.Unlock()
	if _, err := r.d.Put(context.Background(), sbx, spec("op-1", "Running")); err != nil {
		t.Fatal(err)
	}
	time.Sleep(100 * time.Millisecond)
	if n := r.api.count("RevertActor " + sbx); n != 1 {
		t.Fatalf("reverts: %d, want 1", n)
	}
	if s, _ := r.d.Status(sbx); s.Reason != "Crashed" {
		t.Fatalf("status: %+v", s)
	}
}

func TestEgressPolicyKeyedHosts(t *testing.T) {
	s := settings()
	s.KeysProvider = DefaultKeysProvider
	keys := &driver.SpecKeys{Sandbox: "sbx_01", Hosts: []driver.KeyHost{
		{Host: "api.openai.com", Header: "Authorization"},
		{Host: "*.example.com", Header: "X-Api-Key"},
	}}
	p, err := EgressPolicy(s, Network{Hosts: []string{"pypi.org", "api.openai.com"}, Suffixes: []string{".example.com"}}, keys)
	if err != nil {
		t.Fatal(err)
	}
	var https []*ateapi.HttpsRule
	var passed []string
	for _, r := range p.GetRules() {
		if h := r.GetHttps(); h != nil {
			https = append(https, h)
		}
		if tp := r.GetTlsPassthrough(); tp != nil && tp.GetHostnames()[0] != s.EdgeHost {
			passed = append(passed, tp.GetHostnames()...)
		}
	}
	if len(https) != 2 {
		t.Fatalf("want an https rule per keyed host: %v", https)
	}
	for _, h := range https {
		inj := h.GetEffects().GetReplaceHeaders()[0]
		want := KeyReference(DefaultKeysProvider, "sbx_01", h.GetHostnames()[0])
		if inj.GetCredentialUri() != want || inj.GetPrefix() != "" {
			t.Fatalf("injection %v, want %s", inj, want)
		}
	}
	if strings.Join(passed, ",") != "pypi.org" {
		t.Fatalf("keyed hosts must leave the passthrough rule: %v", passed)
	}

	// Keys off: keyed hosts are passed through like any other.
	off, err := EgressPolicy(settings(), Network{Hosts: []string{"api.openai.com"}}, keys)
	if err != nil {
		t.Fatal(err)
	}
	for _, r := range off.GetRules() {
		if r.GetHttps() != nil {
			t.Fatalf("keys off renders no https rule: %v", r)
		}
	}
}

func TestSpecKeysValidation(t *testing.T) {
	good := spec("op-1", "Running")
	good.Keys = &driver.SpecKeys{Sandbox: "sbx_01", Hosts: []driver.KeyHost{{Host: "API.OpenAI.com."}, {Host: "api.openai.com"}}}
	if err := good.Normalize(); err != nil {
		t.Fatal(err)
	}
	if len(good.Keys.Hosts) != 1 || good.Keys.Hosts[0].Host != "api.openai.com" || good.Keys.Hosts[0].Header != "Authorization" {
		t.Fatalf("normalized: %+v", good.Keys.Hosts)
	}
	for _, bad := range []*driver.SpecKeys{
		{Sandbox: "", Hosts: []driver.KeyHost{{Host: "x.com"}}},
		{Sandbox: "sbx_01", Hosts: []driver.KeyHost{{Host: "x.com/path"}}},
		{Sandbox: "sbx_01", Hosts: []driver.KeyHost{{Host: "x.com", Header: "bad header"}}},
		{Sandbox: "sbx_01", Hosts: []driver.KeyHost{{Host: "a.*.com"}}},
	} {
		s := spec("op-1", "Running")
		s.Keys = bad
		if err := s.Normalize(); err == nil {
			t.Fatalf("accepted %+v", bad)
		}
	}
}

// actorTemplate is the template the sandbox's actor names now.
func (r *rig) actorTemplate() *ateapi.ActorTemplate {
	r.api.mu.Lock()
	defer r.api.mu.Unlock()
	return r.api.templates[space+"/"+r.api.actors[space+"/"+sbx].GetActorTemplate().GetName()]
}

func (r *rig) actorUID() string {
	r.api.mu.Lock()
	defer r.api.mu.Unlock()
	return r.api.actors[space+"/"+sbx].GetMetadata().GetUid()
}

// upgraded is spec on the next Runtime release: only the image the engine is mounted from changes.
func upgraded(op string) driver.Spec {
	s := spec(op, "Running")
	s.JoinToken = ""
	s.HarnessImage = "ghcr.io/nylorun/runtime:0.46.0-beta"
	return s
}

func TestFakeRefusesARepointThatChangesTheEngine(t *testing.T) {
	r := newRig(t)
	if _, err := r.d.Put(context.Background(), sbx, spec("op-1", "Suspended")); err != nil {
		t.Fatal(err)
	}
	r.wait(t, "suspended")
	// The template the Runtime upgrade renders, as the driver did before it kept the engine (E12).
	rendered, err := RenderTemplate(settings(), func() driver.Spec { s := upgraded("op-2"); _ = s.Normalize(); return s }(),
		Resolved{Image: "python:3.13-slim@sha256:x", Harness: "ghcr.io/nylorun/runtime@sha256:" + strings.Repeat("b", 64)}, "join-token-1")
	if err != nil {
		t.Fatal(err)
	}
	name, _ := TemplateName(sbx, rendered)
	proposed, err := ToProto(rendered, name)
	if err != nil {
		t.Fatal(err)
	}
	if why := RepointRefusal(r.actorTemplate(), proposed); why != "its volumes would change (changes nylo)" {
		t.Fatalf("refusal = %q", why)
	}
	if _, err := r.api.CreateActorTemplate(context.Background(), &ateapi.CreateActorTemplateRequest{ActorTemplate: proposed}); err != nil {
		t.Fatal(err)
	}
	actor, _ := r.api.GetActor(context.Background(), &ateapi.GetActorRequest{Actor: &ateapi.ObjectRef{Atespace: space, Name: sbx}})
	actor.ActorTemplate = &ateapi.ObjectRef{Atespace: space, Name: name}
	_, err = r.api.UpdateActor(context.Background(), &ateapi.UpdateActorRequest{Actor: actor})
	if status.Code(err) != codes.FailedPrecondition || !strings.Contains(err.Error(), "volumes must be identical to repoint an actor") {
		t.Fatalf("UpdateActor = %v", err)
	}
}

func TestRuntimeUpgradeKeepsTheActorAndItsEngine(t *testing.T) {
	r := newRig(t)
	if _, err := r.d.Put(context.Background(), sbx, spec("op-1", "Running")); err != nil {
		t.Fatal(err)
	}
	r.wait(t, "ready")
	uid, before := r.actorUID(), r.actorTemplate()
	engine := EngineReference(before)
	if !strings.HasPrefix(engine, "ghcr.io/nylorun/runtime:0.45.0-beta@sha256:") {
		t.Fatalf("engine = %q", engine)
	}
	s, err := r.d.Put(context.Background(), sbx, upgraded("op-2"))
	if err != nil {
		t.Fatal(err)
	}
	if s.OpID != "op-2" || s.Reason != "" {
		t.Fatalf("status after the upgrade: %+v", s)
	}
	r.wait(t, "ready")
	if r.actorUID() != uid {
		t.Fatal("the upgrade replaced the actor")
	}
	after := r.actorTemplate()
	if after.GetMetadata().GetName() != before.GetMetadata().GetName() || EngineReference(after) != engine {
		t.Fatalf("template %s (engine %s), was %s", after.GetMetadata().GetName(), EngineReference(after), before.GetMetadata().GetName())
	}
	if n := r.api.count("UpdateActor refused " + sbx); n != 0 {
		t.Fatalf("Substrate refused %d repoints", n)
	}
}

func TestRuntimeUpgradeWithAnotherChangeRepointsKeepingTheEngine(t *testing.T) {
	r := newRig(t)
	if _, err := r.d.Put(context.Background(), sbx, spec("op-1", "Running")); err != nil {
		t.Fatal(err)
	}
	r.wait(t, "ready")
	uid, before := r.actorUID(), r.actorTemplate()
	changed := upgraded("op-2")
	changed.Image = "node:24-slim"
	if _, err := r.d.Put(context.Background(), sbx, changed); err != nil {
		t.Fatal(err)
	}
	ready := r.wait(t, "ready")
	after := r.actorTemplate()
	if r.actorUID() != uid || after.GetMetadata().GetName() == before.GetMetadata().GetName() {
		t.Fatalf("expected the same actor on a new template: %s", after.GetMetadata().GetName())
	}
	if EngineReference(after) != EngineReference(before) || !strings.Contains(ready.ImageID, "node:24-slim@sha256:") {
		t.Fatalf("engine %s, image %s", EngineReference(after), ready.ImageID)
	}
	if !strings.Contains(strings.Join(r.api.calls, "\n"), "SuspendActor "+sbx+"\nUpdateActor "+sbx+" "+after.GetMetadata().GetName()) {
		t.Fatalf("expected a suspend then a repoint: %v", r.api.calls)
	}
}

func TestAVolumeChangeIsReportedNotRetried(t *testing.T) {
	r := newRig(t)
	builtin := spec("op-1", "Running")
	builtin.Entrypoint, builtin.HarnessImage = driver.EntrypointBuiltin, ""
	if _, err := r.d.Put(context.Background(), sbx, builtin); err != nil {
		t.Fatal(err)
	}
	r.wait(t, "ready")
	templates := len(r.api.templates)
	calls := len(r.api.calls)
	// The image's engine is not the Runtime's any more: the Runtime asks for its own, an image volume.
	engine := spec("op-2", "Running")
	engine.JoinToken = ""
	s, err := r.d.Put(context.Background(), sbx, engine)
	if err != nil {
		t.Fatalf("a refused change failed the put (the Runtime sends it again): %v", err)
	}
	if s.OpID != "op-2" || s.Ready || s.Reason != RepointRefused || !strings.Contains(s.Message, "adds nylo") {
		t.Fatalf("status: %+v", s)
	}
	for _, c := range r.api.calls[calls:] {
		if strings.HasPrefix(c, "SuspendActor") || strings.HasPrefix(c, "UpdateActor") || strings.HasPrefix(c, "CreateActorTemplate") {
			t.Fatalf("a refused change called Substrate: %v", r.api.calls[calls:])
		}
	}
	if len(r.api.templates) != templates {
		t.Fatal("a refused change left a template")
	}
	again, err := r.d.Put(context.Background(), sbx, engine)
	if err != nil || again.Reason != RepointRefused || len(r.api.calls) != calls {
		t.Fatalf("the same request again: %+v %v %v", again, err, r.api.calls[calls:])
	}
	status, err := r.d.Status(sbx)
	if err != nil || status.Ready || status.Reason != RepointRefused {
		t.Fatalf("status: %+v %v", status, err)
	}
	// A suspend is still carried out; a later request that fits clears the reason.
	suspend := spec("op-3", "Suspended")
	suspend.JoinToken, suspend.Entrypoint, suspend.HarnessImage = "", driver.EntrypointEngine, "ghcr.io/nylorun/runtime:0.45.0-beta"
	if _, err := r.d.Put(context.Background(), sbx, suspend); err != nil {
		t.Fatal(err)
	}
	r.wait(t, "suspended")
	back := builtin
	back.OpID, back.JoinToken = "op-4", ""
	if _, err := r.d.Put(context.Background(), sbx, back); err != nil {
		t.Fatal(err)
	}
	if ready := r.wait(t, "ready"); ready.Reason != "" {
		t.Fatalf("reason kept: %+v", ready)
	}
}

func TestATemplateSubstrateRefusesIsReported(t *testing.T) {
	r := newRig(t)
	if _, err := r.d.Put(context.Background(), sbx, spec("op-1", "Running")); err != nil {
		t.Fatal(err)
	}
	r.wait(t, "ready")
	r.api.refuseRepoint = status.Error(codes.FailedPrecondition, "the storage location must be identical to repoint an actor that owns a snapshot")
	old := r.actorTemplate().GetMetadata().GetName()
	changed := spec("op-2", "Running")
	changed.JoinToken, changed.Image = "", "node:24-slim"
	s, err := r.d.Put(context.Background(), sbx, changed)
	if err != nil {
		t.Fatalf("put: %v", err)
	}
	if s.Reason != RepointRefused || !strings.Contains(s.Message, "storage location must be identical") || s.Ready {
		t.Fatalf("status: %+v", s)
	}
	if r.actorTemplate().GetMetadata().GetName() != old {
		t.Fatal("the actor changed template")
	}
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		r.api.mu.Lock()
		n := len(r.api.templates)
		r.api.mu.Unlock()
		if n == 1 {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("the refused template was not deleted: %d templates", len(r.api.templates))
}

func TestACrashedActorIsRevertedBeforeARepoint(t *testing.T) {
	r := newRig(t)
	if _, err := r.d.Put(context.Background(), sbx, spec("op-1", "Running")); err != nil {
		t.Fatal(err)
	}
	r.wait(t, "ready")
	r.api.setState(sbx, ateapi.ActorState_ACTOR_STATE_CRASHED)
	changed := spec("op-2", "Running")
	changed.JoinToken, changed.Image = "", "node:24-slim"
	if _, err := r.d.Put(context.Background(), sbx, changed); err != nil {
		t.Fatalf("put: %v", err)
	}
	r.wait(t, "ready")
	calls := strings.Join(r.api.calls, "\n")
	if !strings.Contains(calls, "RevertActor "+sbx+"\nUpdateActor "+sbx+" ") {
		t.Fatalf("expected a revert then a repoint: %s", calls)
	}
}
