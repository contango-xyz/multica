package handler

import (
	"os"
	"strings"

	"github.com/jackc/pgx/v5/pgtype"
)

// botMemberIDsEnv lists member (user) ids that are automation, not people:
// comma-separated UUIDs. Contango sets it to multica-bot, whose pr-watch posts
// mention agents to wake them.
const botMemberIDsEnv = "MULTICA_BOT_USER_IDS"

// isBotMember reports whether a member id is listed in MULTICA_BOT_USER_IDS
// (Contango). The variable is read on each call so tests and a recreated
// container pick up changes; unset means no member is a bot.
func isBotMember(id pgtype.UUID) bool {
	if !id.Valid {
		return false
	}
	want := uuidToString(id)
	for _, raw := range strings.Split(os.Getenv(botMemberIDsEnv), ",") {
		if strings.EqualFold(strings.TrimSpace(raw), want) {
			return true
		}
	}
	return false
}
