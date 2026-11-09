// Package api is the sandboxes service's HTTP API. Only the Runtime's core holds its bearer
// token (NYLORUN_SANDBOXES_TOKEN); /ready and /health are open for health checks.
//
//	GET    /ready                 informers synced and the API server answers
//	GET    /health                the process is up
//	GET    /v1/info               the cluster as `nylorun local sandbox enable` recorded it
//	PUT    /v1/pods/{name}        create or update a Sandbox (body driver.Spec)
//	GET    /v1/pods/{name}        its status; ?wait=ready|suspended|expired|gone&timeoutMs=<=30000
//	DELETE /v1/pods/{name}?opId=  delete it (foreground) and its join Secret
package api

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"google.golang.org/grpc/codes"
	grpcstatus "google.golang.org/grpc/status"
	apierrors "k8s.io/apimachinery/pkg/api/errors"

	"github.com/nylorun/agents/sandboxes/internal/config"
	"github.com/nylorun/agents/sandboxes/internal/driver"
)

// MaxWait bounds GET ?wait=.
const MaxWait = 30 * time.Second

// Backend runs the sandboxes: agent-sandbox's driver, or Substrate's (ADR-138).
type Backend interface {
	Put(ctx context.Context, name string, spec driver.Spec) (driver.Status, error)
	Delete(ctx context.Context, name string) (driver.Status, error)
	Status(name string) (driver.Status, error)
	Wait(ctx context.Context, name, want string, timeout time.Duration) (driver.Status, bool, error)
	// Ping checks the backend's API answers and allows this service.
	Ping(ctx context.Context) error
	// Synced reports whether the backend has read its state once.
	Synced() bool
}

// Server serves the API over a backend.
type Server struct {
	Driver  Backend
	Cluster config.Cluster
	Token   string
	Log     *slog.Logger

	mu        sync.Mutex
	checkedAt time.Time
	readyErr  error
}

// Info is GET /v1/info.
type Info struct {
	// Backend is agent-sandbox or substrate.
	Backend           string               `json:"backend"`
	Namespace         string               `json:"namespace"`
	Context           string               `json:"context"`
	ControllerVersion string               `json:"controllerVersion"`
	APIVersion        string               `json:"apiVersion"`
	HostAddress       string               `json:"hostAddress"`
	Ports             config.Ports         `json:"ports"`
	NetworkPolicy     config.NetworkPolicy `json:"networkPolicy"`
	// Atespace and SubstrateVersion, with backend substrate.
	Atespace         string `json:"atespace,omitempty"`
	SubstrateVersion string `json:"substrateVersion,omitempty"`
}

// Handler is the API's routes.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", func(w http.ResponseWriter, r *http.Request) {
		write(w, http.StatusOK, map[string]string{"status": "ok"})
	})
	mux.HandleFunc("GET /ready", s.ready)
	mux.HandleFunc("GET /v1/info", s.auth(s.info))
	mux.HandleFunc("PUT /v1/pods/{name}", s.auth(s.put))
	mux.HandleFunc("GET /v1/pods/{name}", s.auth(s.get))
	mux.HandleFunc("DELETE /v1/pods/{name}", s.auth(s.delete))
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		fail(w, &driver.Error{Status: http.StatusNotFound, Code: "not_found", Message: "no such route"})
	})
	return mux
}

func digest(value string) []byte {
	sum := sha256.Sum256([]byte(value))
	return sum[:]
}

func (s *Server) auth(next http.HandlerFunc) http.HandlerFunc {
	want := digest(s.Token)
	return func(w http.ResponseWriter, r *http.Request) {
		token, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
		if !ok || subtle.ConstantTimeCompare(digest(token), want) != 1 {
			w.Header().Set("WWW-Authenticate", "Bearer")
			fail(w, &driver.Error{Status: http.StatusUnauthorized, Code: "unauthorized", Message: "missing or wrong bearer token"})
			return
		}
		next(w, r)
	}
}

