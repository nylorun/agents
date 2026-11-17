package computer

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"encoding/pem"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/nylorun/agents/sandboxes/internal/ticket"
)

func TestWaitIsCappedAt50Seconds(t *testing.T) {
	cases := []struct {
		raw     any
		present bool
		want    time.Duration
	}{
		{nil, false, MaxWait},
		{float64(120_000), true, MaxWait},
		{float64(250), true, 250 * time.Millisecond},
		{float64(-5), true, 0},
		{nil, true, 0},
		{"300", true, 300 * time.Millisecond},
		{"soon", true, 0},
	}
	for _, c := range cases {
		if got := waitOf(c.raw, c.present); got != c.want {
			t.Errorf("waitOf(%v, %v) = %v, want %v", c.raw, c.present, got, c.want)
		}
	}
}

func TestResultsAreKeptTenMinutes(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	runs := 0
	commands := NewCommands(func(ExecRequest, <-chan struct{}) (Result, error) {
		runs++
		return Result{Stdout: "ok"}, nil
	}, func() time.Time { return now })
	if a := commands.Start("c", ExecRequest{}, time.Second); a.State != "done" || a.Result.Stdout != "ok" {
		t.Fatalf("start: %+v", a)
	}
	now = now.Add(Keep)
	if _, known := commands.Attach("c", 0); !known {
		t.Fatal("forgot a result before 10 minutes")
	}
	commands.Start("other", ExecRequest{}, time.Second) // a start prunes, as the engine's does
	if _, known := commands.Attach("c", 0); !known {
		t.Fatal("pruned a result at exactly 10 minutes")
	}
	now = now.Add(time.Millisecond)
	commands.Start("other", ExecRequest{}, time.Second)
	if _, known := commands.Attach("c", 0); known {
		t.Fatal("kept a result past 10 minutes")
	}
	if runs != 2 {
		t.Fatalf("runs %d, want 2 (a repeated start joins)", runs)
	}
}

func TestBaseEnv(t *testing.T) {
	baseline := BaselineFrom([]string{"PATH=/bin", "LC_CTYPE=C", "TZ=UTC", "LANG=en", "HOME=/root", "NODE_OPTIONS=x", "HTTPS_PROXY=p", "NYLORUN_X=1"})
	got := BaseEnv(baseline, "/workspace")
	want := map[string]string{"PATH": "/bin", "LC_CTYPE": "C", "TZ": "UTC", "LANG": "en", "TERM": "dumb", "HOME": "/workspace"}
	if len(got) != len(want) {
		t.Fatalf("env %v, want %v", got, want)
	}
	for k, v := range want {
		if got[k] != v {
			t.Fatalf("env %v, want %v", got, want)
		}
	}
	// The local backend's own filter, for a baseline given whole.
	if env := BaseEnv(map[string]string{"NYLORUN_A": "1", "no_proxy": "x", "KEEP": "1"}, "/w"); env["NYLORUN_A"] != "" || env["no_proxy"] != "" || env["KEEP"] != "1" {
		t.Fatalf("env %v", env)
	}
}

func TestTrustEnvironment(t *testing.T) {
	dir := t.TempDir()
	roots := filepath.Join(dir, "roots.pem")
	ca := filepath.Join(dir, "egress.pem")
	bundle := filepath.Join(dir, "bundle.pem")
	_ = os.WriteFile(roots, []byte("ROOTS\n\n"), 0o644)
	_ = os.WriteFile(ca, []byte("EGRESS"), 0o644)

	if env, err := TrustEnvironment("", bundle, []string{roots}); err != nil || len(env) != 0 {
		t.Fatalf("no egress CA: %v %v", env, err)
	}
	if env, err := TrustEnvironment(filepath.Join(dir, "missing.pem"), bundle, []string{roots}); err != nil || len(env) != 0 {
		t.Fatalf("an unreadable egress CA: %v %v", env, err)
	}
	env, err := TrustEnvironment(ca, bundle, []string{filepath.Join(dir, "none.pem"), roots})
	if err != nil || len(env) != len(TrustVariables) || env["SSL_CERT_FILE"] != bundle {
		t.Fatalf("env %v %v", env, err)
	}
	if raw, _ := os.ReadFile(bundle); string(raw) != "ROOTS\nEGRESS\n" {
		t.Fatalf("bundle %q", raw)
	}
	if _, err := TrustEnvironment(ca, bundle, nil); err != nil {
		t.Fatal(err)
	}
	if raw, _ := os.ReadFile(bundle); string(raw) != "EGRESS\n" {
		t.Fatalf("bundle without system roots %q", raw)
	}
}

