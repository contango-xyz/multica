package handler

// Availability (contango patch 38): who works when and who is away. Working hours stay the
// `work_hours` notification preference (patch 24, work_hours.go); this adds time off (typed in by
// the person or imported from the shared company calendar and personal iCal feeds), a backup person
// and the personal iCal address itself. Agents and the ops tools read it so an ask never waits on
// someone who is away (owner, 2026-11-10).

import (
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/logger"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

const (
	availabilityDefaultDays = 14
	availabilityMaxDays     = 120
	timeOffMaxDays          = 366
)

var timeOffSources = map[string]bool{"shared-ical": true, "personal-ical": true}

type timeOffResponse struct {
	ID       string `json:"id"`
	StartsOn string `json:"starts_on"`
	EndsOn   string `json:"ends_on"`
	HalfDay  bool   `json:"half_day"`
	Label    string `json:"label"`
	Source   string `json:"source"`
}

type memberAvailabilityResponse struct {
	UserID       string            `json:"user_id"`
	Name         string            `json:"name"`
	Email        string            `json:"email"`
	Role         string            `json:"role"`
	WorkHours    string            `json:"work_hours"`
	BackupUserID *string           `json:"backup_user_id"`
	PersonalICal bool              `json:"personal_ical"`
	AwayToday    bool              `json:"away_today"`
	TimeOff      []timeOffResponse `json:"time_off"`
}

func dateString(d pgtype.Date) string {
	if !d.Valid {
		return ""
	}
	return d.Time.Format("2006-01-02")
}

func parseDay(s string) (pgtype.Date, error) {
	t, err := time.Parse("2006-01-02", strings.TrimSpace(s))
	if err != nil {
		return pgtype.Date{}, errors.New("dates are YYYY-MM-DD")
	}
	return pgtype.Date{Time: t, Valid: true}, nil
}

func toTimeOff(t db.MemberTimeOff) timeOffResponse {
	return timeOffResponse{ID: uuidToString(t.ID), StartsOn: dateString(t.StartsOn), EndsOn: dateString(t.EndsOn),
		HalfDay: t.HalfDay, Label: t.Label, Source: t.Source}
}

// availabilityWindow reads ?from=&to= (YYYY-MM-DD) or ?days=N from today (UTC).
func availabilityWindow(r *http.Request, now time.Time) (pgtype.Date, pgtype.Date, error) {
	today := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, time.UTC)
	from, to := today, today.AddDate(0, 0, availabilityDefaultDays)
	q := r.URL.Query()
	if v := q.Get("days"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 0 || n > availabilityMaxDays {
			return pgtype.Date{}, pgtype.Date{}, errors.New("days must be 0..120")
		}
		to = today.AddDate(0, 0, n)
	}
	if v := q.Get("from"); v != "" {
		d, err := parseDay(v)
		if err != nil {
			return pgtype.Date{}, pgtype.Date{}, err
		}
		from = d.Time
	}
	if v := q.Get("to"); v != "" {
		d, err := parseDay(v)
		if err != nil {
			return pgtype.Date{}, pgtype.Date{}, err
		}
		to = d.Time
	}
	if to.Before(from) || to.Sub(from) > availabilityMaxDays*24*time.Hour {
		return pgtype.Date{}, pgtype.Date{}, errors.New("window must be 0..120 days")
	}
	return pgtype.Date{Time: from, Valid: true}, pgtype.Date{Time: to, Valid: true}, nil
}

