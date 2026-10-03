package driver_test

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/dynamic/fake"

	"github.com/nylorun/agents/sandboxes/internal/driver"
	"github.com/nylorun/agents/sandboxes/internal/driver/drivertest"
)

var update = flag.Bool("update", false, "rewrite the golden files")

const namespace = "nylorun-sbx-shop"

var urls = driver.PodURLs{
	Harness: "http://192.168.65.254:41001",
	Gates:   "http://192.168.65.254:41002",
	Egress:  "http://192.168.65.254:41003",
}

func fullSpec() driver.Spec {
	return driver.Spec{
		OpID:             "op-1",
		Mode:             "Running",
		Image:            "python:3.13-slim",
		HarnessImage:     "ghcr.io/nylorun/runtime:0.16.0",
		CPUs:             2,
		MemoryMiB:        2048,
		StorageGiB:       10,
		StopGraceSeconds: 10,
		ShutdownTime:     "2026-10-04T12:00:00+02:00",
		ShutdownPolicy:   "Retain",
		Env:              map[string]string{"B_VAR": "2", "A_VAR": "1"},
	}
}

func TestName(t *testing.T) {
	name := driver.Name("shop", "sbx_01", 0)
	if !driver.NamePattern.MatchString(name) {
		t.Fatalf("%s does not match %s", name, driver.NamePattern)
	}
	// A fixed vector, so core's TypeScript can match it.
	if name != "sbx-ub6g5m7mvjlct6r7-g0" {
		t.Fatalf("Name(shop, sbx_01, 0) = %s", name)
	}
	if driver.Name("shop", "sbx_01", 1) == name || driver.Name("other", "sbx_01", 0) == name {
		t.Fatal("names must differ by Tenant and volume generation")
	}
}

