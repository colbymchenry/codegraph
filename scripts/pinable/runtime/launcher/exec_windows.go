//go:build windows

package main

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"syscall"
	"unsafe"
)

// These layouts mirror JOBOBJECT_EXTENDED_LIMIT_INFORMATION in winnt.h.
// Only 64-bit targets are distributed. Assign the launcher BEFORE spawning:
// children inherit the job without the race of assigning a running child.
type basicLimits struct {
	ProcessTime     int64
	JobTime         int64
	Flags           uint32
	MinWorkingSet   uintptr
	MaxWorkingSet   uintptr
	ActiveProcesses uint32
	Affinity        uintptr
	Priority        uint32
	Scheduling      uint32
}
type ioCounters struct{ ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes uint64 }
type extendedLimits struct {
	Basic                                                      basicLimits
	IO                                                         ioCounters
	ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory uintptr
}

func processJob() (syscall.Handle, error) {
	dll := syscall.NewLazyDLL("kernel32.dll")
	h, _, e := dll.NewProc("CreateJobObjectW").Call(0, 0)
	if h == 0 {
		return 0, fmt.Errorf("CreateJobObjectW: %w", e)
	}
	job := syscall.Handle(h)
	limits := extendedLimits{Basic: basicLimits{Flags: 0x2000}} // KILL_ON_JOB_CLOSE
	ok, _, e := dll.NewProc("SetInformationJobObject").Call(h, 9, uintptr(unsafe.Pointer(&limits)), unsafe.Sizeof(limits))
	if ok == 0 {
		syscall.CloseHandle(job)
		return 0, fmt.Errorf("SetInformationJobObject: %w", e)
	}
	current, err := syscall.GetCurrentProcess()
	if err != nil {
		syscall.CloseHandle(job)
		return 0, err
	}
	ok, _, e = dll.NewProc("AssignProcessToJobObject").Call(h, uintptr(current))
	if ok == 0 {
		syscall.CloseHandle(job)
		return 0, fmt.Errorf("AssignProcessToJobObject: %w", e)
	}
	// Do not close while the launcher is alive: that would terminate this process
	// too. The non-inheritable handle closes on os.Exit or forced termination,
	// killing any remaining Node descendants. Failure above is fail-closed.
	return job, nil
}

func execute(node string, args, env []string) int {
	job, err := processJob()
	if err != nil {
		fmt.Fprintln(os.Stderr, "codegraph: process containment:", err)
		return 1
	}
	_ = job // The kernel handle remains open until process exit (no finalizer).
	cmd := exec.Command(node, args[1:]...)
	cmd.Env = env
	cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, os.Stdout, os.Stderr
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	err = cmd.Run()
	if err == nil {
		return 0
	}
	var exit *exec.ExitError
	if errors.As(err, &exit) {
		return exit.ExitCode()
	}
	fmt.Fprintln(os.Stderr, "codegraph:", err)
	return 1
}