// GetAvailability lists every member with their working hours, backup and time off in the window.
func (h *Handler) GetAvailability(w http.ResponseWriter, r *http.Request) {
	workspaceID := ctxWorkspaceID(r.Context())
	if _, ok := h.workspaceMember(w, r, workspaceID); !ok {
		return
	}
	now := time.Now().UTC()
	from, to, err := availabilityWindow(r, now)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	ws := parseUUID(workspaceID)
	ctx := r.Context()
	members, err := h.Queries.ListMembersWithUser(ctx, ws)
	if err != nil {
		slog.Warn("availability: members failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to load availability")
		return
	}
	ids := make([]pgtype.UUID, 0, len(members))
	for _, m := range members {
		ids = append(ids, m.UserID)
	}
	hours := map[string]string{}
	if prefs, err := h.Queries.ListNotificationPreferencesByUsers(ctx, db.ListNotificationPreferencesByUsersParams{
		WorkspaceID: ws, UserIds: ids}); err == nil {
		for _, p := range prefs {
			var m map[string]string
			if json.Unmarshal(p.Preferences, &m) == nil {
				hours[uuidToString(p.UserID)] = m[workHoursKey]
			}
		}
	}
	extra := map[string]db.MemberAvailability{}
	if rows, err := h.Queries.ListMemberAvailability(ctx, ws); err == nil {
		for _, a := range rows {
			extra[uuidToString(a.UserID)] = a
		}
	}
	off := map[string][]timeOffResponse{}
	away := map[string]bool{}
	rows, err := h.Queries.ListMemberTimeOff(ctx, db.ListMemberTimeOffParams{WorkspaceID: ws, FromDay: from, ToDay: to})
	if err != nil {
		slog.Warn("availability: time off failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to load availability")
		return
	}
	today := now.Format("2006-01-02")
	for _, t := range rows {
		uid := uuidToString(t.UserID)
		off[uid] = append(off[uid], toTimeOff(t))
		if dateString(t.StartsOn) <= today && today <= dateString(t.EndsOn) && !t.HalfDay {
			away[uid] = true
		}
	}
	out := make([]memberAvailabilityResponse, 0, len(members))
	for _, m := range members {
		uid := uuidToString(m.UserID)
		item := memberAvailabilityResponse{UserID: uid, Name: m.UserName, Email: m.UserEmail, Role: m.Role,
			WorkHours: hours[uid], AwayToday: away[uid], TimeOff: off[uid]}
		if item.TimeOff == nil {
			item.TimeOff = []timeOffResponse{}
		}
		if a, ok := extra[uid]; ok {
			if a.BackupUserID.Valid {
				b := uuidToString(a.BackupUserID)
				item.BackupUserID = &b
			}
			item.PersonalICal = a.PersonalIcalUrl.Valid && a.PersonalIcalUrl.String != ""
		}
		out = append(out, item)
	}
	writeJSON(w, http.StatusOK, map[string]any{"workspace_id": workspaceID, "from": dateString(from),
		"to": dateString(to), "today": today, "members": out})
}

type updateMyAvailabilityRequest struct {
	BackupUserID    *string `json:"backup_user_id"`
	PersonalICalURL *string `json:"personal_ical_url"`
}

func validICalURL(s string) bool {
	u, err := url.Parse(s)
	return err == nil && u.Scheme == "https" && u.Host != "" && len(s) <= 2048
}

