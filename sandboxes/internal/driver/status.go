package driver

import (
	"context"
	"sync"
	"time"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/dynamic/dynamicinformer"
	"k8s.io/client-go/tools/cache"
)

// Status is a sandbox as GET /v1/pods/{name} reports it.
type Status struct {
	Name string `json:"name"`
	// Exists: the Sandbox object exists (possibly being deleted).
	Exists   bool `json:"exists"`
	Deleting bool `json:"deleting"`
	// Mode is spec.operatingMode (Running or Suspended).
	Mode string `json:"mode,omitempty"`
	// Ready: the controller reports the pod Ready for the current generation.
	Ready bool `json:"ready"`
	// Suspended: the controller reports the pod gone for a Suspended generation.
	Suspended bool `json:"suspended"`
	// Expired: shutdownTime passed (Ready=False, reason SandboxExpired).
	Expired bool `json:"expired"`
	// PodUID is the current (not terminating) pod's UID.
	PodUID string `json:"podUID,omitempty"`
	// PodPhase is the pod's phase, Terminating while it is deleted; empty with no pod.
	PodPhase string `json:"podPhase,omitempty"`
	// Volume is present while the claim data-<name> exists, else missing.
	Volume       string `json:"volume"`
	OpID         string `json:"opId,omitempty"`
	ShutdownTime string `json:"shutdownTime,omitempty"`
	// Reason and Message are the Ready condition's.
	Reason  string `json:"reason,omitempty"`
	Message string `json:"message,omitempty"`
}

var waits = map[string]func(Status) bool{
	"ready":     func(s Status) bool { return s.Exists && !s.Deleting && s.Ready },
	"suspended": func(s Status) bool { return s.Exists && s.Suspended && s.PodPhase == "" },
	"expired":   func(s Status) bool { return s.Exists && s.Expired },
	"gone":      func(s Status) bool { return !s.Exists && s.PodPhase == "" && s.Volume == "missing" },
}

// Cache holds Sandbox, Pod and claim informers for the namespace and wakes waiters on change.
type Cache struct {
	sandboxes, pods, claims cache.SharedIndexInformer
	namespace               string
	mu                      sync.Mutex
	changed                 chan struct{}
}

const podIndex = "sandbox"

func informer(client dynamic.Interface, gvr schema.GroupVersionResource, namespace string,
	indexers cache.Indexers, tweak dynamicinformer.TweakListOptionsFunc) cache.SharedIndexInformer {
	return dynamicinformer.NewFilteredDynamicInformer(client, gvr, namespace, 10*time.Minute, indexers, tweak).Informer()
}

// NewCache builds (but does not start) the informers.
func NewCache(client dynamic.Interface, namespace string) *Cache {
	c := &Cache{namespace: namespace, changed: make(chan struct{})}
	c.sandboxes = informer(client, SandboxGVR, namespace, cache.Indexers{}, nil)
	c.pods = informer(client, PodGVR, namespace, cache.Indexers{
		podIndex: func(obj any) ([]string, error) {
			if o, ok := obj.(*unstructured.Unstructured); ok {
				if name := o.GetLabels()[SandboxLabel]; name != "" {
					return []string{name}, nil
				}
			}
			return nil, nil
		},
	}, func(options *metav1.ListOptions) { options.LabelSelector = RoleLabel + "=sandbox" })
	c.claims = informer(client, PVCGVR, namespace, cache.Indexers{}, nil)
	handler := cache.ResourceEventHandlerFuncs{
		AddFunc:    func(any) { c.notify() },
		UpdateFunc: func(any, any) { c.notify() },
		DeleteFunc: func(any) { c.notify() },
	}
	for _, i := range []cache.SharedIndexInformer{c.sandboxes, c.pods, c.claims} {
		_, _ = i.AddEventHandler(handler)
	}
	return c
}

// Start runs the informers until ctx ends.
func (c *Cache) Start(ctx context.Context) {
	for _, i := range []cache.SharedIndexInformer{c.sandboxes, c.pods, c.claims} {
		go i.Run(ctx.Done())
	}
}

// Synced reports whether every informer has listed once.
func (c *Cache) Synced() bool {
	return c.sandboxes.HasSynced() && c.pods.HasSynced() && c.claims.HasSynced()
}

