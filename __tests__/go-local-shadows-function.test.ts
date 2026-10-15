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

let tempDir: string;
let cg: CodeGraph | null = null;

async function callees(files: Record<string, string>, fromName: string): Promise<string[]> {
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
    .map((e) => cg!.getNode(e.target))
    .filter((n): n is NonNullable<typeof n> => !!n)
    .map((n) => `${n.kind}:${n.name}`);
}

afterEach(() => {
  cg?.close();
  cg = null;
  fs.rmSync(tempDir, { recursive: true, force: true });
});

const GO_MOD = 'module example.com/app\n\ngo 1.22\n';
const RUN = 'func run(a, b int) int { return a + b }';

describe('a Go local or parameter shadows a same-named package function (#2580)', () => {
  it.each([
    ['a := closure', 'func use() string {\n\trun := func(s string) string { return s }\n\treturn run("x")\n}'],
    ['a func parameter', 'func use(run func(string) string) string {\n\treturn run("x")\n}'],
    ['a var closure', 'func use() string {\n\tvar run = func(s string) string { return s }\n\treturn run("x")\n}'],
    ['an if-header local', 'func use() string {\n\tif run := func(s string) string { return s }; true {\n\t\treturn run("x")\n\t}\n\treturn ""\n}'],
  ])('%s, in the same file', async (_label, use) => {
    const out = await callees({ 'go.mod': GO_MOD, 'main.go': `package main\n\n${RUN}\n\n${use}\n\nfunc main() { use(nil) }\n`.replace('use(nil)', use.includes('use(run') ? 'use(nil)' : 'use()') }, 'use');
    expect(out).toEqual([]);
  });

  it('shadows a package function declared in another file', async () => {
    const out = await callees(
      {
        'go.mod': GO_MOD,
        'run.go': `package main\n\n${RUN}\n`,
        'use.go': 'package main\n\nfunc use(run func(string) string) string {\n\treturn run("x")\n}\n\nfunc main() { use(nil) }\n',
      },
      'use'
    );
    expect(out).toEqual([]);
  });

  it('keeps the edge where the local is not in scope', async () => {
    const out = await callees(
      {
        'go.mod': GO_MOD,
        'main.go': [
          'package main',
          '',
          RUN,
          '',
          'func use() int {',
          '\tn := run(1, 2)',
          '\tif true {',
          '\t\trun := func(s string) string { return s }',
          '\t\t_ = run("x")',
          '\t}',
          '\treturn n',
          '}',
          '',
          'func main() { use() }',
          '',
        ].join('\n'),
      },
      'use'
    );
    expect(out).toEqual(['function:run']);
  });
});
