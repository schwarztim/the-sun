package fleet

import (
	"fmt"
	"os"
	"path/filepath"
	"sync"
)

// rotatingWriter is a size-bounded io.Writer for a single child's combined
// stdout/stderr. When the active file would exceed maxBytes it rotates
// (name -> name.1 -> name.2 ... keeping `keep` old files) so a chatty server
// can never fill the disk (the §7 "1GB incident" mitigation).
type rotatingWriter struct {
	mu       sync.Mutex
	path     string
	maxBytes int64
	keep     int
	f        *os.File
	size     int64
}

func newRotatingWriter(path string, maxBytes int64, keep int) (*rotatingWriter, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, err
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return nil, err
	}
	info, err := f.Stat()
	if err != nil {
		f.Close()
		return nil, err
	}
	return &rotatingWriter{path: path, maxBytes: maxBytes, keep: keep, f: f, size: info.Size()}, nil
}

func (w *rotatingWriter) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.size+int64(len(p)) > w.maxBytes {
		if err := w.rotate(); err != nil {
			// Rotation failure must not lose the write — keep appending,
			// but log so disk-full / permission issues are visible.
			fmt.Fprintf(os.Stderr, "logrotate: rotation failed for %s: %v\n", w.path, err)
		}
	}
	n, err := w.f.Write(p)
	w.size += int64(n)
	return n, err
}

// rotate closes the active file, shifts name.(keep-1)->name.keep ... name->name.1,
// then reopens a fresh active file. Oldest beyond `keep` is discarded.
func (w *rotatingWriter) rotate() error {
	if err := w.f.Close(); err != nil {
		return err
	}
	// Drop the oldest, then shift each backup up by one.
	oldest := w.backupName(w.keep)
	_ = os.Remove(oldest)
	for i := w.keep - 1; i >= 1; i-- {
		_ = os.Rename(w.backupName(i), w.backupName(i+1))
	}
	if w.keep >= 1 {
		_ = os.Rename(w.path, w.backupName(1))
	}
	f, err := os.OpenFile(w.path, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	w.f = f
	w.size = 0
	return nil
}

func (w *rotatingWriter) backupName(i int) string {
	return w.path + "." + itoa(i)
}

func (w *rotatingWriter) Close() error {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.f != nil {
		return w.f.Close()
	}
	return nil
}

// itoa avoids importing strconv for a single tiny use.
func itoa(i int) string {
	if i == 0 {
		return "0"
	}
	var b [20]byte
	pos := len(b)
	for i > 0 {
		pos--
		b[pos] = byte('0' + i%10)
		i /= 10
	}
	return string(b[pos:])
}