// UpdateMyAvailability sets the caller's backup person and personal iCal address. A field left out
// keeps its value; an empty string clears it. The address is never returned (it is a secret).
func (h *Handler) UpdateMyAvailability(w http.ResponseWriter, r *http.Request) {
	userID, ok := requireUserID(w, r)
	if !ok {
		return
	}
	workspaceID := ctxWorkspaceID(r.Context())
	var req updateMyAvailabilityRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	ws, me := parseUUID(workspaceID), parseUUID(userID)
	cur, err := h.Queries.GetMemberAvailability(r.Context(), db.GetMemberAvailabilityParams{WorkspaceID: ws, UserID: me})
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusInternalServerError, "failed to load availability")
		return
	}
	backup, ical := cur.BackupUserID, cur.PersonalIcalUrl
	if req.BackupUserID != nil {
		backup = pgtype.UUID{}
		if v := strings.TrimSpace(*req.BackupUserID); v != "" {
			id, ok := parseUUIDOrBadRequest(w, v, "backup_user_id")
			if !ok {
				return
			}
			if v == userID {
				writeError(w, http.StatusBadRequest, "backup_user_id can't be yourself")
				return
			}
			if _, err := h.Queries.GetMemberByUserAndWorkspace(r.Context(), db.GetMemberByUserAndWorkspaceParams{
				UserID: id, WorkspaceID: ws}); err != nil {
				writeError(w, http.StatusBadRequest, "backup_user_id is not a member of this workspace")
				return
			}
			backup = id
		}
	}
	if req.PersonalICalURL != nil {
		ical = pgtype.Text{}
		if v := strings.TrimSpace(*req.PersonalICalURL); v != "" {
			if !validICalURL(v) {
				writeError(w, http.StatusBadRequest, "personal_ical_url must be an https address")
				return
			}
			ical = pgtype.Text{String: v, Valid: true}
		}
	}
	a, err := h.Queries.UpsertMemberAvailability(r.Context(), db.UpsertMemberAvailabilityParams{
		WorkspaceID: ws, UserID: me, BackupUserID: backup, PersonalIcalUrl: ical})
	if err != nil {
		slog.Warn("availability: update failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to save availability")
		return
	}
	var b *string
	if a.BackupUserID.Valid {
		s := uuidToString(a.BackupUserID)
		b = &s
	}
	writeJSON(w, http.StatusOK, map[string]any{"backup_user_id": b,
		"personal_ical": a.PersonalIcalUrl.Valid && a.PersonalIcalUrl.String != ""})
}

type createTimeOffRequest struct {
	StartsOn string `json:"starts_on"`
	EndsOn   string `json:"ends_on"`
	HalfDay  bool   `json:"half_day"`
	Label    string `json:"label"`
}

func validTimeOff(startsOn, endsOn string) (pgtype.Date, pgtype.Date, error) {
	s, err := parseDay(startsOn)
	if err != nil {
		return s, s, err
	}
	e := s
	if endsOn != "" {
		if e, err = parseDay(endsOn); err != nil {
			return s, e, err
		}
	}
	if e.Time.Before(s.Time) {
		return s, e, errors.New("ends_on is before starts_on")
	}
	if e.Time.Sub(s.Time) > timeOffMaxDays*24*time.Hour {
		return s, e, errors.New("time off is limited to a year per entry")
	}
	return s, e, nil
}

// CreateMyTimeOff adds a manual time-off entry for the caller (ends_on inclusive; omitted = one day).
func (h *Handler) CreateMyTimeOff(w http.ResponseWriter, r *http.Request) {
	userID, ok := requireUserID(w, r)
	if !ok {
		return
	}
	var req createTimeOffRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	s, e, err := validTimeOff(req.StartsOn, req.EndsOn)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	label := strings.TrimSpace(req.Label)
	if len(label) > 200 {
		label = label[:200]
	}
	t, err := h.Queries.CreateMemberTimeOff(r.Context(), db.CreateMemberTimeOffParams{
		WorkspaceID: parseUUID(ctxWorkspaceID(r.Context())), UserID: parseUUID(userID), StartsOn: s, EndsOn: e,
		HalfDay: req.HalfDay, Label: label})
	if err != nil {
		slog.Warn("availability: create time off failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to save time off")
		return
	}
	writeJSON(w, http.StatusCreated, toTimeOff(t))
}

