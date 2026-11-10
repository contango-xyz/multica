//go:build !linux && !darwin

package daemon

// processUsingDir has no probe on this platform: the sweeper behaves as before.
func processUsingDir(string) (int, bool) { return 0, false }
