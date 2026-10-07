package handler

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/multica-ai/multica/server/internal/logger"
	"github.com/multica-ai/multica/server/internal/push"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

const maxPushTokenLength = 200

type registerPushDeviceRequest struct {
	Platform    string `json:"platform"`
	Token       string `json:"token"`
	BundleID    string `json:"bundle_id"`
	Environment string `json:"environment"`
}

// RegisterPushDevice stores (or re-assigns) the caller's APNs device token.
func (h *Handler) RegisterPushDevice(w http.ResponseWriter, r *http.Request) {
	userID, ok := requireUserID(w, r)
	if !ok {
		return
	}
	var req registerPushDeviceRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	req.Token = strings.TrimSpace(req.Token)
	req.BundleID = strings.TrimSpace(req.BundleID)
	switch {
	case req.Platform != "ios":
		writeError(w, http.StatusBadRequest, "platform must be ios")
		return
	case req.Environment != "sandbox" && req.Environment != "production":
		writeError(w, http.StatusBadRequest, "environment must be sandbox or production")
		return
	case req.Token == "" || len(req.Token) > maxPushTokenLength:
		writeError(w, http.StatusBadRequest, "invalid token")
		return
	case req.BundleID == "":
		writeError(w, http.StatusBadRequest, "bundle_id is required")
		return
	}
	if !push.BundleAllowed(req.BundleID) {
		writeError(w, http.StatusForbidden, "bundle id not allowed")
		return
	}
	if _, err := h.Queries.UpsertPushDevice(r.Context(), db.UpsertPushDeviceParams{
		UserID:      parseUUID(userID),
		Platform:    req.Platform,
		Token:       req.Token,
		BundleID:    req.BundleID,
		Environment: req.Environment,
	}); err != nil {
		slog.Warn("UpsertPushDevice failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to register device")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// UnregisterPushDevice removes the caller's own token; another user's token
// is a silent no-op so the endpoint reveals nothing about it.
func (h *Handler) UnregisterPushDevice(w http.ResponseWriter, r *http.Request) {
	userID, ok := requireUserID(w, r)
	if !ok {
		return
	}
	token := strings.TrimSpace(chi.URLParam(r, "token"))
	if token == "" || len(token) > maxPushTokenLength {
		writeError(w, http.StatusBadRequest, "invalid token")
		return
	}
	if err := h.Queries.DeletePushDeviceForUser(r.Context(), db.DeletePushDeviceForUserParams{
		UserID: parseUUID(userID),
		Token:  token,
	}); err != nil {
		slog.Warn("DeletePushDeviceForUser failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to unregister device")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
