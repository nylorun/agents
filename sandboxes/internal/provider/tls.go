package provider

import (
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"os"
)

// DefaultInjector is the egress gateway's identity in Substrate's default install: the only
// caller the provider admits.
const DefaultInjector = "spiffe://cluster.local/ns/ate-system/sa/atenet-egress"

// ServerTLS is mutual TLS as Substrate's reference provider serves it: this pod's servicedns
// certificate (a PEM bundle of its chain and key), a client certificate that chains to the
// podidentity trust bundle, and the injector's URI SAN. Both files are read again for every
// connection, because pod certificates rotate.
func ServerTLS(serverBundle, clientCAFile, injector string) *tls.Config {
	return &tls.Config{
		MinVersion: tls.VersionTLS12,
		GetConfigForClient: func(*tls.ClientHelloInfo) (*tls.Config, error) {
			raw, err := os.ReadFile(serverBundle)
			if err != nil {
				return nil, fmt.Errorf("read the server bundle: %w", err)
			}
			cert, err := tls.X509KeyPair(raw, raw)
			if err != nil {
				return nil, fmt.Errorf("parse the server bundle: %w", err)
			}
			caPEM, err := os.ReadFile(clientCAFile)
			if err != nil {
				return nil, fmt.Errorf("read the client CA: %w", err)
			}
			pool := x509.NewCertPool()
			if !pool.AppendCertsFromPEM(caPEM) {
				return nil, errors.New("the client CA holds no certificate")
			}
			return &tls.Config{
				MinVersion:            tls.VersionTLS12,
				Certificates:          []tls.Certificate{cert},
				ClientAuth:            tls.RequireAndVerifyClientCert,
				ClientCAs:             pool,
				NextProtos:            []string{"h2"},
				VerifyPeerCertificate: verifyInjector(injector),
			}, nil
		},
	}
}

// verifyInjector admits a verified client certificate only with the injector's URI SAN.
func verifyInjector(injector string) func([][]byte, [][]*x509.Certificate) error {
	return func(_ [][]byte, chains [][]*x509.Certificate) error {
		if len(chains) == 0 || len(chains[0]) == 0 {
			return errors.New("no verified client certificate")
		}
		for _, uri := range chains[0][0].URIs {
			if uri.String() == injector {
				return nil
			}
		}
		return fmt.Errorf("client certificate URI SANs %v do not include %s", chains[0][0].URIs, injector)
	}
}
