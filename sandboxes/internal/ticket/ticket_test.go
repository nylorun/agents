package ticket

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"encoding/pem"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestSignVerify(t *testing.T) {
	public, private, _ := ed25519.GenerateKey(rand.Reader)
	now := time.Unix(1_800_000_000, 0)
	token := Sign(private, "sbx-a-g0", now.Add(time.Minute))
	c, err := Verify(token, public, now)
	if err != nil || c.Subject != "sbx-a-g0" {
		t.Fatalf("verify: %v %+v", err, c)
	}
	if _, err := Verify(token, public, now.Add(2*time.Minute)); !errors.Is(err, ErrInvalid) {
		t.Fatalf("an expired ticket held: %v", err)
	}
	other, _, _ := ed25519.GenerateKey(rand.Reader)
	if _, err := Verify(token, other, now); !errors.Is(err, ErrInvalid) {
		t.Fatalf("another key's ticket held: %v", err)
	}
	parts := strings.Split(token, ".")
	if _, err := Verify(parts[0]+"."+parts[1]+"x."+parts[2], public, now); !errors.Is(err, ErrInvalid) {
		t.Fatalf("a changed payload held: %v", err)
	}
}

func TestLoadPrivate(t *testing.T) {
	_, private, _ := ed25519.GenerateKey(rand.Reader)
	der, _ := x509.MarshalPKCS8PrivateKey(private)
	path := filepath.Join(t.TempDir(), "ticket.key")
	if err := os.WriteFile(path, pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der}), 0o600); err != nil {
		t.Fatal(err)
	}
	loaded, err := LoadPrivate(path)
	if err != nil || !loaded.Equal(private) {
		t.Fatalf("load: %v", err)
	}
	pub, err := PublicPEM(loaded)
	if err != nil || !strings.Contains(pub, "BEGIN PUBLIC KEY") {
		t.Fatalf("public: %v %q", err, pub)
	}
}
