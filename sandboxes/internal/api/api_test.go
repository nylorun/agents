package api_test

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/nylorun/agents/sandboxes/internal/api"
	"github.com/nylorun/agents/sandboxes/internal/config"
	"github.com/nylorun/agents/sandboxes/internal/driver"
	"github.com/nylorun/agents/sandboxes/internal/driver/drivertest"
)

const token = "0123456789abcdef0123456789abcdef"

func server(t *testing.T, synced bool) *httptest.Server {
	t.Helper()
	d := driver.New(drivertest.NewFakeClient(), "nylorun-sbx-shop", driver.PodURLs{})
	if synced {
		ctx, cancel := context.WithCancel(context.Background())
		t.Cleanup(cancel)
		d.Cache().Start(ctx)
		d.Cache().WaitForSync(ctx)
	}
	s := &api.Server{
		Driver: d,
		Cluster: config.Cluster{Namespace: "nylorun-sbx-shop", Context: "kind-nylorun", ControllerVersion: "v1.0.5",
			HostAddress: "172.17.0.1", Ports: config.Ports{Harness: 1, Gates: 2, Egress: 3},
			NetworkPolicy: config.NetworkPolicy{Enforced: true, ProbedAt: "2026-10-03T00:00:00Z"}},
		Token: token,
		Log:   slog.New(slog.NewTextHandler(io.Discard, nil)),
	}
	ts := httptest.NewServer(s.Handler())
	t.Cleanup(ts.Close)
	return ts
}

func call(t *testing.T, ts *httptest.Server, method, path, bearer, body string) (int, map[string]any) {
	t.Helper()
	request, _ := http.NewRequest(method, ts.URL+path, strings.NewReader(body))
	if bearer != "" {
		request.Header.Set("Authorization", "Bearer "+bearer)
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	var out map[string]any
	_ = json.NewDecoder(response.Body).Decode(&out)
	return response.StatusCode, out
}

const name = "sbx-ub6g5m7mvjlct6r7-g0"

func TestAuth(t *testing.T) {
	ts := server(t, true)
	for _, bearer := range []string{"", "wrong"} {
		if code, out := call(t, ts, "GET", "/v1/info", bearer, ""); code != 401 || out["error"].(map[string]any)["code"] != "unauthorized" {
			t.Fatalf("bearer %q: %d %v", bearer, code, out)
		}
	}
	if code, _ := call(t, ts, "GET", "/health", "", ""); code != 200 {
		t.Fatal("/health is open")
	}
	code, info := call(t, ts, "GET", "/v1/info", token, "")
	if code != 200 || info["apiVersion"] != driver.APIVersion || info["namespace"] != "nylorun-sbx-shop" ||
		info["networkPolicy"].(map[string]any)["enforced"] != true {
		t.Fatalf("info: %d %v", code, info)
	}
}

func TestReadyNeedsSyncedInformers(t *testing.T) {
	if code, out := call(t, server(t, false), "GET", "/ready", "", ""); code != 503 || out["status"] != "unavailable" {
		t.Fatalf("unsynced: %d %v", code, out)
	}
	if code, out := call(t, server(t, true), "GET", "/ready", "", ""); code != 200 || out["status"] != "ready" {
		t.Fatalf("synced: %d %v", code, out)
	}
}

func TestPods(t *testing.T) {
	ts := server(t, true)
	body := `{"opId":"op-1","mode":"Running","image":"busybox:1.37.0","command":["sleep","60"],"joinToken":"j"}`
	if code, out := call(t, ts, "PUT", "/v1/pods/not-ours", token, body); code != 400 {
		t.Fatalf("foreign name: %d %v", code, out)
	}
	if code, out := call(t, ts, "PUT", "/v1/pods/"+name, token, `{"opId":"op-1","mode":"Running","extra":1}`); code != 400 {
		t.Fatalf("unknown field: %d %v", code, out)
	}
	if code, out := call(t, ts, "PUT", "/v1/pods/"+name, token, `{"opId":"op-1","mode":"Running"}`); code != 400 ||
		!strings.Contains(out["error"].(map[string]any)["message"].(string), "harnessImage") {
		t.Fatalf("no engine: %d %v", code, out)
	}
	code, out := call(t, ts, "PUT", "/v1/pods/"+name, token, body)
	if code != 200 || out["exists"] != true || out["mode"] != "Running" || out["opId"] != "op-1" {
		t.Fatalf("put: %d %v", code, out)
	}
	code, out = call(t, ts, "GET", "/v1/pods/"+name, token, "")
	if code != 200 || out["name"] != name || out["volume"] != "missing" {
		t.Fatalf("get: %d %v", code, out)
	}
	code, out = call(t, ts, "GET", "/v1/pods/"+name+"?wait=ready&timeoutMs=50", token, "")
	if code != 200 || out["met"] != false {
		t.Fatalf("wait: %d %v", code, out)
	}
	if code, _ := call(t, ts, "GET", "/v1/pods/"+name+"?wait=ready&timeoutMs=60000", token, ""); code != 400 {
		t.Fatal("waits are bounded at 30 s")
	}
	if code, out = call(t, ts, "DELETE", "/v1/pods/"+name+"?opId=op-2", token, ""); code != 200 {
		t.Fatalf("delete: %d %v", code, out)
	}
	code, out = call(t, ts, "GET", "/v1/pods/"+name+"?wait=gone&timeoutMs=2000", token, "")
	if code != 200 || out["met"] != true || out["exists"] != false {
		t.Fatalf("gone: %d %v", code, out)
	}
}