func publicPEM(t *testing.T) string {
	public, _, _ := ed25519.GenerateKey(rand.Reader)
	der, err := x509.MarshalPKIXPublicKey(public)
	if err != nil {
		t.Fatal(err)
	}
	return string(pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der}))
}

func TestLoadConfig(t *testing.T) {
	env := map[string]string{"NYLORUN_COMPUTER_TICKET_KEY": publicPEM(t), "NYLORUN_COMPUTER_NAME_FILE": "/run/nylorun/actor/actor-name"}
	getenv := func(name string) string { return env[name] }
	c, err := LoadConfig(getenv)
	if err != nil || c.Port != 8080 || c.HarnessRoot != "/harness" || c.Workspace != "/workspace" || c.TrustFile != DefaultTrustFile || c.Substrate {
		t.Fatalf("config %+v %v", c, err)
	}
	env["NYLORUN_SANDBOX_SUBSTRATE"], env["NYLORUN_COMPUTER_PORT"], env["NYLORUN_SANDBOX_EGRESS_CA_FILE"] = "1", "9090", "/run/nylorun/trust/egress.pem"
	if c, err = LoadConfig(getenv); err != nil || !c.Substrate || c.Port != 9090 || c.EgressCAFile == "" {
		t.Fatalf("config %+v %v", c, err)
	}
	for name, value := range map[string]string{
		"NYLORUN_COMPUTER_PORT": "80a", "NYLORUN_HARNESS_ROOT": "harness", "NYLORUN_JOIN_TOKEN": "t", "NYLORUN_COMPUTER_TICKET_KEY": "nope",
	} {
		saved := env[name]
		env[name] = value
		if _, err := LoadConfig(getenv); err == nil {
			t.Errorf("%s=%s held", name, value)
		}
		env[name] = saved
	}
	delete(env, "NYLORUN_COMPUTER_NAME_FILE")
	if _, err := LoadConfig(getenv); err == nil || !strings.Contains(err.Error(), "NAME_FILE") {
		t.Fatalf("no name file: %v", err)
	}
}

func TestJSConversions(t *testing.T) {
	for s, want := range map[string]float64{"": 0, " 12 ": 12, "1e3": 1000, "0x10": 16, "5.": 5, ".5": 0.5} {
		if got := jsNumber(s); got != want {
			t.Errorf("Number(%q) = %v, want %v", s, got, want)
		}
	}
	for _, s := range []string{"abc", "inf", "1_000", "12px"} {
		if got := jsNumber(s); got == got {
			t.Errorf("Number(%q) = %v, want NaN", s, got)
		}
	}
	for f, want := range map[float64]string{3: "3", 1.5: "1.5", 1e21: "1e+21", 1e-7: "1e-7", 9007199254740991: "9007199254740991"} {
		if got := jsNumberString(f); got != want {
			t.Errorf("String(%v) = %q, want %q", f, got, want)
		}
	}
	if got := decodeUTF8([]byte("a\xf0\x9f\x98")); got != "a\uFFFD" {
		t.Errorf("a cut emoji: %q", got)
	}
	if !lessUTF16("\U0001F600", "\uFFFF") || lessUTF16("\uFFFF", "\U0001F600") {
		t.Error("UTF-16 order: a surrogate pair sorts before U+FFFF")
	}
}

func TestTicketCheckReasons(t *testing.T) {
	public, private, _ := ed25519.GenerateKey(rand.Reader)
	now := time.Unix(1_800_000_000, 0)
	token := ticket.Sign(private, "sbx-a-g0", now.Add(time.Minute))
	if why := ticket.Check(token, public, "sbx-a-g0", now); why != "" {
		t.Fatalf("a good ticket: %s", why)
	}
	for _, c := range []struct{ token, subject, want string }{
		{"", "sbx-a-g0", "no ticket"},
		{token, "sbx-b-g0", "subject"},
		{"a.b.c", "sbx-a-g0", "malformed"},
		{signClaims(private, map[string]any{"alg": "EdDSA"}, map[string]any{"aud": "nylorun-computer", "sub": "sbx-a-g0", "exp": 1_800_000_000.5}), "sbx-a-g0", ""},
		{signClaims(private, map[string]any{"alg": "EdDSA"}, map[string]any{"aud": "nylorun-computer", "sub": "sbx-a-g0", "exp": "2000000000"}), "sbx-a-g0", "expired"},
	} {
		if got := ticket.Check(c.token, public, c.subject, now); got != c.want {
			t.Errorf("Check(%.20q) = %q, want %q", c.token, got, c.want)
		}
	}
}
