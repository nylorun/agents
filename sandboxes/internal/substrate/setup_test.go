package substrate

import (
	"context"
	"testing"

	ateapi "go.ate.dev/substrate/api/ateapi/v1"
)

func TestSetupMakesAtespaceAndEditor(t *testing.T) {
	api := newFakeAPI()
	principal := "user:system:serviceaccount:nylorun-sbx-shop:nylorun-sandboxes"
	if err := Setup(context.Background(), api, "nylorun-shop", principal); err != nil {
		t.Fatal(err)
	}
	if !api.atespaces["nylorun-shop"] {
		t.Fatal("no atespace")
	}
	if got := editors(api.access["nylorun-shop"]); len(got) != 1 || got[0] != principal {
		t.Fatalf("editors %v", got)
	}
	// Again: nothing changes.
	if err := Setup(context.Background(), api, "nylorun-shop", principal); err != nil {
		t.Fatal(err)
	}
	if got := editors(api.access["nylorun-shop"]); len(got) != 1 {
		t.Fatalf("editors after a second run %v", got)
	}
}

func TestSetupKeepsOtherBindings(t *testing.T) {
	api := newFakeAPI()
	api.atespaces["nylorun-shop"] = true
	api.access["nylorun-shop"] = &ateapi.AccessPolicy{
		Metadata: &ateapi.ResourceMetadata{Atespace: "nylorun-shop", Name: "default", Version: 3},
		Bindings: []*ateapi.Binding{{Role: "viewer", Members: []string{"user:alice"}}, {Role: "editor", Members: []string{"user:bob"}}},
	}
	if err := Setup(context.Background(), api, "nylorun-shop", "user:sbx"); err != nil {
		t.Fatal(err)
	}
	p := api.access["nylorun-shop"]
	if got := editors(p); len(got) != 2 || got[1] != "user:sbx" {
		t.Fatalf("editors %v", got)
	}
	if p.GetMetadata().GetVersion() != 3 || len(p.GetBindings()) != 2 {
		t.Fatalf("policy %v", p)
	}
}

func editors(p *ateapi.AccessPolicy) []string {
	for _, b := range p.GetBindings() {
		if b.GetRole() == "editor" {
			return b.GetMembers()
		}
	}
	return nil
}
