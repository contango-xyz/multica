//go:build linux

package daemon

import (
	"context"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

// startIn starts `sleep` with its working directory dir, or (open != "") with
// cwd "/" and file open held open on fd 3. The process is killed at cleanup.
func startIn(t *testing.T, dir, open string) *exec.Cmd {
	t.Helper()
	cmd := exec.Command("sleep", "60")
	cmd.Dir = dir
	if open != "" {
		cmd = exec.Command("sh", "-c", `exec 3<"$1"; exec sleep 60`, "sh", open)
		cmd.Dir = "/"
	}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = cmd.Process.Kill(); _, _ = cmd.Process.Wait() })
	return cmd
}

// waitUsing polls until the probe sees the child (sh needs a moment to open fd 3).
func waitUsing(t *testing.T, dir string, pid int) {
	t.Helper()
	for i := 0; i < 200; i++ {
		if got, busy := processUsingDir(dir); busy && got == pid {
			return
		}
		if _, err := os.Stat("/proc"); err != nil {
			t.Skip("no /proc")
		}
		exec.Command("sleep", "0.01").Run()
	}
	t.Fatalf("probe never saw pid %d using %s", pid, dir)
}

func TestProcessUsingDir_SeesCwdAndOpenFiles(t *testing.T) {
	t.Parallel()
	root := t.TempDir()
	cwdDir, fileDir, idle := filepath.Join(root, "cwd"), filepath.Join(root, "file"), filepath.Join(root, "idle")
	for _, d := range []string{cwdDir, fileDir, idle} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	held := filepath.Join(fileDir, "held.log")
	if err := os.WriteFile(held, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	a := startIn(t, cwdDir, "")
	b := startIn(t, "", held)
	waitUsing(t, cwdDir, a.Process.Pid)
	waitUsing(t, fileDir, b.Process.Pid)
	if pid, busy := processUsingDir(idle); busy {
		t.Fatalf("idle dir reported in use by pid %d", pid)
	}
}

// CTG-2260: the sweeper removed a completed task's directory while another
// run was working inside it. Every mutating action must leave a busy
// directory alone and take it on a later pass once it is free.
func TestApplyGCAction_LeavesDirInUseForNextPass(t *testing.T) {
	t.Parallel()
	d := newGCTestDaemon(t, http.NewServeMux())
	taskDir := createTaskDir(t, d.cfg.WorkspacesRoot, "ws1", "busy", nil)
	workdir := filepath.Join(taskDir, "workdir")
	writeFile(t, filepath.Join(workdir, "payload.bin"), 64)

	child := startIn(t, workdir, "")
	waitUsing(t, taskDir, child.Process.Pid)

	stats := &gcStats{byPattern: map[string]int{}}
	if removed := d.applyGCAction(context.Background(), taskDir, gcActionClean, stats); removed != 0 {
		t.Fatalf("removed a directory a live process is using")
	}
	if stats.skipped != 1 || stats.cleaned != 0 {
		t.Fatalf("stats = skipped %d cleaned %d, want 1 and 0", stats.skipped, stats.cleaned)
	}
	if _, err := os.Stat(filepath.Join(workdir, "payload.bin")); err != nil {
		t.Fatalf("busy task dir was mutated: %v", err)
	}

	_ = child.Process.Kill()
	_, _ = child.Process.Wait()
	if removed := d.applyGCAction(context.Background(), taskDir, gcActionClean, &gcStats{byPattern: map[string]int{}}); removed != 1 {
		t.Fatalf("next pass after the process exited removed %d, want 1", removed)
	}
	if _, err := os.Stat(taskDir); !os.IsNotExist(err) {
		t.Fatal("task dir should be removed once nothing uses it")
	}
}
