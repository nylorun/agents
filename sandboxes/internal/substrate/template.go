// Package substrate runs the Tenant's sandboxes as Agent Substrate actors (preview). It keeps the sandboxes service's contract with core: one actor per sandbox
// incarnation (the Sandbox name sbx-<16>-g<gen>), with an ActorTemplate rendered for it from the
// same Spec the agent-sandbox driver renders a pod from.
package substrate

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net"
	"slices"
	"sort"
	"strconv"
	"strings"

	ateapi "go.ate.dev/substrate/api/ateapi/v1"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"

	"github.com/nylorun/agents/sandboxes/internal/driver"
)

// Paths inside an actor.
const (
	// InfoDir is the systemInfo volume with the actor's name and uid.
	InfoDir = "/run/nylorun/actor"
	// TrustDir is the systemInfo volume with Substrate's egress CA, appended to the edge's CA.
	TrustDir = "/run/nylorun/trust"
	// EngineDir is the Runtime image, mounted read-only as an image volume (entrypoint engine).
	EngineDir = "/nylo"
	// JoinFile is where the wrapper writes the join token for the engine.
	JoinFile = "/tmp/.nylorun-join"
	// CAFile is the edge's CA plus Substrate's egress CA, for NODE_EXTRA_CA_CERTS.
	CAFile = "/tmp/.nylorun-ca.pem"
	// BlockedProbe is the address the engine's network check expects refused: an actor's TCP
	// connects all reach atunnel, except link-local ones.
	BlockedProbe = "169.254.169.254:80"
)

// ReconnectTuning is the engine's reconnect without its 5 s wait after a restore (4.9 s
// -> 0.22 s at p50). It is merged under the operator's own tuning.
var ReconnectTuning = map[string]any{"harness": map[string]any{
	"reconnectStopMs": 0, "reconnect": map[string]any{"minMs": 1, "maxMs": 1000}}}

// Network is what the actor's commands may reach (the Agent's resolved network).
type Network struct {
	// Open allows every host (preset open).
	Open bool
	// Hosts are exact names; Suffixes are ".example.com" (one label, as Substrate's "*.").
	Hosts, Suffixes []string
}

// Settings are the Tenant-wide parts of a template.
type Settings struct {
	Atespace string
	// ImageMirrors maps a workload image's repository to its mirror: the template
	// names the mirror, and the state keeps the image as resolved, under the Agent's name.
	ImageMirrors driver.Mirrors
	// HarnessURL and GatesURL are the edge's addresses for actors.
	HarnessURL, GatesURL string
	// EdgeHost is the edge's name, allowed through in every egress policy.
	EdgeHost string
	// EdgeAddress is the address EdgeHost resolves to (the Docker host's, as `enable` found it).
	// The wrapper pins it in the actor's /etc/hosts, so reaching the edge needs no DNS lookup: a
	// restored actor's first lookup can be lost. Egress routes the edge by its TLS name,
	// so the address only has to be one the actor can dial. Empty leaves the edge to DNS.
	EdgeAddress string
	// EdgePorts are the edge's ports.
	EdgePorts []int
	// EdgeCA is the PEM of the CA the edge's certificate chains to.
	EdgeCA string
	// WorkerSelector picks the worker pool; empty for any.
	WorkerSelector map[string]string
	// KeysProvider is the keys provider's name, the host of its ate-secret:// references
	//; empty when keys are off, and keyed hosts are then passed through like any other.
	KeysProvider string
	// ComputerPort, when not 0, makes every sandbox a computer: its engine runs
	// `--service computer` on this port, with no join token, edge or loop.
	ComputerPort int
	// TicketKey is the PEM public key the computer checks tickets with (with ComputerPort).
	TicketKey string
	// ComputerAgent is what serves a computer (with ComputerPort, entrypoint engine): AgentGo, the
	// computer agent from ComputerImage, or AgentEngine (the default when empty), the Runtime's
	// engine in computer mode, from the spec's harnessImage.
	ComputerAgent string
	// ComputerImage is the computer agent's image (ghcr.io/nylorun/computer, by digest), for
	// AgentGo.
	ComputerImage string
}

