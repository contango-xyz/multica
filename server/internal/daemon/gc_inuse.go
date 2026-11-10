package daemon

import (
	"path/filepath"
	"strings"
)

// dirInUse reports a live process, other than this daemon, whose working
// directory or an open file is inside dir. The GC asks it immediately before
// mutating a task directory and leaves a busy one for the next pass.
//
// Contango (CTG-2260, 2026-11-10): an agent resumed its work inside another
// task's completed directory; the completed-task TTL expired and the sweeper
// removed the directory under the running process, killing it. A directory a
// process is using is never garbage, whatever its metadata says.
//
// A package variable so tests can stand in for the platform probe.
var dirInUse = processUsingDir

// pathWithin reports whether path is root or lies below it. Callers pass
// cleaned absolute paths.
func pathWithin(path, root string) bool {
	path = strings.TrimSuffix(path, " (deleted)")
	return path == root || strings.HasPrefix(path, root+string(filepath.Separator))
}

// resolvedDir returns dir with symlinks resolved, because the kernel reports
// the resolved path for a process's cwd and open files.
func resolvedDir(dir string) string {
	abs, err := filepath.Abs(dir)
	if err != nil {
		abs = dir
	}
	if real, err := filepath.EvalSymlinks(abs); err == nil {
		return filepath.Clean(real)
	}
	return filepath.Clean(abs)
}
