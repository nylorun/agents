// Command sandboxes is Nylorun's sandboxes service: the only holder of the cluster
// credentials, it runs the Tenant's sandboxes for the Runtime's core (D32): as agent-sandbox
// Sandboxes, or as Agent Substrate actors (ADR-138, preview). `sandboxes healthcheck` probes
// /ready for the Compose health check; `sandboxes substrate-setup` makes the Tenant's atespace
// once, as one of Substrate's owners (`nylorun local sandbox enable --backend substrate`).
package main

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/kubernetes"

	"github.com/nylorun/agents/sandboxes/internal/api"
	"github.com/nylorun/agents/sandboxes/internal/config"
	"github.com/nylorun/agents/sandboxes/internal/driver"
	"github.com/nylorun/agents/sandboxes/internal/edge"
	"github.com/nylorun/agents/sandboxes/internal/substrate"
)

func main() {
	if len(os.Args) > 1 && os.Args[1] == "healthcheck" {
		os.Exit(healthcheck())
	}
	log := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	if len(os.Args) > 1 && os.Args[1] == "edge-cert" {
		// sandboxes edge-cert <host> <dir>: the edge's CA and certificate, for `enable`.
		if len(os.Args) != 4 {
			fmt.Fprintln(os.Stderr, "usage: sandboxes edge-cert <host> <dir>")
			os.Exit(2)
		}
		if err := edge.WriteCert(os.Args[3], os.Args[2], time.Now()); err != nil {
			fmt.Fprintln(os.Stderr, "edge-cert:", err)
			os.Exit(1)
		}
		return
	}
	if len(os.Args) > 1 && os.Args[1] == "substrate-setup" {
		if err := substrateSetup(); err != nil {
			fmt.Fprintln(os.Stderr, "substrate-setup:", err)
			os.Exit(1)
		}
		return
	}
	if err := run(log); err != nil {
		log.Error("sandboxes stopped", "error", err)
		os.Exit(1)
	}
}

func healthcheck() int {
	listen := os.Getenv("NYLORUN_SANDBOXES_LISTEN")
	if listen == "" {
		listen = ":4300"
	}
	_, port, err := net.SplitHostPort(listen)
	if err != nil {
		return 1
	}
	client := http.Client{Timeout: 4 * time.Second}
	response, err := client.Get("http://" + net.JoinHostPort("127.0.0.1", port) + "/ready")
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	_ = response.Body.Close()
	if response.StatusCode != http.StatusOK {
		fmt.Fprintln(os.Stderr, "not ready:", response.Status)
		return 1
	}
	return 0
}

// envOr is the variable, or def when it is unset.
func envOr(name, def string) string {
	if value := os.Getenv(name); value != "" {
		return value
	}
	return def
}

func run(log *slog.Logger) error {
	cfg, err := config.Load(os.Getenv)
	if err != nil {
		return err
	}
	restConfig, err := cfg.Rest()
	if err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	var backend api.Backend
	var side func(context.Context) error
	switch cfg.Cluster.Backend {
	case config.BackendSubstrate:
		backend, side, err = substrateBackend(ctx, cfg, log)
		if err != nil {
			return err
		}
	default:
		client, err := dynamic.NewForConfig(restConfig)
		if err != nil {
			return err
		}
		harness, gates, egress := cfg.Cluster.PodURLs()
		d := driver.New(client, cfg.Cluster.Namespace, driver.PodURLs{Harness: harness, Gates: gates, Egress: egress})
		d.Cache().Start(ctx)
		backend = d
	}

	server := &http.Server{
		Addr:              cfg.Listen,
		Handler:           (&api.Server{Driver: backend, Cluster: cfg.Cluster, Token: cfg.Token, Log: log}).Handler(),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       15 * time.Second,
		WriteTimeout:      api.MaxWait + 30*time.Second,
		IdleTimeout:       90 * time.Second,
	}
	errs := make(chan error, 2)
	if side != nil {
		go func() { errs <- side(ctx) }()
	}
	go func() {
		<-ctx.Done()
		shutdown, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = server.Shutdown(shutdown)
	}()
	log.Info("sandboxes listening", "listen", cfg.Listen, "backend", cfg.Cluster.Backend, "namespace", cfg.Cluster.Namespace,
		"context", cfg.Cluster.Context, "dial", cfg.Cluster.Dial)
	go func() {
		if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			errs <- err
			return
		}
		errs <- nil
	}()
	select {
	case err := <-errs:
		return err
	case <-ctx.Done():
		return nil
	}
}

