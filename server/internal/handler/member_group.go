package handler

// Role mention groups (contango patch 48): @devops, @fe, ... A group is a named,
// ordered list of people. Mentioning it notifies the people on duty (time off
// skipped, then backups, then the group's fallback); see internal/membergroup.
// Reading is open to members and agents (the ops scripts and agents look groups
// up); changing a group is for workspace admins (the bot is one).

import (
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/logger"
	"github.com/multica-ai/multica/server/internal/membergroup"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

const memberGroupMaxMembers = 20

func (h *Handler) loadMemberGroups(w http.ResponseWriter, r *http.Request) ([]membergroup.Group, bool) {
	groups, err := membergroup.Load(r.Context(), h.Queries, parseUUID(ctxWorkspaceID(r.Context())), time.Now())
	if err != nil {
		slog.Warn("member groups: load failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to load groups")
		return nil, false
	}
	return groups, true
}

func (h *Handler) findMemberGroup(w http.ResponseWriter, r *http.Request) (membergroup.Group, bool) {
	groups, ok := h.loadMemberGroups(w, r)
	if !ok {
		return membergroup.Group{}, false
	}
	g, found := membergroup.Find(groups, chi.URLParam(r, "ref"))
	if !found {
		writeError(w, http.StatusNotFound, "group not found")
		return membergroup.Group{}, false
	}
	return g, true
}

// ListMemberGroups: every live group with members, away flags and who is on duty.
func (h *Handler) ListMemberGroups(w http.ResponseWriter, r *http.Request) {
	if _, ok := h.workspaceMember(w, r, ctxWorkspaceID(r.Context())); !ok {
		return
	}
	groups, ok := h.loadMemberGroups(w, r)
	if !ok {
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"groups": groups})
}

// GetMemberGroup: one group by id or handle.
func (h *Handler) GetMemberGroup(w http.ResponseWriter, r *http.Request) {
	if _, ok := h.workspaceMember(w, r, ctxWorkspaceID(r.Context())); !ok {
		return
	}
	if g, ok := h.findMemberGroup(w, r); ok {
		writeJSON(w, http.StatusOK, g)
	}
}

// GetMemberGroupOnDuty: who a mention of the group reaches now, and the first of them.
func (h *Handler) GetMemberGroupOnDuty(w http.ResponseWriter, r *http.Request) {
	if _, ok := h.workspaceMember(w, r, ctxWorkspaceID(r.Context())); !ok {
		return
	}
	if g, ok := h.findMemberGroup(w, r); ok {
		writeJSON(w, http.StatusOK, map[string]any{"id": g.ID, "handle": g.Handle, "on_duty": g.OnDuty,
			"via": g.OnDutyVia, "first": g.First()})
	}
}

type memberGroupRequest struct {
	Handle         *string `json:"handle"`
	Name           *string `json:"name"`
	Description    *string `json:"description"`
	FallbackUserID *string `json:"fallback_user_id"`
}

func (h *Handler) requireGroupAdmin(w http.ResponseWriter, r *http.Request) bool {
	m, ok := h.workspaceMember(w, r, ctxWorkspaceID(r.Context()))
	if !ok {
		return false
	}
	if !isWorkspaceAdmin(m) {
		writeError(w, http.StatusForbidden, "workspace admins only")
		return false
	}
	return true
}

// validGroupHandle refuses a handle that a mention or ask already means: reserved
// words, a person's handle (email up to the @) or an agent's name.
func (h *Handler) validGroupHandle(w http.ResponseWriter, r *http.Request, handle string) bool {
	if !membergroup.HandleRe.MatchString(handle) {
		writeError(w, http.StatusBadRequest, "handle must be 2-24 characters: a-z first, then a-z, 0-9 or -")
		return false
	}
	if membergroup.ReservedHandles[handle] {
		writeError(w, http.StatusBadRequest, "handle "+handle+" is reserved")
		return false
	}
	ws := parseUUID(ctxWorkspaceID(r.Context()))
	members, err := h.Queries.ListMembersWithUser(r.Context(), ws)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to check the handle")
		return false
	}
	for _, m := range members {
		if membergroup.HandleOf(m.UserEmail) == handle {
			writeError(w, http.StatusConflict, "handle "+handle+" is a person's handle")
			return false
		}
	}
	agents, err := h.Queries.ListAgents(r.Context(), ws)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to check the handle")
		return false
	}
	for _, a := range agents {
		name := strings.ToLower(strings.TrimSpace(a.Name))
		if name == handle || strings.ReplaceAll(name, " ", "-") == handle {
			writeError(w, http.StatusConflict, "handle "+handle+" is an agent's name")
			return false
		}
	}
	return true
}

