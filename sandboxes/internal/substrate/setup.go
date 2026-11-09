package substrate

import (
	"context"
	"encoding/json"
	"fmt"

	ateapi "go.ate.dev/substrate/api/ateapi/v1"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/encoding/protojson"
)

// SetupAPI is what `sandboxes substrate-setup` calls, as one of Substrate's owners.
type SetupAPI interface {
	CreateAtespace(ctx context.Context, in *ateapi.CreateAtespaceRequest, opts ...grpc.CallOption) (*ateapi.Atespace, error)
	GetAtespaceAccessPolicy(ctx context.Context, in *ateapi.GetAtespaceAccessPolicyRequest, opts ...grpc.CallOption) (*ateapi.AccessPolicy, error)
	CreateAtespaceAccessPolicy(ctx context.Context, in *ateapi.CreateAtespaceAccessPolicyRequest, opts ...grpc.CallOption) (*ateapi.AccessPolicy, error)
	UpdateAtespaceAccessPolicy(ctx context.Context, in *ateapi.UpdateAtespaceAccessPolicyRequest, opts ...grpc.CallOption) (*ateapi.AccessPolicy, error)
}

// Setup makes the Tenant's atespace and makes `principal` (user:system:serviceaccount:<ns>:<sa>)
// its editor, keeping any other bindings the policy already has. It is safe to run again.
func Setup(ctx context.Context, api SetupAPI, atespace, principal string) error {
	_, err := api.CreateAtespace(ctx, &ateapi.CreateAtespaceRequest{Atespace: &ateapi.Atespace{
		Metadata: &ateapi.ResourceMetadata{Name: atespace}}})
	if err != nil && status.Code(err) != codes.AlreadyExists {
		return fmt.Errorf("create atespace %s: %w", atespace, err)
	}
	current, err := api.GetAtespaceAccessPolicy(ctx, &ateapi.GetAtespaceAccessPolicyRequest{Atespace: &ateapi.ObjectRef{Name: atespace}, Name: "default"})
	if status.Code(err) == codes.NotFound {
		policy, perr := accessPolicy(atespace, nil, principal)
		if perr != nil {
			return perr
		}
		_, err = api.CreateAtespaceAccessPolicy(ctx, &ateapi.CreateAtespaceAccessPolicyRequest{
			Atespace: &ateapi.ObjectRef{Name: atespace}, AccessPolicy: policy})
		if err != nil {
			return fmt.Errorf("create the access policy of %s: %w", atespace, err)
		}
		return nil
	}
	if err != nil {
		return fmt.Errorf("read the access policy of %s: %w", atespace, err)
	}
	policy, err := accessPolicy(atespace, current, principal)
	if err != nil || policy == nil {
		return err
	}
	_, err = api.UpdateAtespaceAccessPolicy(ctx, &ateapi.UpdateAtespaceAccessPolicyRequest{
		Atespace: &ateapi.ObjectRef{Name: atespace}, AccessPolicy: policy})
	if err != nil {
		return fmt.Errorf("update the access policy of %s: %w", atespace, err)
	}
	return nil
}

// accessPolicy is `current` with principal as an editor; nil when it already is one.
func accessPolicy(atespace string, current *ateapi.AccessPolicy, principal string) (*ateapi.AccessPolicy, error) {
	doc := map[string]any{"bindings": []any{}}
	if current != nil {
		raw, err := protojson.Marshal(current)
		if err != nil {
			return nil, err
		}
		if err := json.Unmarshal(raw, &doc); err != nil {
			return nil, err
		}
	}
	bindings, _ := doc["bindings"].([]any)
	added := false
	for _, b := range bindings {
		binding, ok := b.(map[string]any)
		if !ok || binding["role"] != "editor" {
			continue
		}
		members, _ := binding["members"].([]any)
		for _, m := range members {
			if m == principal {
				return nil, nil
			}
		}
		binding["members"] = append(members, principal)
		added = true
		break
	}
	if !added {
		bindings = append(bindings, map[string]any{"role": "editor", "members": []any{principal}})
	}
	doc["bindings"] = bindings
	meta, _ := doc["metadata"].(map[string]any)
	if meta == nil {
		meta = map[string]any{}
	}
	meta["name"] = "default"
	meta["atespace"] = atespace
	doc["metadata"] = meta
	raw, err := json.Marshal(doc)
	if err != nil {
		return nil, err
	}
	var out ateapi.AccessPolicy
	if err := protojson.Unmarshal(raw, &out); err != nil {
		return nil, fmt.Errorf("render the access policy: %w", err)
	}
	return &out, nil
}
