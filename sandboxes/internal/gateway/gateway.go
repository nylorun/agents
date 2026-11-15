// Package gateway is the sandbox gateway (ADR-148): the one client of Agent Substrate's router
// the Runtime adds. Core and the harness call `/{sandbox}/…` with a computer ticket; the gateway
// checks it, opens an mTLS CONNECT tunnel to atenet-router with `ate-target-actor:
// <atespace>/<sandbox>`, and proxies the request to the computer's engine inside it. It holds no
// Kubernetes rights and keeps no state: the router resumes, parks and routes each request.
package gateway

import (
	"bufio"
	"context"
	"crypto/ed25519"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"strconv"
	"time"

	"github.com/nylorun/agents/sandboxes/internal/driver"
	"github.com/nylorun/agents/sandboxes/internal/ticket"
)

// Header is where a caller puts its ticket; the gateway passes it on to the computer.
const Header = "X-Nylorun-Ticket"

// Router is how the gateway reaches atenet-router's CONNECT listener.
type Router struct {
	// Address is host:port (atenet-router.ate-system.svc:8444).
	Address string
	// ServerName is the name its certificate is checked against (atenet-router.ate-system.svc).
	ServerName string
	// CredentialFile holds this pod's certificate chain and key (a podCertificate projected
	// volume); it is read on each handshake, as the kubelet rotates it.
	CredentialFile string
	// CAFile is the router's serving CA (a clusterTrustBundle projected volume), read on each dial.
	CAFile string
}

// Server is the gateway.
type Server struct {
	Public   ed25519.PublicKey
	Atespace string
	// Port is the computer's port in the actor.
	Port   int
	Router Router
	Log    *slog.Logger
	// Now is the clock tickets are checked against; default time.Now.
	Now func() time.Time
	// Dial replaces the router dial (tests).
	Dial func(ctx context.Context, actor, authority string) (net.Conn, error)

	proxy *httputil.ReverseProxy
}

type routed struct{ sandbox, path string }

type ctxKey struct{}

// Handler is the gateway's routes: `/healthz`, and `/{sandbox}/{path...}`.
func (s *Server) Handler() http.Handler {
	if s.Now == nil {
		s.Now = time.Now
	}
	dial := s.Dial
	if dial == nil {
		dial = s.Router.dial
	}
	transport := &http.Transport{
		DialContext: func(ctx context.Context, _, addr string) (net.Conn, error) {
			host, _, err := net.SplitHostPort(addr)
			if err != nil {
				return nil, err
			}
			return dial(ctx, s.Atespace+"/"+host, addr)
		},
		MaxIdleConnsPerHost: 8,
		IdleConnTimeout:     60 * time.Second,
		DisableCompression:  true,
	}
	s.proxy = &httputil.ReverseProxy{
		Rewrite: func(r *httputil.ProxyRequest) {
			rt := r.In.Context().Value(ctxKey{}).(routed)
			r.Out.URL = &url.URL{Scheme: "http", Host: net.JoinHostPort(rt.sandbox, strconv.Itoa(s.Port)),
				Path: "/" + rt.path, RawQuery: r.In.URL.RawQuery}
			r.Out.Host = r.Out.URL.Host
		},
		Transport:     transport,
		FlushInterval: -1,
		ErrorHandler: func(w http.ResponseWriter, r *http.Request, err error) {
			rt, _ := r.Context().Value(ctxKey{}).(routed)
			s.Log.Warn("gateway: the computer can't be reached", "sandbox", rt.sandbox, "error", err)
			fail(w, http.StatusBadGateway, "computer_unreachable", "The computer can't be reached: "+err.Error())
		},
	}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte("ok")) })
	mux.HandleFunc("/{sandbox}/{path...}", s.serve)
	return mux
}

func (s *Server) serve(w http.ResponseWriter, r *http.Request) {
	sandbox := r.PathValue("sandbox")
	if err := driver.ValidateName(sandbox); err != nil {
		fail(w, http.StatusNotFound, "not_found", "No such sandbox")
		return
	}
	claims, err := ticket.Verify(r.Header.Get(Header), s.Public, s.Now())
	if err != nil || claims.Subject != sandbox {
		fail(w, http.StatusUnauthorized, "unauthorized", "A ticket for this computer is required")
		return
	}
	ctx := context.WithValue(r.Context(), ctxKey{}, routed{sandbox: sandbox, path: r.PathValue("path")})
	s.proxy.ServeHTTP(w, r.WithContext(ctx))
}

func fail(w http.ResponseWriter, status int, code, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]any{"error": map[string]string{"code": code, "message": message}})
}

// dial opens a CONNECT tunnel to authority through the router, for actor.
func (r Router) dial(ctx context.Context, actor, authority string) (net.Conn, error) {
	caPEM, err := os.ReadFile(r.CAFile)
	if err != nil {
		return nil, fmt.Errorf("read the router's CA: %w", err)
	}
	roots := x509.NewCertPool()
	if !roots.AppendCertsFromPEM(caPEM) {
		return nil, errors.New("the router's CA file holds no certificate")
	}
	config := &tls.Config{
		MinVersion: tls.VersionTLS12,
		ServerName: r.ServerName,
		RootCAs:    roots,
		GetClientCertificate: func(*tls.CertificateRequestInfo) (*tls.Certificate, error) {
			cert, err := tls.LoadX509KeyPair(r.CredentialFile, r.CredentialFile)
			if err != nil {
				return nil, fmt.Errorf("read this pod's certificate: %w", err)
			}
			return &cert, nil
		},
	}
	return Connect(ctx, (&tls.Dialer{Config: config}).DialContext, r.Address, actor, authority)
}

// Connect dials address with dial and asks for a tunnel to authority for actor.
func Connect(ctx context.Context, dial func(ctx context.Context, network, address string) (net.Conn, error), address, actor, authority string) (net.Conn, error) {
	conn, err := dial(ctx, "tcp", address)
	if err != nil {
		return nil, err
	}
	if deadline, ok := ctx.Deadline(); ok {
		_ = conn.SetDeadline(deadline)
	} else {
		_ = conn.SetDeadline(time.Now().Add(30 * time.Second))
	}
	request := &http.Request{
		Method: http.MethodConnect,
		URL:    &url.URL{Opaque: authority},
		Host:   authority,
		Header: http.Header{"Ate-Target-Actor": {actor}},
	}
	if err := request.Write(conn); err != nil {
		_ = conn.Close()
		return nil, err
	}
	reader := bufio.NewReader(conn)
	response, err := http.ReadResponse(reader, request)
	if err != nil {
		_ = conn.Close()
		return nil, fmt.Errorf("the router's answer to CONNECT: %w", err)
	}
	if response.StatusCode != http.StatusOK {
		_ = conn.Close()
		return nil, fmt.Errorf("the router refused the tunnel to %s: %s", actor, response.Status)
	}
	_ = conn.SetDeadline(time.Time{})
	return &bufferedConn{Conn: conn, reader: reader}, nil
}

type bufferedConn struct {
	net.Conn
	reader *bufio.Reader
}

func (c *bufferedConn) Read(p []byte) (int, error) { return c.reader.Read(p) }

// LoadPublic is the public half of the ticket key file.
func LoadPublic(path string) (ed25519.PublicKey, error) {
	private, err := ticket.LoadPrivate(path)
	if err != nil {
		return nil, err
	}
	return private.Public().(ed25519.PublicKey), nil
}
