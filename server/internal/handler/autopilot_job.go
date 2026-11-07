package handler

// Contango patch 22: the ops runner's API for autopilot ops jobs.
// docs/contango/AUTOPILOT-JOBS.md has the contract.

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/multica-ai/multica/server/internal/service"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// AutopilotJobRunResponse is one job run as the runner sees it.
type AutopilotJobRunResponse struct {
	ID          string  `json:"id"`
	AutopilotID string  `json:"autopilot_id"`
	Title       string  `json:"title"`
	JobName     string  `json:"job_name"`
	Status      string  `json:"status"`
	Source      string  `json:"source"`
	FiredAt     string  `json:"fired_at"`
	StartedAt   *string `json:"started_at"`
	FinishedAt  *string `json:"finished_at"`
	ExitCode    *int32  `json:"exit_code"`
}

type FinishAutopilotJobRunRequest struct {
	Status     string  `json:"status"`
	ExitCode   *int32  `json:"exit_code"`
	OutputTail *string `json:"output_tail"`
}

func jobRunResponse(id, autopilotID pgtype.UUID, title string, jobName pgtype.Text, status, source string,
	firedAt, startedAt, finishedAt pgtype.Timestamptz, exitCode pgtype.Int4) AutopilotJobRunResponse {
	var code *int32
	if exitCode.Valid {
		v := exitCode.Int32
		code = &v
	}
	return AutopilotJobRunResponse{
		ID:          uuidToString(id),
		AutopilotID: uuidToString(autopilotID),
		Title:       title,
		JobName:     jobName.String,
		Status:      status,
		Source:      source,
		FiredAt:     timestampToString(firedAt),
		StartedAt:   timestampToPtr(startedAt),
		FinishedAt:  timestampToPtr(finishedAt),
		ExitCode:    code,
	}
}

// jobRunHumanOnly is the in-handler backstop for the router's
// RequireHumanActor: agent task tokens never drive the ops runner.
func jobRunHumanOnly(w http.ResponseWriter, r *http.Request) bool {
	if isMachineCredentialActor(r) {
		writeError(w, http.StatusForbidden, "this endpoint is only available to human actors")
		return false
	}
	return true
}

// ListAutopilotJobRuns handles GET /api/autopilot/job-runs?status=pending|running.
// Stale pending runs are expired first, so the list never offers a run the
// claim would refuse for age.
func (h *Handler) ListAutopilotJobRuns(w http.ResponseWriter, r *http.Request) {
	if !jobRunHumanOnly(w, r) {
		return
	}
	wsUUID, ok := parseUUIDOrBadRequest(w, h.resolveWorkspaceID(r), "workspace id")
	if !ok {
		return
	}
	status := r.URL.Query().Get("status")
	if status == "" {
		status = "pending"
	}
	if status != "pending" && status != "running" {
		writeError(w, http.StatusBadRequest, "status must be pending or running")
		return
	}
	limit := int32(100)
	if l := r.URL.Query().Get("limit"); l != "" {
		v, err := strconv.Atoi(l)
		if err != nil || v < 1 || v > 500 {
			writeError(w, http.StatusBadRequest, "limit must be 1-500")
			return
		}
		limit = int32(v)
	}
	if _, err := h.AutopilotService.ExpireStaleAutopilotJobRuns(r.Context(), wsUUID, pgtype.UUID{}); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to list job runs")
		return
	}
	rows, err := h.Queries.ListAutopilotJobRuns(r.Context(), db.ListAutopilotJobRunsParams{
		WorkspaceID: wsUUID,
		Status:      status,
		RowLimit:    limit,
	})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to list job runs")
		return
	}
	out := make([]AutopilotJobRunResponse, len(rows))
	for i, row := range rows {
		out[i] = jobRunResponse(row.ID, row.AutopilotID, row.Title, row.JobName, row.Status, row.Source,
			row.TriggeredAt, row.StartedAt, row.CompletedAt, row.ExitCode)
	}
	writeJSON(w, http.StatusOK, map[string]any{"runs": out, "total": len(out)})
}

