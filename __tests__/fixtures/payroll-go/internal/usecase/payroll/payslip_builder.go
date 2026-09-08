package payroll

import (
	"context"
	"fmt"

	"github.com/example/payroll-svc/internal/domain/payroll"
)

// BuildPayslip turns one employee's contract and timesheet into a complete
// payslip for the cycle: base pay, overtime, allowances, then deductions and
// tax, in that order. Every amount is in integer cents; nothing here rounds
// until the final net, so a cent never disappears between two lines.
//
// This is the calculation the generated CRUD layer does NOT do — fkit's
// BuildPayslip only copies fields between a DTO and a row.
func (s *Service) BuildPayslip(
	ctx context.Context,
	cycle payroll.Cycle,
	employee payroll.Employee,
	timesheet payroll.Timesheet,
) (payroll.Payslip, error) {
	if err := ctx.Err(); err != nil {
		return payroll.Payslip{}, err
	}
	if timesheet.EmployeeID != "" && timesheet.EmployeeID != employee.ID {
		return payroll.Payslip{}, fmt.Errorf("timesheet/employee mismatch: %s vs %s", timesheet.EmployeeID, employee.ID)
	}

	slip := payroll.Payslip{
		CycleID:    cycle.ID,
		EmployeeID: employee.ID,
		Currency:   employee.Contract.Currency,
		PeriodFrom: cycle.Start,
		PeriodTo:   cycle.End,
	}

	base := s.basePayCents(employee, cycle, timesheet)
	slip.Lines = append(slip.Lines, payroll.Line{
		Code: "BASE", Kind: payroll.LineEarning, AmountCents: base,
	})

	if overtime := s.overtimeCents(employee, timesheet); overtime > 0 {
		slip.Lines = append(slip.Lines, payroll.Line{
			Code: "OT", Kind: payroll.LineEarning, AmountCents: overtime,
		})
	}

	for _, allowance := range employee.Contract.Allowances {
		amount := prorateAllowance(allowance, cycle, employee)
		if amount == 0 {
			continue
		}
		slip.Lines = append(slip.Lines, payroll.Line{
			Code: allowance.Code, Kind: payroll.LineEarning, AmountCents: amount,
		})
	}

	slip.GrossCents = sumKind(slip.Lines, payroll.LineEarning)

	for _, d := range employee.Deductions {
		amount := d.AmountFor(slip.GrossCents)
		if amount == 0 {
			continue
		}
		slip.Lines = append(slip.Lines, payroll.Line{
			Code: d.Code, Kind: payroll.LineDeduction, AmountCents: amount,
		})
	}

	tax, err := s.taxCents(employee, slip.GrossCents)
	if err != nil {
		return payroll.Payslip{}, fmt.Errorf("tax for %s: %w", employee.ID, err)
	}
	slip.Lines = append(slip.Lines, payroll.Line{
		Code: "TAX", Kind: payroll.LineDeduction, AmountCents: tax,
	})

	slip.DeductionCents = sumKind(slip.Lines, payroll.LineDeduction)
	slip.NetCents = slip.GrossCents - slip.DeductionCents
	if slip.NetCents < 0 {
		slip.NetCents = 0
		slip.Underwater = true
	}

	return slip, nil
}

// basePayCents is the contractual pay for the period: salaried staff get the
// period rate prorated across their contract window, hourly staff get rate ×
// approved units.
func (s *Service) basePayCents(e payroll.Employee, cycle payroll.Cycle, ts payroll.Timesheet) int64 {
	switch e.Contract.Kind {
	case payroll.ContractSalaried:
		full := e.Contract.PeriodRateCents
		return prorateSalary(full, e.Contract, cycle)
	case payroll.ContractHourly:
		return e.Contract.RateCents * int64(ts.Units)
	default:
		return 0
	}
}

// overtimeCents pays approved units above the contractual threshold at the
// contract's overtime multiplier.
func (s *Service) overtimeCents(e payroll.Employee, ts payroll.Timesheet) int64 {
	if e.Contract.Kind != payroll.ContractHourly {
		return 0
	}
	threshold := e.Contract.OvertimeThresholdUnits
	if threshold <= 0 || ts.Units <= threshold {
		return 0
	}
	extra := int64(ts.Units - threshold)
	return int64(float64(e.Contract.RateCents) * e.Contract.OvertimeMultiplier * float64(extra))
}

// taxCents applies the employee's tax band schedule to the gross.
func (s *Service) taxCents(e payroll.Employee, gross int64) (int64, error) {
	if len(e.TaxBands) == 0 {
		return 0, nil
	}
	var tax int64
	remaining := gross
	for _, band := range e.TaxBands {
		if remaining <= 0 {
			break
		}
		if band.RateBasisPoints < 0 || band.RateBasisPoints > 10000 {
			return 0, fmt.Errorf("invalid band rate %d", band.RateBasisPoints)
		}
		slice := remaining
		if band.UpToCents > 0 && slice > band.UpToCents {
			slice = band.UpToCents
		}
		tax += slice * int64(band.RateBasisPoints) / 10000
		remaining -= slice
	}
	return tax, nil
}

func sumKind(lines []payroll.Line, kind payroll.LineKind) int64 {
	var total int64
	for _, l := range lines {
		if l.Kind == kind {
			total += l.AmountCents
		}
	}
	return total
}
