/**
 * A Go package can define one name once per build target: `sep` in
 * `sep_unix.go` (`//go:build unix`) and `sep_other.go` (`//go:build !unix`).
 * Name matching took whichever came first, so a Linux caller reached the
 * `!unix` definition (#2581). A reference now reaches the definition that
 * builds for the most typical target its own file builds for: Linux on
 * amd64, then a Mac, then Windows and the rest. The constraint is read from
 * the `//go:build` line, the legacy `// +build` lines and the file name's
 * `_GOOS` / `_GOARCH` suffix.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';

const GO_MOD = 'module example.com/app\n\ngo 1.22\n';

let tempDir: string;
let cg: CodeGraph | null = null;

afterEach(() => {
  cg?.close();
  cg = null;
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
});

async function index(files: Record<string, string>): Promise<CodeGraph> {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-2581-build-'));
  for (const [rel, source] of Object.entries({ 'go.mod': GO_MOD, ...files })) {
    fs.mkdirSync(path.dirname(path.join(tempDir, rel)), { recursive: true });
    fs.writeFileSync(path.join(tempDir, rel), source);
  }
  cg = await CodeGraph.init(tempDir, { index: true });
  cg.resolveReferences();
  return cg;
}

/** `<target> <target file>` of every call out of the function `fromName`, sorted. */
function callsFrom(graph: CodeGraph, fromName: string): string[] {
  const from = graph.getNodesByKind('function').find((n) => n.name === fromName);
  expect(from, fromName).toBeDefined();
  return graph
    .getOutgoingEdges(from!.id)
    .filter((e) => e.kind === 'calls')
    .map((e) => {
      const target = graph.getNode(e.target);
      return `${target?.qualifiedName} ${target?.filePath}`;
    })
    .sort();
}

describe('Go definitions under complementary build constraints (#2581)', () => {
  it("calls the issue's `unix` definition, not the `!unix` one", async () => {
    const graph = await index({
      'main.go': 'package main\n\nfunc main() { println(sep()) }\n',
      'sep_unix.go': '//go:build unix\n\npackage main\n\nfunc sep() string { return "/" }\n',
      'sep_other.go': '//go:build !unix\n\npackage main\n\nfunc sep() string { return "\\\\" }\n',
    });
    expect(callsFrom(graph, 'main')).toEqual(['sep sep_unix.go']);
  });

  it('reads legacy `// +build` lines and `_GOOS` / `_GOARCH` file names', async () => {
    const graph = await index({
      'main.go': 'package main\n\nfunc main() { println(page(), dir(), cpu()) }\n',
      // No system in these names: only the `+build` lines tell them apart.
      'page_small.go': '// +build plan9\n\npackage main\n\nfunc page() int { return 1 }\n',
      'page_std.go': '// +build !plan9\n\npackage main\n\nfunc page() int { return 4096 }\n',
      'dir_darwin.go': 'package main\n\nfunc dir() string { return "/Users" }\n',
      'dir_linux.go': 'package main\n\nfunc dir() string { return "/home" }\n',
      'cpu_386.go': 'package main\n\nfunc cpu() int { return 32 }\n',
      'cpu_amd64.go': 'package main\n\nfunc cpu() int { return 64 }\n',
    });
    expect(callsFrom(graph, 'main')).toEqual(['cpu cpu_amd64.go', 'dir dir_linux.go', 'page page_std.go']);
  });

  it('follows the build target of the calling file, and falls back to a Mac', async () => {
    const graph = await index({
      'main.go': 'package main\n\nfunc main() { open(); notify() }\n',
      'run_windows.go': 'package main\n\nfunc run() { open() }\n',
      'open_other.go': '//go:build !windows\n\npackage main\n\nfunc open() {}\n',
      'open_windows.go': 'package main\n\nfunc open() {}\n',
      'notify_aix.go': 'package main\n\nfunc notify() {}\n',
      'notify_darwin.go': 'package main\n\nfunc notify() {}\n',
    });
    expect(callsFrom(graph, 'main')).toEqual(['notify notify_darwin.go', 'open open_other.go']);
    expect(callsFrom(graph, 'run')).toEqual(['open open_windows.go']);
  });

  it("applies to a method and to a call through another package's import", async () => {
    const graph = await index({
      'main.go': `package main

import "example.com/app/osutil"

func main() {
	var f file
	_ = f.close()
	_ = osutil.Sep()
}
`,
      'file.go': 'package main\n\ntype file struct{}\n',
      'file_other.go': '//go:build !unix\n\npackage main\n\nfunc (f *file) close() error { return nil }\n',
      'file_unix.go': '//go:build unix\n\npackage main\n\nfunc (f *file) close() error { return nil }\n',
      'osutil/sep_other.go': '//go:build !unix\n\npackage osutil\n\nfunc Sep() string { return "\\\\" }\n',
      'osutil/sep_unix.go': '//go:build unix\n\npackage osutil\n\nfunc Sep() string { return "/" }\n',
    });
    expect(callsFrom(graph, 'main')).toEqual(['Sep osutil/sep_unix.go', 'file::close file_unix.go']);
  });
});
