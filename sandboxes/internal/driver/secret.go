package driver

import (
	"context"
	"encoding/base64"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/client-go/dynamic"
)

// The join Secret <name>-join (key token) is mounted, optional, at JoinDir in the workload.
// The Role allows Secrets get/create/update/patch/delete: no list or watch.

func (d *Driver) secrets() dynamic.ResourceInterface {
	return d.client.Resource(SecretGVR).Namespace(d.namespace)
}

func joinSecretName(name string) string { return name + "-join" }

func (d *Driver) putJoinSecret(ctx context.Context, name, token string) error {
	data := map[string]any{"token": base64.StdEncoding.EncodeToString([]byte(token))}
	current, err := d.secrets().Get(ctx, joinSecretName(name), metav1.GetOptions{})
	if err == nil {
		if value, _, _ := unstructured.NestedString(current.Object, "data", "token"); value == data["token"] {
			return nil
		}
		current.Object["data"] = data
		_, err = d.secrets().Update(ctx, current, metav1.UpdateOptions{FieldManager: FieldManager})
		return err
	}
	if !apierrors.IsNotFound(err) {
		return err
	}
	secret := &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "v1",
		"kind":       "Secret",
		"metadata": map[string]any{
			"name":      joinSecretName(name),
			"namespace": d.namespace,
			"labels":    map[string]any{ManagedLabel: FieldManager, SandboxLabel: name},
		},
		"type": "Opaque",
		"data": data,
	}}
	_, err = d.secrets().Create(ctx, secret, metav1.CreateOptions{FieldManager: FieldManager})
	return err
}

func (d *Driver) deleteJoinSecret(ctx context.Context, name string) error {
	err := d.secrets().Delete(ctx, joinSecretName(name), metav1.DeleteOptions{})
	if apierrors.IsNotFound(err) {
		return nil
	}
	return err
}
