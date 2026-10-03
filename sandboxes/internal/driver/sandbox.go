// Package driver drives agent-sandbox Sandboxes (agents.x-k8s.io/v1beta1) in one namespace
// with the dynamic client: it renders the pod shape, applies it server-side, and reads status
// from namespace informers. It keeps no state of its own; the operation id of the last apply
// is an annotation on the Sandbox.
package driver

import (
	"context"
	"crypto/sha256"
	"encoding/base32"
	"fmt"
	"net/http"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/dynamic"
)

var (
	SandboxGVR = schema.GroupVersionResource{Group: "agents.x-k8s.io", Version: "v1beta1", Resource: "sandboxes"}
	PodGVR     = schema.GroupVersionResource{Version: "v1", Resource: "pods"}
	PVCGVR     = schema.GroupVersionResource{Version: "v1", Resource: "persistentvolumeclaims"}
	SecretGVR  = schema.GroupVersionResource{Version: "v1", Resource: "secrets"}
)

const (
	// APIVersion is the agent-sandbox API this service drives (controller v1.0.5).
	APIVersion = "agents.x-k8s.io/v1beta1"
	// FieldManager owns every field this service applies.
	FieldManager = "nylorun-sandboxes"
	// OpAnnotation records the operation id of the last apply.
	OpAnnotation = "nylorun.dev/op"
	RoleLabel    = "nylorun.dev/role"
	SandboxLabel = "nylorun.dev/sandbox"
	ManagedLabel = "app.kubernetes.io/managed-by"

	// DefaultImage runs when neither the sandbox spec nor the Tenant names one.
	DefaultImage = "python:3.13-slim"
	// JoinDir is where the workload reads its join token (Secret <name>-join, key token).
	JoinDir  = "/run/nylorun/join"
	JoinFile = JoinDir + "/token"
	// VolumeName is the volume claim template; agent-sandbox names the claim data-<name>.
	VolumeName = "data"
	uid        = int64(1000)
)

// NamePattern is the Kubernetes name of a sandbox incarnation: sbx-<16 base32>-g<volume generation>.
var NamePattern = regexp.MustCompile(`^sbx-[a-z2-7]{16}-g[0-9]{1,6}$`)

