package computer

import (
	"crypto/ed25519"
	"crypto/x509"
	"encoding/pem"
	"errors"
	"fmt"
	"regexp"
	"strconv"
	"strings"
)

// Config is the agent's configuration, from the variables a computer's template carries: the
// engine's `--service computer` reads the same ones.
type Config struct {
	// Port is NYLORUN_COMPUTER_PORT (8080).
	Port int
	// Public is NYLORUN_COMPUTER_TICKET_KEY, the ticket key's public half (SPKI PEM).
	Public ed25519.PublicKey
	// NameFile is NYLORUN_COMPUTER_NAME_FILE, the file holding the actor's name.
	NameFile string
	// HarnessRoot is NYLORUN_HARNESS_ROOT (/harness): a disk root, beside the workspace.
	HarnessRoot string
	// EgressCAFile is NYLORUN_SANDBOX_EGRESS_CA_FILE, Substrate's egress CA, trusted by commands.
	EgressCAFile string
	// Substrate is NYLORUN_SANDBOX_SUBSTRATE=1: SIGTERM means the worker is stopping, not that the
	// agent should.
	Substrate bool
	// Workspace is NYLORUN_COMPUTER_WORKSPACE (/workspace; the engine's is fixed).
	Workspace string
	// TrustFile is NYLORUN_COMPUTER_TRUST_FILE, where the trust bundle is written
	// (DefaultTrustFile).
	TrustFile string
}

// refused are what a computer must not hold: it runs next to agent code and holds no Runtime
// credential.
var refused = []string{"NYLORUN_DATABASE_URL", "NYLORUN_GATES_TOKEN", "NYLORUN_KEYS_URL", "NYLORUN_HARNESS_TOKEN", "NYLORUN_JOIN_TOKEN"}

var digits = regexp.MustCompile(`^\d+$`)

// LoadConfig reads the environment, as the engine's parseComputerService does: a variable set to
// blanks is unset.
func LoadConfig(getenv func(string) string) (Config, error) {
	read := func(name string) string { return strings.TrimSpace(getenv(name)) }
	var held []string
	for _, name := range refused {
		if read(name) != "" {
			held = append(held, name)
		}
	}
	if len(held) > 0 {
		return Config{}, fmt.Errorf("the computer agent refuses to start with %s set: a computer holds no Runtime credential", strings.Join(held, ", "))
	}
	key := read("NYLORUN_COMPUTER_TICKET_KEY")
	if !strings.Contains(key, "PUBLIC KEY") {
		return Config{}, errors.New("NYLORUN_COMPUTER_TICKET_KEY is required: the PEM public key tickets are checked with")
	}
	public, err := ParsePublic(key)
	if err != nil {
		return Config{}, fmt.Errorf("NYLORUN_COMPUTER_TICKET_KEY: %w", err)
	}
	c := Config{Port: 8080, Public: public, HarnessRoot: "/harness", Workspace: Workspace, TrustFile: DefaultTrustFile}
	if c.NameFile = read("NYLORUN_COMPUTER_NAME_FILE"); c.NameFile == "" {
		return Config{}, errors.New("NYLORUN_COMPUTER_NAME_FILE is required: the file holding the actor's name")
	}
	if raw := read("NYLORUN_COMPUTER_PORT"); raw != "" {
		if !digits.MatchString(raw) {
			return Config{}, fmt.Errorf("NYLORUN_COMPUTER_PORT must be a port number; got %s", raw)
		}
		port, err := strconv.Atoi(raw)
		if err != nil || port < 1 || port > 65535 {
			return Config{}, fmt.Errorf("NYLORUN_COMPUTER_PORT must be between 1 and 65535; got %s", raw)
		}
		c.Port = port
	}
	if root := read("NYLORUN_HARNESS_ROOT"); root != "" {
		c.HarnessRoot = root
	}
	if !strings.HasPrefix(c.HarnessRoot, "/") {
		return Config{}, fmt.Errorf("NYLORUN_HARNESS_ROOT must be an absolute path, not %s", c.HarnessRoot)
	}
	if workspace := read("NYLORUN_COMPUTER_WORKSPACE"); workspace != "" {
		c.Workspace = workspace
	}
	if !strings.HasPrefix(c.Workspace, "/") {
		return Config{}, fmt.Errorf("NYLORUN_COMPUTER_WORKSPACE must be an absolute path, not %s", c.Workspace)
	}
	if file := read("NYLORUN_COMPUTER_TRUST_FILE"); file != "" {
		c.TrustFile = file
	}
	c.EgressCAFile = read("NYLORUN_SANDBOX_EGRESS_CA_FILE")
	c.Substrate = read("NYLORUN_SANDBOX_SUBSTRATE") == "1"
	return c, nil
}

// ParsePublic reads an Ed25519 public key, SPKI PEM.
func ParsePublic(text string) (ed25519.PublicKey, error) {
	block, _ := pem.Decode([]byte(text))
	if block == nil {
		return nil, errors.New("not PEM")
	}
	key, err := x509.ParsePKIXPublicKey(block.Bytes)
	if err != nil {
		return nil, err
	}
	public, ok := key.(ed25519.PublicKey)
	if !ok {
		return nil, errors.New("not an Ed25519 key")
	}
	return public, nil
}
