package payroll

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"time"

	"github.com/example/payroll-svc/internal/domain/payroll"
	"github.com/example/payroll-svc/internal/platform/clock"
	"github.com/example/payroll-svc/internal/store/payslipstore"
)

// ErrCycleClosed is returned when a cycle has already been finalized.
var ErrCycleClosed = errors.New("payroll cycle is closed")

// ErrNoEmployees is returned when a cycle resolves to an empty roster.
var ErrNoEmployees = errors.New("payroll cycle has no active employees")

// RunOptions tunes a single run of a payroll cycle.
type RunOptions struct {
	// DryRun computes every payslip but persists nothing.
	DryRun bool
	// Reason is recorded on the audit trail for re-runs.
	Reason string
	// Only, when non-empty, restricts the run to these employee ids.
	Only []string
}

// RunResult is the outcome of one payroll cycle run.
type RunResult struct {
	CycleID         string
	Payslips        []payroll.Payslip
	TotalGrossCents int64
	TotalNetCents   int64
	Skipped         []string
	FinishedAt      time.Time
}

// Service is the hand-written payroll use-case layer. It owns the order of
// operations for a cycle: resolve the roster, build a payslip per employee,
// then persist. The generated CRUD layer under internal/gen has no opinion
// about any of that — it can only read and write single rows.
type Service struct {
	store *payslipstore.Store
	clock clock.Clock
}

func NewService(store *payslipstore.Store, c clock.Clock) *Service {
	return &Service{store: store, clock: c}
}

// RunCycle is the public entry point used by the HTTP handler. It loads the
// cycle, guards its state, and delegates the actual work to runPayrollCycleAll.
func (s *Service) RunCycle(ctx context.Context, cycleID string, opts RunOptions) (RunResult, error) {
	cycle, err := s.loadCycle(ctx, cycleID)
	if err != nil {
		return RunResult{}, err
	}
	if cycle.Status == payroll.CycleClosed {
		return RunResult{}, ErrCycleClosed
	}

	roster, err := s.rosterFor(ctx, cycle, opts)
	if err != nil {
		return RunResult{}, err
	}
	if len(roster) == 0 {
		return RunResult{}, ErrNoEmployees
	}

	return s.runPayrollCycleAll(ctx, cycle, roster, opts)
}

// runPayrollCycleAll is the heart of the cycle: for every employee on the
// roster it builds a payslip from that employee's contract and timesheet,
// then upserts the result. Ordering matters — a payslip is only persisted
// after every earning, deduction and tax line has been resolved, so a
// partially-computed slip can never reach the store.
func (s *Service) runPayrollCycleAll(
	ctx context.Context,
	cycle payroll.Cycle,
	roster []payroll.Employee,
	opts RunOptions,
) (RunResult, error) {
	result := RunResult{CycleID: cycle.ID}
	now := s.clock.Now()

	for _, employee := range roster {
		if err := ctx.Err(); err != nil {
			return result, err
		}

		timesheet, err := s.timesheetFor(ctx, cycle, employee)
		if err != nil {
			result.Skipped = append(result.Skipped, employee.ID)
			continue
		}

		slip, err := s.BuildPayslip(ctx, cycle, employee, timesheet)
		if err != nil {
			return result, fmt.Errorf("build payslip for %s: %w", employee.ID, err)
		}

		slip.RunAt = now
		slip.RunReason = opts.Reason

		if !opts.DryRun {
			if err := s.store.Upsert(ctx, slip); err != nil {
				return result, fmt.Errorf("persist payslip for %s: %w", employee.ID, err)
			}
		}

		result.Payslips = append(result.Payslips, slip)
		result.TotalGrossCents += slip.GrossCents
		result.TotalNetCents += slip.NetCents
	}

	if !opts.DryRun {
		if err := s.closeCycle(ctx, cycle, now); err != nil {
			return result, err
		}
	}

	sort.Slice(result.Payslips, func(i, j int) bool {
		return result.Payslips[i].EmployeeID < result.Payslips[j].EmployeeID
	})
	result.FinishedAt = now
	return result, nil
}

// rosterFor resolves which employees this cycle pays. An employee joins the
// roster when their contract overlaps the cycle window and they are not on
// unpaid leave for the whole period.
func (s *Service) rosterFor(ctx context.Context, cycle payroll.Cycle, opts RunOptions) ([]payroll.Employee, error) {
	all, err := s.store.EmployeesForCycle(ctx, cycle.ID)
	if err != nil {
		return nil, err
	}

	only := map[string]bool{}
	for _, id := range opts.Only {
		only[id] = true
	}

	roster := make([]payroll.Employee, 0, len(all))
	for _, e := range all {
		if len(only) > 0 && !only[e.ID] {
			continue
		}
		if !e.Contract.OverlapsWindow(cycle.Start, cycle.End) {
			continue
		}
		if e.UnpaidLeaveCoversWindow(cycle.Start, cycle.End) {
			continue
		}
		roster = append(roster, e)
	}

	sort.Slice(roster, func(i, j int) bool { return roster[i].ID < roster[j].ID })
	return roster, nil
}

func (s *Service) timesheetFor(ctx context.Context, cycle payroll.Cycle, e payroll.Employee) (payroll.Timesheet, error) {
	ts, err := s.store.Timesheet(ctx, cycle.ID, e.ID)
	if err != nil {
		return payroll.Timesheet{}, err
	}
	if ts.Approved {
		return ts, nil
	}
	if e.Contract.Kind == payroll.ContractSalaried {
		// Salaried staff are paid the contractual period regardless of an
		// unapproved timesheet; hourly staff are skipped until approval.
		return payroll.Timesheet{
			CycleID:    cycle.ID,
			EmployeeID: e.ID,
			Approved:   true,
			Units:      e.Contract.PeriodUnits(cycle.Start, cycle.End),
		}, nil
	}
	return payroll.Timesheet{}, fmt.Errorf("timesheet for %s not approved", e.ID)
}

func (s *Service) loadCycle(ctx context.Context, cycleID string) (payroll.Cycle, error) {
	if cycleID == "" {
		return payroll.Cycle{}, errors.New("empty cycle id")
	}
	return s.store.Cycle(ctx, cycleID)
}

func (s *Service) closeCycle(ctx context.Context, cycle payroll.Cycle, at time.Time) error {
	cycle.Status = payroll.CycleClosed
	cycle.ClosedAt = at
	return s.store.SaveCycle(ctx, cycle)
}

// Cycle exposes a cycle for the read endpoints.
func (s *Service) Cycle(ctx context.Context, cycleID string) (payroll.Cycle, error) {
	return s.loadCycle(ctx, cycleID)
}

// PayslipsForCycle lists the payslips a completed cycle produced.
func (s *Service) PayslipsForCycle(ctx context.Context, cycleID string) ([]payroll.Payslip, error) {
	slips, err := s.store.ListByCycle(ctx, cycleID)
	if err != nil {
		return nil, err
	}
	sort.Slice(slips, func(i, j int) bool { return slips[i].EmployeeID < slips[j].EmployeeID })
	return slips, nil
}

// Reopen unwinds a closed cycle so it can be re-run after a correction.
func (s *Service) Reopen(ctx context.Context, cycleID string, reason string) error {
	cycle, err := s.loadCycle(ctx, cycleID)
	if err != nil {
		return err
	}
	if cycle.Status != payroll.CycleClosed {
		return nil
	}
	cycle.Status = payroll.CycleOpen
	cycle.ReopenReason = reason
	cycle.ClosedAt = time.Time{}
	return s.store.SaveCycle(ctx, cycle)
}