// WaitForSync blocks until the informers synced or ctx ends.
func (c *Cache) WaitForSync(ctx context.Context) bool {
	return cache.WaitForCacheSync(ctx.Done(), c.sandboxes.HasSynced, c.pods.HasSynced, c.claims.HasSynced)
}

func (c *Cache) notify() {
	c.mu.Lock()
	close(c.changed)
	c.changed = make(chan struct{})
	c.mu.Unlock()
}

func (c *Cache) signal() <-chan struct{} {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.changed
}

func get(store cache.Store, key string) *unstructured.Unstructured {
	item, exists, err := store.GetByKey(key)
	if err != nil || !exists {
		return nil
	}
	o, _ := item.(*unstructured.Unstructured)
	return o
}

// Status reads the sandbox from the informers.
func (c *Cache) Status(name string) Status {
	return c.statusWith(name, get(c.sandboxes.GetStore(), c.namespace+"/"+name))
}

// statusWith uses `sandbox` (e.g. the object an apply returned) with the cached pod and claim.
func (c *Cache) statusWith(name string, sandbox *unstructured.Unstructured) Status {
	var pods []*unstructured.Unstructured
	items, _ := c.pods.GetIndexer().ByIndex(podIndex, name)
	for _, item := range items {
		if o, ok := item.(*unstructured.Unstructured); ok {
			pods = append(pods, o)
		}
	}
	claim := get(c.claims.GetStore(), c.namespace+"/"+VolumeName+"-"+name)
	return Compute(name, sandbox, pods, claim)
}

func condition(o *unstructured.Unstructured, kind string) (status, reason, message string, current bool) {
	items, _, _ := unstructured.NestedSlice(o.Object, "status", "conditions")
	for _, item := range items {
		m, ok := item.(map[string]any)
		if !ok || m["type"] != kind {
			continue
		}
		status, _ = m["status"].(string)
		reason, _ = m["reason"].(string)
		message, _ = m["message"].(string)
		generation, found, _ := unstructured.NestedInt64(m, "observedGeneration")
		return status, reason, message, !found || generation >= o.GetGeneration()
	}
	return "", "", "", false
}

// Compute derives a Status from the Sandbox, its pods and its claim (each may be absent).
func Compute(name string, sandbox *unstructured.Unstructured, pods []*unstructured.Unstructured,
	claim *unstructured.Unstructured) Status {
	s := Status{Name: name, Volume: "missing"}
	if claim != nil {
		s.Volume = "present"
	}
	for _, pod := range pods {
		if pod.GetDeletionTimestamp() != nil {
			if s.PodPhase == "" {
				s.PodPhase = "Terminating"
			}
			continue
		}
		s.PodUID = string(pod.GetUID())
		s.PodPhase, _, _ = unstructured.NestedString(pod.Object, "status", "phase")
		if s.PodPhase == "" {
			s.PodPhase = "Pending"
		}
	}
	if sandbox == nil {
		return s
	}
	s.Exists = true
	s.Deleting = sandbox.GetDeletionTimestamp() != nil
	s.Mode, _, _ = unstructured.NestedString(sandbox.Object, "spec", "operatingMode")
	s.ShutdownTime, _, _ = unstructured.NestedString(sandbox.Object, "spec", "shutdownTime")
	s.OpID = sandbox.GetAnnotations()[OpAnnotation]
	ready, reason, message, current := condition(sandbox, "Ready")
	if current {
		s.Reason, s.Message = reason, message
		s.Ready = ready == "True" && s.Mode == "Running" && s.PodUID != ""
		s.Expired = reason == "SandboxExpired"
	}
	suspended, _, _, current := condition(sandbox, "Suspended")
	s.Suspended = current && suspended == "True" && s.Mode == "Suspended"
	return s
}

// Wait blocks until match(status) holds, the timeout passes or ctx ends.
func (c *Cache) Wait(ctx context.Context, name string, match func(Status) bool, timeout time.Duration) (Status, bool) {
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	for {
		changed := c.signal()
		status := c.Status(name)
		if match(status) {
			return status, true
		}
		select {
		case <-changed:
		case <-timer.C:
			return status, false
		case <-ctx.Done():
			return status, false
		}
	}
}
