// Package config reads the files `nylorun sandbox enable` writes under
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

// Cluster is cluster.json, as `nylorun sandbox enable` records it.
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
		return Config{}, fmt.Errorf("read cluster.json (run nylorun sandbox enable): %w", err)
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
	return c, nil
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
