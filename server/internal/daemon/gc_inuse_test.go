package daemon

import "testing"

func TestPathWithin(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		path, root string
		want       bool
	}{
		{"/w/ws/task", "/w/ws/task", true},
		{"/w/ws/task/workdir/x.log", "/w/ws/task", true},
		{"/w/ws/task/x.log (deleted)", "/w/ws/task", true},
		{"/w/ws/task-2", "/w/ws/task", false}, // a sibling sharing the prefix is not inside
		{"/w/ws", "/w/ws/task", false},
	} {
		if got := pathWithin(tc.path, tc.root); got != tc.want {
			t.Errorf("pathWithin(%q, %q) = %v, want %v", tc.path, tc.root, got, tc.want)
		}
	}
}
