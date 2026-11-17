package computer

import (
	"errors"
	"syscall"
)

// libuv's names and messages for the errors a computer's files and commands meet, so the
// messages read as the engine's (`ENOENT: no such file or directory, open '/x'`).
var uvErrors = map[syscall.Errno][2]string{
	syscall.ENOENT:       {"ENOENT", "no such file or directory"},
	syscall.ENOTDIR:      {"ENOTDIR", "not a directory"},
	syscall.EISDIR:       {"EISDIR", "illegal operation on a directory"},
	syscall.EACCES:       {"EACCES", "permission denied"},
	syscall.EPERM:        {"EPERM", "operation not permitted"},
	syscall.EEXIST:       {"EEXIST", "file already exists"},
	syscall.ENOSPC:       {"ENOSPC", "no space left on device"},
	syscall.EROFS:        {"EROFS", "read-only file system"},
	syscall.EMFILE:       {"EMFILE", "too many open files"},
	syscall.ENFILE:       {"ENFILE", "file table overflow"},
	syscall.ELOOP:        {"ELOOP", "too many symbolic links encountered"},
	syscall.ENAMETOOLONG: {"ENAMETOOLONG", "name too long"},
	syscall.EIO:          {"EIO", "i/o error"},
	syscall.EBUSY:        {"EBUSY", "resource busy or locked"},
	syscall.ETXTBSY:      {"ETXTBSY", "text file is busy"},
	syscall.ENOEXEC:      {"ENOEXEC", "exec format error"},
	syscall.E2BIG:        {"E2BIG", "argument list too long"},
	syscall.EINVAL:       {"EINVAL", "invalid argument"},
	syscall.ENOMEM:       {"ENOMEM", "not enough memory"},
	syscall.EAGAIN:       {"EAGAIN", "resource temporarily unavailable"},
	syscall.EDQUOT:       {"EDQUOT", "disk quota exceeded"},
	syscall.EFBIG:        {"EFBIG", "file too large"},
}

// fsError is a Node fs error's message for err: `<CODE>: <description>, <syscall>[ '<path>']`.
func fsError(err error, call, path string) error {
	var errno syscall.Errno
	if !errors.As(err, &errno) {
		return err
	}
	code, description := errnoName(errno)
	message := code + ": " + description + ", " + call
	if path != "" {
		message += " '" + path + "'"
	}
	return &nodeError{message: message, errno: errno}
}

// spawnError is child_process.spawn's error: `spawn <file> <CODE>`.
func spawnError(err error, file string) error {
	var errno syscall.Errno
	if !errors.As(err, &errno) {
		return err
	}
	code, _ := errnoName(errno)
	return &nodeError{message: "spawn " + file + " " + code, errno: errno}
}

func errnoName(errno syscall.Errno) (string, string) {
	if named, ok := uvErrors[errno]; ok {
		return named[0], named[1]
	}
	return "Unknown system error " + jsNumberString(-float64(errno)), errno.Error()
}

type nodeError struct {
	message string
	errno   syscall.Errno
}

func (e *nodeError) Error() string { return e.message }
func (e *nodeError) Unwrap() error { return e.errno }

// missing is Node's ENOENT or ENOTDIR: no such file.
func missing(err error) bool {
	return errors.Is(err, syscall.ENOENT) || errors.Is(err, syscall.ENOTDIR)
}
