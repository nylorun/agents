package provider

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"io"
	"log/slog"
	"math/big"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"testing"
	"time"

	credprovider "go.ate.dev/substrate/api/credprovider/v1"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

const actorID = "spiffe://substrate-actor.local/actor/nylorun-local/sbx-ub6g5m7mvjlct6r7-g0"

func certPEM(s *httptest.Server) string {
	return string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: s.Certificate().Raw}))
}

type seen struct {
	body  map[string]string
	token string
}

// decideServer answers each decide with status and body, recording what it got.
func decideServer(t *testing.T, code int, body string, got *seen) *httptest.Server {
	t.Helper()
	s := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(raw, &got.body)
		got.token = r.Header.Get("Authorization")
		w.WriteHeader(code)
		_, _ = w.Write([]byte(body))
	}))
	t.Cleanup(s.Close)
	return s
}

func newServer(t *testing.T, cfg Config) *Server {
	t.Helper()
	file := filepath.Join(t.TempDir(), "config.json")
	raw, _ := json.Marshal(cfg)
	if err := os.WriteFile(file, raw, 0o600); err != nil {
		t.Fatal(err)
	}
	return &Server{Name: DefaultName, ConfigFile: file, Log: slog.New(slog.NewTextHandler(io.Discard, nil))}
}

func call(s *Server, uri string) (string, error) {
	resp, err := s.FetchSecret(context.Background(), &credprovider.FetchSecretRequest{Uri: uri, ActorSpiffeId: actorID})
	if err != nil {
		return "", err
	}
	return string(resp.GetOpaqueBytes()), nil
}

func TestParse(t *testing.T) {
	ref, err := ParseReference(DefaultName, "ate-secret://keys.nylorun.dev/c2J4XzAx/*.googleapis.com")
	if err != nil || ref.Sandbox != "sbx_01" || ref.Host != "*.googleapis.com" {
		t.Fatalf("%+v %v", ref, err)
	}
	for _, bad := range []string{
		"ate-secret://other.dev/sbx_01/api.github.com",
		"ate-secret://keys.nylorun.dev/sbx_01",
		"ate-secret://keys.nylorun.dev/c2J4XzAx/api.github.com/x",
		"ate-secret://keys.nylorun.dev/c2J4XzAx/API.github.com",
		"https://keys.nylorun.dev/sbx_01/api.github.com",
	} {
		if _, err := ParseReference(DefaultName, bad); err == nil {
			t.Fatalf("accepted %s", bad)
		}
	}
	actor, err := ParseActor(actorID)
	if err != nil || actor.Atespace != "nylorun-local" || actor.Name != "sbx-ub6g5m7mvjlct6r7-g0" {
		t.Fatalf("%+v %v", actor, err)
	}
	if _, err := ParseActor("spiffe://cluster.local/ns/ate-system/sa/atenet-egress"); err == nil {
		t.Fatal("a workload identity is not an actor")
	}
}

func TestVaultValue(t *testing.T) {
	var got seen
	decide := decideServer(t, 200, `{"value":"Bearer sk-real"}`, &got)
	s := newServer(t, Config{Tenants: map[string]Tenant{"nylorun-local": {DecideURL: decide.URL + "/nylorun/v1/egress/decide", Token: "tok", EdgeCA: certPEM(decide)}}})
	value, err := call(s, "ate-secret://keys.nylorun.dev/c2J4XzAx/api.openai.com")
	if err != nil || value != "Bearer sk-real" {
		t.Fatalf("%q %v", value, err)
	}
	if got.token != "Bearer tok" || got.body["actor"] != "sbx-ub6g5m7mvjlct6r7-g0" || got.body["sandboxId"] != "sbx_01" || got.body["host"] != "api.openai.com" {
		t.Fatalf("decide got %+v", got)
	}
}

