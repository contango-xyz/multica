package handler

import (
	"errors"
	"fmt"
	"strings"
	"time"
	_ "time/tzdata" // IANA zones even in a minimal image
)

// workHoursKey is a per-user notification preference (contango): when the
// person works, as "<IANA zone>|<days>|<HH:MM-HH:MM>", e.g.
// "Europe/London|Mon-Fri|09:00-18:00". Days are a range or a comma list of
// Mon..Sun; hours may cross midnight. The empty string clears it. The ops
// inbox feeder sends its "asks waiting on you" reminder pushes only inside
// this window (docs/contango/SMART-INBOX.md); new asks are unaffected.
const workHoursKey = "work_hours"

var weekdays = map[string]bool{"Mon": true, "Tue": true, "Wed": true, "Thu": true, "Fri": true, "Sat": true, "Sun": true}

func validateWorkHours(v string) error {
	parts := strings.Split(v, "|")
	if len(parts) != 3 {
		return errors.New(`want "<zone>|<days>|<HH:MM-HH:MM>"`)
	}
	if _, err := time.LoadLocation(parts[0]); err != nil || parts[0] == "" || parts[0] == "Local" {
		return fmt.Errorf("unknown time zone %q", parts[0])
	}
	if parts[1] == "" {
		return errors.New("no days")
	}
	for _, d := range strings.Split(parts[1], ",") {
		a, b, _ := strings.Cut(d, "-")
		if !weekdays[a] || (b != "" && !weekdays[b]) {
			return fmt.Errorf("bad days %q (use Mon..Sun, a range or a comma list)", parts[1])
		}
	}
	from, to, ok := strings.Cut(parts[2], "-")
	if !ok || !validClock(from) || !validClock(to) || from == to {
		return fmt.Errorf("bad hours %q (use HH:MM-HH:MM)", parts[2])
	}
	return nil
}

func validClock(s string) bool {
	if len(s) != 5 {
		return false
	}
	t, err := time.Parse("15:04", s)
	return err == nil && t.Format("15:04") == s
}
