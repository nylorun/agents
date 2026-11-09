package edge

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"fmt"
	"math/big"
	"os"
	"path/filepath"
	"time"
)

// WriteCert makes a CA and a certificate for host under dir: edge-ca.pem (the CA, which actors
// trust), edge.crt and edge.key (0600). The CA's key is not kept: a new certificate means a new
// CA, which `nylorun local sandbox enable` writes again.
func WriteCert(dir, host string, now time.Time) error {
	caKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return err
	}
	serial := func() *big.Int {
		n, _ := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 120))
		return n
	}
	caTemplate := &x509.Certificate{
		SerialNumber:          serial(),
		Subject:               pkix.Name{CommonName: "Nylorun sandboxes edge CA"},
		NotBefore:             now.Add(-time.Hour),
		NotAfter:              now.AddDate(10, 0, 0),
		KeyUsage:              x509.KeyUsageCertSign | x509.KeyUsageCRLSign,
		BasicConstraintsValid: true,
		IsCA:                  true,
		MaxPathLenZero:        true,
	}
	caDER, err := x509.CreateCertificate(rand.Reader, caTemplate, caTemplate, &caKey.PublicKey, caKey)
	if err != nil {
		return err
	}
	ca, err := x509.ParseCertificate(caDER)
	if err != nil {
		return err
	}
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return err
	}
	leaf := &x509.Certificate{
		SerialNumber: serial(),
		Subject:      pkix.Name{CommonName: host},
		DNSNames:     []string{host},
		NotBefore:    now.Add(-time.Hour),
		NotAfter:     now.AddDate(5, 0, 0),
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	}
	leafDER, err := x509.CreateCertificate(rand.Reader, leaf, ca, &key.PublicKey, caKey)
	if err != nil {
		return err
	}
	keyDER, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		return err
	}
	write := func(name string, mode os.FileMode, blocks ...*pem.Block) error {
		var out []byte
		for _, b := range blocks {
			out = append(out, pem.EncodeToMemory(b)...)
		}
		path := filepath.Join(dir, name)
		if err := os.WriteFile(path, out, mode); err != nil {
			return fmt.Errorf("write %s: %w", path, err)
		}
		return os.Chmod(path, mode)
	}
	if err := write("edge-ca.pem", 0o644, &pem.Block{Type: "CERTIFICATE", Bytes: caDER}); err != nil {
		return err
	}
	if err := write("edge.crt", 0o644, &pem.Block{Type: "CERTIFICATE", Bytes: leafDER}, &pem.Block{Type: "CERTIFICATE", Bytes: caDER}); err != nil {
		return err
	}
	return write("edge.key", 0o600, &pem.Block{Type: "EC PRIVATE KEY", Bytes: keyDER})
}