var (
	opPattern  = regexp.MustCompile(`^[A-Za-z0-9._:-]{1,128}$`)
	envPattern = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]{0,127}$`)
	reserved   = map[string]bool{
		"HOME": true, "NYLORUN_POD_UID": true, "NYLORUN_SANDBOX_JOIN_FILE": true,
		"NYLORUN_HARNESS_URL": true, "NYLORUN_GATES_URL": true, "NYLORUN_EGRESS_PROXY": true,
		"NYLORUN_SANDBOX_KIND": true,
	}
	lowerBase32 = base32.NewEncoding("abcdefghijklmnopqrstuvwxyz234567").WithPadding(base32.NoPadding)
)

// Name is the Sandbox name of a Tenant's sandbox at a volume generation:
// sbx-<lowercase base32(sha256("<tenant>/<id>"))[:16]>-g<volumeGen>. Core computes the same.
func Name(tenant, id string, volumeGen int) string {
	sum := sha256.Sum256([]byte(tenant + "/" + id))
	return fmt.Sprintf("sbx-%s-g%d", lowerBase32.EncodeToString(sum[:])[:16], volumeGen)
}

// Spec is the body of PUT /v1/pods/{name}.
type Spec struct {
	OpID string `json:"opId"`
	// Mode is Running or Suspended.
	Mode string `json:"mode"`
	// Image is the workload image (default python:3.13-slim).
	Image string `json:"image,omitempty"`
	// HarnessImage is the Runtime image the engine is copied from (init container nylo-copy).
	HarnessImage string `json:"harnessImage,omitempty"`
	// Command replaces the engine command; without a harness image the engine is not copied.
	// For diagnostics and the service suite.
	Command          []string          `json:"command,omitempty"`
	CPUs             float64           `json:"cpus,omitempty"`
	MemoryMiB        int64             `json:"memoryMiB,omitempty"`
	StorageGiB       int64             `json:"storageGiB,omitempty"`
	StopGraceSeconds int64             `json:"stopGraceSeconds,omitempty"`
	ShutdownTime     string            `json:"shutdownTime,omitempty"`
	ShutdownPolicy   string            `json:"shutdownPolicy,omitempty"`
	Env              map[string]string `json:"env,omitempty"`
	// JoinToken, when set, is written to Secret <name>-join before the Sandbox is applied.
	JoinToken string `json:"joinToken,omitempty"`
}

// PodURLs are the pod-facing addresses on the Docker host (empty until the stack publishes them).
type PodURLs struct{ Harness, Gates, Egress string }

// Error is a refusal with an HTTP status and a stable code.
type Error struct {
	Status  int
	Code    string
	Message string
}

func (e *Error) Error() string { return e.Message }

func invalid(format string, args ...any) error {
	return &Error{http.StatusBadRequest, "invalid_request", fmt.Sprintf(format, args...)}
}

// ValidateName refuses names this service does not manage.
func ValidateName(name string) error {
	if !NamePattern.MatchString(name) {
		return invalid("name must match %s", NamePattern)
	}
	return nil
}

// Normalize validates a spec and fills its defaults.
func (s *Spec) Normalize() error {
	if !opPattern.MatchString(s.OpID) {
		return invalid("opId must match %s", opPattern)
	}
	if s.Mode != "Running" && s.Mode != "Suspended" {
		return invalid("mode must be Running or Suspended")
	}
	if s.Image == "" {
		s.Image = DefaultImage
	}
	if len(s.Image) > 512 || strings.ContainsAny(s.Image, " \t\n") {
		return invalid("image is not an image reference")
	}
	if len(s.HarnessImage) > 512 || strings.ContainsAny(s.HarnessImage, " \t\n") {
		return invalid("harnessImage is not an image reference")
	}
	if s.HarnessImage == "" && len(s.Command) == 0 {
		return invalid("harnessImage is required unless command is given")
	}
	if len(s.Command) > 64 {
		return invalid("command has more than 64 arguments")
	}
	if s.CPUs == 0 {
		s.CPUs = 1
	}
	if s.CPUs < 0.1 || s.CPUs > 64 {
		return invalid("cpus must be between 0.1 and 64")
	}
	if s.MemoryMiB == 0 {
		s.MemoryMiB = 1024
	}
	if s.MemoryMiB < 64 || s.MemoryMiB > 262144 {
		return invalid("memoryMiB must be between 64 and 262144")
	}
	if s.StorageGiB == 0 {
		s.StorageGiB = 5
	}
	if s.StorageGiB < 1 || s.StorageGiB > 1024 {
		return invalid("storageGiB must be between 1 and 1024")
	}
	if s.StopGraceSeconds == 0 {
		s.StopGraceSeconds = 10
	}
	if s.StopGraceSeconds < 1 || s.StopGraceSeconds > 30 {
		return invalid("stopGraceSeconds must be between 1 and 30")
	}
	if s.ShutdownTime != "" {
		at, err := time.Parse(time.RFC3339, s.ShutdownTime)
		if err != nil {
			return invalid("shutdownTime must be RFC 3339")
		}
		s.ShutdownTime = at.UTC().Format(time.RFC3339)
	}
	if s.ShutdownPolicy == "" {
		s.ShutdownPolicy = "Retain"
	}
	if s.ShutdownPolicy != "Retain" && s.ShutdownPolicy != "Delete" {
		return invalid("shutdownPolicy must be Retain or Delete")
	}
	if len(s.Env) > 64 {
		return invalid("env has more than 64 variables")
	}
	for key, value := range s.Env {
		if !envPattern.MatchString(key) || reserved[key] {
			return invalid("env %q is not allowed", key)
		}
		if len(value) > 4096 {
			return invalid("env %q is longer than 4096 bytes", key)
		}
	}
	if len(s.JoinToken) > 512 {
		return invalid("joinToken is longer than 512 bytes")
	}
	return nil
}

func hardened() map[string]any {
	return map[string]any{
		"allowPrivilegeEscalation": false,
		"readOnlyRootFilesystem":   true,
		"capabilities":             map[string]any{"drop": []any{"ALL"}},
	}
}

func strings2any(values []string) []any {
	out := make([]any, len(values))
	for i, v := range values {
		out[i] = v
	}
	return out
}

func millicores(cpus float64) string {
	return strconv.FormatInt(int64(cpus*1000+0.5), 10) + "m"
}

// EngineCommand runs the copied engine under tini as PID 1 (signals reach the whole group).
var EngineCommand = []string{
	"/nylo/tini-static", "-g", "--",
	"/nylo/node", "/nylo/app/runtime/dist/host/main.js", "--service", "harness",
}

// Render is the Sandbox for spec (normalized) in namespace. The pod shape is decided here only.
func Render(namespace, name string, spec Spec, urls PodURLs) *unstructured.Unstructured {
	env := []any{
		map[string]any{"name": "HOME", "value": "/harness/home"},
		map[string]any{"name": "NYLORUN_POD_UID", "valueFrom": map[string]any{
			"fieldRef": map[string]any{"fieldPath": "metadata.uid"}}},
		map[string]any{"name": "NYLORUN_SANDBOX_KIND", "value": "pod"},
		map[string]any{"name": "NYLORUN_SANDBOX_JOIN_FILE", "value": JoinFile},
		map[string]any{"name": "NYLORUN_HARNESS_URL", "value": urls.Harness},
		map[string]any{"name": "NYLORUN_GATES_URL", "value": urls.Gates},
		map[string]any{"name": "NYLORUN_EGRESS_PROXY", "value": urls.Egress},
	}
	keys := make([]string, 0, len(spec.Env))
	for key := range spec.Env {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		env = append(env, map[string]any{"name": key, "value": spec.Env[key]})
	}

	command := EngineCommand
	if len(spec.Command) > 0 {
		command = spec.Command
	}
	mounts := []any{
		map[string]any{"name": VolumeName, "mountPath": "/workspace", "subPath": "workspace"},
		map[string]any{"name": VolumeName, "mountPath": "/harness", "subPath": "harness"},
		map[string]any{"name": "tmp", "mountPath": "/tmp"},
		map[string]any{"name": "join", "mountPath": JoinDir, "readOnly": true},
	}
	volumes := []any{
		map[string]any{"name": "tmp", "emptyDir": map[string]any{}},
		map[string]any{"name": "join", "secret": map[string]any{
			"secretName": name + "-join", "optional": true, "defaultMode": int64(0o440)}},
	}
	podSpec := map[string]any{
		"automountServiceAccountToken":  false,
		"enableServiceLinks":            false,
		"terminationGracePeriodSeconds": spec.StopGraceSeconds,
		"securityContext": map[string]any{
			"runAsNonRoot":   true,
			"runAsUser":      uid,
			"runAsGroup":     uid,
			"fsGroup":        uid,
			"seccompProfile": map[string]any{"type": "RuntimeDefault"},
		},
	}
	if spec.HarnessImage != "" {
		// The engine (node, tini and the Runtime's /app) is copied from the Runtime image into
		// an emptyDir, read-only in the workload: any glibc image can host the harness.
		// kindnet applies a new pod's NetworkPolicy asynchronously (egress seen open for ~1 s
		// after start): the engine must not trust the network before it applies (8b).
		mounts = append(mounts, map[string]any{"name": "nylo", "mountPath": "/nylo", "readOnly": true})
		volumes = append(volumes, map[string]any{"name": "nylo", "emptyDir": map[string]any{}})
		podSpec["initContainers"] = []any{map[string]any{
			"name":            "nylo-copy",
			"image":           spec.HarnessImage,
			"command":         []any{"cp", "-a", "/usr/bin/tini-static", "/usr/local/bin/node", "/app", "/nylo/"},
			"securityContext": hardened(),
			"resources": map[string]any{
				"requests": map[string]any{"cpu": "50m", "memory": "64Mi"},
				"limits":   map[string]any{"cpu": "1", "memory": "256Mi"},
			},
			"volumeMounts": []any{map[string]any{"name": "nylo", "mountPath": "/nylo"}},
		}}
	}
	podSpec["containers"] = []any{map[string]any{
		"name":            "workload",
		"image":           spec.Image,
		"command":         strings2any(command),
		"workingDir":      "/workspace",
		"env":             env,
		"securityContext": hardened(),
		"resources": map[string]any{
			"requests": map[string]any{"cpu": "100m", "memory": "128Mi"},
			"limits": map[string]any{
				"cpu":    millicores(spec.CPUs),
				"memory": strconv.FormatInt(spec.MemoryMiB, 10) + "Mi",
			},
		},
		"volumeMounts": mounts,
	}}
	podSpec["volumes"] = volumes

	sandboxSpec := map[string]any{
		"operatingMode":  spec.Mode,
		"shutdownPolicy": spec.ShutdownPolicy,
		"podTemplate": map[string]any{
			"metadata": map[string]any{"labels": map[string]any{RoleLabel: "sandbox", SandboxLabel: name}},
			"spec":     podSpec,
		},
		"volumeClaimTemplates": []any{map[string]any{
			"metadata": map[string]any{"name": VolumeName, "labels": map[string]any{SandboxLabel: name}},
			"spec": map[string]any{
				"accessModes": []any{"ReadWriteOnce"},
				"resources": map[string]any{"requests": map[string]any{
					"storage": strconv.FormatInt(spec.StorageGiB, 10) + "Gi"}},
			},
		}},
	}
	if spec.ShutdownTime != "" {
		sandboxSpec["shutdownTime"] = spec.ShutdownTime
	}
	return &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": APIVersion,
		"kind":       "Sandbox",
		"metadata": map[string]any{
			"name":        name,
			"namespace":   namespace,
			"labels":      map[string]any{ManagedLabel: FieldManager, SandboxLabel: name},
			"annotations": map[string]any{OpAnnotation: spec.OpID},
		},
		"spec": sandboxSpec,
	}}
}

// storageOf is the storage request of a Sandbox's volume claim template.
func storageOf(o *unstructured.Unstructured) string {
	templates, _, _ := unstructured.NestedSlice(o.Object, "spec", "volumeClaimTemplates")
	for _, t := range templates {
		if m, ok := t.(map[string]any); ok {
			value, _, _ := unstructured.NestedString(m, "spec", "resources", "requests", "storage")
			return value
		}
	}
	return ""
}

// Driver drives the Sandboxes of one namespace.
type Driver struct {
	client    dynamic.Interface
	namespace string
	urls      PodURLs
	cache     *Cache
	locks     sync.Map
}

// New returns a driver; Start its cache before serving.
func New(client dynamic.Interface, namespace string, urls PodURLs) *Driver {
	return &Driver{client: client, namespace: namespace, urls: urls, cache: NewCache(client, namespace)}
}

// Cache is the driver's namespace informers.
func (d *Driver) Cache() *Cache { return d.cache }

// Namespace is the namespace the driver manages.
func (d *Driver) Namespace() string { return d.namespace }

func (d *Driver) lock(name string) func() {
	value, _ := d.locks.LoadOrStore(name, &sync.Mutex{})
	mu := value.(*sync.Mutex)
	mu.Lock()
	return mu.Unlock
}

func (d *Driver) sandboxes() dynamic.ResourceInterface {
	return d.client.Resource(SandboxGVR).Namespace(d.namespace)
}

// Ping lists one Sandbox: the API server answers and the Role allows it.
func (d *Driver) Ping(ctx context.Context) error {
	_, err := d.sandboxes().List(ctx, metav1.ListOptions{Limit: 1})
	return err
}

// Put creates or updates the Sandbox `name`: the join Secret first (when the spec carries a
// token), then a server-side apply. A spec whose opId the Sandbox already records is a no-op.
func (d *Driver) Put(ctx context.Context, name string, spec Spec) (Status, error) {
	if err := ValidateName(name); err != nil {
		return Status{}, err
	}
	if err := spec.Normalize(); err != nil {
		return Status{}, err
	}
	defer d.lock(name)()
	current, err := d.sandboxes().Get(ctx, name, metav1.GetOptions{})
	switch {
	case err == nil:
		if current.GetDeletionTimestamp() != nil {
			return Status{}, &Error{http.StatusConflict, "deleting", "the sandbox is being deleted"}
		}
		if current.GetAnnotations()[OpAnnotation] == spec.OpID {
			return d.cache.statusWith(name, current), nil
		}
		want := strconv.FormatInt(spec.StorageGiB, 10) + "Gi"
		if have := storageOf(current); have != "" && have != want {
			return Status{}, &Error{http.StatusConflict, "storage_immutable",
				fmt.Sprintf("storage is %s and cannot change; reset the sandbox for a new volume", have)}
		}
	case apierrors.IsNotFound(err):
	default:
		return Status{}, err
	}
	if spec.JoinToken != "" {
		if err := d.putJoinSecret(ctx, name, spec.JoinToken); err != nil {
			return Status{}, err
		}
	}
	applied, err := d.sandboxes().Apply(ctx, name, Render(d.namespace, name, spec, d.urls),
		metav1.ApplyOptions{FieldManager: FieldManager, Force: true})
	if err != nil {
		return Status{}, err
	}
	return d.cache.statusWith(name, applied), nil
}

// Delete deletes the Sandbox in the foreground (its pod and claim go with it) and its join
// Secret. Deleting a sandbox that is gone succeeds.
func (d *Driver) Delete(ctx context.Context, name string) (Status, error) {
	if err := ValidateName(name); err != nil {
		return Status{}, err
	}
	defer d.lock(name)()
	current, err := d.sandboxes().Get(ctx, name, metav1.GetOptions{})
	switch {
	case err == nil:
		if current.GetDeletionTimestamp() == nil {
			uid := current.GetUID()
			policy := metav1.DeletePropagationForeground
			err = d.sandboxes().Delete(ctx, name, metav1.DeleteOptions{
				PropagationPolicy: &policy, Preconditions: &metav1.Preconditions{UID: &uid}})
			if err != nil && !apierrors.IsNotFound(err) {
				return Status{}, err
			}
		}
	case apierrors.IsNotFound(err):
	default:
		return Status{}, err
	}
	if err := d.deleteJoinSecret(ctx, name); err != nil {
		return Status{}, err
	}
	status := d.cache.Status(name)
	if status.Exists {
		status.Deleting = true
	}
	return status, nil
}

// Status is the sandbox as the namespace informers see it.
func (d *Driver) Status(name string) (Status, error) {
	if err := ValidateName(name); err != nil {
		return Status{}, err
	}
	return d.cache.Status(name), nil
}

// Wait blocks until the sandbox reaches `want` (ready, suspended, expired, gone) or the
// timeout passes; met reports which.
func (d *Driver) Wait(ctx context.Context, name, want string, timeout time.Duration) (Status, bool, error) {
	if err := ValidateName(name); err != nil {
		return Status{}, false, err
	}
	match, ok := waits[want]
	if !ok {
		return Status{}, false, invalid("wait must be ready, suspended, expired or gone")
	}
	status, met := d.cache.Wait(ctx, name, match, timeout)
	return status, met, nil
}
