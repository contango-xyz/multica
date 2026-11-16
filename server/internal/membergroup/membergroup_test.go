package membergroup

import (
	"reflect"
	"testing"
)

func TestOnDuty(t *testing.T) {
	everyone := func(string) bool { return true }
	for _, tc := range []struct {
		name     string
		members  []string
		away     map[string]bool
		backup   map[string]string
		fallback string
		isMember func(string) bool
		want     []string
		via      string
	}{
		{name: "members not away, in order", members: []string{"dele", "thibault"}, want: []string{"dele", "thibault"}, via: ViaMembers},
		{name: "time off skipped", members: []string{"dele", "thibault"}, away: map[string]bool{"dele": true}, want: []string{"thibault"}, via: ViaMembers},
		{name: "all away: backups", members: []string{"dele", "thibault"}, away: map[string]bool{"dele": true, "thibault": true},
			backup: map[string]string{"dele": "egill", "thibault": "egill"}, want: []string{"egill"}, via: ViaBackups},
		{name: "away backup skipped, then fallback", members: []string{"dele"}, away: map[string]bool{"dele": true, "egill": true},
			backup: map[string]string{"dele": "egill"}, fallback: "owner", want: []string{"owner"}, via: ViaFallback},
		{name: "removed backup skipped", members: []string{"dele"}, away: map[string]bool{"dele": true},
			backup: map[string]string{"dele": "gone"}, fallback: "owner", isMember: func(id string) bool { return id != "gone" },
			want: []string{"owner"}, via: ViaFallback},
		{name: "everyone away: every member", members: []string{"dele", "thibault"}, away: map[string]bool{"dele": true, "thibault": true, "owner": true},
			fallback: "owner", want: []string{"dele", "thibault"}, via: ViaAwayMembers},
		{name: "no members: fallback even if away", away: map[string]bool{"owner": true}, fallback: "owner", want: []string{"owner"}, via: ViaFallback},
		{name: "nobody", want: []string{}, via: ViaNobody},
	} {
		t.Run(tc.name, func(t *testing.T) {
			isMember := tc.isMember
			if isMember == nil {
				isMember = everyone
			}
			got, via := OnDuty(tc.members, tc.away, tc.backup, tc.fallback, isMember)
			if !reflect.DeepEqual(got, tc.want) || via != tc.via {
				t.Fatalf("OnDuty = %v via %s, want %v via %s", got, via, tc.want, tc.via)
			}
		})
	}
}

func TestFind(t *testing.T) {
	groups := []Group{{ID: "0b6c", Handle: "devops"}, {ID: "77aa", Handle: "fe"}}
	for ref, want := range map[string]string{"devops": "0b6c", "@DevOps": "0b6c", " fe ": "77aa", "77aa": "77aa"} {
		if g, ok := Find(groups, ref); !ok || g.ID != want {
			t.Fatalf("Find(%q) = %v %v, want %s", ref, g.ID, ok, want)
		}
	}
	if _, ok := Find(groups, "be"); ok {
		t.Fatal("Find(be) found a group")
	}
}
