package computer

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"io"
	"math"
	"net/http"
	"os"
	"path"
	"regexp"
	"strings"
	"syscall"
	"time"
)

// The computer's disk (POST /v1/disk): one disk operation of core's disk versions (snapshot,
// restore, seed) on the computer's own workspace and /harness, as the engine's
// runtime/server/src/sandbox/disk-fs.ts runs it. A disk path is relative to the volume, named by
// its first segment, a root: workspace/… or harness/…. A listing holds regular files (size, mode,
// modification time), symbolic links (their target) and empty directories, in path order; the
// engine's own files under harness/ are never listed, read, written or cleared.

// engineFiles are the engine's own files under harness/, which a disk version never holds.
var engineFiles = map[string]bool{"volume-id": true, "egress-ca-bundle.pem": true, "setup.json": true, "sandboxes": true}

// notADiskOp is why a body is not a disk operation.
const notADiskOp = "The body must be one disk operation: list, read, clear or put"

var canonicalBase64 = regexp.MustCompile(`^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$`)

// diskRoot is one root of the disk: its name and where it is.
type diskRoot struct{ name, dir string }

// diskRoots are the disk's roots in the engine's order: the workspace, then /harness when set.
func (s *Server) diskRoots() []diskRoot {
	roots := []diskRoot{{"workspace", s.o.Workspace}}
	if s.o.HarnessRoot != "" {
		roots = append(roots, diskRoot{"harness", s.o.HarnessRoot})
	}
	return roots
}

// diskEntry is one entry of a listing.
type diskEntry struct {
	Path    string  `json:"path"`
	Type    string  `json:"type"`
	Size    int64   `json:"size"`
	Mode    uint32  `json:"mode"`
	MtimeMs int64   `json:"mtimeMs"`
	Target  *string `json:"target,omitempty"`
}

type diskListed struct {
	Kind      string      `json:"kind"`
	Entries   []diskEntry `json:"entries"`
	Truncated bool        `json:"truncated"`
}

type diskRead struct {
	Kind   string `json:"kind"`
	Base64 string `json:"base64"`
	EOF    bool   `json:"eof"`
}

type diskKind struct {
	Kind string `json:"kind"`
}

// diskPut is one entry to write: a file's bytes (or a range to append), a directory or a link.
type diskPut struct {
	path, kind string
	mode       *uint32
	mtimeMs    *float64
	bytes      []byte
	append     bool
	target     string
}

// diskReadOp is a read of length bytes of file path from offset.
type diskReadOp struct {
	path           string
	offset, length int64
}

// diskOp is one decoded operation; exactly one field is set.
type diskOp struct {
	list  *int64
	read  *diskReadOp
	clear bool
	put   []diskPut
}

// serveDisk answers POST /v1/disk.
func (s *Server) serveDisk(w http.ResponseWriter, r *http.Request) error {
	body, err := readJSON(r.Body)
	if err != nil {
		return err
	}
	op, ok := diskOpOf(body)
	if !ok {
		return &failure{http.StatusBadRequest, "invalid_request", notADiskOp}
	}
	roots := s.diskRoots()
	var answer any
	switch {
	case op.list != nil:
		entries, truncated, err := listDisk(roots, *op.list)
		if err != nil {
			return err
		}
		answer = diskListed{Kind: "listed", Entries: entries, Truncated: truncated}
	case op.read != nil:
		content, eof, found, err := readDisk(roots, op.read.path, op.read.offset, op.read.length)
		if err != nil {
			return err
		}
		if !found {
			answer = diskKind{"missing"}
		} else {
			answer = diskRead{Kind: "read", Base64: base64.StdEncoding.EncodeToString(content), EOF: eof}
		}
	case op.clear:
		if err := clearDisk(roots); err != nil {
			return err
		}
		answer = diskKind{"done"}
	default:
		if err := putDisk(roots, op.put); err != nil {
			return err
		}
		answer = diskKind{"done"}
	}
	send(w, http.StatusOK, answer)
	return nil
}

