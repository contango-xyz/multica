// Package membergroup holds role mention groups (contango patch 48): named groups
// of people such as @devops or @fe that a comment can @mention. The server expands
// a group mention to the people on duty, and the API serves the same answer to the
// ops scripts, so there is one rule for who covers a role right now.
package membergroup

import (
	"context"
	"fmt"
	"regexp"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// HandleRe is the shape of a group handle: what follows the @.
var HandleRe = regexp.MustCompile(`^[a-z][a-z0-9-]{1,23}$`)

// ReservedHandles can never name a group: they already mean something in a mention or an ask.
var ReservedHandles = map[string]bool{"all": true, "operator": true, "squad": true, "group": true, "member": true, "agent": true, "issue": true}

// How the on-duty list was chosen.
const (
	ViaMembers     = "members"      // the members who are not away
	ViaBackups     = "backups"      // every member is away; their backups who are not
	ViaFallback    = "fallback"     // every member and backup is away; the group's fallback person
	ViaAwayMembers = "away_members" // nobody is available: every member, who sees it when back
	ViaNobody      = "nobody"       // the group has no members and no fallback
)

// Store is the subset of db.Queries the group lookup reads.
type Store interface {
	ListMemberGroups(ctx context.Context, workspaceID pgtype.UUID) ([]db.MemberGroup, error)
	ListMemberGroupMembers(ctx context.Context, workspaceID pgtype.UUID) ([]db.MemberGroupMember, error)
	ListMembersWithUser(ctx context.Context, workspaceID pgtype.UUID) ([]db.ListMembersWithUserRow, error)
	ListMemberAvailability(ctx context.Context, workspaceID pgtype.UUID) ([]db.MemberAvailability, error)
	ListMemberTimeOff(ctx context.Context, arg db.ListMemberTimeOffParams) ([]db.MemberTimeOff, error)
}

// Person is a group member as the API shows them.
type Person struct {
	UserID       string  `json:"user_id"`
	Name         string  `json:"name"`
	Email        string  `json:"email"`
	Handle       string  `json:"handle"`
	Away         bool    `json:"away"`
	BackupUserID *string `json:"backup_user_id"`
}

// Group is one group with its members (in order) and who is on duty now.
type Group struct {
	ID             string   `json:"id"`
	Handle         string   `json:"handle"`
	Name           string   `json:"name"`
	Description    string   `json:"description"`
	FallbackUserID *string  `json:"fallback_user_id"`
	Members        []Person `json:"members"`
	OnDuty         []string `json:"on_duty"`
	OnDutyVia      string   `json:"on_duty_via"`
	Mention        string   `json:"mention"`
	CreatedAt      string   `json:"created_at"`
	UpdatedAt      string   `json:"updated_at"`
}

// First is the first person on duty, for a script that needs one person (a card field). Empty when nobody.
func (g Group) First() string {
	if len(g.OnDuty) == 0 {
		return ""
	}
	return g.OnDuty[0]
}

// MentionMarkdown is the comment text that mentions the group.
func MentionMarkdown(id, handle string) string {
	return fmt.Sprintf("[@%s](mention://group/%s)", handle, id)
}

// HandleOf is a person's mention handle: their email up to the @, lower case.
func HandleOf(email string) string {
	h, _, _ := strings.Cut(email, "@")
	return strings.ToLower(h)
}

// OnDuty applies the rule. members are the group's people in order (current
// workspace members only); away says who is off today; backup maps a person to
// their backup; isMember says whether a user is still in the workspace.
//  1. members who are not away;
//  2. else their backups who are not away (in member order, no repeats);
//  3. else the fallback person, if not away;
//  4. else every member (they see it when they are back), or the fallback if there are none.
func OnDuty(members []string, away map[string]bool, backup map[string]string, fallback string, isMember func(string) bool) ([]string, string) {
	var out []string
	for _, m := range members {
		if !away[m] {
			out = append(out, m)
		}
	}
	if len(out) > 0 {
		return out, ViaMembers
	}
	seen := map[string]bool{}
	for _, m := range members {
		b := backup[m]
		if b == "" || seen[b] || away[b] || !isMember(b) {
			continue
		}
		seen[b] = true
		out = append(out, b)
	}
	if len(out) > 0 {
		return out, ViaBackups
	}
	fallbackOK := fallback != "" && isMember(fallback)
	if fallbackOK && !away[fallback] {
		return []string{fallback}, ViaFallback
	}
	if len(members) > 0 {
		return append([]string(nil), members...), ViaAwayMembers
	}
	if fallbackOK {
		return []string{fallback}, ViaFallback
	}
	return []string{}, ViaNobody
}

// Load returns every live group in the workspace with members and duty as of now.
// Away means a full day of time off today (UTC), as the Availability page shows it;
// a half day still gets the mention.
func Load(ctx context.Context, s Store, workspaceID pgtype.UUID, now time.Time) ([]Group, error) {
	groups, err := s.ListMemberGroups(ctx, workspaceID)
	if err != nil {
		return nil, fmt.Errorf("list groups: %w", err)
	}
	if len(groups) == 0 {
		return []Group{}, nil
	}
	rows, err := s.ListMemberGroupMembers(ctx, workspaceID)
	if err != nil {
		return nil, fmt.Errorf("list group members: %w", err)
	}
	people, err := s.ListMembersWithUser(ctx, workspaceID)
	if err != nil {
		return nil, fmt.Errorf("list workspace members: %w", err)
	}
	byUser := make(map[string]db.ListMembersWithUserRow, len(people))
	for _, p := range people {
		byUser[util.UUIDToString(p.UserID)] = p
	}
	isMember := func(id string) bool { _, ok := byUser[id]; return ok }

	backup := map[string]string{}
	if avail, err := s.ListMemberAvailability(ctx, workspaceID); err == nil {
		for _, a := range avail {
			if a.BackupUserID.Valid {
				backup[util.UUIDToString(a.UserID)] = util.UUIDToString(a.BackupUserID)
			}
		}
	} else {
		return nil, fmt.Errorf("list availability: %w", err)
	}
	day := pgtype.Date{Time: time.Date(now.UTC().Year(), now.UTC().Month(), now.UTC().Day(), 0, 0, 0, 0, time.UTC), Valid: true}
	off, err := s.ListMemberTimeOff(ctx, db.ListMemberTimeOffParams{WorkspaceID: workspaceID, FromDay: day, ToDay: day})
	if err != nil {
		return nil, fmt.Errorf("list time off: %w", err)
	}
	away := map[string]bool{}
	for _, t := range off {
		if !t.HalfDay {
			away[util.UUIDToString(t.UserID)] = true
		}
	}

	membersOf := map[string][]string{}
	for _, r := range rows {
		uid := util.UUIDToString(r.UserID)
		if !isMember(uid) {
			continue
		}
		gid := util.UUIDToString(r.GroupID)
		membersOf[gid] = append(membersOf[gid], uid)
	}

	out := make([]Group, 0, len(groups))
	for _, g := range groups {
		gid := util.UUIDToString(g.ID)
		fallback := ""
		var fallbackPtr *string
		if g.FallbackUserID.Valid {
			fallback = util.UUIDToString(g.FallbackUserID)
			fallbackPtr = &fallback
		}
		ids := membersOf[gid]
		members := make([]Person, 0, len(ids))
		for _, uid := range ids {
			p := byUser[uid]
			person := Person{UserID: uid, Name: p.UserName, Email: p.UserEmail, Handle: HandleOf(p.UserEmail), Away: away[uid]}
			if b, ok := backup[uid]; ok {
				b := b
				person.BackupUserID = &b
			}
			members = append(members, person)
		}
		duty, via := OnDuty(ids, away, backup, fallback, isMember)
		out = append(out, Group{
			ID: gid, Handle: g.Handle, Name: g.Name, Description: g.Description, FallbackUserID: fallbackPtr,
			Members: members, OnDuty: duty, OnDutyVia: via, Mention: MentionMarkdown(gid, g.Handle),
			CreatedAt: g.CreatedAt.Time.UTC().Format(time.RFC3339), UpdatedAt: g.UpdatedAt.Time.UTC().Format(time.RFC3339),
		})
	}
	return out, nil
}

// Find picks a group by id or handle (with or without the @) from a loaded list.
func Find(groups []Group, ref string) (Group, bool) {
	ref = strings.ToLower(strings.TrimLeft(strings.TrimSpace(ref), "@"))
	for _, g := range groups {
		if g.ID == ref || g.Handle == ref {
			return g, true
		}
	}
	return Group{}, false
}