// DeleteMyTimeOff removes one of the caller's own manual entries (imported ones come back from the
// calendar, so they are changed there).
func (h *Handler) DeleteMyTimeOff(w http.ResponseWriter, r *http.Request) {
	userID, ok := requireUserID(w, r)
	if !ok {
		return
	}
	id, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "id"), "id")
	if !ok {
		return
	}
	n, err := h.Queries.DeleteManualMemberTimeOff(r.Context(), db.DeleteManualMemberTimeOffParams{
		ID: id, WorkspaceID: parseUUID(ctxWorkspaceID(r.Context())), UserID: parseUUID(userID)})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to delete time off")
		return
	}
	if n == 0 {
		writeError(w, http.StatusNotFound, "no such manual time off of yours")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

type importTimeOffEntry struct {
	UserID   string `json:"user_id"`
	UID      string `json:"uid"`
	StartsOn string `json:"starts_on"`
	EndsOn   string `json:"ends_on"`
	HalfDay  bool   `json:"half_day"`
	Label    string `json:"label"`
}

type importTimeOffRequest struct {
	Source  string               `json:"source"`
	UserIDs []string             `json:"user_ids"`
	Entries []importTimeOffEntry `json:"entries"`
}

func (h *Handler) requireAvailabilityAdmin(w http.ResponseWriter, r *http.Request) bool {
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

// ImportTimeOff replaces one calendar source's entries for the users it covers (idempotent: the ops
// import job sends the whole feed every run; entries it no longer sends are removed).
func (h *Handler) ImportTimeOff(w http.ResponseWriter, r *http.Request) {
	if !h.requireAvailabilityAdmin(w, r) {
		return
	}
	var req importTimeOffRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if !timeOffSources[req.Source] {
		writeError(w, http.StatusBadRequest, "source must be shared-ical or personal-ical")
		return
	}
	ws := parseUUID(ctxWorkspaceID(r.Context()))
	users, ok := parseUUIDSliceOrBadRequest(w, req.UserIDs, "user_ids")
	if !ok {
		return
	}
	covered := map[string]bool{}
	for _, u := range req.UserIDs {
		covered[u] = true
	}
	keep := []string{}
	for _, e := range req.Entries {
		if !covered[e.UserID] || strings.TrimSpace(e.UID) == "" {
			writeError(w, http.StatusBadRequest, "every entry needs a uid and a user in user_ids")
			return
		}
		s, end, err := validTimeOff(e.StartsOn, e.EndsOn)
		if err != nil {
			writeError(w, http.StatusBadRequest, e.UID+": "+err.Error())
			return
		}
		label := strings.TrimSpace(e.Label)
		if len(label) > 200 {
			label = label[:200]
		}
		if _, err := h.Queries.UpsertImportedMemberTimeOff(r.Context(), db.UpsertImportedMemberTimeOffParams{
			WorkspaceID: ws, UserID: parseUUID(e.UserID), StartsOn: s, EndsOn: end, HalfDay: e.HalfDay, Label: label,
			Source: req.Source, ExternalUid: pgtype.Text{String: e.UID, Valid: true}}); err != nil {
			slog.Warn("availability: import upsert failed", append(logger.RequestAttrs(r), "error", err)...)
			writeError(w, http.StatusInternalServerError, "failed to import time off")
			return
		}
		keep = append(keep, e.UID)
	}
	removed, err := h.Queries.DeleteStaleImportedMemberTimeOff(r.Context(), db.DeleteStaleImportedMemberTimeOffParams{
		WorkspaceID: ws, Source: req.Source, UserIds: users, KeepUids: keep})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to prune time off")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"source": req.Source, "upserted": len(req.Entries), "removed": removed})
}

// ListICalSources gives the import job the members' personal iCal addresses (admins only: they are
// secrets; the people endpoint only says whether one is set).
func (h *Handler) ListICalSources(w http.ResponseWriter, r *http.Request) {
	if !h.requireAvailabilityAdmin(w, r) {
		return
	}
	rows, err := h.Queries.ListMemberAvailability(r.Context(), parseUUID(ctxWorkspaceID(r.Context())))
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to list sources")
		return
	}
	out := []map[string]string{}
	for _, a := range rows {
		if a.PersonalIcalUrl.Valid && a.PersonalIcalUrl.String != "" {
			out = append(out, map[string]string{"user_id": uuidToString(a.UserID), "url": a.PersonalIcalUrl.String})
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"sources": out})
}