// isCount is a whole, not negative, safe JavaScript number.
func isCount(v any) bool {
	x, ok := v.(float64)
	return ok && x >= 0 && x == math.Trunc(x) && x <= 9007199254740991
}

// diskOpOf is a decoded body as a disk operation, as the engine's wireDiskOpOf takes it: an
// object of one key, list, read, clear or put.
func diskOpOf(body any) (diskOp, bool) {
	fields, ok := body.(map[string]any)
	if !ok || len(fields) != 1 {
		return diskOp{}, false
	}
	var op diskOp
	for key, value := range fields {
		switch key {
		case "list":
			list, ok := value.(map[string]any)
			if !ok || !isCount(list["maxEntries"]) {
				return diskOp{}, false
			}
			max := int64(list["maxEntries"].(float64))
			op.list = &max
		case "read":
			read, ok := value.(map[string]any)
			if !ok {
				return diskOp{}, false
			}
			file, okPath := read["path"].(string)
			if !okPath || !isCount(read["offset"]) || !isCount(read["length"]) {
				return diskOp{}, false
			}
			op.read = &diskReadOp{file, int64(read["offset"].(float64)), int64(read["length"].(float64))}
		case "clear":
			if value != true {
				return diskOp{}, false
			}
			op.clear = true
		case "put":
			entries, ok := value.([]any)
			if !ok {
				return diskOp{}, false
			}
			op.put = make([]diskPut, 0, len(entries))
			for _, raw := range entries {
				put, ok := diskPutOf(raw)
				if !ok {
					return diskOp{}, false
				}
				op.put = append(op.put, put)
			}
		default:
			return diskOp{}, false
		}
	}
	return op, true
}

func diskPutOf(raw any) (diskPut, bool) {
	entry, ok := raw.(map[string]any)
	if !ok {
		return diskPut{}, false
	}
	var put diskPut
	if put.path, ok = entry["path"].(string); !ok {
		return diskPut{}, false
	}
	put.kind, _ = entry["type"].(string)
	if put.kind != "file" && put.kind != "dir" && put.kind != "link" {
		return diskPut{}, false
	}
	if v, present := entry["mode"]; present {
		if !isCount(v) || v.(float64) > 0o7777 {
			return diskPut{}, false
		}
		mode := uint32(v.(float64))
		put.mode = &mode
	}
	if v, present := entry["mtimeMs"]; present {
		ms, ok := v.(float64)
		if !ok {
			return diskPut{}, false
		}
		put.mtimeMs = &ms
	}
	if v, present := entry["base64"]; present {
		text, ok := v.(string)
		if !ok || !canonicalBase64.MatchString(text) {
			return diskPut{}, false
		}
		content, err := base64.StdEncoding.DecodeString(text)
		if err != nil {
			return diskPut{}, false
		}
		put.bytes = content
	}
	if v, present := entry["append"]; present {
		if put.append, ok = v.(bool); !ok {
			return diskPut{}, false
		}
	}
	if v, present := entry["target"]; present {
		if put.target, ok = v.(string); !ok {
			return diskPut{}, false
		}
	}
	return put, true
}

// diskPath is the absolute path of p (relative to the volume), a 400 when it leaves its root or
// names the engine's own files.
func diskPath(roots []diskRoot, p string) (string, error) {
	segments := strings.Split(p, "/")
	root, rest := segments[0], segments[1:]
	base := ""
	for _, r := range roots {
		if r.name == root {
			base = r.dir
		}
	}
	if base == "" {
		return "", &failure{http.StatusBadRequest, "invalid_request", p + " is not under a root of this disk"}
	}
	for _, segment := range rest {
		if segment == "" || segment == "." || segment == ".." {
			return "", &failure{http.StatusBadRequest, "invalid_request", p + " is not a plain relative path"}
		}
	}
	if root == "harness" && len(rest) > 0 && engineFiles[rest[0]] {
		return "", &failure{http.StatusBadRequest, "invalid_request", p + " is the engine's own"}
	}
	if len(rest) == 0 {
		return base, nil
	}
	return path.Join(append([]string{base}, rest...)...), nil
}

