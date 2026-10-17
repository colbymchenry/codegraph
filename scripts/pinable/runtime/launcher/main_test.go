package main

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestBundleRoot(t *testing.T) {
	for _, location := range []string{"root", "bin"} {
		t.Run(location, func(t *testing.T) {
			root := filepath.Join(t.TempDir(), "含 空格 runtime")
			node := "node"
			if runtime.GOOS == "windows" {
				node += ".exe"
			}
			for _, name := range []string{node, "lib/dist/bin/codegraph.js", "bin/launcher", "launcher"} {
				file := filepath.Join(root, filepath.FromSlash(name))
				if err := os.MkdirAll(filepath.Dir(file), 0755); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(file, []byte("fixture"), 0755); err != nil {
					t.Fatal(err)
				}
			}
			executable := filepath.Join(root, "launcher")
			if location == "bin" {
				executable = filepath.Join(root, "bin", "launcher")
			}
			canonical, err := filepath.EvalSymlinks(root)
			if err != nil {
				t.Fatal(err)
			}
			found, err := bundleRoot(executable)
			if err != nil || found != canonical {
				t.Fatalf("got %q, %v", found, err)
			}
			if err := os.Remove(filepath.Join(root, node)); err != nil {
				t.Fatal(err)
			}
			if _, err := bundleRoot(executable); err == nil {
				t.Fatal("accepted missing bundled Node")
			}
		})
	}
}
func TestEnv(t *testing.T) {
	env := []string{"PATH=unchanged", "CODEGRAPH_TELEMETRY=1", "CODEGRAPH_HOST_PPID=42"}
	result := childEnv(env, 99)
	joined := "\n" + strings.Join(result, "\n") + "\n"
	for _, want := range []string{"PATH=unchanged", "CODEGRAPH_TELEMETRY=1", "DO_NOT_TRACK=1", "CODEGRAPH_HOST_PPID=42"} {
		if !strings.Contains(joined, "\n"+want+"\n") {
			t.Fatalf("missing %s: %v", want, result)
		}
	}
	if len(env) != 3 {
		t.Fatal("mutated caller environment")
	}
	if len(childEnv(nil, 99)) != 3 {
		t.Fatal("defaults missing")
	}
}
