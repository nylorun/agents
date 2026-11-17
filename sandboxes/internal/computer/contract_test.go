package computer

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"sort"
	"strings"
	"testing"
	"time"
)

// The shared contract (testdata/contract.json), against the computer agent with real processes
// in a temporary workspace. The engine's side is runtime/server/test/sandbox/computer-contract.test.ts.

type contract struct {
	Name        string            `json:"name"`
	HarnessRoot string            `json:"harnessRoot"`
	ProcessEnv  map[string]string `json:"processEnv"`
	Cases       []contractCase    `json:"cases"`
}

type contractCase struct {
	Name      string `json:"name"`
	Workspace string `json:"workspace"`
	Steps     []struct {
		Request struct {
			Method   string          `json:"method"`
			Path     string          `json:"path"`
			Ticket   string          `json:"ticket"`
			Body     json.RawMessage `json:"body"`
			BodyText *string         `json:"bodyText"`
		} `json:"request"`
		Expect struct {
			Status      int     `json:"status"`
			ContentType string  `json:"contentType"`
			JSON        any     `json:"json"`
			Text        *string `json:"text"`
		} `json:"expect"`
	} `json:"steps"`
}

func loadContract(t *testing.T) contract {
	raw, err := os.ReadFile(filepath.Join("testdata", "contract.json"))
	if err != nil {
		t.Fatal(err)
	}
	var c contract
	if err := json.Unmarshal(raw, &c); err != nil {
		t.Fatal(err)
	}
	return c
}

// signClaims signs any header and claims, as a test would forge them.
func signClaims(private ed25519.PrivateKey, header, claims map[string]any) string {
	enc := base64.RawURLEncoding
	h, _ := json.Marshal(header)
	c, _ := json.Marshal(claims)
	input := enc.EncodeToString(h) + "." + enc.EncodeToString(c)
	return input + "." + enc.EncodeToString(ed25519.Sign(private, []byte(input)))
}

func contractTicket(kind, name string, private ed25519.PrivateKey) string {
	now := time.Now().Unix()
	header := map[string]any{"alg": "EdDSA", "typ": "JWT"}
	claims := map[string]any{"aud": "nylorun-computer", "sub": name, "exp": now + 600}
	switch kind {
	case "", "valid":
	case "none":
		return ""
	case "garbage":
		return "a.b.c"
	case "expired":
		claims["exp"] = now - 1
	case "noExp":
		delete(claims, "exp")
	case "otherSubject":
		claims["sub"] = "sbx-aaaaaaaaaaaaaaaa-g0"
	case "otherAudience":
		claims["aud"] = "nylorun-sandbox"
	case "otherKey":
		_, private, _ = ed25519.GenerateKey(rand.Reader)
	case "algHS256":
		header["alg"] = "HS256"
	default:
		panic("unknown ticket kind " + kind)
	}
	return signClaims(private, header, claims)
}

func TestContract(t *testing.T) {
	c := loadContract(t)
	environ := make([]string, 0, len(c.ProcessEnv))
	for k, v := range c.ProcessEnv {
		environ = append(environ, k+"="+v)
	}
	for _, kase := range c.Cases {
		t.Run(kase.Name, func(t *testing.T) {
			t.Parallel()
			root := t.TempDir()
			workspace := filepath.Join(root, "workspace")
			harnessRoot := filepath.Join(root, c.HarnessRoot)
			if kase.Workspace != "missing" {
				if err := os.Mkdir(workspace, 0o755); err != nil {
					t.Fatal(err)
				}
			}
			bundle := filepath.Join(root, "trust.pem")
			trust := map[string]string{}
			for _, name := range TrustVariables {
				trust[name] = bundle
			}
			public, private, _ := ed25519.GenerateKey(rand.Reader)
			server := httptest.NewServer(New(Options{
				Workspace: workspace, HarnessRoot: harnessRoot, Public: public, Name: c.Name,
				Runner: &Runner{Shell: CommandShell(), Base: BaseEnv(BaselineFrom(environ), workspace), Trust: trust},
			}))
			defer server.Close()
			fill := strings.NewReplacer("{{workspace}}", workspace, "{{harnessRoot}}", harnessRoot, "{{trustBundle}}", bundle).Replace
			for i, step := range kase.Steps {
				label := fmt.Sprintf("step %d (%s %s)", i, step.Request.Method, step.Request.Path)
				var body io.Reader
				switch {
				case step.Request.BodyText != nil:
					body = strings.NewReader(fill(*step.Request.BodyText))
				case step.Request.Body != nil:
					body = strings.NewReader(fill(string(step.Request.Body)))
				}
				req, err := http.NewRequest(step.Request.Method, server.URL+fill(step.Request.Path), body)
				if err != nil {
					t.Fatal(err)
				}
				if token := contractTicket(step.Request.Ticket, c.Name, private); token != "" {
					req.Header.Set("X-Nylorun-Ticket", token)
				}
				res, err := http.DefaultClient.Do(req)
				if err != nil {
					t.Fatalf("%s: %v", label, err)
				}
				raw, _ := io.ReadAll(res.Body)
				_ = res.Body.Close()
				if res.StatusCode != step.Expect.Status {
					t.Fatalf("%s: status %d, want %d: %s", label, res.StatusCode, step.Expect.Status, abbreviate(raw))
				}
				if want := step.Expect.ContentType; want != "" && res.Header.Get("Content-Type") != want {
					t.Fatalf("%s: content-type %q, want %q", label, res.Header.Get("Content-Type"), want)
				}
				if step.Expect.Text != nil && string(raw) != fill(*step.Expect.Text) {
					t.Fatalf("%s: body %q, want %q", label, abbreviate(raw), fill(*step.Expect.Text))
				}
				if step.Expect.JSON != nil {
					var got any
					if err := json.Unmarshal(raw, &got); err != nil {
						t.Fatalf("%s: not JSON: %s", label, abbreviate(raw))
					}
					if why := match(got, step.Expect.JSON, fill, "$"); why != "" {
						t.Fatalf("%s: %s\ngot: %s", label, why, abbreviate(raw))
					}
				}
			}
		})
	}
}

