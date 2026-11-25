package payroll

import "time"

// CycleStatus is the lifecycle state of a payroll cycle.
type CycleStatus string

const (
	CycleOpen   CycleStatus = "open"
	CycleClosed CycleStatus = "closed"
)

// ContractKind distinguishes the two pay models this service supports.
type ContractKind string

const (
	ContractSalaried ContractKind = "salaried"
	ContractHourly   ContractKind = "hourly"
)

// LineKind separates the two halves of a payslip.
type LineKind string

const (
	LineEarning   LineKind = "earning"
	LineDeduction LineKind = "deduction"
)

// Cycle is one payroll period.
type Cycle struct {
	ID           string
	Start        time.Time
	End          time.Time
	Status       CycleStatus
	ClosedAt     time.Time
	ReopenReason string
}

// Line is a single earning or deduction on a payslip.
type Line struct {
	Code        string
	Kind        LineKind
	AmountCents int64
}

// Payslip is what a cycle produces for one employee.
type Payslip struct {
	CycleID        string
	EmployeeID     string
	Currency       string
	PeriodFrom     time.Time
	PeriodTo       time.Time
	Lines          []Line
	GrossCents     int64
	DeductionCents int64
	NetCents       int64
	Underwater     bool
	RunAt          time.Time
	RunReason      string
}

// Timesheet is the approved unit count backing an hourly payslip.
type Timesheet struct {
	CycleID    string
	EmployeeID string
	Approved   bool
	Units      int
}

// Allowance is a recurring earning attached to a contract.
type Allowance struct {
	Code        string
	AmountCents int64
	Prorated    bool
}

// Contract holds the pay terms for one employee.
type Contract struct {
	Kind                   ContractKind
	Currency               string
	RateCents              int64
	PeriodRateCents        int64
	OvertimeThresholdUnits int
	OvertimeMultiplier     float64
	Allowances             []Allowance
	StartsOn               time.Time
	EndsOn                 time.Time
}

// OverlapsWindow reports whether the contract is live at any point in the window.
func (c Contract) OverlapsWindow(from, to time.Time) bool {
	if !c.StartsOn.IsZero() && c.StartsOn.After(to) {
		return false
	}
	if !c.EndsOn.IsZero() && c.EndsOn.Before(from) {
		return false
	}
	return true
}

// PeriodUnits is the contractual unit count for a window, used when a salaried
// employee has no approved timesheet.
func (c Contract) PeriodUnits(from, to time.Time) int {
	if to.Before(from) {
		return 0
	}
	days := int(to.Sub(from).Hours()/24) + 1
	return days * 8
}

// Deduction is a fixed or proportional subtraction from gross.
type Deduction struct {
	Code            string
	FixedCents      int64
	RateBasisPoints int
}

// AmountFor resolves a deduction against a gross amount.
func (d Deduction) AmountFor(grossCents int64) int64 {
	if d.FixedCents > 0 {
		return d.FixedCents
	}
	return grossCents * int64(d.RateBasisPoints) / 10000
}

// TaxBand is one slice of a progressive tax schedule.
type TaxBand struct {
	UpToCents       int64
	RateBasisPoints int
}

// Leave is an absence window.
type Leave struct {
	From   time.Time
	To     time.Time
	Unpaid bool
}

// Employee is the payroll view of a person.
type Employee struct {
	ID         string
	Contract   Contract
	Deductions []Deduction
	TaxBands   []TaxBand
	Leave      []Leave
}

// UnpaidLeaveCoversWindow reports whether unpaid leave swallows the whole window.
func (e Employee) UnpaidLeaveCoversWindow(from, to time.Time) bool {
	for _, l := range e.Leave {
		if !l.Unpaid {
			continue
		}
		if !l.From.After(from) && !l.To.Before(to) {
			return true
		}
	}
	return false
}
