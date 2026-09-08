package payroll

import (
	"time"

	"github.com/example/payroll-svc/internal/domain/payroll"
)

// prorateSalary scales a full period rate down when the contract covers only
// part of the cycle window (a mid-period joiner or leaver).
func prorateSalary(fullCents int64, contract payroll.Contract, cycle payroll.Cycle) int64 {
	window := calendarDays(cycle.Start, cycle.End)
	if window <= 0 {
		return 0
	}
	covered := calendarDays(laterOf(cycle.Start, contract.StartsOn), earlierOf(cycle.End, contract.EndsOn))
	if covered >= window {
		return fullCents
	}
	if covered <= 0 {
		return 0
	}
	return fullCents * int64(covered) / int64(window)
}

// prorateAllowance applies the same window rule to a recurring allowance.
func prorateAllowance(a payroll.Allowance, cycle payroll.Cycle, e payroll.Employee) int64 {
	if !a.Prorated {
		return a.AmountCents
	}
	return prorateSalary(a.AmountCents, e.Contract, cycle)
}

func calendarDays(from, to time.Time) int {
	if to.Before(from) {
		return 0
	}
	return int(to.Sub(from).Hours()/24) + 1
}

func laterOf(a, b time.Time) time.Time {
	if b.IsZero() || a.After(b) {
		return a
	}
	return b
}

func earlierOf(a, b time.Time) time.Time {
	if b.IsZero() || a.Before(b) {
		return a
	}
	return b
}
