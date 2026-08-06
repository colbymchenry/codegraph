package httpapi

import (
	"encoding/json"
	"errors"
	"net/http"

	"github.com/example/payroll-svc/internal/usecase/payroll"
)

// PayrollHandler is the HTTP entry point into the payroll use-case layer.
type PayrollHandler struct {
	svc *payroll.Service
}

func NewPayrollHandler(svc *payroll.Service) *PayrollHandler {
	return &PayrollHandler{svc: svc}
}

type runCycleRequest struct {
	DryRun bool   `json:"dryRun"`
	Reason string `json:"reason"`
}

type runCycleResponse struct {
	CycleID    string `json:"cycleId"`
	Payslips   int    `json:"payslips"`
	GrossCents int64  `json:"grossCents"`
	NetCents   int64  `json:"netCents"`
}

// RunCycle kicks off a payroll cycle: it hands the cycle id to the use-case
// layer, which builds and persists a payslip per active employee.
func (h *PayrollHandler) RunCycle(w http.ResponseWriter, r *http.Request) {
	cycleID := r.PathValue("cycleID")
	if cycleID == "" {
		httpError(w, http.StatusBadRequest, "cycleID is required")
		return
	}

	var req runCycleRequest
	if r.ContentLength > 0 {
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			httpError(w, http.StatusBadRequest, "malformed body")
			return
		}
	}

	result, err := h.svc.RunCycle(r.Context(), cycleID, payroll.RunOptions{
		DryRun: req.DryRun,
		Reason: req.Reason,
	})
	if err != nil {
		if errors.Is(err, payroll.ErrCycleClosed) {
			httpError(w, http.StatusConflict, "cycle already closed")
			return
		}
		httpError(w, http.StatusInternalServerError, "run failed")
		return
	}

	writeJSON(w, http.StatusOK, runCycleResponse{
		CycleID:    result.CycleID,
		Payslips:   len(result.Payslips),
		GrossCents: result.TotalGrossCents,
		NetCents:   result.TotalNetCents,
	})
}

func (h *PayrollHandler) GetCycle(w http.ResponseWriter, r *http.Request) {
	cycle, err := h.svc.Cycle(r.Context(), r.PathValue("cycleID"))
	if err != nil {
		httpError(w, http.StatusNotFound, "no such cycle")
		return
	}
	writeJSON(w, http.StatusOK, cycle)
}

func (h *PayrollHandler) ListPayslips(w http.ResponseWriter, r *http.Request) {
	slips, err := h.svc.PayslipsForCycle(r.Context(), r.PathValue("cycleID"))
	if err != nil {
		httpError(w, http.StatusNotFound, "no such cycle")
		return
	}
	writeJSON(w, http.StatusOK, slips)
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func httpError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}
