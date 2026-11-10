package service

import "testing"

// Contango patch 37: squads listed in MULTICA_SCHEDULED_SQUAD_IDS own Todo through a scheduler.
func TestScheduledSquad(t *testing.T) {
	t.Setenv("MULTICA_SCHEDULED_SQUAD_IDS", " 2E6D8EF7-46ae-411d-a4a8-3f2fd40b7e42 , other ")
	if !scheduledSquad("2e6d8ef7-46ae-411d-a4a8-3f2fd40b7e42") {
		t.Fatal("listed squad should be scheduled")
	}
	if scheduledSquad("11111111-46ae-411d-a4a8-3f2fd40b7e42") || scheduledSquad("") {
		t.Fatal("unlisted or empty squad is not scheduled")
	}
	t.Setenv("MULTICA_SCHEDULED_SQUAD_IDS", "")
	if scheduledSquad("2e6d8ef7-46ae-411d-a4a8-3f2fd40b7e42") {
		t.Fatal("unset env: nothing is scheduled")
	}
}
