// Package provider is the keys provider (ADR-142): the one credential provider Agent Substrate's
// egress gateway asks for the header of a keyed request, as `sandboxes provider`. It runs as a
// pod beside the egress, in Substrate's namespace, and does what Substrate's own providers do:
// it serves mutual TLS with its servicedns pod certificate, admits only the egress gateway's
// identity, and reads the value live from where it is stored. It stores nothing and decides
// nothing:
//
//  1. FetchSecret(ate-secret://keys.nylorun.dev/<sandbox>/<host>, actor) arrives from the egress
//     (the sandbox id base64url-encoded);
//  2. the actor's atespace picks the Tenant in the config file;
//  3. the Tenant's egress service decides (POST <decideUrl> {actor, sandboxId, host}, its token):
//     a vault value comes back, or "fetch" with the Agent, owner and host of a person's key;
//  4. on "fetch", the outside credential source the Tenant names gives the value
//     (POST <outside.url>/v1/fetch {agentId, owner, host}); the Runtime never sees it.
//
// Logs name the sandbox, host and outcome, never a value. Every call has one budget, under the
// egress gateway's 5 s.
package provider

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strings"
	"sync"
	"time"

	credprovider "go.ate.dev/substrate/api/credprovider/v1"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

// DefaultName is the provider's name: the host of its references.
const DefaultName = "keys.nylorun.dev"

// DefaultBudget is one FetchSecret's time, decide and fetch together.
const DefaultBudget = 3 * time.Second

// maxValue bounds a header value read back.
const maxValue = 16 << 10

// Config is the provider's config file (a Secret): one entry per Tenant, by its atespace.
type Config struct {
	Tenants map[string]Tenant `json:"tenants"`
}

// Tenant is how the provider reaches one Tenant.
type Tenant struct {
	// DecideURL is the egress service's decide route through the edge's keys port, e.g.
	// https://nylorun-local.edge.nylorun.internal:8795/nylorun/v1/egress/decide.
	DecideURL string `json:"decideUrl"`
	// Token is NYLORUN_EGRESS_KEYS_TOKEN.
	Token string `json:"token"`
	// EdgeCA is the PEM of the CA the edge's certificate chains to.
	EdgeCA string `json:"edgeCa"`
	// Outside is the Host's outside credential source, for a person's keys; none: no such keys.
	Outside *Outside `json:"outside,omitempty"`
}

// Outside is an outside credential source (the CP-E contract): Cloud's is Connections.
type Outside struct {
	URL   string `json:"url"`
	Token string `json:"token"`
	// CA is a PEM to trust instead of the public roots, when the source has a private CA.
	CA string `json:"ca,omitempty"`
}

// Server answers FetchSecret.
type Server struct {
	credprovider.UnimplementedCredentialProviderServer
	// Name is the host of the references this provider serves.
	Name string
	// ConfigFile is read again when it changes (the Secret is updated in place).
	ConfigFile string
	Budget     time.Duration
	Log        *slog.Logger

	mu      sync.Mutex
	loaded  time.Time
	config  Config
	clients map[string]*http.Client
}

