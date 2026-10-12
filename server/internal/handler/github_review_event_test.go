package handler

import "testing"

func TestPRAddressFromReviewEvent(t *testing.T) {
	const repo = `"installation":{"id":42},"repository":{"name":"relay","owner":{"login":"contango-xyz"}}`
	cases := []struct {
		name   string
		body   string
		number int32
		ok     bool
	}{
		{"review", `{` + repo + `,"action":"submitted","review":{"state":"approved"},"pull_request":{"number":74}}`, 74, true},
		{"review comment", `{` + repo + `,"comment":{"id":1},"pull_request":{"number":77}}`, 77, true},
		{"review thread", `{` + repo + `,"thread":{"node_id":"x"},"pull_request":{"number":9}}`, 9, true},
		{"PR conversation comment", `{` + repo + `,"issue":{"number":12,"pull_request":{"url":"u"}},"comment":{"id":2}}`, 12, true},
		{"plain issue comment", `{` + repo + `,"issue":{"number":13},"comment":{"id":3}}`, 0, false},
		{"issue comment, null pull_request", `{` + repo + `,"issue":{"number":14,"pull_request":null}}`, 0, false},
		{"no installation", `{"repository":{"name":"relay","owner":{"login":"o"}},"pull_request":{"number":1}}`, 0, false},
		{"bad json", `{`, 0, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			inst, owner, name, number, ok := prAddressFromReviewEvent([]byte(c.body))
			if ok != c.ok || number != c.number {
				t.Fatalf("got number=%d ok=%v, want %d %v", number, ok, c.number, c.ok)
			}
			if ok && (inst != 42 || owner != "contango-xyz" || name != "relay") {
				t.Fatalf("got %d %s/%s", inst, owner, name)
			}
		})
	}
}