// workspaceUserOrBadRequest parses a user id and checks they are in the workspace.
func (h *Handler) workspaceUserOrBadRequest(w http.ResponseWriter, r *http.Request, id, field string) (pgtype.UUID, bool) {
	uid, ok := parseUUIDOrBadRequest(w, id, field)
	if !ok {
		return pgtype.UUID{}, false
	}
	if _, err := h.Queries.GetMemberByUserAndWorkspace(r.Context(), db.GetMemberByUserAndWorkspaceParams{
		UserID: uid, WorkspaceID: parseUUID(ctxWorkspaceID(r.Context()))}); err != nil {
		writeError(w, http.StatusBadRequest, field+" "+id+" is not a member of this workspace")
		return pgtype.UUID{}, false
	}
	return uid, true
}

// CreateMemberGroup (admins): handle, name, optional description and fallback person.
func (h *Handler) CreateMemberGroup(w http.ResponseWriter, r *http.Request) {
	if !h.requireGroupAdmin(w, r) {
		return
	}
	var req memberGroupRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 16<<10)).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if req.Handle == nil || req.Name == nil || strings.TrimSpace(*req.Name) == "" {
		writeError(w, http.StatusBadRequest, "handle and name are required")
		return
	}
	handle := strings.ToLower(strings.TrimLeft(strings.TrimSpace(*req.Handle), "@"))
	if !h.validGroupHandle(w, r, handle) {
		return
	}
	params := db.CreateMemberGroupParams{WorkspaceID: parseUUID(ctxWorkspaceID(r.Context())), Handle: handle,
		Name: strings.TrimSpace(*req.Name)}
	if req.Description != nil {
		params.Description = strings.TrimSpace(*req.Description)
	}
	if req.FallbackUserID != nil && *req.FallbackUserID != "" {
		uid, ok := h.workspaceUserOrBadRequest(w, r, *req.FallbackUserID, "fallback_user_id")
		if !ok {
			return
		}
		params.FallbackUserID = uid
	}
	g, err := h.Queries.CreateMemberGroup(r.Context(), params)
	if isUniqueViolation(err) {
		writeError(w, http.StatusConflict, "a group @"+handle+" already exists")
		return
	}
	if err != nil {
		slog.Warn("member groups: create failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to create the group")
		return
	}
	h.writeMemberGroup(w, r, uuidToString(g.ID), http.StatusCreated)
}

func (h *Handler) writeMemberGroup(w http.ResponseWriter, r *http.Request, id string, status int) {
	groups, ok := h.loadMemberGroups(w, r)
	if !ok {
		return
	}
	g, found := membergroup.Find(groups, id)
	if !found {
		writeError(w, http.StatusNotFound, "group not found")
		return
	}
	writeJSON(w, status, g)
}

