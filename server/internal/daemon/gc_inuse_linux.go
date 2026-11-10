//go:build linux

package daemon

import (
	"os"
	"strconv"
)

// processUsingDir scans /proc for a process whose cwd or an open file
// descriptor resolves inside dir. Processes the daemon may not inspect
// (another user's) are skipped: agents run as the daemon's own user.
func processUsingDir(dir string) (int, bool) {
	root := resolvedDir(dir)
	entries, err := os.ReadDir("/proc")
	if err != nil {
		return 0, false
	}
	self := os.Getpid()
	for _, e := range entries {
		pid, err := strconv.Atoi(e.Name())
		if err != nil || pid == self {
			continue
		}
		base := "/proc/" + e.Name()
		if target, err := os.Readlink(base + "/cwd"); err == nil && pathWithin(target, root) {
			return pid, true
		}
		fds, err := os.ReadDir(base + "/fd")
		if err != nil {
			continue
		}
		for _, fd := range fds {
			if target, err := os.Readlink(base + "/fd/" + fd.Name()); err == nil && pathWithin(target, root) {
				return pid, true
			}
		}
	}
	return 0, false
}
