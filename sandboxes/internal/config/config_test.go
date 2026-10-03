package config_test

import (
	"encoding/base64"
	"os"
	"path/filepath"
	"testing"

	"github.com/nylorun/agents/sandboxes/internal/config"
)

func TestLoad(t *testing.T) {
	dir := t.TempDir()
	ca := base64.StdEncoding.EncodeToString([]byte("-----BEGIN CERTIFICATE-----\n"))
	cluster := `{"context":"docker-desktop","server":"https://127.0.0.1:6443","dial":"host.docker.internal:6443",
		"tlsServerName":"127.0.0.1","caData":"` + ca + `","namespace":"nylorun-sbx-shop","controllerVersion":"v1.0.5",
		"hostAddress":"192.168.65.254","bindAddress":"127.0.0.1","ports":{"harness":41001,"gates":41002,"egress":41003},
		"networkPolicy":{"enforced":true,"probedAt":"2026-10-03T00:00:00Z"},"enabledAt":"2026-10-03T00:00:00Z"}`
	if err := os.WriteFile(filepath.Join(dir, "cluster.json"), []byte(cluster), 0o600); err != nil {
		t.Fatal(err)
	}
	env := map[string]string{"NYLORUN_SANDBOXES_DIR": dir, "NYLORUN_SANDBOXES_TOKEN": "short"}
	if _, err := config.Load(func(k string) string { return env[k] }); err == nil {
		t.Fatal("a short token is refused")
	}
	env["NYLORUN_SANDBOXES_TOKEN"] = "0123456789abcdef0123456789abcdef"
	cfg, err := config.Load(func(k string) string { return env[k] })
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Listen != ":4300" || cfg.TokenFile != filepath.Join(dir, "token") {
		t.Fatalf("defaults: %+v", cfg)
	}
	rest, err := cfg.Rest()
	if err != nil {
		t.Fatal(err)
	}
	// Dial the Docker host, verify the kubeconfig's own server name.
	if rest.Host != "https://host.docker.internal:6443" || rest.TLSClientConfig.ServerName != "127.0.0.1" ||
		rest.BearerTokenFile != cfg.TokenFile || string(rest.TLSClientConfig.CAData) != "-----BEGIN CERTIFICATE-----\n" {
		t.Fatalf("rest config: %+v", rest)
	}
	harness, gates, egress := cfg.Cluster.PodURLs()
	if harness != "http://192.168.65.254:41001" || gates != "http://192.168.65.254:41002" || egress != "http://192.168.65.254:41003" {
		t.Fatal("pod URLs", harness, gates, egress)
	}
	for _, bad := range []string{`{}`, `{"namespace":"n","dial":"nohost","caData":"x"}`, `{"namespace":"n","dial":"h:1","caData":"%%"}`} {
		if _, err := config.ParseCluster([]byte(bad)); err == nil {
			t.Errorf("%s is refused", bad)
		}
	}
}