// UpdateMemberGroup (admins): a field left out keeps its value; "" clears the fallback.
func (h *Handler) UpdateMemberGroup(w http.ResponseWriter, r *http.Request) {
	if !h.requireGroupAdmin(w, r) {
		return
	}
	cur, ok := h.findMemberGroup(w, r)
	if !ok {
		return
	}
	var req memberGroupRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 16<<10)).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	params := db.UpdateMemberGroupParams{ID: parseUUID(cur.ID), WorkspaceID: parseUUID(ctxWorkspaceID(r.Context())),
		Handle: cur.Handle, Name: cur.Name, Description: cur.Description}
	if cur.FallbackUserID != nil {
		params.FallbackUserID = parseUUID(*cur.FallbackUserID)
	}
	if req.Handle != nil {
		handle := strings.ToLower(strings.TrimLeft(strings.TrimSpace(*req.Handle), "@"))
		if handle != cur.Handle && !h.validGroupHandle(w, r, handle) {
			return
		}
		params.Handle = handle
	}
	if req.Name != nil {
		if strings.TrimSpace(*req.Name) == "" {
			writeError(w, http.StatusBadRequest, "name can't be empty")
			return
		}
		params.Name = strings.TrimSpace(*req.Name)
	}
	if req.Description != nil {
		params.Description = strings.TrimSpace(*req.Description)
	}
	if req.FallbackUserID != nil {
		params.FallbackUserID = pgtype.UUID{}
		if *req.FallbackUserID != "" {
			uid, ok := h.workspaceUserOrBadRequest(w, r, *req.FallbackUserID, "fallback_user_id")
			if !ok {
				return
			}
			params.FallbackUserID = uid
		}
	}
	_, err := h.Queries.UpdateMemberGroup(r.Context(), params)
	if isUniqueViolation(err) {
		writeError(w, http.StatusConflict, "a group @"+params.Handle+" already exists")
		return
	}
	if err != nil {
		slog.Warn("member groups: update failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to update the group")
		return
	}
	h.writeMemberGroup(w, r, cur.ID, http.StatusOK)
}

type memberGroupMembersRequest struct {
	UserIDs []string `json:"user_ids"`
}

// SetMemberGroupMembers (admins) replaces the members with an ordered list of people.
func (h *Handler) SetMemberGroupMembers(w http.ResponseWriter, r *http.Request) {
	if !h.requireGroupAdmin(w, r) {
		return
	}
	cur, ok := h.findMemberGroup(w, r)
	if !ok {
		return
	}
	var req memberGroupMembersRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 16<<10)).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if len(req.UserIDs) > memberGroupMaxMembers {
		writeError(w, http.StatusBadRequest, "a group has at most 20 people")
		return
	}
	ws := parseUUID(ctxWorkspaceID(r.Context()))
	gid := parseUUID(cur.ID)
	seen := map[string]bool{}
	ids := make([]pgtype.UUID, 0, len(req.UserIDs))
	for _, id := range req.UserIDs {
		uid, ok := h.workspaceUserOrBadRequest(w, r, id, "user_id")
		if !ok {
			return
		}
		key := uuidToString(uid)
		if seen[key] {
			writeError(w, http.StatusBadRequest, "user "+key+" is listed twice")
			return
		}
		seen[key] = true
		ids = append(ids, uid)
	}
	tx, err := h.TxStarter.Begin(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to set members")
		return
	}
	defer tx.Rollback(r.Context())
	qtx := h.Queries.WithTx(tx)
	if err := qtx.DeleteMemberGroupMembers(r.Context(), db.DeleteMemberGroupMembersParams{GroupID: gid, WorkspaceID: ws}); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to set members")
		return
	}
	for i, uid := range ids {
		if err := qtx.AddMemberGroupMember(r.Context(), db.AddMemberGroupMemberParams{GroupID: gid, WorkspaceID: ws,
			UserID: uid, Position: int32(i)}); err != nil {
			writeError(w, http.StatusInternalServerError, "failed to set members")
			return
		}
	}
	if err := tx.Commit(r.Context()); err != nil && !errors.Is(err, pgx.ErrTxClosed) {
		writeError(w, http.StatusInternalServerError, "failed to set members")
		return
	}
	h.writeMemberGroup(w, r, cur.ID, http.StatusOK)
}

// ArchiveMemberGroup (admins): the group stops expanding; old mentions show as text.
func (h *Handler) ArchiveMemberGroup(w http.ResponseWriter, r *http.Request) {
	if !h.requireGroupAdmin(w, r) {
		return
	}
	cur, ok := h.findMemberGroup(w, r)
	if !ok {
		return
	}
	if _, err := h.Queries.ArchiveMemberGroup(r.Context(), db.ArchiveMemberGroupParams{ID: parseUUID(cur.ID),
		WorkspaceID: parseUUID(ctxWorkspaceID(r.Context()))}); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to archive the group")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
