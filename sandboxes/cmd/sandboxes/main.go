// Command sandboxes is Nylorun's sandboxes service: the only holder of the cluster
// credentials, it drives agent-sandbox Sandboxes in the Tenant's namespace for the Runtime's
// core (D32). `sandboxes healthcheck` probes /ready for the Compose health check.
package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"k8s.io/client-go/dynamic"

	"github.com/nylorun/agents/sandboxes/internal/api"
	"github.com/nylorun/agents/sandboxes/internal/config"
	"github.com/nylorun/agents/sandboxes/internal/driver"
)

func main() {
	if len(os.Args) > 1 && os.Args[1] == "healthcheck" {
		os.Exit(healthcheck())
	}
	log := slog.New(slog.NewJSONHandler(os.Stdout, nil))
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

func run(log *slog.Logger) error {
	cfg, err := config.Load(os.Getenv)
	if err != nil {
		return err
	}
	restConfig, err := cfg.Rest()
	if err != nil {
		return err
	}
	client, err := dynamic.NewForConfig(restConfig)
	if err != nil {
		return err
	}
	harness, gates, egress := cfg.Cluster.PodURLs()
	d := driver.New(client, cfg.Cluster.Namespace, driver.PodURLs{Harness: harness, Gates: gates, Egress: egress})

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	d.Cache().Start(ctx)

	server := &http.Server{
		Addr:              cfg.Listen,
		Handler:           (&api.Server{Driver: d, Cluster: cfg.Cluster, Token: cfg.Token, Log: log}).Handler(),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       15 * time.Second,
		WriteTimeout:      api.MaxWait + 30*time.Second,
		IdleTimeout:       90 * time.Second,
	}
	go func() {
		<-ctx.Done()
		shutdown, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = server.Shutdown(shutdown)
	}()
	log.Info("sandboxes listening", "listen", cfg.Listen, "namespace", cfg.Cluster.Namespace,
		"context", cfg.Cluster.Context, "dial", cfg.Cluster.Dial)
	if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}
