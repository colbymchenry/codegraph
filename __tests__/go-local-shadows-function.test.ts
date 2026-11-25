/**
 * In Go a parameter or local declared in a function shadows a package-level
 * function of the same name for the rest of its block, so a bare call to it
 * — `run("x")` after `run := func…` or with a `run func(…)` parameter — calls
 * the local func value, never the package-level `run` (#2580). The graph has
 * no node for the local, so the call gets no edge. Outside the local's scope,
 * the package-level function keeps its callers.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';

const GO_MOD = 'module example.com/app\n\ngo 1.22\n';
const RUN = 'func run(a, b int) int { return a + b }';

let tempDir: string;
let cg: CodeGraph | null = null;

async function edges(files: Record<string, string>, fromName: string): Promise<string[]> {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-2580-'));
  for (const [rel, source] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(tempDir, rel)), { recursive: true });
    fs.writeFileSync(path.join(tempDir, rel), source);
  }
  cg = await CodeGraph.init(tempDir, { index: true });
  cg.resolveReferences();
  const from = cg.getNodesByKind('function').find((n) => n.name === fromName)!;
  expect(from).toBeDefined();
  return cg
    .getOutgoingEdges(from.id)
    .filter((e) => e.kind === 'calls')
    .map((e) => [e, cg!.getNode(e.target)] as const)
    .filter(([, n]) => n?.kind === 'function')
    .map(([e, n]) => `${e.kind} ${n!.name} L${e.line}`);
}

/** `package main` with the package-level `run`, `body`, and a `main` that calls `call`. */
function mainGo(body: string, call: string): Record<string, string> {
  return { 'go.mod': GO_MOD, 'main.go': `package main\n\n${RUN}\n\n${body}\n\nfunc main() { ${call} }\n` };
}

afterEach(() => {
  cg?.close();
  cg = null;
  fs.rmSync(tempDir, { recursive: true, force: true });
});


describe('a Go local or parameter shadows a same-named package function (#2580)', () => {
  it.each([
    ['a := closure', 'func use() string {\n\trun := func(s string) string { return s }\n\treturn run("x")\n}', 'use()'],
    ['a func parameter', 'func use(run func(string) string) string {\n\treturn run("x")\n}', 'use(nil)'],
    ['a var closure', 'func use() string {\n\tvar run = func(s string) string { return s }\n\treturn run("x")\n}', 'use()'],
    ['an if-header local', 'func use() string {\n\tif run := func(s string) string { return s }; true {\n\t\treturn run("x")\n\t}\n\treturn ""\n}', 'use()'],
    ['a named result', 'func use() (run func(string) string) {\n\trun = func(s string) string { return s }\n\trun("x")\n\treturn\n}', 'use()'],
    ['a range value', 'func use(fns []func()) {\n\tfor _, run := range fns {\n\t\trun()\n\t}\n}', 'use(nil)'],
  ])('%s, in the same file', async (_label, body, call) => {
    expect((await edges(mainGo(body, call), 'use')).filter((e) => / run /.test(e))).toEqual([]);
  });

  it('shadows a package function declared in another file', async () => {
    const out = await edges(
      {
        'go.mod': GO_MOD,
        'run.go': `package main\n\n${RUN}\n`,
        'use.go': 'package main\n\nfunc use(run func(string) string) string {\n\treturn run("x")\n}\n\nfunc main() { use(nil) }\n',
      },
      'use'
    );
    expect(out).toEqual([]);
  });

  it('shadows a name a framework pattern would resolve', async () => {
    const out = await edges(
      {
        'go.mod': GO_MOD,
        'main.go': 'package main\n\nfunc errHandler(e error) {}\n\nfunc use() {\n\terrHandler := func(e error) {}\n\terrHandler(nil)\n}\n\nfunc main() { use() }\n',
      },
      'use'
    );
    expect(out).toEqual([]);
  });

  it.each([
    ['a call before the local is declared', 'func use() {\n\trun(1, 2)\n\trun := func() {}\n\trun()\n}', ['calls run L6']],
    ['a local initialised from the package function', 'func use() {\n\trun := run(1, 2)\n\t_ = run\n}', ['calls run L6']],
    ['a call after the block declaring the local', 'func use() {\n\tif true {\n\t\trun := func() {}\n\t\trun()\n\t}\n\trun(1, 2)\n}', ['calls run L10']],
    ['a sibling case clause', 'func use(x int) int {\n\tswitch x {\n\tcase 1:\n\t\trun := func(a, b int) int { return a }\n\t\treturn run(1, 2)\n\tcase 2:\n\t\treturn run(1, 2)\n\t}\n\treturn 0\n}', ['calls run L11']],
    ['a select default after a case declaring the local', 'func use(ch chan int) int {\n\tselect {\n\tcase <-ch:\n\t\trun := func(a, b int) int { return a }\n\t\treturn run(1, 2)\n\tdefault:\n\t\treturn run(1, 2)\n\t}\n}', ['calls run L11']],
    ['a pointer-to-func result naming a parameter run', 'func use() *func(run int) int {\n\t_ = run(1, 2)\n\treturn nil\n}', ['calls run L6']],
    ['a send-only channel-of-func result naming a parameter run', 'func use() chan<- func(run int) {\n\t_ = run(1, 2)\n\treturn nil\n}', ['calls run L6']],
    ['a func-type result naming a parameter run', 'func use() func(run int) int {\n\t_ = run(1, 2)\n\treturn nil\n}', ['calls run L6']],
  ])('keeps the edge for %s', async (_label, body, expected) => {
    expect(await edges(mainGo(body, 'use()'), 'use')).toEqual(expected);
  });
});
