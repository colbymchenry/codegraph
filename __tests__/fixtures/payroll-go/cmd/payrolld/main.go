package main

import (
	"log"
	"net/http"
	"os"
	"time"

	"github.com/example/payroll-svc/internal/platform/clock"
	"github.com/example/payroll-svc/internal/store/payslipstore"
	"github.com/example/payroll-svc/internal/transport/httpapi"
	"github.com/example/payroll-svc/internal/usecase/payroll"
)

func main() {
	addr := os.Getenv("LISTEN_ADDR")
	if addr == "" {
		addr = ":8080"
	}

	store := payslipstore.New()
	svc := payroll.NewService(store, clock.System{})
	router := httpapi.NewRouter(httpapi.NewPayrollHandler(svc))

	srv := &http.Server{
		Addr:              addr,
		Handler:           router,
		ReadHeaderTimeout: 5 * time.Second,
	}

	log.Printf("payrolld listening on %s", addr)
	if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatalf("payrolld: %v", err)
	}
}
