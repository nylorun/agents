package driver

import (
	"strings"
	"testing"
)

const (
	srcRepo    = "ghcr.io/nylorun/bot-computer"
	mirrorRepo = "asia-south1-docker.pkg.dev/beta-project/nylorun/bot-computer"
	digest     = "sha256:1111111111111111111111111111111111111111111111111111111111111111"
)

func testMirrors(t *testing.T) Mirrors {
	t.Helper()
	m, err := NewMirrors(map[string]string{srcRepo: mirrorRepo, "python": "mirror.example.com/library/python"})
	if err != nil {
		t.Fatal(err)
	}
	return m
}

func TestMirrorsTo(t *testing.T) {
	m := testMirrors(t)
	cases := map[string]string{
		srcRepo + "@" + digest:               mirrorRepo + "@" + digest,
		srcRepo + ":2026.11.21":              mirrorRepo + ":2026.11.21",
		srcRepo + ":2026.11.21@" + digest:    mirrorRepo + "@" + digest,
		"python:3.13-slim":                   "mirror.example.com/library/python:3.13-slim",
		"docker.io/library/python@" + digest: "mirror.example.com/library/python@" + digest,
		// Not mapped: as it is.
		"ghcr.io/nylorun/computer:1.0@" + digest:       "ghcr.io/nylorun/computer:1.0@" + digest,
		"ghcr.io/nylorun/bot-computer-other@" + digest: "ghcr.io/nylorun/bot-computer-other@" + digest,
		"not a reference": "not a reference",
	}
	for in, want := range cases {
		if got := m.To(in); got != want {
			t.Errorf("To(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestMirrorsFrom(t *testing.T) {
	m := testMirrors(t)
	cases := map[string]string{
		mirrorRepo + "@" + digest:                        srcRepo + "@" + digest,
		"docker-pullable://" + mirrorRepo + "@" + digest: "docker-pullable://" + srcRepo + "@" + digest,
		"ghcr.io/nylorun/computer@" + digest:             "ghcr.io/nylorun/computer@" + digest,
		"":                                               "",
	}
	for in, want := range cases {
		if got := m.From(in); got != want {
			t.Errorf("From(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestMirrorsEmptyMapsNothing(t *testing.T) {
	var m Mirrors
	ref := srcRepo + "@" + digest
	if m.To(ref) != ref || m.From(ref) != ref || m.Len() != 0 {
		t.Fatal("the zero Mirrors changed a reference")
	}
}

func TestNewMirrorsRefuses(t *testing.T) {
	for name, in := range map[string]map[string]string{
		"a tag":            {srcRepo + ":1": mirrorRepo},
		"a digest":         {srcRepo: mirrorRepo + "@" + digest},
		"the same":         {srcRepo: srcRepo},
		"empty mirror":     {srcRepo: ""},
		"one mirror twice": {srcRepo: mirrorRepo, "ghcr.io/nylorun/other": mirrorRepo},
	} {
		if _, err := NewMirrors(in); err == nil || !strings.Contains(err.Error(), "imageMirrors") {
			t.Errorf("%s: got %v, want an imageMirrors error", name, err)
		}
	}
}
