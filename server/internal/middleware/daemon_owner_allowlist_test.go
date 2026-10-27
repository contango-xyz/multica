package middleware

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestDaemonOwnerAllowlist(t *testing.T) {
	emails := map[string]string{
		"bot-id":   "Bot@Example.com",
		"other-id": "other@example.com",
	}
	lookups := 0
	lookup := func(_ context.Context, id string) (string, error) {
		lookups++
		if id == "broken-id" {
			return "", errors.New("db down")
		}
		return emails[id], nil
	}
	mw := DaemonOwnerAllowlist(ParseDaemonAllowedEmails(" bot@example.com ,"), lookup)
	handler := mw(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))

	cases := []struct {
		name string
		ctx  func(context.Context) context.Context
		user string
		want int
	}{
		{"pat owner allowed", nil, "bot-id", http.StatusOK},
		{"pat owner refused", nil, "other-id", http.StatusForbidden},
		{"unknown user refused", nil, "ghost-id", http.StatusForbidden},
		{"lookup failure is transient", nil, "broken-id", http.StatusServiceUnavailable},
		{"no identity refused", nil, "", http.StatusForbidden},
		{"daemon token owner allowed", func(c context.Context) context.Context {
			return WithDaemonTokenOwnerID(WithDaemonContext(c, "ws", "d"), "bot-id")
		}, "", http.StatusOK},
		{"unbound daemon token ignores X-User-ID", func(c context.Context) context.Context {
			return WithDaemonContext(c, "ws", "d")
		}, "bot-id", http.StatusForbidden},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest("POST", "/api/daemon/register", nil)
			if tc.user != "" {
				req.Header.Set("X-User-ID", tc.user)
			}
			if tc.ctx != nil {
				req = req.WithContext(tc.ctx(req.Context()))
			}
			w := httptest.NewRecorder()
			handler.ServeHTTP(w, req)
			if w.Code != tc.want {
				t.Fatalf("got %d, want %d: %s", w.Code, tc.want, w.Body.String())
			}
		})
	}

	before := lookups
	req := httptest.NewRequest("POST", "/api/daemon/heartbeat", nil)
	req.Header.Set("X-User-ID", "other-id")
	handler.ServeHTTP(httptest.NewRecorder(), req)
	if lookups != before {
		t.Fatalf("expected cached decision, got %d new lookups", lookups-before)
	}
}

func TestDaemonOwnerAllowlist_EmptyListAllowsAll(t *testing.T) {
	mw := DaemonOwnerAllowlist(ParseDaemonAllowedEmails(""), nil)
	handler := mw(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, httptest.NewRequest("POST", "/api/daemon/register", nil))
	if w.Code != http.StatusOK {
		t.Fatalf("got %d, want 200", w.Code)
	}
}
