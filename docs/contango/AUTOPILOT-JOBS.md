# Autopilot ops jobs (contango patch 22, owner request 2026-11-07)

## Why

The owner wants every scheduled thing in one place: Multica's autopilot page. Agent autopilots
already live there; the ~20 ops jobs (pr-watch, the inbox feeder, stall-watch, the scheduler, wiki
sync, the exploration planner, …) were systemd timers on the ops box. An **ops job** is an autopilot
whose schedule fires **without waking an agent**: the server records a run, an ops runner on the ops
box executes it and reports back.

## Model

- A third `execution_mode`, **`job`**. The autopilot has a **`job_name`** matching
  `^[a-z0-9][a-z0-9-]{0,63}$` (e.g. `pr-watch`, `explore`) and **no assignee** (`assignee_id` is
  NULL in the database and `""` in API responses). `description` is free text (notes for humans).
- Triggers: **schedule** triggers work exactly as for agent autopilots (same scheduler, same
  catch-up and idempotency per occurrence), and **Run now** fires one too. Webhook triggers are
  refused for a job (400); a webhook left over from before a mode switch records a `skipped` run.
- Firing a job autopilot creates one `autopilot_run`. It never creates an issue, a task or a
  wakeup, never runs an agent, never takes autopilot quota. Pause, archive and status checks are the
  same as for every autopilot (the scheduler skips non-active autopilots; Run now needs `active`).
- Run lifecycle:

  ```
  fire ──► pending ──claim──► running ──finish──► completed ("succeeded") | failed
     │        └── not claimed within 10 min ──► expired
     └── a previous run is still pending/running ──► skipped (reason_code already_active)
  ```

  The overlap check and the insert run under a row lock on the autopilot, so two triggers or two
  server replicas cannot both start a run. A stale pending run is expired before the overlap check,
  so a dead runner never blocks the next fire for more than 10 minutes. Expiry runs every minute on
  the server (`runAutopilotJobExpirer`) and also inline on fire, list and claim.
- A `running` run never times out on the server: the runner must always call finish (see the
  runner contract). A run stuck in `running` makes every later fire `skipped`.
