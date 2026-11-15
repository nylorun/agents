package gateway

import (
	"bufio"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/nylorun/agents/sandboxes/internal/ticket"
)

const sbx = "sbx-ub6g5m7mvjlct6r7-g0"

// fakeRouter answers CONNECT for any actor, records the header, and pipes to backend.
type fakeRouter struct {
	ln      net.Listener
	backend string
	mu      sync.Mutex
	actors  []string
}

func newFakeRouter(t *testing.T, backend string) *fakeRouter {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	f := &fakeRouter{ln: ln, backend: backend}
	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			go f.serve(conn)
		}
	}()
	t.Cleanup(func() { _ = ln.Close() })
	return f
}

func (f *fakeRouter) serve(conn net.Conn) {
	reader := bufio.NewReader(conn)
	req, err := http.ReadRequest(reader)
	if err != nil || req.Method != http.MethodConnect {
		_ = conn.Close()
		return
	}
	f.mu.Lock()
	f.actors = append(f.actors, req.Header.Get("Ate-Target-Actor")+" "+req.Host)
	f.mu.Unlock()
	upstream, err := net.Dial("tcp", f.backend)
	if err != nil {
		_, _ = conn.Write([]byte("HTTP/1.1 503 Service Unavailable\r\n\r\n"))
		_ = conn.Close()
		return
	}
	_, _ = conn.Write([]byte("HTTP/1.1 200 OK\r\n\r\n"))
	go func() { _, _ = io.Copy(upstream, reader); _ = upstream.Close() }()
	_, _ = io.Copy(conn, upstream)
	_ = conn.Close()
}

func rig(t *testing.T) (*httptest.Server, *fakeRouter, ed25519.PrivateKey) {
	t.Helper()
	computer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(r.Method + " " + r.URL.RequestURI() + " " + r.Header.Get(Header)[:3]))
	}))
	t.Cleanup(computer.Close)
	router := newFakeRouter(t, computer.Listener.Addr().String())
	public, private, _ := ed25519.GenerateKey(rand.Reader)
	s := &Server{Public: public, Atespace: "nylorun", Port: 8080, Log: slog.New(slog.NewTextHandler(io.Discard, nil)),
		Dial: func(ctx context.Context, actor, authority string) (net.Conn, error) {
			return Connect(ctx, (&net.Dialer{}).DialContext, router.ln.Addr().String(), actor, authority)
		}}
	gw := httptest.NewServer(s.Handler())
	t.Cleanup(gw.Close)
	return gw, router, private
}

func TestTheGatewayTunnelsToTheComputer(t *testing.T) {
	gw, router, private := rig(t)
	req, _ := http.NewRequest(http.MethodPost, gw.URL+"/"+sbx+"/v1/exec?x=1", strings.NewReader("{}"))
	req.Header.Set(Header, ticket.Sign(private, sbx, time.Now().Add(time.Minute)))
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(res.Body)
	if res.StatusCode != 200 || string(body) != "POST /v1/exec?x=1 eyJ" {
		t.Fatalf("%d %q", res.StatusCode, body)
	}
	router.mu.Lock()
	defer router.mu.Unlock()
	if len(router.actors) != 1 || router.actors[0] != "nylorun/"+sbx+" "+sbx+":8080" {
		t.Fatalf("CONNECT %v", router.actors)
	}
}

func TestTheGatewayRefusesWithoutTheComputersTicket(t *testing.T) {
	gw, _, private := rig(t)
	for name, token := range map[string]string{
		"none":    "",
		"other":   ticket.Sign(private, "sbx-aaaaaaaaaaaaaaaa-g0", time.Now().Add(time.Minute)),
		"expired": ticket.Sign(private, sbx, time.Now().Add(-time.Minute)),
		"mangled": "a.b.c",
	} {
		req, _ := http.NewRequest(http.MethodGet, gw.URL+"/"+sbx+"/v1/info", nil)
		if token != "" {
			req.Header.Set(Header, token)
		}
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		if res.StatusCode != http.StatusUnauthorized {
			t.Fatalf("%s: %d", name, res.StatusCode)
		}
	}
	res, _ := http.Get(gw.URL + "/not-a-sandbox/v1/info")
	if res.StatusCode != http.StatusNotFound {
		t.Fatalf("bad name: %d", res.StatusCode)
	}
}

func TestARefusedTunnelIsABadGateway(t *testing.T) {
	public, private, _ := ed25519.GenerateKey(rand.Reader)
	ln, _ := net.Listen("tcp", "127.0.0.1:0")
	defer ln.Close()
	go func() {
		conn, err := ln.Accept()
		if err == nil {
			_, _ = http.ReadRequest(bufio.NewReader(conn))
			_, _ = conn.Write([]byte("HTTP/1.1 403 Forbidden\r\n\r\n"))
			_ = conn.Close()
		}
	}()
	s := &Server{Public: public, Atespace: "nylorun", Port: 8080, Log: slog.New(slog.NewTextHandler(io.Discard, nil)),
		Dial: func(ctx context.Context, actor, authority string) (net.Conn, error) {
			return Connect(ctx, (&net.Dialer{}).DialContext, ln.Addr().String(), actor, authority)
		}}
	gw := httptest.NewServer(s.Handler())
	defer gw.Close()
	req, _ := http.NewRequest(http.MethodGet, gw.URL+"/"+sbx+"/v1/info", nil)
	req.Header.Set(Header, ticket.Sign(private, sbx, time.Now().Add(time.Minute)))
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	if res.StatusCode != http.StatusBadGateway {
		t.Fatalf("%d", res.StatusCode)
	}
}