// The computer agents.
const (
	AgentGo     = "go"
	AgentEngine = "engine"
)

// Computer says whether sandboxes are computers.
func (s Settings) Computer() bool { return s.ComputerPort > 0 }

// ComputerAgentGo says whether computers run the computer agent instead of the engine.
func (s Settings) ComputerAgentGo() bool { return s.Computer() && s.ComputerAgent == AgentGo }

// AgentFile is the computer agent in its image, so at EngineDir+AgentFile in a computer.
const AgentFile = "/computer"

// computerWrapper is the container's command for a computer's engine: no join token, no edge,
// only the dirs its workspace needs, then the engine under tini as PID 1.
const computerWrapper = `set -e
umask 022
mkdir -p /harness/home /workspace /skills
cd /workspace
exec "$@"`

// computerArgs is what the wrapper execs for a computer.
func computerArgs() []string {
	args := engineArgs()
	return append(args[:len(args)-1], "computer")
}

// renderComputer is a computer's template (see RenderTemplate).
func renderComputer(s Settings, spec driver.Spec, images Resolved) (map[string]any, error) {
	if spec.Entrypoint == driver.EntrypointImage {
		return nil, &driver.Error{Status: 400, Code: "invalid_request",
			Message: "a computer runs the Runtime's engine: entrypoint image (a custom harness in the image) is not a computer"}
	}
	env := map[string]string{
		"HOME": "/harness/home",
		// The engine stays up on a stopping worker's SIGTERM, so it can be suspended (drain.go).
		"NYLORUN_SANDBOX_SUBSTRATE":      "1",
		"NYLORUN_SANDBOX_EGRESS_CA_FILE": TrustDir + "/egress.pem",
		"NYLORUN_COMPUTER_PORT":          strconv.Itoa(s.ComputerPort),
		"NYLORUN_COMPUTER_TICKET_KEY":    s.TicketKey,
		"NYLORUN_COMPUTER_NAME_FILE":     InfoDir + "/actor-name",
	}
	for key, value := range spec.Env {
		env[key] = value
	}
	keys := make([]string, 0, len(env))
	for key := range env {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	envList := make([]any, 0, len(keys))
	for _, key := range keys {
		envList = append(envList, map[string]any{"name": key, "value": env[key]})
	}
	mounts, volumes := baseVolumes()
	container := map[string]any{"name": "workload", "image": s.ImageMirrors.To(images.Image), "env": envList}
	if len(spec.Command) > 0 {
		container["command"] = spec.Command
	} else if spec.Entrypoint == driver.EntrypointEngine && s.ComputerAgentGo() {
		// The computer agent: its own image in place of the Runtime's, at the
		// same volume and path, run as the actor's only process. It does the wrapper's work itself,
		// so starting it needs no shell, and it reads the same variables.
		image := images.Computer
		if image == "" {
			image = s.ComputerImage
		}
		if image == "" {
			return nil, &driver.Error{Status: 400, Code: "invalid_request", Message: "the computer agent's image is not configured (--computer-image)"}
		}
		mounts = append(mounts, map[string]any{"name": EngineVolume, "mountPath": EngineDir})
		volumes = append(volumes, map[string]any{"name": EngineVolume, "image": map[string]any{"reference": image}})
		container["command"] = []string{EngineDir + AgentFile}
		container["wakeupProbe"] = map[string]any{
			"httpGet":        map[string]any{"path": "/ready", "port": s.ComputerPort},
			"timeoutSeconds": 120,
		}
	} else {
		if spec.Entrypoint == driver.EntrypointEngine {
			if images.Harness == "" {
				return nil, &driver.Error{Status: 400, Code: "invalid_request", Message: "harnessImage is required for entrypoint engine"}
			}
			mounts = append(mounts, map[string]any{"name": EngineVolume, "mountPath": EngineDir})
			volumes = append(volumes, map[string]any{"name": EngineVolume, "image": map[string]any{"reference": images.Harness}})
		}
		container["command"] = append([]string{"/bin/sh", "-c", computerWrapper, "nylorun-computer"}, computerArgs()...)
		// ResumeActor returns only once the engine answers.
		container["wakeupProbe"] = map[string]any{
			"httpGet":        map[string]any{"path": "/ready", "port": s.ComputerPort},
			"timeoutSeconds": 120,
		}
	}
	container["volumeMounts"] = mounts
	return finishTemplate(s, spec, container, volumes), nil
}

// baseVolumes are every sandbox's mounts and volumes: its identity, Substrate's egress CA, and
// its two durable dirs.
func baseVolumes() ([]any, []any) {
	mounts := []any{
		map[string]any{"name": "info", "mountPath": InfoDir},
		map[string]any{"name": "trust", "mountPath": TrustDir},
		map[string]any{"name": "workspace", "mountPath": "/workspace"},
		map[string]any{"name": "harness", "mountPath": "/harness"},
		// The engine writes the session's skills here, as the pods driver's volume.
		// A volume, not a directory the wrapper makes at the root: an image that runs as a user
		// other than root (uid 1000, as most computer images) can't create /skills.
		map[string]any{"name": "skills", "mountPath": "/skills"},
	}
	volumes := []any{
		map[string]any{"name": "info", "systemInfo": map[string]any{"dataSources": []any{map[string]any{
			"actorMetadata": map[string]any{"items": []any{
				map[string]any{"field": "ACTOR_METADATA_FIELD_NAME", "path": "actor-name"},
				map[string]any{"field": "ACTOR_METADATA_FIELD_UID", "path": "actor-uid"},
			}}}}}},
		map[string]any{"name": "trust", "systemInfo": map[string]any{"dataSources": []any{map[string]any{
			"trustBundle": map[string]any{"names": []any{"egress-mitm.ate.dev"}, "path": "egress.pem"}}}}},
		map[string]any{"name": "workspace", "durableDir": map[string]any{}},
		map[string]any{"name": "harness", "durableDir": map[string]any{}},
		map[string]any{"name": "skills", "durableDir": map[string]any{}},
	}
	return mounts, volumes
}

// finishTemplate wraps a container into a template: resources, snapshots and the worker pool.
func finishTemplate(s Settings, spec driver.Spec, container map[string]any, volumes []any) map[string]any {
	t := map[string]any{
		"metadata":   map[string]any{"atespace": s.Atespace},
		"containers": []any{container},
		"volumes":    volumes,
		"resources": map[string]any{"limits": map[string]any{
			"cpuMillicores": strconv.FormatInt(int64(spec.CPUs*1000), 10),
			"memoryBytes":   strconv.FormatInt(spec.MemoryMiB<<20, 10),
		}},
		"snapshotConfig": map[string]any{
			"preferredFidelity": "SNAPSHOT_FIDELITY_MEMORY",
			// Each incarnation is its own: a golden snapshot would share one engine's state.
			"goldenSnapshotConfig": map[string]any{"mode": "GOLDEN_SNAPSHOT_MODE_DISABLED"},
		},
	}
	if len(s.WorkerSelector) > 0 {
		t["workerSelector"] = map[string]any{"matchLabels": s.WorkerSelector}
	}
	return t
}

// DefaultKeysProvider is the keys provider's name when the cluster records it.
const DefaultKeysProvider = "keys.nylorun.dev"

// KeyReference is the credential URI of a keyed host: where the keys provider asks, never a value.
// The sandbox id is base64url-encoded (an id may hold a slash; Substrate refuses percent-encoding).
func KeyReference(provider, sandbox, host string) string {
	return "ate-secret://" + provider + "/" + base64.RawURLEncoding.EncodeToString([]byte(sandbox)) + "/" + host
}

// Resolved are a spec's images pinned by digest (Substrate refuses tags).
type Resolved struct {
	// Image is the workload image as name@sha256:….
	Image string
	// Harness is the Runtime image the engine is mounted from, for entrypoint engine. An existing
	// actor keeps the one it has (see Driver.Put).
	Harness string
	// Computer is the computer agent's image, for a computer with Settings.ComputerAgent go
	// (default Settings.ComputerImage). An existing actor keeps the one it has, as for Harness.
	Computer string
}

// RunsAgent says whether a template runs the computer agent (rather than the engine) from its
// EngineVolume.
func RunsAgent(t *ateapi.ActorTemplate) bool {
	for _, c := range t.GetContainers() {
		if command := c.GetCommand(); len(command) > 0 && command[0] == EngineDir+AgentFile {
			return true
		}
	}
	return false
}

// wrapper is the container's command for our engine: it gives the engine what agent-sandbox
// gave it through the pod (the uid from the downward API, the join token from a Secret, the
// trust for the edge), then runs it under tini as PID 1. A memory restore resumes the engine
// itself; the wrapper runs again only on a fresh start.
const wrapper = `set -e
umask 022
ca="${NYLORUN_EDGE_CA:-}"
if [ -n "$ca" ]; then
  printf '%s\n' "$ca" > ` + CAFile + `
  cat ` + TrustDir + `/egress.pem >> ` + CAFile + ` 2>/dev/null || true
  export NODE_EXTRA_CA_CERTS=` + CAFile + `
fi
(umask 077 && printf '%s' "${NYLORUN_JOIN_TOKEN:-}" > ` + JoinFile + `)
unset NYLORUN_JOIN_TOKEN NYLORUN_EDGE_CA
if [ -n "${NYLORUN_EDGE_ADDRESS:-}" ] && [ -w /etc/hosts ]; then
  printf '%s %s\n' "$NYLORUN_EDGE_ADDRESS" "$NYLORUN_EDGE_HOST" >> /etc/hosts || true
fi
export NYLORUN_SANDBOX_JOIN_FILE=` + JoinFile + `
export NYLORUN_POD_UID="$(cat ` + InfoDir + `/actor-uid)"
mkdir -p /harness/home /workspace /skills
cd /workspace
exec "$@"`

// engineArgs is what the wrapper execs: our engine from the mounted Runtime image.
func engineArgs() []string {
	return []string{
		EngineDir + "/usr/bin/tini-static", "-g", "--",
		EngineDir + "/usr/local/bin/node", EngineDir + "/engine/harness.mjs", "--service", "harness",
	}
}

// mergeTuning puts ReconnectTuning under the operator's NYLORUN_TUNING (theirs wins).
func mergeTuning(operator string) (string, error) {
	merged := map[string]any{}
	deepMerge(merged, ReconnectTuning)
	if strings.TrimSpace(operator) != "" {
		var theirs map[string]any
		if err := json.Unmarshal([]byte(operator), &theirs); err != nil {
			return "", fmt.Errorf("NYLORUN_TUNING is not a JSON object: %w", err)
		}
		deepMerge(merged, theirs)
	}
	out, err := json.Marshal(merged)
	return string(out), err
}

func deepMerge(into, from map[string]any) {
	for key, value := range from {
		if sub, ok := value.(map[string]any); ok {
			if existing, ok := into[key].(map[string]any); ok {
				deepMerge(existing, sub)
				continue
			}
			copied := map[string]any{}
			deepMerge(copied, sub)
			into[key] = copied
			continue
		}
		into[key] = value
	}
}

// RenderTemplate is the ActorTemplate for a sandbox incarnation, before its name is set. The
// spec is normalized. joinToken is the incarnation's; it lives in the template's environment
// until the incarnation is deleted.
func RenderTemplate(s Settings, spec driver.Spec, images Resolved, joinToken string) (map[string]any, error) {
	if s.Computer() {
		return renderComputer(s, spec, images)
	}
	env := map[string]string{
		"HOME":                 "/harness/home",
		"NYLORUN_SANDBOX_KIND": "pod",
		// The engine stays up on a stopping worker's SIGTERM, so it can be suspended (drain.go).
		"NYLORUN_SANDBOX_SUBSTRATE":     "1",
		"NYLORUN_HARNESS_URL":           s.HarnessURL,
		"NYLORUN_GATES_URL":             s.GatesURL,
		"NYLORUN_SANDBOX_BLOCKED_PROBE": BlockedProbe,
		// Substrate's egress CA, which commands must trust for hosts whose keys the egress adds
		//: the engine writes it with the public roots into the bundle the trust
		// variables name.
		"NYLORUN_SANDBOX_EGRESS_CA_FILE": TrustDir + "/egress.pem",
	}
	if s.EdgeCA != "" {
		env["NYLORUN_EDGE_CA"] = s.EdgeCA
	}
	if ip := net.ParseIP(s.EdgeAddress); ip != nil && s.EdgeHost != "" {
		env["NYLORUN_EDGE_ADDRESS"] = ip.String()
		env["NYLORUN_EDGE_HOST"] = s.EdgeHost
	}
	if joinToken != "" {
		env["NYLORUN_JOIN_TOKEN"] = joinToken
	}
	for key, value := range spec.Env {
		env[key] = value
	}
	tuning, err := mergeTuning(spec.Env["NYLORUN_TUNING"])
	if err != nil {
		return nil, &driver.Error{Status: 400, Code: "invalid_request", Message: err.Error()}
	}
	env["NYLORUN_TUNING"] = tuning
	keys := make([]string, 0, len(env))
	for key := range env {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	envList := make([]any, 0, len(keys))
	for _, key := range keys {
		envList = append(envList, map[string]any{"name": key, "value": env[key]})
	}

	mounts := []any{
		map[string]any{"name": "info", "mountPath": InfoDir},
		map[string]any{"name": "trust", "mountPath": TrustDir},
		map[string]any{"name": "workspace", "mountPath": "/workspace"},
		map[string]any{"name": "harness", "mountPath": "/harness"},
		// The engine writes the session's skills here, as the pods driver's volume.
		// A volume, not a directory the wrapper makes at the root: an image that runs as a user
		// other than root (uid 1000, as most computer images) can't create /skills.
		map[string]any{"name": "skills", "mountPath": "/skills"},
	}
	volumes := []any{
		map[string]any{"name": "info", "systemInfo": map[string]any{"dataSources": []any{map[string]any{
			"actorMetadata": map[string]any{"items": []any{
				map[string]any{"field": "ACTOR_METADATA_FIELD_NAME", "path": "actor-name"},
				map[string]any{"field": "ACTOR_METADATA_FIELD_UID", "path": "actor-uid"},
			}}}}}},
		map[string]any{"name": "trust", "systemInfo": map[string]any{"dataSources": []any{map[string]any{
			"trustBundle": map[string]any{"names": []any{"egress-mitm.ate.dev"}, "path": "egress.pem"}}}}},
		map[string]any{"name": "workspace", "durableDir": map[string]any{}},
		map[string]any{"name": "harness", "durableDir": map[string]any{}},
		map[string]any{"name": "skills", "durableDir": map[string]any{}},
	}
	container := map[string]any{"name": "workload", "image": s.ImageMirrors.To(images.Image), "env": envList}
	switch {
	case len(spec.Command) > 0:
		container["command"] = spec.Command
	case spec.Entrypoint == driver.EntrypointImage:
		// A custom harness is the image: its own ENTRYPOINT and CMD run.
	default:
		if spec.Entrypoint == driver.EntrypointEngine {
			if images.Harness == "" {
				return nil, &driver.Error{Status: 400, Code: "invalid_request", Message: "harnessImage is required for entrypoint engine"}
			}
			mounts = append(mounts, map[string]any{"name": EngineVolume, "mountPath": EngineDir})
			volumes = append(volumes, map[string]any{"name": EngineVolume, "image": map[string]any{"reference": images.Harness}})
		}
		container["command"] = append([]string{"/bin/sh", "-c", wrapper, "nylorun-engine"}, engineArgs()...)
	}
	container["volumeMounts"] = mounts

	t := map[string]any{
		"metadata":   map[string]any{"atespace": s.Atespace},
		"containers": []any{container},
		"volumes":    volumes,
		"resources": map[string]any{"limits": map[string]any{
			"cpuMillicores": strconv.FormatInt(int64(spec.CPUs*1000), 10),
			"memoryBytes":   strconv.FormatInt(spec.MemoryMiB<<20, 10),
		}},
		"snapshotConfig": map[string]any{
			"preferredFidelity": "SNAPSHOT_FIDELITY_MEMORY",
			// Each incarnation joins as itself: a golden snapshot would share one engine's identity.
			"goldenSnapshotConfig": map[string]any{"mode": "GOLDEN_SNAPSHOT_MODE_DISABLED"},
		},
	}
	if len(s.WorkerSelector) > 0 {
		t["workerSelector"] = map[string]any{"matchLabels": s.WorkerSelector}
	}
	return t, nil
}

// EngineVolume is the image volume the engine is mounted from (entrypoint engine).
const EngineVolume = "nylo"

// EngineReference is the Runtime image a template mounts the engine from, or "" without one.
func EngineReference(t *ateapi.ActorTemplate) string {
	for _, v := range t.GetVolumes() {
		if v.GetName() == EngineVolume {
			return v.GetImage().GetReference()
		}
	}
	return ""
}

// RepointRefusal says why Substrate v1.0.0 would refuse to repoint an actor from template `from`
// to `to`, or "" when it would not: the volumes must be identical, order included, and each
// container in both must keep identical volume mounts (controlapi's
// validateTemplateVolumesUnchanged). An image volume's reference is pinned by digest, so a
// different image is a different volume.
func RepointRefusal(from, to *ateapi.ActorTemplate) string {
	if !slices.EqualFunc(from.GetVolumes(), to.GetVolumes(), func(a, b *ateapi.Volume) bool { return proto.Equal(a, b) }) {
		return "its volumes would change (" + volumeChanges(from.GetVolumes(), to.GetVolumes()) + ")"
	}
	containers := map[string]*ateapi.Container{}
	for _, c := range to.GetContainers() {
		containers[c.GetName()] = c
	}
	for _, c := range from.GetContainers() {
		next, ok := containers[c.GetName()]
		if ok && !slices.EqualFunc(c.GetVolumeMounts(), next.GetVolumeMounts(), func(a, b *ateapi.VolumeMount) bool { return proto.Equal(a, b) }) {
			return fmt.Sprintf("the volume mounts of container %q would change", c.GetName())
		}
	}
	return ""
}

// volumeChanges names the volumes added, removed and changed between two lists.
func volumeChanges(from, to []*ateapi.Volume) string {
	before := map[string]*ateapi.Volume{}
	for _, v := range from {
		before[v.GetName()] = v
	}
	var parts []string
	seen := map[string]bool{}
	for _, v := range to {
		seen[v.GetName()] = true
		switch old, ok := before[v.GetName()]; {
		case !ok:
			parts = append(parts, "adds "+v.GetName())
		case !proto.Equal(old, v):
			parts = append(parts, "changes "+v.GetName())
		}
	}
	for _, v := range from {
		if !seen[v.GetName()] {
			parts = append(parts, "removes "+v.GetName())
		}
	}
	if len(parts) == 0 {
		return "reorders them"
	}
	return strings.Join(parts, ", ")
}

// TemplateName is the template's name: the incarnation's, and a hash of what it renders, so a
// changed spec gets a new template (templates are immutable) and a repeated one the same.
func TemplateName(sandbox string, rendered map[string]any) (string, error) {
	raw, err := json.Marshal(rendered)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(raw)
	return sandbox + "-t" + hex.EncodeToString(sum[:])[:10], nil
}

// ToProto decodes a rendered template, named, into the API's message.
func ToProto(rendered map[string]any, name string) (*ateapi.ActorTemplate, error) {
	copyOf := map[string]any{}
	for k, v := range rendered {
		copyOf[k] = v
	}
	meta := map[string]any{}
	if m, ok := rendered["metadata"].(map[string]any); ok {
		for k, v := range m {
			meta[k] = v
		}
	}
	meta["name"] = name
	copyOf["metadata"] = meta
	raw, err := json.Marshal(copyOf)
	if err != nil {
		return nil, err
	}
	var out ateapi.ActorTemplate
	if err := protojson.Unmarshal(raw, &out); err != nil {
		return nil, fmt.Errorf("render template %s: %w", name, err)
	}
	return &out, nil
}

// EgressPolicy is the actor's singleton policy: the edge passed through (the engine's
// WebSocket and its gates), the Agent's hosts over TLS (passed through, 443) and cleartext HTTP
// (80), and, with keys on, an https rule per keyed host whose header Substrate's egress fills from
// the keys provider. A keyed pattern leaves the passthrough rule: Substrate refuses two
// rules that tie on a name and port, and an exact keyed host already wins over a wildcard.
func EgressPolicy(s Settings, network Network, keys *driver.SpecKeys) (*ateapi.EgressPolicy, error) {
	edgePorts := make([]any, 0, len(s.EdgePorts))
	for _, port := range s.EdgePorts {
		edgePorts = append(edgePorts, port)
	}
	// A computer dials nothing to the Runtime: no edge rule.
	rules := []any{}
	if s.EdgeHost != "" && !s.Computer() {
		rules = append(rules, map[string]any{"tlsPassthrough": map[string]any{
			"hostnames": []any{s.EdgeHost}, "ports": map[string]any{"numbers": edgePorts}}})
	}
	var hosts []any
	if network.Open {
		hosts = []any{"*"}
	} else {
		seen := map[string]bool{}
		add := func(h string) {
			h = strings.ToLower(strings.TrimSuffix(h, "."))
			if h != "" && !seen[h] && len(hosts) < 256 {
				seen[h] = true
				hosts = append(hosts, h)
			}
		}
		for _, h := range network.Hosts {
			add(h)
		}
		for _, suffix := range network.Suffixes {
			add("*" + suffix)
		}
	}
	keyed := map[string]bool{}
	if s.KeysProvider != "" && keys != nil {
		for _, k := range keys.Hosts {
			keyed[k.Host] = true
			rules = append(rules, map[string]any{"https": map[string]any{
				"hostnames": []any{k.Host},
				"ports":     map[string]any{"numbers": []any{443}},
				"effects": map[string]any{"replaceHeaders": []any{map[string]any{
					"header":        k.Header,
					"prefix":        "",
					"credentialUri": KeyReference(s.KeysProvider, keys.Sandbox, k.Host),
				}}},
			}})
		}
	}
	passed := make([]any, 0, len(hosts))
	for _, h := range hosts {
		if !keyed[h.(string)] {
			passed = append(passed, h)
		}
	}
	if len(passed) > 0 {
		rules = append(rules, map[string]any{"tlsPassthrough": map[string]any{"hostnames": passed, "ports": map[string]any{"numbers": []any{443}}}})
	}
	if len(hosts) > 0 {
		rules = append(rules,
			map[string]any{"http": map[string]any{"hostnames": hosts, "ports": map[string]any{"numbers": []any{80}}}},
		)
	}
	raw, err := json.Marshal(map[string]any{"rules": rules})
	if err != nil {
		return nil, err
	}
	var p ateapi.EgressPolicy
	if err := protojson.Unmarshal(raw, &p); err != nil {
		return nil, fmt.Errorf("render egress policy: %w", err)
	}
	return &p, nil
}
