// Package drivertest fakes the cluster for the driver and API tests.
package drivertest

import (
	"encoding/json"
	"fmt"
	"reflect"
	"sync/atomic"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/dynamic/fake"
	k8stesting "k8s.io/client-go/testing"

	"github.com/nylorun/agents/sandboxes/internal/driver"
)

// NewFakeClient is a dynamic fake for the resources the driver uses, with server-side apply on
// Sandboxes emulated as create-or-replace (generation bumps when the spec changes). For tests.
func NewFakeClient(objects ...runtime.Object) *fake.FakeDynamicClient {
	client := fake.NewSimpleDynamicClientWithCustomListKinds(runtime.NewScheme(), map[schema.GroupVersionResource]string{
		driver.SandboxGVR: "SandboxList",
		driver.PodGVR:     "PodList",
		driver.PVCGVR:     "PersistentVolumeClaimList",
		driver.SecretGVR:  "SecretList",
	}, objects...)
	tracker := client.Tracker()
	var uids atomic.Int64
	client.PrependReactor("patch", "sandboxes", func(action k8stesting.Action) (bool, runtime.Object, error) {
		patch, ok := action.(k8stesting.PatchActionImpl)
		if !ok || patch.GetPatchType() != types.ApplyPatchType {
			return false, nil, nil
		}
		applied := &unstructured.Unstructured{}
		if err := json.Unmarshal(patch.GetPatch(), &applied.Object); err != nil {
			return true, nil, err
		}
		gvr, namespace, name := patch.GetResource(), patch.GetNamespace(), patch.GetName()
		applied.SetNamespace(namespace)
		existing, err := tracker.Get(gvr, namespace, name, metav1.GetOptions{})
		switch {
		case apierrors.IsNotFound(err):
			applied.SetUID(types.UID(fmt.Sprintf("uid-%d", uids.Add(1))))
			applied.SetGeneration(1)
			err = tracker.Create(gvr, applied, namespace)
		case err == nil:
			old := existing.(*unstructured.Unstructured)
			applied.SetUID(old.GetUID())
			applied.SetGeneration(old.GetGeneration())
			if !reflect.DeepEqual(old.Object["spec"], applied.Object["spec"]) {
				applied.SetGeneration(old.GetGeneration() + 1)
			}
			if status, ok := old.Object["status"]; ok {
				applied.Object["status"] = status
			}
			err = tracker.Update(gvr, applied, namespace)
		}
		if err != nil {
			return true, nil, err
		}
		stored, err := tracker.Get(gvr, namespace, name, metav1.GetOptions{})
		return true, stored, err
	})
	return client
}
