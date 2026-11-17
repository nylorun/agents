package computer

import (
	"io"
	"os"
	"path"
	"sort"
)

// TooLargeError is a file larger than the read allows (413 too_large).
type TooLargeError struct {
	Path     string
	Size     int64
	MaxBytes float64
}

func (e *TooLargeError) Error() string {
	return e.Path + " is " + jsNumberString(float64(e.Size)) + " bytes, more than " + jsNumberString(e.MaxBytes)
}

// readBytes is a file's bytes, nil when it doesn't exist, a *TooLargeError past maxBytes.
func readBytes(file string, maxBytes float64) ([]byte, error) {
	info, err := os.Stat(file)
	if err != nil {
		if missing(err) {
			return nil, nil
		}
		return nil, fsError(err, "stat", file)
	}
	if float64(info.Size()) > maxBytes {
		return nil, &TooLargeError{Path: file, Size: info.Size(), MaxBytes: maxBytes}
	}
	f, err := os.Open(file)
	if err != nil {
		return nil, fsError(err, "open", file)
	}
	defer f.Close()
	content, err := io.ReadAll(f)
	if err != nil {
		return nil, fsError(err, "read", "")
	}
	if content == nil {
		content = []byte{}
	}
	return content, nil
}

// writeFile writes body to file, created or truncated.
func writeFile(file string, body io.Reader) error {
	f, err := os.OpenFile(file, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o666)
	if err != nil {
		return fsError(err, "open", file)
	}
	if _, err := io.Copy(f, body); err != nil {
		_ = f.Close()
		return fsError(err, "write", "")
	}
	if err := f.Close(); err != nil {
		return fsError(err, "close", "")
	}
	return nil
}

// Entry is a listed file, by its path in the listed folder.
type Entry struct {
	Path string `json:"path"`
	Size int64  `json:"size"`
}

// Listing is a folder's files.
type Listing struct {
	Entries []Entry `json:"entries"`
	// Truncated says the walk stopped once it held more than maxEntries: it then holds
	// maxEntries+1 entries, as the engine's does.
	Truncated bool `json:"truncated"`
}

// listFiles walks dir's regular files, depth first in JavaScript's name order, skipping
// symbolic links; nil when dir isn't a directory.
func listFiles(dir string, maxEntries float64) (*Listing, error) {
	info, err := os.Lstat(dir)
	if err != nil {
		if missing(err) {
			return nil, nil
		}
		return nil, fsError(err, "lstat", dir)
	}
	if !info.IsDir() {
		return nil, nil
	}
	entries := []Entry{}
	var walk func(absolute, relative string) (bool, error)
	walk = func(absolute, relative string) (bool, error) {
		names, err := readNames(absolute)
		if err != nil {
			return false, err
		}
		for _, name := range names {
			full := path.Join(absolute, name)
			inFolder := name
			if relative != "" {
				inFolder = relative + "/" + name
			}
			info, err := os.Lstat(full)
			if err != nil {
				return false, fsError(err, "lstat", full)
			}
			switch {
			case info.Mode()&os.ModeSymlink != 0:
			case info.IsDir():
				complete, err := walk(full, inFolder)
				if err != nil || !complete {
					return false, err
				}
			case info.Mode().IsRegular():
				entries = append(entries, Entry{Path: inFolder, Size: info.Size()})
				if float64(len(entries)) > maxEntries {
					return false, nil
				}
			}
		}
		return true, nil
	}
	complete, err := walk(dir, "")
	if err != nil {
		return nil, err
	}
	return &Listing{Entries: entries, Truncated: !complete}, nil
}

func readNames(dir string) ([]string, error) {
	f, err := os.Open(dir)
	if err != nil {
		return nil, fsError(err, "scandir", dir)
	}
	defer f.Close()
	names, err := f.Readdirnames(-1)
	if err != nil {
		return nil, fsError(err, "scandir", dir)
	}
	sort.Slice(names, func(i, j int) bool { return lessUTF16(names[i], names[j]) })
	return names, nil
}