// Ready is nil once the informers synced and the API server answered within the last 5 s.
func (s *Server) Ready(ctx context.Context) error {
	if !s.Driver.Synced() {
		return errors.New("the backend has not synced")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if time.Since(s.checkedAt) < 5*time.Second {
		return s.readyErr
	}
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	s.readyErr = s.Driver.Ping(ctx)
	s.checkedAt = time.Now()
	return s.readyErr
}

func (s *Server) ready(w http.ResponseWriter, r *http.Request) {
	if err := s.Ready(r.Context()); err != nil {
		write(w, http.StatusServiceUnavailable, map[string]string{"status": "unavailable", "reason": err.Error()})
		return
	}
	write(w, http.StatusOK, map[string]string{"status": "ready"})
}

func (s *Server) info(w http.ResponseWriter, r *http.Request) {
	c := s.Cluster
	info := Info{
		Backend:   c.Backend,
		Namespace: c.Namespace, Context: c.Context, ControllerVersion: c.ControllerVersion,
		APIVersion: driver.APIVersion, HostAddress: c.HostAddress, Ports: c.Ports, NetworkPolicy: c.NetworkPolicy,
	}
	if info.Backend == "" {
		info.Backend = config.BackendAgentSandbox
	}
	if c.Substrate != nil {
		info.APIVersion = "ateapi.v1"
		info.Atespace, info.SubstrateVersion = c.Substrate.Atespace, c.Substrate.Version
	}
	write(w, http.StatusOK, info)
}

func (s *Server) put(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	var spec driver.Spec
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&spec); err != nil {
		fail(w, &driver.Error{Status: http.StatusBadRequest, Code: "invalid_request", Message: "invalid JSON body: " + err.Error()})
		return
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		fail(w, &driver.Error{Status: http.StatusBadRequest, Code: "invalid_request", Message: "the body must be one JSON object"})
		return
	}
	status, err := s.Driver.Put(r.Context(), name, spec)
	if err != nil {
		s.Log.Warn("put", "name", name, "opId", spec.OpID, "error", err)
		fail(w, err)
		return
	}
	s.Log.Info("put", "name", name, "opId", spec.OpID, "mode", spec.Mode)
	write(w, http.StatusOK, status)
}

// waited is a status with whether the awaited state was reached.
type waited struct {
	driver.Status
	Met bool `json:"met"`
}

func (s *Server) get(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	query := r.URL.Query()
	want := query.Get("wait")
	if want == "" {
		status, err := s.Driver.Status(name)
		if err != nil {
			fail(w, err)
			return
		}
		write(w, http.StatusOK, status)
		return
	}
	timeout := MaxWait
	if raw := query.Get("timeoutMs"); raw != "" {
		ms, err := strconv.Atoi(raw)
		if err != nil || ms < 0 || time.Duration(ms)*time.Millisecond > MaxWait {
			fail(w, &driver.Error{Status: http.StatusBadRequest, Code: "invalid_request", Message: "timeoutMs must be 0–30000"})
			return
		}
		timeout = time.Duration(ms) * time.Millisecond
	}
	status, met, err := s.Driver.Wait(r.Context(), name, want, timeout)
	if err != nil {
		fail(w, err)
		return
	}
	write(w, http.StatusOK, waited{status, met})
}

func (s *Server) delete(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	opID := r.URL.Query().Get("opId")
	status, err := s.Driver.Delete(r.Context(), name)
	if err != nil {
		s.Log.Warn("delete", "name", name, "opId", opID, "error", err)
		fail(w, err)
		return
	}
	s.Log.Info("delete", "name", name, "opId", opID)
	write(w, http.StatusOK, status)
}

func write(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

// fail maps an error to {error: {code, message}}.
func fail(w http.ResponseWriter, err error) {
	var refusal *driver.Error
	status, code := http.StatusBadGateway, "kubernetes_error"
	switch {
	case errors.As(err, &refusal):
		status, code = refusal.Status, refusal.Code
	case apierrors.IsNotFound(err):
		status, code = http.StatusNotFound, "not_found"
	case apierrors.IsConflict(err), apierrors.IsAlreadyExists(err):
		status, code = http.StatusConflict, "conflict"
	case apierrors.IsInvalid(err):
		status, code = http.StatusUnprocessableEntity, "invalid_spec"
	case apierrors.IsForbidden(err):
		status, code = http.StatusBadGateway, "forbidden"
	case apierrors.IsTimeout(err), apierrors.IsServerTimeout(err), apierrors.IsServiceUnavailable(err),
		errors.Is(err, context.DeadlineExceeded):
		status, code = http.StatusServiceUnavailable, "unavailable"
	default:
		// Substrate's API answers with gRPC codes.
		if st, ok := grpcstatus.FromError(err); ok {
			switch st.Code() {
			case codes.NotFound:
				status, code = http.StatusNotFound, "not_found"
			case codes.AlreadyExists, codes.Aborted, codes.FailedPrecondition:
				status, code = http.StatusConflict, "conflict"
			case codes.InvalidArgument:
				status, code = http.StatusUnprocessableEntity, "invalid_spec"
			case codes.PermissionDenied, codes.Unauthenticated:
				status, code = http.StatusBadGateway, "forbidden"
			case codes.Unavailable, codes.DeadlineExceeded:
				status, code = http.StatusServiceUnavailable, "unavailable"
			}
		}
	}
	write(w, status, map[string]any{"error": map[string]string{"code": code, "message": err.Error()}})
}
