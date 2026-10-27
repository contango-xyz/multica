package middleware

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"sync"

	"github.com/jackc/pgx/v5"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// UserEmailLookupFunc returns the email of a user ID, or "" when the user
// does not exist.
type UserEmailLookupFunc func(ctx context.Context, userID string) (string, error)

// UserEmailLookupFor resolves user emails through the generated GetUser query.
func UserEmailLookupFor(queries *db.Queries) UserEmailLookupFunc {
	return func(ctx context.Context, userID string) (string, error) {
		id, err := util.ParseUUID(userID)
		if err != nil {
			return "", nil
		}
		u, err := queries.GetUser(ctx, id)
		if err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return "", nil
			}
			return "", err
		}
		return u.Email, nil
	}
}

// ParseDaemonAllowedEmails splits MULTICA_DAEMON_ALLOWED_EMAILS
// (comma-separated) into a lowercase set. Empty means no restriction.
func ParseDaemonAllowedEmails(raw string) map[string]bool {
	out := map[string]bool{}
	for _, part := range strings.Split(raw, ",") {
		if e := strings.ToLower(strings.TrimSpace(part)); e != "" {
			out[e] = true
		}
	}
	return out
}

// DaemonOwnerAllowlist runs after DaemonAuth and refuses every /api/daemon
// request whose authenticated owner is not in allowed, so only approved
// accounts can register, heartbeat or claim tasks with a runtime. An empty
// set disables the check. Decisions are cached per user ID for the life of
// the process; changing the list needs a restart anyway.
func DaemonOwnerAllowlist(allowed map[string]bool, lookup UserEmailLookupFunc) func(http.Handler) http.Handler {
	if len(allowed) == 0 {
		return func(next http.Handler) http.Handler { return next }
	}
	var decisions sync.Map // user ID -> bool
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			ownerID := DaemonTokenOwnerIDFromContext(r.Context())
			if ownerID == "" && DaemonAuthPathFromContext(r.Context()) != DaemonAuthPathDaemonToken {
				ownerID = r.Header.Get("X-User-ID")
			}
			if ownerID == "" {
				writeError(w, http.StatusForbidden, "this server does not accept runtimes from this account")
				return
			}

			ok, cached := decisions.Load(ownerID)
			if !cached {
				email, err := lookup(r.Context(), ownerID)
				if err != nil {
					slog.Warn("daemon_allowlist: user lookup failed", "user_id", ownerID, "error", err)
					writeError(w, http.StatusServiceUnavailable, "failed to check runtime owner")
					return
				}
				ok = allowed[strings.ToLower(email)]
				decisions.Store(ownerID, ok)
			}
			if !ok.(bool) {
				slog.Info("daemon_allowlist: refused", "user_id", ownerID, "path", r.URL.Path)
				writeError(w, http.StatusForbidden, "this server does not accept runtimes from this account; turn off the daemon in your desktop app")
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}