// substrateBackend connects to Substrate and returns the driver and the edge, which runs beside
// the API: the TLS front actors reach the Harness API and the gates through.
func substrateBackend(ctx context.Context, cfg config.Config, log *slog.Logger) (api.Backend, func(context.Context) error, error) {
	sub := cfg.Cluster.Substrate
	restConfig, err := cfg.Rest()
	if err != nil {
		return nil, nil, err
	}
	kube, err := kubernetes.NewForConfig(restConfig)
	if err != nil {
		return nil, nil, err
	}
	dir := envOr("NYLORUN_SANDBOXES_DIR", config.DefaultDir)
	caPEM, err := os.ReadFile(filepath.Join(dir, "edge-ca.pem"))
	if err != nil {
		return nil, nil, fmt.Errorf("read the edge's CA (run nylorun local sandbox enable): %w", err)
	}
	cert, err := tls.LoadX509KeyPair(filepath.Join(dir, "edge.crt"), filepath.Join(dir, "edge.key"))
	if err != nil {
		return nil, nil, fmt.Errorf("read the edge's certificate: %w", err)
	}
	client, closeConn, err := substrate.Dial(ctx, substrate.ConnOptions{
		Rest: restConfig, Kube: kube, SystemNamespace: sub.SystemNamespace, APIService: sub.APIService,
		Endpoint: sub.Endpoint, Namespace: cfg.Cluster.Namespace, ServiceAccount: sub.ServiceAccount,
	})
	if err != nil {
		return nil, nil, err
	}
	harnessURL, gatesURL := cfg.Cluster.EdgeURLs()
	d := substrate.New(client, substrate.Options{
		Settings: substrate.Settings{
			Atespace: sub.Atespace, HarnessURL: harnessURL, GatesURL: gatesURL, EdgeHost: sub.Edge.Host,
			EdgePorts: []int{sub.Edge.HarnessPort, sub.Edge.GatesPort}, EdgeCA: string(caPEM), WorkerSelector: sub.WorkerSelector,
		},
		Namespace: cfg.Cluster.Namespace, Kube: kube, Resolver: &substrate.RegistryResolver{}, Log: log,
	})
	harnessUp, err := url.Parse(envOr("NYLORUN_SANDBOXES_EDGE_HARNESS_UPSTREAM", "http://runtime:4200"))
	if err != nil {
		return nil, nil, err
	}
	gatesUp, err := url.Parse(envOr("NYLORUN_SANDBOXES_EDGE_GATES_UPSTREAM", "http://gateway:4100"))
	if err != nil {
		return nil, nil, err
	}
	front := &edge.Server{Cert: cert, Log: log, Routes: []edge.Route{
		{Name: "harness", Listen: envOr("NYLORUN_SANDBOXES_EDGE_HARNESS_LISTEN", ":8443"), Upstream: harnessUp},
		{Name: "gates", Listen: envOr("NYLORUN_SANDBOXES_EDGE_GATES_LISTEN", ":8444"), Upstream: gatesUp},
	}}
	side := func(ctx context.Context) error {
		defer closeConn()
		go d.Run(ctx, 30*time.Second)
		return front.Run(ctx)
	}
	return d, side, nil
}

// substrateSetup makes the Tenant's atespace and its access policy with the owner token in
// NYLORUN_SUBSTRATE_OWNER_TOKEN or the file NYLORUN_SUBSTRATE_OWNER_TOKEN_FILE names (Substrate's
// ate-client, minted by `enable`), then exits.
func substrateSetup() error {
	owner := os.Getenv("NYLORUN_SUBSTRATE_OWNER_TOKEN")
	if file := os.Getenv("NYLORUN_SUBSTRATE_OWNER_TOKEN_FILE"); owner == "" && file != "" {
		raw, err := os.ReadFile(file)
		if err != nil {
			return err
		}
		owner = strings.TrimSpace(string(raw))
	}
	if owner == "" {
		return errors.New("NYLORUN_SUBSTRATE_OWNER_TOKEN or NYLORUN_SUBSTRATE_OWNER_TOKEN_FILE is not set")
	}
	dir := envOr("NYLORUN_SANDBOXES_DIR", config.DefaultDir)
	raw, err := os.ReadFile(filepath.Join(dir, "cluster.json"))
	if err != nil {
		return err
	}
	cluster, err := config.ParseCluster(raw)
	if err != nil {
		return err
	}
	if cluster.Backend != config.BackendSubstrate {
		return errors.New("cluster.json's backend is not substrate")
	}
	cfg := config.Config{Cluster: cluster, TokenFile: filepath.Join(dir, "token")}
	restConfig, err := cfg.Rest()
	if err != nil {
		return err
	}
	kube, err := kubernetes.NewForConfig(restConfig)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	sub := cluster.Substrate
	client, closeConn, err := substrate.Dial(ctx, substrate.ConnOptions{
		Rest: restConfig, Kube: kube, SystemNamespace: sub.SystemNamespace, APIService: sub.APIService,
		Endpoint: sub.Endpoint, StaticToken: owner,
	})
	if err != nil {
		return err
	}
	defer closeConn()
	principal := "user:system:serviceaccount:" + cluster.Namespace + ":" + sub.ServiceAccount
	if err := substrate.Setup(ctx, client, sub.Atespace, principal); err != nil {
		return err
	}
	fmt.Printf("atespace %s: %s is its editor\n", sub.Atespace, principal)
	return nil
}
