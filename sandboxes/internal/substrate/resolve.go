package substrate

import (
	"context"
	"strings"
	"sync"
	"time"

	"github.com/google/go-containerregistry/pkg/name"
	"github.com/google/go-containerregistry/pkg/v1/remote"
)

// RegistryResolver pins a reference to its digest with a HEAD request to its registry,
// anonymously, and remembers the answer for an hour. A reference that already names a digest
// is returned as it is.
type RegistryResolver struct {
	mu    sync.Mutex
	cache map[string]resolved
}

type resolved struct {
	ref string
	at  time.Time
}

// Resolve returns ref as name@sha256:….
func (r *RegistryResolver) Resolve(ctx context.Context, ref string) (string, error) {
	if strings.Contains(ref, "@sha256:") {
		return ref, nil
	}
	r.mu.Lock()
	if r.cache == nil {
		r.cache = map[string]resolved{}
	}
	if hit, ok := r.cache[ref]; ok && time.Since(hit.at) < time.Hour {
		r.mu.Unlock()
		return hit.ref, nil
	}
	r.mu.Unlock()
	parsed, err := name.ParseReference(ref)
	if err != nil {
		return "", err
	}
	desc, err := remote.Head(parsed, remote.WithContext(ctx))
	if err != nil {
		return "", err
	}
	// Docker Hub's repositories read docker.io/…, as a pod's imageID does, so core pins them.
	repo := strings.Replace(parsed.Context().Name(), "index.docker.io/", "docker.io/", 1)
	pinned := repo + "@" + desc.Digest.String()
	r.mu.Lock()
	r.cache[ref] = resolved{pinned, time.Now()}
	r.mu.Unlock()
	return pinned, nil
}
