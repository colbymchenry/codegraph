package httpapi

import "net/http"

// NewRouter wires the HTTP surface. The payroll cycle endpoint is the only
// entry point into the hand-written use-case layer.
func NewRouter(h *PayrollHandler) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/payroll/cycles/{cycleID}/run", h.RunCycle)
	mux.HandleFunc("GET /v1/payroll/cycles/{cycleID}", h.GetCycle)
	mux.HandleFunc("GET /v1/payroll/cycles/{cycleID}/payslips", h.ListPayslips)
	mux.HandleFunc("GET /healthz", health)
	return mux
}

func health(w http.ResponseWriter, _ *http.Request) {
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte("ok"))
}
