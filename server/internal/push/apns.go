package push

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"sync"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

// ErrTokenInvalid means APNs rejected the device token for good; the caller
// should stop sending to it.
var ErrTokenInvalid = errors.New("push: device token invalid")

// Device is one registered phone.
type Device struct {
	Token       string
	BundleID    string
	Environment string // "sandbox" | "production"
}

// Notification is what a user sees, plus routing data for the app.
type Notification struct {
	Title    string
	Body     string
	ThreadID string
	Badge    *int
	Data     map[string]any
}

// Sender delivers one notification to one device.
type Sender interface {
	Send(ctx context.Context, d Device, n Notification) error
}

// APNsClient talks to Apple Push Notification service with token auth.
type APNsClient struct {
	keyID      string
	teamID     string
	key        *ecdsa.PrivateKey
	httpClient *http.Client
	endpoints  map[string]string

	mu      sync.Mutex
	token   string
	tokenAt time.Time
}

const providerTokenTTL = 50 * time.Minute // Apple rejects tokens older than 60 min

func NewAPNsClient(cfg Config) (*APNsClient, error) {
	key, err := jwt.ParseECPrivateKeyFromPEM(cfg.KeyPEM)
	if err != nil {
		return nil, fmt.Errorf("parse APNs key: %w", err)
	}
	return &APNsClient{
		keyID:  cfg.KeyID,
		teamID: cfg.TeamID,
		key:    key,
		// net/http negotiates HTTP/2 over TLS, which APNs requires.
		httpClient: &http.Client{Timeout: 10 * time.Second},
		endpoints: map[string]string{
			"production": "https://api.push.apple.com",
			"sandbox":    "https://api.sandbox.push.apple.com",
		},
	}, nil
}

func (c *APNsClient) providerToken() (string, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.token != "" && time.Since(c.tokenAt) < providerTokenTTL {
		return c.token, nil
	}
	now := time.Now()
	t := jwt.NewWithClaims(jwt.SigningMethodES256, jwt.MapClaims{"iss": c.teamID, "iat": now.Unix()})
	t.Header["kid"] = c.keyID
	signed, err := t.SignedString(c.key)
	if err != nil {
		return "", err
	}
	c.token, c.tokenAt = signed, now
	return signed, nil
}

// Send posts one notification. Routing data goes under "body", the key
// expo-notifications exposes to the app as content.data.
func (c *APNsClient) Send(ctx context.Context, d Device, n Notification) error {
	base, ok := c.endpoints[d.Environment]
	if !ok {
		return fmt.Errorf("push: unknown APNs environment %q", d.Environment)
	}
	aps := map[string]any{
		"alert": map[string]any{"title": n.Title, "body": n.Body},
		"sound": "default",
	}
	if n.Badge != nil {
		aps["badge"] = *n.Badge
	}
	if n.ThreadID != "" {
		aps["thread-id"] = n.ThreadID
	}
	payload := map[string]any{"aps": aps}
	if len(n.Data) > 0 {
		payload["body"] = n.Data
	}
	raw, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	tok, err := c.providerToken()
	if err != nil {
		return fmt.Errorf("push: sign provider token: %w", err)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, base+"/3/device/"+d.Token, bytes.NewReader(raw))
	if err != nil {
		return err
	}
	req.Header.Set("authorization", "bearer "+tok)
	req.Header.Set("apns-topic", d.BundleID)
	req.Header.Set("apns-push-type", "alert")
	req.Header.Set("apns-priority", "10")
	req.Header.Set("content-type", "application/json")

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("push: apns request: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusOK {
		return nil
	}
	var body struct {
		Reason string `json:"reason"`
	}
	b, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
	_ = json.Unmarshal(b, &body)
	switch {
	case resp.StatusCode == http.StatusGone,
		body.Reason == "BadDeviceToken",
		body.Reason == "Unregistered",
		body.Reason == "DeviceTokenNotForTopic":
		return fmt.Errorf("%w: %d %s", ErrTokenInvalid, resp.StatusCode, body.Reason)
	}
	return fmt.Errorf("push: apns status %d: %s", resp.StatusCode, body.Reason)
}
