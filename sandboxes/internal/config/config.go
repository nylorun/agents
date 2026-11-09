// Package config reads the files `nylorun local sandbox enable` writes under
// `<Host root>/sandboxes/` (mounted read-only at /run/nylorun/sandboxes) and the
// service's environment.
package config

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"k8s.io/client-go/rest"
)

// Cluster is cluster.json, as `nylorun local sandbox enable` records it.
type Cluster struct {
	// Context is the kubeconfig context `enable` installed into.
	Context string `json:"context"`
	// Server is the API server URL in that context.
	Server string `json:"server"`
	// Dial is the host:port this service connects to. It differs from Server's host when the API
	// server listens on the Docker host's loopback (host.docker.internal:<port>).
	Dial string `json:"dial"`
	// TLSServerName is the name the API server's certificate is verified against (Server's host).
	TLSServerName string `json:"tlsServerName"`
	// CAData is the cluster CA bundle, base64 PEM as in a kubeconfig.
	CAData            string `json:"caData"`
	Namespace         string `json:"namespace"`
	ControllerVersion string `json:"controllerVersion"`
	// HostAddress is the Docker host as pods reach it (192.168.65.254 on Docker Desktop).
	HostAddress string `json:"hostAddress"`
	// BindAddress is where the stack publishes the ports pods use.
	BindAddress   string        `json:"bindAddress"`
	Ports         Ports         `json:"ports"`
	NetworkPolicy NetworkPolicy `json:"networkPolicy"`
	EnabledAt     string        `json:"enabledAt"`
	// Backend is what runs the Tenant's sandboxes: agent-sandbox (the default when absent) or
	// substrate (ADR-138, Phase 1: preview).
	Backend string `json:"backend,omitempty"`
	// Substrate is the Agent Substrate setup, with backend substrate.
	Substrate *Substrate `json:"substrate,omitempty"`
}

// The backends.
const (
	BackendAgentSandbox = "agent-sandbox"
	BackendSubstrate    = "substrate"
)

// Substrate is where the Tenant's actors live and how the service reaches Substrate's API.
type Substrate struct {
	// Atespace holds the Tenant's actors and templates (nylorun-<tenant>).
	Atespace string `json:"atespace"`
	// SystemNamespace is Substrate's control-plane namespace (ate-system).
	SystemNamespace string `json:"systemNamespace"`
	// APIService is ate-api-server's Service (api), port 443, reached by a port-forward unless
	// Endpoint is set.
	APIService string `json:"apiService"`
	// Endpoint is a host:port that reaches ate-api-server directly, when one exists.
	Endpoint string `json:"endpoint,omitempty"`
	// ServiceAccount is the Tenant's ServiceAccount; the service mints its own Substrate token for it.
	ServiceAccount string `json:"serviceAccount"`
	// Version is the Substrate release `enable` found.
	Version string `json:"version,omitempty"`
	// Edge is the TLS front actors reach the Harness API and the gates through.
	Edge Edge `json:"edge"`
	// WorkerSelector picks the worker pool, e.g. {"ate.dev/sandbox-class": "gvisor"}; empty: any.
	WorkerSelector map[string]string `json:"workerSelector,omitempty"`
}

// Edge is the service's TLS front for actors: Host is the name actors dial (in CoreDNS), and
// HarnessPort and GatesPort are the ports published on the bind address.
type Edge struct {
	Host        string `json:"host"`
	HarnessPort int    `json:"harnessPort"`
	GatesPort   int    `json:"gatesPort"`
}

// Ports are the host ports pods may reach (the namespace's NetworkPolicy allows only these).
type Ports struct {
	Harness int `json:"harness"`
	Gates   int `json:"gates"`
	Egress  int `json:"egress"`
}

// NetworkPolicy is the result of `enable`'s probe.
type NetworkPolicy struct {
	Enforced bool   `json:"enforced"`
	ProbedAt string `json:"probedAt"`
}

// Config is the service's configuration.
type Config struct {
	Cluster Cluster
	// Listen is the API's address (NYLORUN_SANDBOXES_LISTEN, default :4300).
	Listen string
	// Token is the bearer core presents (NYLORUN_SANDBOXES_TOKEN).
	Token string
	// TokenFile holds the ServiceAccount token for the API server.
	TokenFile string
}

// DefaultDir is where Compose mounts `<Host root>/sandboxes`.
const DefaultDir = "/run/nylorun/sandboxes"

