package main

import (
	"net/http"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/multica-ai/multica/server/internal/analytics"
	"github.com/multica-ai/multica/server/internal/events"
	"github.com/multica-ai/multica/server/internal/realtime"
)

func TestIssueAskRoutesAreRegistered(t *testing.T) {
	router, ok := NewRouter(nil, realtime.NewHub(), events.New(), analytics.NoopClient{}, nil).(chi.Routes)
	if !ok {
		t.Fatal("router does not expose chi.Routes")
	}
	const ask = "019a0000-0000-7000-8000-000000000001"
	for _, route := range []struct{ method, path string }{
		{http.MethodPost, "/api/issues/CTG-1/asks"},
		{http.MethodGet, "/api/issues/CTG-1/asks"},
		{http.MethodGet, "/api/issues/CTG-1/asks/oldest-open"},
		{http.MethodGet, "/api/asks/" + ask},
		{http.MethodPost, "/api/asks/" + ask + "/resolve"},
		{http.MethodPost, "/api/asks/" + ask + "/withdraw"},
	} {
		if !router.Match(chi.NewRouteContext(), route.method, route.path) {
			t.Errorf("%s %s is not routed", route.method, route.path)
		}
	}
}