// statOf is what a listing keeps of a file's lstat: its mode bits and modification time in
// whole milliseconds, rounded as Math.round rounds Node's mtimeMs.
func statOf(info os.FileInfo) (uint32, int64) {
	st, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return uint32(info.Mode().Perm()), info.ModTime().UnixMilli()
	}
	ms := float64(st.Mtim.Sec)*1000 + float64(st.Mtim.Nsec)/1e6
	rounded := math.Floor(ms)
	if ms-rounded >= 0.5 {
		rounded++
	}
	return st.Mode & 0o7777, int64(rounded)
}

// listDisk is the disk's entries in path order, at most maxEntries+1, and whether there were
// more than maxEntries. Each root is walked depth first in JavaScript's name order, so a
// truncated listing holds the same entries as the engine's.
func listDisk(roots []diskRoot, maxEntries int64) ([]diskEntry, bool, error) {
	entries := []diskEntry{}
	full := func() bool { return int64(len(entries)) > maxEntries }
	var walk func(absolute, relative string, top bool) error
	walk = func(absolute, relative string, top bool) error {
		names, err := readNames(absolute)
		if err != nil {
			if missing(err) {
				return nil
			}
			return err
		}
		if len(names) == 0 && !top {
			info, err := os.Lstat(absolute)
			if err != nil {
				return fsError(err, "lstat", absolute)
			}
			mode, mtime := statOf(info)
			entries = append(entries, diskEntry{Path: relative, Type: "dir", Mode: mode, MtimeMs: mtime})
			return nil
		}
		for _, name := range names {
			if full() {
				return nil
			}
			if relative == "harness" && engineFiles[name] {
				continue
			}
			entryPath := relative + "/" + name
			child := path.Join(absolute, name)
			info, err := os.Lstat(child)
			if err != nil {
				if missing(err) {
					continue
				}
				return fsError(err, "lstat", child)
			}
			mode, mtime := statOf(info)
			switch {
			case info.Mode()&os.ModeSymlink != 0:
				target, err := os.Readlink(child)
				if err != nil {
					return fsError(err, "readlink", child)
				}
				entries = append(entries, diskEntry{Path: entryPath, Type: "link", Mode: mode, MtimeMs: mtime, Target: &target})
			case info.IsDir():
				if err := walk(child, entryPath, false); err != nil {
					return err
				}
			case info.Mode().IsRegular():
				entries = append(entries, diskEntry{Path: entryPath, Type: "file", Size: info.Size(), Mode: mode, MtimeMs: mtime})
			}
		}
		return nil
	}
	for _, root := range roots {
		if root.dir == "" || full() {
			continue
		}
		if err := walk(root.dir, root.name, true); err != nil {
			return nil, false, err
		}
	}
	sortByPath(entries)
	truncated := full()
	if int64(len(entries)) > maxEntries+1 {
		entries = entries[:maxEntries+1]
	}
	return entries, truncated, nil
}

// sortByPath sorts entries by path in JavaScript's string order, stably.
func sortByPath(entries []diskEntry) {
	for i := 1; i < len(entries); i++ {
		for j := i; j > 0 && lessUTF16(entries[j].Path, entries[j-1].Path); j-- {
			entries[j], entries[j-1] = entries[j-1], entries[j]
		}
	}
}

