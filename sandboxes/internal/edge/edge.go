// Package edge is the TLS front Substrate actors reach the Runtime through (ADR-138, Phase 1).
// Substrate's egress gateway refuses WebSocket upgrades on cleartext and intercepted HTTP, so an
// actor's engine reaches the Harness API (a WebSocket) and the gates over TLS that the gateway
// passes through by name. The edge terminates that TLS and forwards to the Runtime's listeners on
// the Compose network, with the Host they accept.
package edge

import (
	"context"
	"crypto/tls"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"time"
)

// Route is one TLS listener and the upstream it forwards to.
type Route struct {
	// Name is for logs (harness, gates).
	Name string
	// Listen is the address inside the container (":8443").
	Listen string
	// Upstream is the Runtime's listener on the Compose network (http://runtime:4200).
	Upstream *url.URL
}

// Server serves the routes with one certificate.
type Server struct {
	Cert   tls.Certificate
	Routes []Route
	Log    *slog.Logger
}

// Proxy forwards to upstream with the upstream's Host, which its allow-list accepts, streaming
// WebSocket upgrades and server-sent events as they come.
func Proxy(upstream *url.URL, log *slog.Logger) http.Handler {
	proxy := &httputil.ReverseProxy{
		Rewrite: func(r *httputil.ProxyRequest) {
			r.SetURL(upstream)
			r.Out.Host = upstream.Host
			r.Out.Header.Del("Forwarded")
		},
		FlushInterval: -1,
		ErrorHandler: func(w http.ResponseWriter, r *http.Request, err error) {
			log.Warn("edge upstream", "upstream", upstream.String(), "path", r.URL.Path, "error", err)
			w.WriteHeader(http.StatusBadGateway)
		},
	}
	return proxy
}

// Run serves every route until ctx ends; it returns the first listener's error.
func (s *Server) Run(ctx context.Context) error {
	errs := make(chan error, len(s.Routes))
	var servers []*http.Server
	for _, route := range s.Routes {
		listener, err := net.Listen("tcp", route.Listen)
		if err != nil {
			return err
		}
		server := &http.Server{
			Handler:           Proxy(route.Upstream, s.Log),
			ReadHeaderTimeout: 10 * time.Second,
			TLSConfig:         &tls.Config{MinVersion: tls.VersionTLS12, Certificates: []tls.Certificate{s.Cert}},
		}
		servers = append(servers, server)
		s.Log.Info("edge listening", "route", route.Name, "listen", route.Listen, "upstream", route.Upstream.String())
		go func() {
			if err := server.ServeTLS(listener, "", ""); err != nil && !errors.Is(err, http.ErrServerClosed) {
				errs <- err
			}
		}()
	}
	select {
	case <-ctx.Done():
		shutdown, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		for _, server := range servers {
			_ = server.Shutdown(shutdown)
		}
		return nil
	case err := <-errs:
		return err
	}
}