- The failure-rate auto-pause monitor treats job runs like other runs (completed/failed count;
  skipped/expired don't).

## Runner API

All three routes need a **workspace member's human credentials**: a personal access token
(`mul_…`, the multica-bot member's token, as the CLI uses) or a session, plus `X-Workspace-ID` (or
`X-Workspace-Slug`). Any workspace member may call them. **Agent task tokens and cloud-node tokens
get 403** (`RequireHumanActor`, as for the smart-inbox signal routes).

### `GET /api/autopilot/job-runs?status=pending&limit=100`

`status` is `pending` (default) or `running`; `limit` 1–500 (default 100). Stale pending runs are
expired first. Oldest first.

```json
200 {"runs": [{"id": "uuid", "autopilot_id": "uuid", "title": "PR watch", "job_name": "pr-watch",
               "status": "pending", "source": "schedule", "fired_at": "2026-11-07T10:00:00Z",
               "started_at": null, "finished_at": null, "exit_code": null}],
     "total": 1}
```

400 on another status or a bad limit.

### `POST /api/autopilot/job-runs/{id}/claim`

No body. Atomic `pending → running` (sets `started_at`). Exactly one concurrent claim wins.

- **200** the run (same shape as a list item, `status: "running"`, `started_at` set).
- **409** `{"error": "job run is running, not pending", "code": "job_run_conflict", "status": "running"}`:
  already claimed, finished, skipped, or expired. A pending run older than 10 minutes is expired by
  this call and answers 409 with `"status": "expired"`.
- **404** no such run in this workspace, or it is an agent run.

### `POST /api/autopilot/job-runs/{id}/finish`

```json
{"status": "succeeded" | "failed", "exit_code": 0, "output_tail": "last lines of output"}
```

`exit_code` and `output_tail` are optional. `output_tail` keeps the **last 8 KiB** (truncated from
the start on a UTF-8 boundary; invalid UTF-8 and NUL bytes are replaced). Body limit 1 MiB.
`running → completed | failed`, sets `finished_at`. A failed run gets
`failure_reason = "ops job failed (exit code N)"`.

- **200** the run (`status` is `completed` for `succeeded`, or `failed`; `finished_at`, `exit_code` set).
- **400** missing or other `status`, malformed body.
- **409** the run is not `running` (`code: job_run_conflict`, current `status` in the body).
- **404** as for claim.

### Existing routes that change

- `POST /api/autopilots` and `PATCH /api/autopilots/{id}` accept `execution_mode: "job"` and
  `job_name`. A job takes no `assignee_id` (400 if sent); `job_name` is required and validated
  (400); `job_name` on another mode is 400. Switching to `job` clears the assignee, the issue title
  template and keeps the project untouched; switching away needs `assignee_type` + `assignee_id` in
  the same PATCH (400 otherwise). Responses carry `job_name` (null unless job).
- `POST /api/autopilots/{id}/trigger` on a job returns the run with `status: "pending"` (or
  `"skipped"` on overlap).
- `GET /api/autopilots/{id}/runs` and `…/runs/{runId}`: runs carry `started_at`, `exit_code`,
  `output_tail` when set (omitted otherwise). Run statuses gain `pending` and `expired`.
- `POST /api/autopilots/{id}/triggers` with `kind: "webhook"` on a job: 400.

## CLI

```
multica autopilot create --title "PR watch" --mode job --job-name pr-watch   # --execution-mode is an alias of --mode
multica autopilot update <id> --job-name pr-watch-v2
multica autopilot update <id> --mode run_only --agent <agent>                # leave job mode
multica autopilot trigger-add <id> --cron "*/5 * * * *" --timezone UTC
multica autopilot job-runs list [--status pending|running] [--limit N] [--output json|table]
multica autopilot job-runs claim <run-id> [--output json|table]
multica autopilot job-runs finish <run-id> --status succeeded|failed [--exit-code N]
        [--output-tail TEXT | --output-tail-file PATH|-] [--output json|table]
```

`job-runs` prints JSON by default. A 409/404 exits non-zero with the server's message.
`multica autopilot trigger` on a job reports success for `pending`.

## Runner contract (the ops box side)

- The runner owns a **fixed map `job_name → command`** (argv, environment, working directory,
  timeout). **The server never runs commands** and never sends one: it only stores the name. An
  unknown `job_name` is finished as `failed` with an explanatory `output_tail`, never guessed at.
- Loop (every ~15–30 s): list pending runs; for each, claim; on 200 run the mapped command; then
  finish with `succeeded` iff the exit code is 0, the exit code, and the tail of combined
  stdout/stderr. On 409 skip the run (another runner or expiry got it).
- Always finish a claimed run, including on timeout and on runner shutdown (`failed`, with what is
  known); otherwise the job stays `running` and every later fire is `skipped`. A runner restarting
  with runs it claimed but never finished should finish them as `failed` ("runner restarted").
- Claim within 10 minutes of the fire, or the run expires.
- Use the multica-bot member's PAT, never an agent task token.

## UI (web and desktop, `packages/views`)

- Create / edit dialog: a third output mode **"Ops job (no agent)"**. Choosing it replaces the
  assignee picker with a required **Job name** field (monospace, validated like the server), hides
  the project, subscribers and webhook options, and saves a schedule trigger as usual.
- List: the Assignee column shows the job name (terminal icon, monospace); Last run shows the
  status dot (pending blue, expired amber) and time; Next run and Trigger as for any autopilot.
- Detail: a **Job** property instead of Agent; mode read-only (entering or leaving job mode goes
  through the edit dialog); no Project property; summary "Runs ops job `<name>`". Run history rows
  show status, fire time, duration, exit code and source; a finished run expands to its output tail
  (monospace, scrollable). Skipped (overlap) runs are grouped as for agent autopilots. Add trigger
  offers schedule only.
