package push

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/golang-jwt/jwt/v5"
)

func testKey(t *testing.T) (*ecdsa.PrivateKey, []byte) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	der, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		t.Fatal(err)
	}
	return key, pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der})
}

type captured struct {
	path, auth, topic, pushType string
	body                        map[string]any
}

func fakeAPNs(t *testing.T, status int, reason string) (*httptest.Server, *captured) {
	t.Helper()
	got := &captured{}
	ts := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got.path = r.URL.Path
		got.auth = r.Header.Get("authorization")
		got.topic = r.Header.Get("apns-topic")
		got.pushType = r.Header.Get("apns-push-type")
		b, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(b, &got.body)
		w.WriteHeader(status)
		if reason != "" {
			_, _ = w.Write([]byte(`{"reason":"` + reason + `"}`))
		}
	}))
	ts.EnableHTTP2 = true
	ts.StartTLS()
	t.Cleanup(ts.Close)
	return ts, got
}

func newTestClient(t *testing.T, ts *httptest.Server) (*APNsClient, *ecdsa.PrivateKey) {
	t.Helper()
	key, pemBytes := testKey(t)
	c, err := NewAPNsClient(Config{KeyPEM: pemBytes, KeyID: "KEY123", TeamID: "TEAM123"})
	if err != nil {
		t.Fatal(err)
	}
	c.httpClient = ts.Client()
	c.endpoints = map[string]string{"sandbox": ts.URL, "production": ts.URL}
	return c, key
}

func TestAPNsSendBuildsRequest(t *testing.T) {
	ts, got := fakeAPNs(t, http.StatusOK, "")
	c, key := newTestClient(t, ts)
	badge := 3
	err := c.Send(context.Background(),
		Device{Token: "abc123", BundleID: "com.example.app", Environment: "production"},
		Notification{Title: "T", Body: "B", ThreadID: "issue-1", Badge: &badge, Data: map[string]any{"kind": "inbox"}})
	if err != nil {
		t.Fatal(err)
	}
	if got.path != "/3/device/abc123" || got.topic != "com.example.app" || got.pushType != "alert" {
		t.Fatalf("request = %+v", got)
	}
	tok := strings.TrimPrefix(got.auth, "bearer ")
	parsed, err := jwt.Parse(tok, func(*jwt.Token) (any, error) { return &key.PublicKey, nil })
	if err != nil || !parsed.Valid || parsed.Header["kid"] != "KEY123" {
		t.Fatalf("jwt invalid: %v %v", err, parsed.Header)
	}
	if iss, _ := parsed.Claims.(jwt.MapClaims)["iss"].(string); iss != "TEAM123" {
		t.Fatalf("iss = %q", iss)
	}
	aps := got.body["aps"].(map[string]any)
	alert := aps["alert"].(map[string]any)
	if alert["title"] != "T" || alert["body"] != "B" || aps["badge"].(float64) != 3 || aps["thread-id"] != "issue-1" {
		t.Fatalf("aps = %+v", aps)
	}
	if got.body["body"].(map[string]any)["kind"] != "inbox" {
		t.Fatalf("data = %+v", got.body["body"])
	}
}

func TestAPNsInvalidTokenResponses(t *testing.T) {
	for _, tc := range []struct {
		status int
		reason string
	}{{http.StatusGone, "Unregistered"}, {http.StatusBadRequest, "BadDeviceToken"}, {http.StatusBadRequest, "DeviceTokenNotForTopic"}} {
		ts, _ := fakeAPNs(t, tc.status, tc.reason)
		c, _ := newTestClient(t, ts)
		err := c.Send(context.Background(), Device{Token: "x", BundleID: "b", Environment: "sandbox"}, Notification{Title: "t"})
		if !errors.Is(err, ErrTokenInvalid) {
			t.Fatalf("%d %s: err = %v, want ErrTokenInvalid", tc.status, tc.reason, err)
		}
	}
}

func TestAPNsServerErrorIsNotTokenInvalid(t *testing.T) {
	ts, _ := fakeAPNs(t, http.StatusInternalServerError, "InternalServerError")
	c, _ := newTestClient(t, ts)
	err := c.Send(context.Background(), Device{Token: "x", BundleID: "b", Environment: "sandbox"}, Notification{Title: "t"})
	if err == nil || errors.Is(err, ErrTokenInvalid) {
		t.Fatalf("err = %v", err)
	}
}

func TestAPNsUnknownEnvironment(t *testing.T) {
	ts, _ := fakeAPNs(t, http.StatusOK, "")
	c, _ := newTestClient(t, ts)
	c.endpoints = map[string]string{}
	if err := c.Send(context.Background(), Device{Token: "x", BundleID: "b", Environment: "sandbox"}, Notification{}); err == nil {
		t.Fatal("want error for unknown environment")
	}
}
