//go:build darwin

package daemon

import (
	"bufio"
	"bytes"
	"context"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"time"
)

// processUsingDir asks lsof for every process's cwd and open files (one call,
// field output) and looks for a path inside dir. When lsof is missing, fails or
// times out the check answers "not in use", so the sweeper behaves as before
// rather than never cleaning.
func processUsingDir(dir string) (int, bool) {
	root := resolvedDir(dir)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "lsof", "-n", "-P", "-w", "-F", "pn").Output()
	if err != nil && len(out) == 0 {
		return 0, false
	}
	self := os.Getpid()
	pid := 0
	sc := bufio.NewScanner(bytes.NewReader(out))
	sc.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for sc.Scan() {
		line := sc.Text()
		switch {
		case strings.HasPrefix(line, "p"):
			pid, _ = strconv.Atoi(line[1:])
		case strings.HasPrefix(line, "n") && pid != 0 && pid != self:
			if pathWithin(line[1:], root) {
				return pid, true
			}
		}
	}
	return 0, false
}