// Load reads the environment and `<dir>/cluster.json`.
func Load(getenv func(string) string) (Config, error) {
	dir := getenv("NYLORUN_SANDBOXES_DIR")
	if dir == "" {
		dir = DefaultDir
	}
	token := strings.TrimSpace(getenv("NYLORUN_SANDBOXES_TOKEN"))
	if len(token) < 32 {
		return Config{}, errors.New("NYLORUN_SANDBOXES_TOKEN must be set (at least 32 characters)")
	}
	listen := getenv("NYLORUN_SANDBOXES_LISTEN")
	if listen == "" {
		listen = ":4300"
	}
	raw, err := os.ReadFile(filepath.Join(dir, "cluster.json"))
	if err != nil {
		return Config{}, fmt.Errorf("read cluster.json (run nylorun local sandbox enable): %w", err)
	}
	cluster, err := ParseCluster(raw)
	if err != nil {
		return Config{}, err
	}
	return Config{Cluster: cluster, Listen: listen, Token: token, TokenFile: filepath.Join(dir, "token")}, nil
}

// ParseCluster decodes and validates cluster.json.
func ParseCluster(raw []byte) (Cluster, error) {
	var c Cluster
	if err := json.Unmarshal(raw, &c); err != nil {
		return Cluster{}, fmt.Errorf("cluster.json: %w", err)
	}
	if c.Namespace == "" || c.Dial == "" || c.CAData == "" {
		return Cluster{}, errors.New("cluster.json: namespace, dial and caData are required")
	}
	if _, port, err := net.SplitHostPort(c.Dial); err != nil || port == "" {
		return Cluster{}, fmt.Errorf("cluster.json: dial %q is not host:port", c.Dial)
	}
	if _, err := base64.StdEncoding.DecodeString(c.CAData); err != nil {
		return Cluster{}, fmt.Errorf("cluster.json: caData is not base64: %w", err)
	}
	switch c.Backend {
	case "", BackendAgentSandbox:
		c.Backend = BackendAgentSandbox
	case BackendSubstrate:
		s := c.Substrate
		if s == nil || s.Atespace == "" || s.SystemNamespace == "" || s.APIService == "" || s.ServiceAccount == "" {
			return Cluster{}, errors.New("cluster.json: backend substrate needs substrate.atespace, systemNamespace, apiService and serviceAccount")
		}
		if s.Edge.Host == "" || s.Edge.HarnessPort == 0 || s.Edge.GatesPort == 0 {
			return Cluster{}, errors.New("cluster.json: backend substrate needs substrate.edge host, harnessPort and gatesPort")
		}
	default:
		return Cluster{}, fmt.Errorf("cluster.json: backend %q is not agent-sandbox or substrate", c.Backend)
	}
	return c, nil
}

// EdgeURLs are what an actor dials for the Harness API and the gates: the edge's name and ports.
func (c Cluster) EdgeURLs() (harness, gates string) {
	if c.Substrate == nil {
		return "", ""
	}
	e := c.Substrate.Edge
	return "https://" + net.JoinHostPort(e.Host, strconv.Itoa(e.HarnessPort)),
		"https://" + net.JoinHostPort(e.Host, strconv.Itoa(e.GatesPort))
}

// Rest is the client-go configuration: dial `Dial`, verify the certificate against
// `TLSServerName` and the recorded CA, authenticate with the ServiceAccount token file
// (re-read by client-go when it changes).
func (c Config) Rest() (*rest.Config, error) {
	ca, err := base64.StdEncoding.DecodeString(c.Cluster.CAData)
	if err != nil {
		return nil, err
	}
	return &rest.Config{
		Host:            "https://" + c.Cluster.Dial,
		BearerTokenFile: c.TokenFile,
		TLSClientConfig: rest.TLSClientConfig{CAData: ca, ServerName: c.Cluster.TLSServerName},
		Timeout:         20 * time.Second,
		UserAgent:       "nylorun-sandboxes",
		QPS:             20,
		Burst:           40,
	}, nil
}

// PodURLs are the addresses a pod uses for the Harness API, the gates and egress, on the
// Docker host. A zero port yields an empty URL.
func (c Cluster) PodURLs() (harness, gates, egress string) {
	url := func(port int) string {
		if port == 0 || c.HostAddress == "" {
			return ""
		}
		return "http://" + net.JoinHostPort(c.HostAddress, strconv.Itoa(port))
	}
	return url(c.Ports.Harness), url(c.Ports.Gates), url(c.Ports.Egress)
}
