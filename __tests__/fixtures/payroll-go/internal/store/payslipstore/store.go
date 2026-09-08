package payslipstore

import (
	"context"
	"fmt"
	"sync"

	"github.com/example/payroll-svc/internal/domain/payroll"
)

// Store is the hand-written persistence seam the use-case layer writes through.
// It is deliberately narrow: the generated fkit store can address every table,
// this one only exposes the operations a payroll cycle needs.
type Store struct {
	mu        sync.RWMutex
	payslips  map[string]payroll.Payslip
	cycles    map[string]payroll.Cycle
	employees map[string][]payroll.Employee
	sheets    map[string]payroll.Timesheet
}

func New() *Store {
	return &Store{
		payslips:  map[string]payroll.Payslip{},
		cycles:    map[string]payroll.Cycle{},
		employees: map[string][]payroll.Employee{},
		sheets:    map[string]payroll.Timesheet{},
	}
}

func key(cycleID, employeeID string) string { return cycleID + "/" + employeeID }

// Upsert writes a payslip, replacing any prior slip for the same
// (cycle, employee). A re-run of a cycle must not duplicate rows, so this is
// an upsert rather than an insert.
func (s *Store) Upsert(ctx context.Context, slip payroll.Payslip) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if slip.CycleID == "" || slip.EmployeeID == "" {
		return fmt.Errorf("payslip missing cycle or employee id")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.payslips[key(slip.CycleID, slip.EmployeeID)] = slip
	return nil
}

// ListByCycle returns every payslip a cycle produced.
func (s *Store) ListByCycle(ctx context.Context, cycleID string) ([]payroll.Payslip, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]payroll.Payslip, 0, len(s.payslips))
	for _, slip := range s.payslips {
		if slip.CycleID == cycleID {
			out = append(out, slip)
		}
	}
	return out, nil
}

func (s *Store) Cycle(ctx context.Context, cycleID string) (payroll.Cycle, error) {
	if err := ctx.Err(); err != nil {
		return payroll.Cycle{}, err
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	cycle, ok := s.cycles[cycleID]
	if !ok {
		return payroll.Cycle{}, fmt.Errorf("cycle %s not found", cycleID)
	}
	return cycle, nil
}

func (s *Store) SaveCycle(ctx context.Context, cycle payroll.Cycle) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.cycles[cycle.ID] = cycle
	return nil
}

func (s *Store) EmployeesForCycle(ctx context.Context, cycleID string) ([]payroll.Employee, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.employees[cycleID], nil
}

func (s *Store) Timesheet(ctx context.Context, cycleID, employeeID string) (payroll.Timesheet, error) {
	if err := ctx.Err(); err != nil {
		return payroll.Timesheet{}, err
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	ts, ok := s.sheets[key(cycleID, employeeID)]
	if !ok {
		return payroll.Timesheet{}, fmt.Errorf("no timesheet for %s in %s", employeeID, cycleID)
	}
	return ts, nil
}

// Seed loads fixture data; the real service reads from Postgres.
func (s *Store) Seed(cycle payroll.Cycle, employees []payroll.Employee, sheets []payroll.Timesheet) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.cycles[cycle.ID] = cycle
	s.employees[cycle.ID] = employees
	for _, ts := range sheets {
		s.sheets[key(ts.CycleID, ts.EmployeeID)] = ts
	}
}