// readDisk is length bytes of file p from offset and whether that reached its end; found is
// false when the file doesn't exist.
func readDisk(roots []diskRoot, p string, offset, length int64) (content []byte, eof, found bool, err error) {
	file, err := diskPath(roots, p)
	if err != nil {
		return nil, false, false, err
	}
	f, err := os.Open(file)
	if err != nil {
		if missing(err) {
			return nil, false, false, nil
		}
		return nil, false, false, fsError(err, "open", file)
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return nil, false, false, fsError(err, "fstat", "")
	}
	size := info.Size()
	want := max(0, min(length, size-offset))
	buffer := make([]byte, want)
	var read int64
	for read < want {
		n, err := f.ReadAt(buffer[read:], offset+read)
		read += int64(n)
		if err != nil {
			if errors.Is(err, io.EOF) {
				break
			}
			return nil, false, false, fsError(err, "read", "")
		}
		if n == 0 {
			break
		}
	}
	return buffer[:read], offset+read >= size, true, nil
}

// clearDisk empties every root, keeping the engine's own files.
func clearDisk(roots []diskRoot) error {
	for _, root := range roots {
		if root.dir == "" {
			continue
		}
		if err := os.MkdirAll(root.dir, 0o777); err != nil {
			return fsError(err, "mkdir", root.dir)
		}
		names, err := readNames(root.dir)
		if err != nil {
			return err
		}
		for _, name := range names {
			if root.name == "harness" && engineFiles[name] {
				continue
			}
			if err := os.RemoveAll(path.Join(root.dir, name)); err != nil {
				return fsError(err, "rm", path.Join(root.dir, name))
			}
		}
	}
	return nil
}

// putDisk writes puts in order: a directory, a file (written to a temporary name and renamed
// into place, or its next range appended) or a link, which replaces what is at its path.
func putDisk(roots []diskRoot, puts []diskPut) error {
	for _, put := range puts {
		target, err := diskPath(roots, put.path)
		if err != nil {
			return err
		}
		if put.kind == "dir" {
			if err := os.MkdirAll(target, 0o777); err != nil {
				return fsError(err, "mkdir", target)
			}
			if put.mode != nil {
				if err := syscall.Chmod(target, *put.mode); err != nil {
					return fsError(err, "chmod", target)
				}
			}
			continue
		}
		if err := os.MkdirAll(path.Dir(target), 0o777); err != nil {
			return fsError(err, "mkdir", path.Dir(target))
		}
		if put.kind == "link" {
			if err := os.RemoveAll(target); err != nil {
				return fsError(err, "rm", target)
			}
			if err := os.Symlink(put.target, target); err != nil {
				return fsError(err, "symlink", put.target)
			}
			continue
		}
		if put.append {
			if err := appendTo(target, put.bytes); err != nil {
				return err
			}
		} else {
			next := target + "." + partName() + ".part"
			if err := os.WriteFile(next, put.bytes, 0o666); err != nil {
				return fsError(err, "open", next)
			}
			if err := os.RemoveAll(target); err != nil {
				return fsError(err, "rm", target)
			}
			if err := os.Rename(next, target); err != nil {
				return fsError(err, "rename", next)
			}
		}
		if put.mode != nil {
			if err := syscall.Chmod(target, *put.mode); err != nil {
				return fsError(err, "chmod", target)
			}
		}
		if put.mtimeMs != nil {
			// As new Date(mtimeMs): whole milliseconds, toward zero.
			at := time.UnixMilli(int64(math.Trunc(*put.mtimeMs)))
			if err := os.Chtimes(target, at, at); err != nil {
				return fsError(err, "utime", target)
			}
		}
	}
	return nil
}

func appendTo(file string, content []byte) error {
	f, err := os.OpenFile(file, os.O_WRONLY|os.O_APPEND|os.O_CREATE, 0o666)
	if err != nil {
		return fsError(err, "open", file)
	}
	if _, err := f.Write(content); err != nil {
		_ = f.Close()
		return fsError(err, "write", "")
	}
	if err := f.Close(); err != nil {
		return fsError(err, "close", "")
	}
	return nil
}

// partName is a random name for a file being written.
func partName() string {
	raw := make([]byte, 16)
	_, _ = rand.Read(raw)
	return hex.EncodeToString(raw)
}