// segmentPattern matches a base64url segment.
var segmentPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{1,344}$`)

// hostPattern matches a lowercase DNS name, or one with "*" as its leftmost label.
var hostPattern = regexp.MustCompile(`^(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$`)

// Reference is a parsed ate-secret://<name>/<sandbox>/<host>.
type Reference struct{ Sandbox, Host string }

// ParseReference reads a reference this provider serves.
func ParseReference(name, raw string) (Reference, error) {
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "ate-secret" || u.Host != name || u.RawQuery != "" || u.Fragment != "" || u.User != nil {
		return Reference{}, fmt.Errorf("not a reference of %s", name)
	}
	parts := strings.Split(strings.TrimPrefix(u.Path, "/"), "/")
	if len(parts) != 2 || !segmentPattern.MatchString(parts[0]) || !hostPattern.MatchString(parts[1]) {
		return Reference{}, errors.New("a reference is ate-secret://<name>/<base64url sandbox id>/<host>")
	}
	id, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil || len(id) == 0 {
		return Reference{}, errors.New("the reference's sandbox id is not base64url")
	}
	return Reference{Sandbox: string(id), Host: parts[1]}, nil
}

// Actor is an actor's identity as the egress gateway verified it.
type Actor struct{ Atespace, Name string }

// ParseActor reads spiffe://<trust domain>/actor/<atespace>/<name>.
func ParseActor(raw string) (Actor, error) {
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "spiffe" || u.Host == "" {
		return Actor{}, errors.New("not a SPIFFE ID")
	}
	parts := strings.Split(strings.TrimPrefix(u.Path, "/"), "/")
	if len(parts) != 3 || parts[0] != "actor" || parts[1] == "" || parts[2] == "" {
		return Actor{}, errors.New("not an actor's SPIFFE ID")
	}
	return Actor{Atespace: parts[1], Name: parts[2]}, nil
}

// FetchSecret is the egress gateway's call for one request's header.
func (s *Server) FetchSecret(ctx context.Context, req *credprovider.FetchSecretRequest) (*credprovider.FetchSecretResponse, error) {
	started := time.Now()
	ref, err := ParseReference(s.Name, req.GetUri())
	if err != nil {
		return nil, status.Error(codes.InvalidArgument, err.Error())
	}
	actor, err := ParseActor(req.GetActorSpiffeId())
	if err != nil {
		return nil, status.Error(codes.PermissionDenied, err.Error())
	}
	value, outcome, err := s.fetch(ctx, ref, actor)
	log := s.Log.With("sandbox", ref.Sandbox, "host", ref.Host, "atespace", actor.Atespace, "actor", actor.Name, "ms", time.Since(started).Milliseconds())
	if err != nil {
		log.Warn("keys: refused", "outcome", outcome, "code", status.Code(err).String(), "reason", status.Convert(err).Message())
		return nil, err
	}
	log.Info("keys: released", "outcome", outcome)
	return &credprovider.FetchSecretResponse{OpaqueBytes: []byte(value)}, nil
}

func (s *Server) fetch(ctx context.Context, ref Reference, actor Actor) (string, string, error) {
	budget := s.Budget
	if budget <= 0 {
		budget = DefaultBudget
	}
	ctx, cancel := context.WithTimeout(ctx, budget)
	defer cancel()
	cfg, err := s.load()
	if err != nil {
		return "", "config", status.Error(codes.Unavailable, "the provider's config is unreadable")
	}
	tenant, ok := cfg.Tenants[actor.Atespace]
	if !ok {
		return "", "tenant", status.Errorf(codes.PermissionDenied, "no Tenant for atespace %q", actor.Atespace)
	}
	client, err := s.client("edge", tenant.EdgeCA)
	if err != nil {
		return "", "config", status.Error(codes.Unavailable, err.Error())
	}
	var decided struct {
		Value *string `json:"value"`
		Fetch *struct {
			AgentID string `json:"agentId"`
			Owner   string `json:"owner"`
			Host    string `json:"host"`
		} `json:"fetch"`
	}
	if err := post(ctx, client, tenant.DecideURL, tenant.Token, map[string]string{
		"actor": actor.Name, "sandboxId": ref.Sandbox, "host": ref.Host,
	}, &decided); err != nil {
		return "", "decide", err
	}
	if decided.Value != nil {
		return *decided.Value, "vault", nil
	}
	if decided.Fetch == nil {
		return "", "decide", status.Error(codes.Unavailable, "the decision named neither a value nor a fetch")
	}
	if tenant.Outside == nil || tenant.Outside.URL == "" {
		return "", "outside", status.Error(codes.NotFound, "the Tenant names no outside credential source")
	}
	outsideClient, err := s.client("outside", tenant.Outside.CA)
	if err != nil {
		return "", "config", status.Error(codes.Unavailable, err.Error())
	}
	var fetched struct {
		Value string `json:"value"`
	}
	if err := post(ctx, outsideClient, strings.TrimRight(tenant.Outside.URL, "/")+"/v1/fetch", tenant.Outside.Token, map[string]string{
		"agentId": decided.Fetch.AgentID, "owner": decided.Fetch.Owner, "host": decided.Fetch.Host,
	}, &fetched); err != nil {
		return "", "outside", err
	}
	if fetched.Value == "" {
		return "", "outside", status.Error(codes.NotFound, "the outside source returned no value")
	}
	return fetched.Value, "outside", nil
}

// post sends body as JSON with the bearer token and decodes a 200 into out. Other answers
// become the codes the egress gateway maps: 403 and 404 deny, the rest retry (503).
func post(ctx context.Context, client *http.Client, target, token string, body any, out any) error {
	raw, err := json.Marshal(body)
	if err != nil {
		return status.Error(codes.Internal, err.Error())
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, target, bytes.NewReader(raw))
	if err != nil {
		return status.Error(codes.Unavailable, "bad URL")
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := client.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return status.Error(codes.DeadlineExceeded, "no answer in time")
		}
		return status.Error(codes.Unavailable, "unreachable")
	}
	defer func() { _ = resp.Body.Close() }()
	data, err := io.ReadAll(io.LimitReader(resp.Body, maxValue+1))
	if err != nil || len(data) > maxValue {
		return status.Error(codes.Unavailable, "unreadable answer")
	}
	switch resp.StatusCode {
	case http.StatusOK:
		if err := json.Unmarshal(data, out); err != nil {
			return status.Error(codes.Unavailable, "unreadable answer")
		}
		return nil
	case http.StatusForbidden, http.StatusUnauthorized:
		return status.Errorf(codes.PermissionDenied, "refused (%d)", resp.StatusCode)
	case http.StatusNotFound:
		return status.Error(codes.NotFound, "no key")
	case http.StatusBadRequest:
		return status.Error(codes.InvalidArgument, "bad request")
	default:
		return status.Errorf(codes.Unavailable, "answered %d", resp.StatusCode)
	}
}

// load reads the config file when it changed.
func (s *Server) load() (Config, error) {
	info, err := os.Stat(s.ConfigFile)
	if err != nil {
		return Config{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if !info.ModTime().After(s.loaded) && s.config.Tenants != nil {
		return s.config, nil
	}
	raw, err := os.ReadFile(s.ConfigFile)
	if err != nil {
		return Config{}, err
	}
	var cfg Config
	if err := json.Unmarshal(raw, &cfg); err != nil {
		return Config{}, err
	}
	if cfg.Tenants == nil {
		cfg.Tenants = map[string]Tenant{}
	}
	s.config, s.loaded, s.clients = cfg, info.ModTime(), nil
	return cfg, nil
}

// client is an HTTP client that trusts ca (the public roots when empty), one per CA.
func (s *Server) client(kind, ca string) (*http.Client, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	key := kind + "\x00" + ca
	if c, ok := s.clients[key]; ok {
		return c, nil
	}
	tlsConfig := &tls.Config{MinVersion: tls.VersionTLS12}
	if strings.TrimSpace(ca) != "" {
		pool := x509.NewCertPool()
		if !pool.AppendCertsFromPEM([]byte(ca)) {
			return nil, fmt.Errorf("the %s CA is not PEM", kind)
		}
		tlsConfig.RootCAs = pool
	}
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.TLSClientConfig = tlsConfig
	transport.Proxy = nil
	c := &http.Client{Transport: transport}
	if s.clients == nil {
		s.clients = map[string]*http.Client{}
	}
	s.clients[key] = c
	return c, nil
}