func TestPersonsKeyFromTheOutsideSource(t *testing.T) {
	var decided, fetched seen
	decide := decideServer(t, 200, `{"fetch":{"agentId":"ag_7","owner":"u:acme:ana","host":"api.github.com"}}`, &decided)
	outside := decideServer(t, 200, `{"value":"token gho_real"}`, &fetched)
	s := newServer(t, Config{Tenants: map[string]Tenant{"nylorun-local": {
		DecideURL: decide.URL, Token: "tok", EdgeCA: certPEM(decide),
		Outside: &Outside{URL: outside.URL, Token: "cp", CA: certPEM(outside)},
	}}})
	value, err := call(s, "ate-secret://keys.nylorun.dev/c2J4XzAx/api.github.com")
	if err != nil || value != "token gho_real" {
		t.Fatalf("%q %v", value, err)
	}
	if fetched.token != "Bearer cp" || fetched.body["owner"] != "u:acme:ana" || fetched.body["agentId"] != "ag_7" || fetched.body["host"] != "api.github.com" {
		t.Fatalf("outside got %+v", fetched)
	}
}

func TestRefusals(t *testing.T) {
	cases := []struct {
		name   string
		code   int
		body   string
		tenant func(decide *httptest.Server) Tenant
		want   codes.Code
	}{
		{"another sandbox", 403, `{"error":{"code":"permission_denied"}}`, nil, codes.PermissionDenied},
		{"no key", 404, `{}`, nil, codes.NotFound},
		{"Tenant down", 503, `{}`, nil, codes.Unavailable},
		{"fetch with no outside source", 200, `{"fetch":{"agentId":"a","owner":"o","host":"h"}}`, nil, codes.NotFound},
		{"wrong edge CA", 200, `{"value":"x"}`, func(d *httptest.Server) Tenant {
			return Tenant{DecideURL: d.URL, Token: "tok", EdgeCA: otherCA(t)}
		}, codes.Unavailable},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			var got seen
			decide := decideServer(t, c.code, c.body, &got)
			tenant := Tenant{DecideURL: decide.URL, Token: "tok", EdgeCA: certPEM(decide)}
			if c.tenant != nil {
				tenant = c.tenant(decide)
			}
			s := newServer(t, Config{Tenants: map[string]Tenant{"nylorun-local": tenant}})
			_, err := call(s, "ate-secret://keys.nylorun.dev/c2J4XzAx/api.openai.com")
			if status.Code(err) != c.want {
				t.Fatalf("got %v, want %v", err, c.want)
			}
		})
	}

	s := newServer(t, Config{Tenants: map[string]Tenant{}})
	if _, err := call(s, "ate-secret://keys.nylorun.dev/c2J4XzAx/api.openai.com"); status.Code(err) != codes.PermissionDenied {
		t.Fatalf("an unknown atespace: %v", err)
	}
	if _, err := call(s, "ate-secret://k8s.io/default/ns/secret/key"); status.Code(err) != codes.InvalidArgument {
		t.Fatalf("another provider's URI: %v", err)
	}
}

func TestOnlyTheInjectorIsAdmitted(t *testing.T) {
	verify := verifyInjector(DefaultInjector)
	egress, _ := url.Parse(DefaultInjector)
	other, _ := url.Parse("spiffe://cluster.local/ns/ate-system/sa/other")
	if err := verify(nil, [][]*x509.Certificate{{{URIs: []*url.URL{egress}}}}); err != nil {
		t.Fatal(err)
	}
	if err := verify(nil, [][]*x509.Certificate{{{URIs: []*url.URL{other}}}}); err == nil {
		t.Fatal("admitted another identity")
	}
	if err := verify(nil, nil); err == nil {
		t.Fatal("admitted no certificate")
	}
}

// otherCA is a CA that signed nothing the test servers present.
func otherCA(t *testing.T) string {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	tmpl := &x509.Certificate{SerialNumber: big.NewInt(1), NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour), IsCA: true, BasicConstraintsValid: true}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	return string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}))
}