func TestRenderGolden(t *testing.T) {
	spec := fullSpec()
	if err := spec.Normalize(); err != nil {
		t.Fatal(err)
	}
	got, err := json.MarshalIndent(driver.Render(namespace, "sbx-ub6g5m7mvjlct6r7-g0", spec, urls).Object, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	golden := filepath.Join("testdata", "sandbox.golden.json")
	if *update {
		if err := os.WriteFile(golden, append(got, '\n'), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	want, err := os.ReadFile(golden)
	if err != nil {
		t.Fatal(err)
	}
	if strings.TrimSpace(string(want)) != string(got) {
		t.Fatalf("rendered Sandbox differs from %s (go test ./... -update):\n%s", golden, got)
	}
}

func TestRenderCommandWithoutEngine(t *testing.T) {
	spec := driver.Spec{OpID: "op", Mode: "Suspended", Image: "busybox:1.37.0", Command: []string{"sleep", "60"}}
	if err := spec.Normalize(); err != nil {
		t.Fatal(err)
	}
	o := driver.Render(namespace, "sbx-aaaaaaaaaaaaaaaa-g0", spec, driver.PodURLs{})
	if _, found, _ := unstructured.NestedSlice(o.Object, "spec", "podTemplate", "spec", "initContainers"); found {
		t.Fatal("no init container without a harness image")
	}
	if _, found, _ := unstructured.NestedString(o.Object, "spec", "shutdownTime"); found {
		t.Fatal("no shutdownTime unless given")
	}
	containers, _, _ := unstructured.NestedSlice(o.Object, "spec", "podTemplate", "spec", "containers")
	command := containers[0].(map[string]any)["command"].([]any)
	if len(command) != 2 || command[0] != "sleep" {
		t.Fatalf("command %v", command)
	}
}

func TestNormalizeRefuses(t *testing.T) {
	cases := map[string]func(*driver.Spec){
		"opId":           func(s *driver.Spec) { s.OpID = "" },
		"mode":           func(s *driver.Spec) { s.Mode = "Paused" },
		"no engine":      func(s *driver.Spec) { s.HarnessImage = "" },
		"cpus":           func(s *driver.Spec) { s.CPUs = 100 },
		"memory":         func(s *driver.Spec) { s.MemoryMiB = 1 },
		"grace":          func(s *driver.Spec) { s.StopGraceSeconds = 31 },
		"shutdownTime":   func(s *driver.Spec) { s.ShutdownTime = "tomorrow" },
		"shutdownPolicy": func(s *driver.Spec) { s.ShutdownPolicy = "Keep" },
		"reserved env":   func(s *driver.Spec) { s.Env = map[string]string{"NYLORUN_GATES_URL": "x"} },
		"bad env":        func(s *driver.Spec) { s.Env = map[string]string{"A-B": "x"} },
		"image":          func(s *driver.Spec) { s.Image = "a b" },
	}
	for name, mutate := range cases {
		spec := fullSpec()
		mutate(&spec)
		var refusal *driver.Error
		if err := spec.Normalize(); !errors.As(err, &refusal) || refusal.Status != http.StatusBadRequest {
			t.Errorf("%s: want a 400 refusal, got %v", name, err)
		}
	}
	if err := driver.ValidateName("my-sandbox"); err == nil {
		t.Error("names outside the pattern are refused")
	}
}

func applies(client *fake.FakeDynamicClient) int {
	count := 0
	for _, action := range client.Actions() {
		if action.GetVerb() == "patch" && action.GetResource().Resource == "sandboxes" {
			count++
		}
	}
	return count
}

func start(t *testing.T, client *fake.FakeDynamicClient) *driver.Driver {
	t.Helper()
	d := driver.New(client, namespace, urls)
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	d.Cache().Start(ctx)
	if !d.Cache().WaitForSync(ctx) {
		t.Fatal("informers did not sync")
	}
	return d
}

func TestPutIsIdempotentByOpID(t *testing.T) {
	client := drivertest.NewFakeClient()
	d := start(t, client)
	ctx := context.Background()
	name := driver.Name("shop", "sbx_01", 0)
	spec := fullSpec()
	spec.JoinToken = "join-1"

	status, err := d.Put(ctx, name, spec)
	if err != nil {
		t.Fatal(err)
	}
	if !status.Exists || status.Mode != "Running" || status.OpID != "op-1" || status.Ready {
		t.Fatalf("after create: %+v", status)
	}
	secret, err := client.Resource(driver.SecretGVR).Namespace(namespace).Get(ctx, name+"-join", metav1.GetOptions{})
	if err != nil {
		t.Fatal("the join Secret is created before the Sandbox:", err)
	}
	if token, _, _ := unstructured.NestedString(secret.Object, "data", "token"); token != "am9pbi0x" {
		t.Fatalf("join token %q", token)
	}

	if _, err := d.Put(ctx, name, spec); err != nil {
		t.Fatal(err)
	}
	if n := applies(client); n != 1 {
		t.Fatalf("a repeated opId must not apply again (%d applies)", n)
	}

	spec.OpID, spec.Mode = "op-2", "Suspended"
	status, err = d.Put(ctx, name, spec)
	if err != nil {
		t.Fatal(err)
	}
	if status.Mode != "Suspended" || status.OpID != "op-2" || applies(client) != 2 {
		t.Fatalf("after suspend: %+v", status)
	}

	spec.OpID, spec.StorageGiB = "op-3", 20
	var refusal *driver.Error
	if _, err := d.Put(ctx, name, spec); !errors.As(err, &refusal) || refusal.Code != "storage_immutable" {
		t.Fatalf("storage change: %v", err)
	}

	if _, err := d.Delete(ctx, name); err != nil {
		t.Fatal(err)
	}
	if _, err := client.Resource(driver.SecretGVR).Namespace(namespace).Get(ctx, name+"-join", metav1.GetOptions{}); err == nil {
		t.Fatal("delete removes the join Secret")
	}
	if _, err := d.Delete(ctx, name); err != nil {
		t.Fatal("deleting a deleted sandbox succeeds:", err)
	}
	status, met, err := d.Wait(ctx, name, "gone", 2*time.Second)
	if err != nil || !met {
		t.Fatalf("gone: %+v %v %v", status, met, err)
	}
}

func object(apiVersion, kind, name string, fields map[string]any) *unstructured.Unstructured {
	o := &unstructured.Unstructured{Object: map[string]any{"apiVersion": apiVersion, "kind": kind}}
	for k, v := range fields {
		o.Object[k] = v
	}
	o.SetName(name)
	o.SetNamespace(namespace)
	return o
}

func sandboxObject(name, mode string, generation int64, conditions ...map[string]any) *unstructured.Unstructured {
	items := make([]any, len(conditions))
	for i, c := range conditions {
		items[i] = c
	}
	o := object(driver.APIVersion, "Sandbox", name, map[string]any{
		"spec":   map[string]any{"operatingMode": mode},
		"status": map[string]any{"conditions": items},
	})
	o.SetGeneration(generation)
	o.SetAnnotations(map[string]string{driver.OpAnnotation: "op"})
	return o
}

func cond(kind, status, reason string, generation int64) map[string]any {
	return map[string]any{"type": kind, "status": status, "reason": reason, "message": reason, "observedGeneration": generation}
}

func pod(name string, uid string) *unstructured.Unstructured {
	o := object("v1", "Pod", name, map[string]any{"status": map[string]any{"phase": "Running"}})
	o.SetUID(types.UID(uid))
	o.SetLabels(map[string]string{driver.RoleLabel: "sandbox", driver.SandboxLabel: name})
	return o
}

func claim(name string) *unstructured.Unstructured {
	return object("v1", "PersistentVolumeClaim", "data-"+name, nil)
}

func TestCompute(t *testing.T) {
	name := "sbx-aaaaaaaaaaaaaaaa-g0"
	ready := driver.Compute(name, sandboxObject(name, "Running", 2, cond("Ready", "True", "DependenciesReady", 2)),
		[]*unstructured.Unstructured{pod(name, "pod-1")}, claim(name))
	if !ready.Ready || ready.PodUID != "pod-1" || ready.Volume != "present" || ready.Suspended {
		t.Fatalf("ready: %+v", ready)
	}
	stale := driver.Compute(name, sandboxObject(name, "Running", 3, cond("Ready", "True", "DependenciesReady", 2)),
		[]*unstructured.Unstructured{pod(name, "pod-1")}, claim(name))
	if stale.Ready {
		t.Fatal("a condition of an older generation is not current")
	}
	suspended := driver.Compute(name, sandboxObject(name, "Suspended", 3,
		cond("Ready", "False", "SandboxSuspended", 3), cond("Suspended", "True", "PodTerminated", 3)), nil, claim(name))
	if !suspended.Suspended || suspended.Ready || suspended.PodPhase != "" {
		t.Fatalf("suspended: %+v", suspended)
	}
	expired := driver.Compute(name, sandboxObject(name, "Running", 1, cond("Ready", "False", "SandboxExpired", 1)), nil, claim(name))
	if !expired.Expired || expired.Reason != "SandboxExpired" {
		t.Fatalf("expired: %+v", expired)
	}
	lost := driver.Compute(name, sandboxObject(name, "Running", 1, cond("Ready", "False", "DependenciesNotReady", 1)), nil, nil)
	if lost.Volume != "missing" || !lost.Exists {
		t.Fatalf("lost volume: %+v", lost)
	}
	terminating := pod(name, "pod-1")
	terminating.SetDeletionTimestamp(&metav1.Time{Time: time.Now()})
	gone := driver.Compute(name, nil, []*unstructured.Unstructured{terminating}, nil)
	if gone.Exists || gone.PodPhase != "Terminating" || gone.PodUID != "" {
		t.Fatalf("terminating pod: %+v", gone)
	}
}

func TestWaitWakesOnInformerEvents(t *testing.T) {
	name := "sbx-aaaaaaaaaaaaaaaa-g0"
	client := drivertest.NewFakeClient()
	ctx := context.Background()
	// Seeded objects get a guessed resource (sandboxs): create through the Sandbox resource.
	if _, err := client.Resource(driver.SandboxGVR).Namespace(namespace).Create(ctx,
		sandboxObject(name, "Running", 1, cond("Ready", "False", "DependenciesNotReady", 1)), metav1.CreateOptions{}); err != nil {
		t.Fatal(err)
	}
	d := start(t, client)
	go func() {
		time.Sleep(100 * time.Millisecond)
		_, _ = client.Resource(driver.PodGVR).Namespace(namespace).Create(ctx, pod(name, "pod-7"), metav1.CreateOptions{})
		_, _ = client.Resource(driver.PVCGVR).Namespace(namespace).Create(ctx, claim(name), metav1.CreateOptions{})
		_, _ = client.Resource(driver.SandboxGVR).Namespace(namespace).Update(ctx,
			sandboxObject(name, "Running", 1, cond("Ready", "True", "DependenciesReady", 1)), metav1.UpdateOptions{})
	}()
	status, met, err := d.Wait(ctx, name, "ready", 5*time.Second)
	if err != nil || !met || status.PodUID != "pod-7" {
		t.Fatalf("wait ready: %+v %v %v", status, met, err)
	}
	status, met, _ = d.Wait(ctx, name, "suspended", 50*time.Millisecond)
	if met || !status.Ready {
		t.Fatalf("a wait that times out reports the current status: %+v %v", status, met)
	}
	if _, _, err := d.Wait(ctx, name, "running", time.Second); err == nil {
		t.Fatal("unknown wait states are refused")
	}
}