// writeJobRunConflict answers a claim/finish that matched no row: 404 when the
// run is not a job run in this workspace, otherwise 409 with its status.
func (h *Handler) writeJobRunConflict(w http.ResponseWriter, r *http.Request, runID, wsUUID pgtype.UUID, want string) {
	cur, err := h.Queries.GetAutopilotJobRunInWorkspace(r.Context(), db.GetAutopilotJobRunInWorkspaceParams{
		ID:          runID,
		WorkspaceID: wsUUID,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusNotFound, "job run not found")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to load job run")
		return
	}
	// An agent run (it has a task, or it was never claimed and its autopilot
	// is not a job) is not the runner's business.
	if cur.TaskID.Valid || (!cur.StartedAt.Valid && cur.ExecutionMode != service.ExecutionModeJob) {
		writeError(w, http.StatusNotFound, "job run not found")
		return
	}
	status := cur.Status
	if want == "pending" && status == "pending" {
		// Pending but past the claim window: expire it now.
		if _, err := h.AutopilotService.ExpireStaleAutopilotJobRuns(r.Context(), wsUUID, cur.AutopilotID); err == nil {
			status = "expired"
		}
	}
	writeJSON(w, http.StatusConflict, map[string]any{
		"error":  fmt.Sprintf("job run is %s, not %s", status, want),
		"code":   "job_run_conflict",
		"status": status,
	})
}

// ClaimAutopilotJobRun handles POST /api/autopilot/job-runs/{runId}/claim:
// pending -> running, atomically. A second claim gets 409.
func (h *Handler) ClaimAutopilotJobRun(w http.ResponseWriter, r *http.Request) {
	if !jobRunHumanOnly(w, r) {
		return
	}
	wsUUID, ok := parseUUIDOrBadRequest(w, h.resolveWorkspaceID(r), "workspace id")
	if !ok {
		return
	}
	runID, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "runId"), "run id")
	if !ok {
		return
	}
	row, err := h.Queries.ClaimAutopilotJobRun(r.Context(), db.ClaimAutopilotJobRunParams{
		ID:          runID,
		WorkspaceID: wsUUID,
		Cutoff:      service.AutopilotJobCutoff(time.Now()),
	})
	if errors.Is(err, pgx.ErrNoRows) {
		h.writeJobRunConflict(w, r, runID, wsUUID, "pending")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to claim job run")
		return
	}
	writeJSON(w, http.StatusOK, jobRunResponse(row.ID, row.AutopilotID, row.Title, row.JobName, row.Status, row.Source,
		row.TriggeredAt, row.StartedAt, row.CompletedAt, row.ExitCode))
}

// FinishAutopilotJobRun handles POST /api/autopilot/job-runs/{runId}/finish:
// running -> completed ("succeeded") | failed.
func (h *Handler) FinishAutopilotJobRun(w http.ResponseWriter, r *http.Request) {
	if !jobRunHumanOnly(w, r) {
		return
	}
	wsUUID, ok := parseUUIDOrBadRequest(w, h.resolveWorkspaceID(r), "workspace id")
	if !ok {
		return
	}
	runID, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "runId"), "run id")
	if !ok {
		return
	}
	var req FinishAutopilotJobRunRequest
	// output_tail is truncated server side; the body cap only stops abuse.
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	var status string
	switch req.Status {
	case "succeeded":
		status = "completed"
	case "failed":
		status = "failed"
	default:
		writeError(w, http.StatusBadRequest, "status must be succeeded or failed")
		return
	}
	params := db.FinishAutopilotJobRunParams{
		ID:          runID,
		WorkspaceID: wsUUID,
		Status:      status,
	}
	if req.ExitCode != nil {
		params.ExitCode = pgtype.Int4{Int32: *req.ExitCode, Valid: true}
	}
	if req.OutputTail != nil {
		params.OutputTail = pgtype.Text{String: service.TruncateJobOutputTail(*req.OutputTail), Valid: true}
	}
	if status == "failed" {
		reason := "ops job failed"
		if req.ExitCode != nil {
			reason = fmt.Sprintf("ops job failed (exit code %d)", *req.ExitCode)
		}
		params.FailureReason = pgtype.Text{String: reason, Valid: true}
	}
	row, err := h.Queries.FinishAutopilotJobRun(r.Context(), params)
	if errors.Is(err, pgx.ErrNoRows) {
		h.writeJobRunConflict(w, r, runID, wsUUID, "running")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to finish job run")
		return
	}
	h.AutopilotService.PublishAutopilotJobRunDone(uuidToString(wsUUID), row.ID, row.AutopilotID, row.Status)
	writeJSON(w, http.StatusOK, jobRunResponse(row.ID, row.AutopilotID, row.Title, row.JobName, row.Status, row.Source,
		row.TriggeredAt, row.StartedAt, row.CompletedAt, row.ExitCode))
}
