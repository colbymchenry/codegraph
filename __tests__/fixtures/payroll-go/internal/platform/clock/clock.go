package clock

import "time"

// Clock is the time seam so a payroll run is reproducible in tests.
type Clock interface {
	Now() time.Time
}

// System is the production clock.
type System struct{}

func (System) Now() time.Time { return time.Now().UTC() }

// Fixed is a frozen clock.
type Fixed struct{ At time.Time }

func (f Fixed) Now() time.Time { return f.At }
