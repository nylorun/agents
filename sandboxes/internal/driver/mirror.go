package driver

import (
	"fmt"
	"sort"
	"strings"

	"github.com/google/go-containerregistry/pkg/name"
)

// Mirrors maps an image repository to the repository that serves the same images
// (cluster.json `imageMirrors`): a deployment's nodes pull an Agent's workload image
// from its own registry, with the digest or tag the Agent named. Keys and values are
// repositories with no tag or digest. The zero value maps nothing.
type Mirrors struct {
	to   map[string]string // source repository (normalized) → mirror repository, as written
	from map[string]string // mirror repository (normalized) → source repository, as written
}

// NewMirrors validates a mapping from cluster.json.
func NewMirrors(m map[string]string) (Mirrors, error) {
	out := Mirrors{to: map[string]string{}, from: map[string]string{}}
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, source := range keys {
		mirror := m[source]
		src, err := repository(source)
		if err != nil {
			return Mirrors{}, fmt.Errorf("imageMirrors: %q is not an image repository: %w", source, err)
		}
		dst, err := repository(mirror)
		if err != nil {
			return Mirrors{}, fmt.Errorf("imageMirrors[%q]: %q is not an image repository: %w", source, mirror, err)
		}
		if src == dst {
			return Mirrors{}, fmt.Errorf("imageMirrors[%q] names the same repository", source)
		}
		if _, dup := out.from[dst]; dup {
			return Mirrors{}, fmt.Errorf("imageMirrors: %q mirrors more than one repository", mirror)
		}
		out.to[src] = strings.TrimSpace(mirror)
		out.from[dst] = strings.TrimSpace(source)
	}
	return out, nil
}

// Len is how many repositories are mapped.
func (m Mirrors) Len() int { return len(m.to) }

// To is ref with a mapped repository replaced by its mirror, keeping its digest or tag. Any
// other reference is returned as it is.
func (m Mirrors) To(ref string) string {
	if len(m.to) == 0 {
		return ref
	}
	parsed, err := name.ParseReference(ref)
	if err != nil {
		return ref
	}
	mirror, ok := m.to[parsed.Context().Name()]
	if !ok {
		return ref
	}
	return join(mirror, parsed)
}

// From is an image the node reports (a pod's imageID, possibly prefixed docker-pullable://)
// with a mirror's repository replaced by the repository it mirrors, so the Runtime reads the name
// the Agent asked for. Any other image is returned as it is.
func (m Mirrors) From(image string) string {
	if len(m.from) == 0 || image == "" {
		return image
	}
	bare := image
	prefix := ""
	if i := strings.Index(image, "://"); i >= 0 {
		prefix, bare = image[:i+3], image[i+3:]
	}
	parsed, err := name.ParseReference(bare)
	if err != nil {
		return image
	}
	source, ok := m.from[parsed.Context().Name()]
	if !ok {
		return image
	}
	return prefix + join(source, parsed)
}

func join(repo string, ref name.Reference) string {
	if d, ok := ref.(name.Digest); ok {
		return repo + "@" + d.DigestStr()
	}
	return repo + ":" + ref.Identifier()
}

// repository normalizes a repository name (index.docker.io/library/python for python), and
// refuses one with a tag or digest.
func repository(s string) (string, error) {
	s = strings.TrimSpace(s)
	if s == "" {
		return "", fmt.Errorf("empty")
	}
	if strings.Contains(s, "@") {
		return "", fmt.Errorf("has a digest")
	}
	if i := strings.LastIndex(s, ":"); i > strings.LastIndex(s, "/") {
		return "", fmt.Errorf("has a tag")
	}
	r, err := name.NewRepository(s)
	if err != nil {
		return "", err
	}
	return r.Name(), nil
}
