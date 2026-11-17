// Package ticket reads and checks computer tickets (ADR-148, the Runtime on Kubernetes plan):
// compact JWS tokens core signs with Ed25519 (`alg: EdDSA`), with `aud: "nylorun-computer"`, `sub`
// the sandbox's name and `exp` in seconds. The sandbox gateway checks them, and the computer's
// engine checks them again with the public key its template carries.
package ticket

import (
	"crypto/ed25519"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"os"
	"strings"
	"time"
)

// Audience is every ticket's `aud`.
const Audience = "nylorun-computer"

// Claims are a ticket's payload.
type Claims struct {
	Audience string `json:"aud"`
	Subject  string `json:"sub"`
	Expires  int64  `json:"exp"`
}

// LoadPrivate reads a PKCS #8 PEM Ed25519 private key.
func LoadPrivate(path string) (ed25519.PrivateKey, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read the computer ticket key: %w", err)
	}
	block, _ := pem.Decode(raw)
	if block == nil {
		return nil, fmt.Errorf("%s is not PEM", path)
	}
	key, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	if err != nil {
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	private, ok := key.(ed25519.PrivateKey)
	if !ok {
		return nil, fmt.Errorf("%s is not an Ed25519 key", path)
	}
	return private, nil
}

// PublicPEM is the key's public half as SPKI PEM.
func PublicPEM(private ed25519.PrivateKey) (string, error) {
	der, err := x509.MarshalPKIXPublicKey(private.Public())
	if err != nil {
		return "", err
	}
	return string(pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der})), nil
}

// Sign makes a ticket (for tests and tools; core signs the real ones).
func Sign(private ed25519.PrivateKey, subject string, expires time.Time) string {
	enc := base64.RawURLEncoding
	header := enc.EncodeToString([]byte(`{"alg":"EdDSA","typ":"JWT"}`))
	body, _ := json.Marshal(Claims{Audience: Audience, Subject: subject, Expires: expires.Unix()})
	input := header + "." + enc.EncodeToString(body)
	return input + "." + enc.EncodeToString(ed25519.Sign(private, []byte(input)))
}

// ErrInvalid is any ticket that doesn't hold.
var ErrInvalid = errors.New("invalid ticket")

// Verify checks a ticket's signature, audience and expiry, and returns its claims.
func Verify(token string, public ed25519.PublicKey, now time.Time) (Claims, error) {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return Claims{}, fmt.Errorf("%w: not a compact JWS", ErrInvalid)
	}
	enc := base64.RawURLEncoding
	headerRaw, err := enc.DecodeString(parts[0])
	if err != nil {
		return Claims{}, fmt.Errorf("%w: header", ErrInvalid)
	}
	var header struct {
		Alg string `json:"alg"`
	}
	if json.Unmarshal(headerRaw, &header) != nil || header.Alg != "EdDSA" {
		return Claims{}, fmt.Errorf("%w: alg is not EdDSA", ErrInvalid)
	}
	sig, err := enc.DecodeString(parts[2])
	if err != nil || !ed25519.Verify(public, []byte(parts[0]+"."+parts[1]), sig) {
		return Claims{}, fmt.Errorf("%w: signature", ErrInvalid)
	}
	bodyRaw, err := enc.DecodeString(parts[1])
	if err != nil {
		return Claims{}, fmt.Errorf("%w: payload", ErrInvalid)
	}
	var c Claims
	if err := json.Unmarshal(bodyRaw, &c); err != nil {
		return Claims{}, fmt.Errorf("%w: payload", ErrInvalid)
	}
	if c.Audience != Audience {
		return Claims{}, fmt.Errorf("%w: audience", ErrInvalid)
	}
	if c.Subject == "" {
		return Claims{}, fmt.Errorf("%w: no subject", ErrInvalid)
	}
	if now.Unix() >= c.Expires {
		return Claims{}, fmt.Errorf("%w: expired", ErrInvalid)
	}
	return c, nil
}

// Check is the computer's own check of a ticket, as the engine's `checkTicket`
// (runtime/server/src/harness/computer.ts) does it, for the computer agent to answer the same:
// "" when the ticket holds for the computer named subject, or why it doesn't, in the engine's
// words: "no ticket", "malformed", "alg", "signature", "audience", "subject" or "expired". It
// decodes base64url as leniently as Node does, and takes `exp` as any JSON number, compared with
// the time in milliseconds.
func Check(token string, public ed25519.PublicKey, subject string, now time.Time) string {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return "no ticket"
	}
	var header any
	if json.Unmarshal(lenientBase64URL(parts[0]), &header) != nil {
		return "malformed"
	}
	switch h := header.(type) {
	case nil:
		return "malformed" // JSON null: the engine fails reading its alg
	case map[string]any:
		if alg, _ := h["alg"].(string); alg != "EdDSA" {
			return "alg"
		}
	default:
		return "alg"
	}
	if len(public) != ed25519.PublicKeySize || !ed25519.Verify(public, []byte(parts[0]+"."+parts[1]), lenientBase64URL(parts[2])) {
		return "signature"
	}
	var payload any
	if json.Unmarshal(lenientBase64URL(parts[1]), &payload) != nil || payload == nil {
		return "malformed"
	}
	claims, ok := payload.(map[string]any)
	if !ok {
		return "audience"
	}
	if aud, _ := claims["aud"].(string); aud != Audience {
		return "audience"
	}
	if sub, isString := claims["sub"].(string); !isString || sub != subject {
		return "subject"
	}
	exp, isNumber := claims["exp"].(float64)
	if !isNumber || float64(now.UnixMilli())/1000 >= exp {
		return "expired"
	}
	return ""
}

// lenientBase64URL decodes as Node's Buffer.from(s, "base64url") does: either alphabet, anything
// else skipped, decoding stopped at padding, and a lone trailing character dropped.
func lenientBase64URL(s string) []byte {
	clean := make([]byte, 0, len(s))
	for i := 0; i < len(s) && s[i] != '='; i++ {
		switch c := s[i]; {
		case c == '+':
			clean = append(clean, '-')
		case c == '/':
			clean = append(clean, '_')
		case c >= 'A' && c <= 'Z', c >= 'a' && c <= 'z', c >= '0' && c <= '9', c == '-', c == '_':
			clean = append(clean, c)
		}
	}
	if len(clean)%4 == 1 {
		clean = clean[:len(clean)-1]
	}
	out, _ := base64.RawURLEncoding.DecodeString(string(clean))
	return out
}
