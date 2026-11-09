package edge

import (
	"bufio"
	"crypto/tls"
	"crypto/x509"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestProxySetsTheUpstreamHost(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, r.Host+" "+r.URL.Path)
	}))
	defer upstream.Close()
	target, _ := url.Parse(upstream.URL)
	front := httptest.NewTLSServer(Proxy(target, slog.New(slog.DiscardHandler)))
	defer front.Close()
	res, err := front.Client().Get(front.URL + "/nylorun/harness/v1/host/join")
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(res.Body)
	_ = res.Body.Close()
	if string(body) != target.Host+" /nylorun/harness/v1/host/join" {
		t.Fatalf("upstream saw %q", body)
	}
}

func TestProxyPassesUpgrades(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.EqualFold(r.Header.Get("Upgrade"), "websocket") {
			http.Error(w, "no upgrade", 400)
			return
		}
		conn, rw, err := w.(http.Hijacker).Hijack()
		if err != nil {
			return
		}
		defer conn.Close()
		_, _ = rw.WriteString("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n")
		_ = rw.Flush()
		line, _ := rw.ReadString('\n')
		_, _ = rw.WriteString("echo " + line)
		_ = rw.Flush()
	}))
	defer upstream.Close()
	target, _ := url.Parse(upstream.URL)
	front := httptest.NewServer(Proxy(target, slog.New(slog.DiscardHandler)))
	defer front.Close()
	conn, err := net.Dial("tcp", strings.TrimPrefix(front.URL, "http://"))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	_, _ = io.WriteString(conn, "GET /nylorun/harness/v1 HTTP/1.1\r\nHost: edge\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n")
	reader := bufio.NewReader(conn)
	status, _ := reader.ReadString('\n')
	if !strings.Contains(status, "101") {
		t.Fatalf("status %q", status)
	}
	for {
		line, err := reader.ReadString('\n')
		if err != nil || line == "\r\n" {
			break
		}
	}
	_, _ = io.WriteString(conn, "hello\n")
	echoed, _ := reader.ReadString('\n')
	if echoed != "echo hello\n" {
		t.Fatalf("echoed %q", echoed)
	}
}

func TestWriteCertChainsToItsCA(t *testing.T) {
	dir := t.TempDir()
	if err := WriteCert(dir, "edge.shop.nylorun.internal", time.Now()); err != nil {
		t.Fatal(err)
	}
	cert, err := tls.LoadX509KeyPair(filepath.Join(dir, "edge.crt"), filepath.Join(dir, "edge.key"))
	if err != nil {
		t.Fatal(err)
	}
	caPEM, _ := os.ReadFile(filepath.Join(dir, "edge-ca.pem"))
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM(caPEM) {
		t.Fatal("no CA")
	}
	leaf, _ := x509.ParseCertificate(cert.Certificate[0])
	if _, err := leaf.Verify(x509.VerifyOptions{DNSName: "edge.shop.nylorun.internal", Roots: pool}); err != nil {
		t.Fatal(err)
	}
	if info, _ := os.Stat(filepath.Join(dir, "edge.key")); info.Mode().Perm() != 0o600 {
		t.Fatalf("key mode %v", info.Mode())
	}
}
