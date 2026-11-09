package handler

import "testing"

func TestAcquireInboxReadCapsOnePersonOnly(t *testing.T) {
	user, other := "limit-test-user", "limit-test-other"
	var releases []func()
	for i := 0; i < maxInboxReadsPerUser; i++ {
		release, ok := acquireInboxRead(user)
		if !ok {
			t.Fatalf("request %d refused below the cap", i)
		}
		releases = append(releases, release)
	}
	if _, ok := acquireInboxRead(user); ok {
		t.Fatal("request over the cap was admitted")
	}
	release, ok := acquireInboxRead(other)
	if !ok {
		t.Fatal("another person was refused")
	}
	release()
	releases[0]()
	if _, ok := acquireInboxRead(user); !ok {
		t.Fatal("a freed slot was not reusable")
	}
	for _, release := range releases[1:] {
		release()
	}
}