func abbreviate(raw []byte) string {
	if len(raw) > 600 {
		return string(raw[:300]) + "…" + string(raw[len(raw)-300:])
	}
	return string(raw)
}

// match compares a decoded answer with the contract's expectation, placeholders filled; "" when
// it holds.
func match(got, want any, fill func(string) string, at string) string {
	if m, ok := want.(map[string]any); ok && isMatcher(m) {
		return matchWith(got, m, fill, at)
	}
	switch w := want.(type) {
	case string:
		if g, ok := got.(string); !ok || g != fill(w) {
			return fmt.Sprintf("%s: %s, want %q", at, short(got), fill(w))
		}
	case map[string]any:
		g, ok := got.(map[string]any)
		if !ok {
			return fmt.Sprintf("%s: %s, want an object", at, short(got))
		}
		keys := map[string]bool{}
		for k := range g {
			keys[k] = true
		}
		for k := range w {
			keys[k] = true
		}
		names := make([]string, 0, len(keys))
		for k := range keys {
			names = append(names, k)
		}
		sort.Strings(names)
		for _, k := range names {
			gv, inGot := g[k]
			wv, inWant := w[k]
			if !inGot || !inWant {
				return fmt.Sprintf("%s.%s: present in answer %v, in the contract %v", at, k, inGot, inWant)
			}
			if why := match(gv, wv, fill, at+"."+k); why != "" {
				return why
			}
		}
	case []any:
		g, ok := got.([]any)
		if !ok || len(g) != len(w) {
			return fmt.Sprintf("%s: %s, want %d items", at, short(got), len(w))
		}
		for i := range w {
			if why := match(g[i], w[i], fill, fmt.Sprintf("%s[%d]", at, i)); why != "" {
				return why
			}
		}
	default:
		if !reflect.DeepEqual(got, want) {
			return fmt.Sprintf("%s: %s, want %v", at, short(got), want)
		}
	}
	return ""
}

func isMatcher(m map[string]any) bool {
	if len(m) == 0 {
		return false
	}
	for k := range m {
		if !strings.HasPrefix(k, "$") {
			return false
		}
	}
	return true
}

func matchWith(got any, m map[string]any, fill func(string) string, at string) string {
	s, isString := got.(string)
	for k, v := range m {
		switch k {
		case "$any":
		case "$type":
			kind := map[string]string{"string": "string", "float64": "number", "bool": "boolean"}[fmt.Sprintf("%T", got)]
			if kind != v {
				return fmt.Sprintf("%s: %s is not a %v", at, short(got), v)
			}
		case "$startsWith":
			if !isString || !strings.HasPrefix(s, fill(v.(string))) {
				return fmt.Sprintf("%s: %s doesn't start with %q", at, short(got), v)
			}
		case "$endsWith":
			if !isString || !strings.HasSuffix(s, fill(v.(string))) {
				return fmt.Sprintf("%s: %s doesn't end with %q", at, short(got), v)
			}
		case "$matches":
			if !isString || !regexp.MustCompile(fill(v.(string))).MatchString(s) {
				return fmt.Sprintf("%s: %s doesn't match %q", at, short(got), v)
			}
		case "$utf8Bytes":
			if !isString || float64(len(s)) != v.(float64) {
				return fmt.Sprintf("%s: %d bytes, want %v", at, len(s), v)
			}
		default:
			return fmt.Sprintf("%s: unknown matcher %s", at, k)
		}
	}
	return ""
}

func short(v any) string {
	raw, _ := json.Marshal(v)
	return abbreviate(bytes.TrimSpace(raw))
}
