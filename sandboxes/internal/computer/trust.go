package computer

import (
	"os"
	"strings"
)

// TrustVariables are the variables CLIs read their trust bundle from: OpenSSL, Node, Python,
// curl, git, AWS (the engine's TRUST_VARIABLES).
var TrustVariables = []string{
	"SSL_CERT_FILE",
	"NODE_EXTRA_CA_CERTS",
	"REQUESTS_CA_BUNDLE",
	"CURL_CA_BUNDLE",
	"GIT_SSL_CAINFO",
	"AWS_CA_BUNDLE",
}

// SystemRootFiles are where Linux images keep their CA bundle (the files Go's crypto/x509 reads),
// in order: Debian, Ubuntu, Alpine and Gentoo; Fedora and RHEL; openSUSE; OpenELEC; CentOS and
// RHEL 7; Alpine's other.
var SystemRootFiles = []string{
	"/etc/ssl/certs/ca-certificates.crt",
	"/etc/pki/tls/certs/ca-bundle.crt",
	"/etc/ssl/ca-bundle.pem",
	"/etc/pki/tls/cacert.pem",
	"/etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem",
	"/etc/ssl/cert.pem",
}

// DefaultTrustFile is where the bundle is written: not on the durable disk, as it is the
// system's roots and Substrate's CA of this start.
const DefaultTrustFile = "/tmp/nylorun-trust.pem"

// TrustEnvironment writes the bundle commands trust (the image's public roots, then Substrate's
// egress CA) to bundle, and returns the trust variables naming it. Without an egress CA (none
// configured, or its file unreadable) it writes nothing and returns none, as the engine does.
//
// The engine writes Node's own roots (tls.rootCertificates, Mozilla's, whatever the image holds);
// a static binary has none, so these are the image's own: the first of rootFiles that exists, or
// none, and then the bundle holds the egress CA alone.
func TrustEnvironment(egressCAFile, bundle string, rootFiles []string) (map[string]string, error) {
	if egressCAFile == "" {
		return map[string]string{}, nil
	}
	ca, err := os.ReadFile(egressCAFile)
	if err != nil {
		return map[string]string{}, nil
	}
	var content strings.Builder
	for _, file := range rootFiles {
		if roots, err := os.ReadFile(file); err == nil && len(strings.TrimSpace(string(roots))) > 0 {
			content.WriteString(strings.TrimRight(string(roots), "\n"))
			content.WriteString("\n")
			break
		}
	}
	content.Write(ca)
	content.WriteString("\n")
	if err := os.WriteFile(bundle, []byte(content.String()), 0o644); err != nil {
		return nil, err
	}
	out := map[string]string{}
	for _, name := range TrustVariables {
		out[name] = bundle
	}
	return out, nil
}
