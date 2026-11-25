/**
 * In Go a receiver-less call — `relogin(ctx)` — can never reach a method:
 * a method is only callable through a value (`l.relogin(ctx)`) or a method
 * expression (`(*Loop).relogin`), never by its bare name. So a bare call to a
 * function parameter or a local func value must not be bound to a same-named
 * method, whether it sits in the same package or — capitalised — in a package
 * the file does not import (#1857). Real method calls, including the
 * `pkg.Factory().Method()` chain the extractor emits under the bare method
 * name, keep their edges.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';

let tempDir: string;
let cg: CodeGraph | null = null;

async function callees(files: Record<string, string>, fromName: string): Promise<string[]> {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-1857-'));
  for (const [rel, source] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(tempDir, rel)), { recursive: true });
    fs.writeFileSync(path.join(tempDir, rel), source);
  }
  cg = await CodeGraph.init(tempDir, { index: true });
  cg.resolveReferences();
  const from = [...cg.getNodesByKind('function'), ...cg.getNodesByKind('method')].find((n) => n.name === fromName)!;
  expect(from).toBeDefined();
  return cg
    .getOutgoingEdges(from.id)
    .filter((e) => e.kind === 'calls')
    .map((e) => cg!.getNode(e.target))
    .filter((n): n is NonNullable<typeof n> => !!n)
    .map((n) => `${n.kind}:${n.name}@${n.filePath}`);
}

afterEach(() => {
  cg?.close();
  cg = null;
  fs.rmSync(tempDir, { recursive: true, force: true });
});

const GO_MOD = 'module example.com/app\n\ngo 1.22\n';

describe('a receiver-less Go call never binds to a method (#1857)', () => {
  it('does not bind a call to a func parameter onto a same-package method', async () => {
    const out = await callees(
      {
        'go.mod': GO_MOD,
        'loop/loop.go': [
          'package loop',
          '',
          'type Loop struct{}',
          '',
          'func (l *Loop) relogin() error { return nil }',
          '',
        ].join('\n'),
        'loop/sched.go': [
          'package loop',
          '',
          'func runScheduler(relogin func() error) error {',
          '\tdefer relogin()',
          '\tgo relogin()',
          '\treturn relogin()',
          '}',
          '',
        ].join('\n'),
      },
      'runScheduler'
    );
    expect(out.filter((c) => c.startsWith('method:'))).toEqual([]);
  });

  it('does not bind a capitalised bare call onto an exported method of an unimported package', async () => {
    const out = await callees(
      {
        'go.mod': GO_MOD,
        'impulse/loop.go': [
          'package impulse',
          '',
          'type Loop struct{}',
          '',
          'func (l *Loop) Relogin() error { return nil }',
          '',
        ].join('\n'),
        'synapse/sched.go': [
          'package synapse',
          '',
          'func RunScheduler(Relogin func() error) error {',
          '\tif err := Relogin(); err != nil {',
          '\t\treturn err',
          '\t}',
          '\treturn nil',
          '}',
          '',
        ].join('\n'),
      },
      'RunScheduler'
    );
    expect(out.filter((c) => c.startsWith('method:'))).toEqual([]);
  });

  it('keeps a bare call onto a same-package function', async () => {
    const out = await callees(
      {
        'go.mod': GO_MOD,
        'loop/loop.go': [
          'package loop',
          '',
          'type Loop struct{}',
          '',
          'func (l *Loop) flush() {}',
          '',
          'func flush() {}',
          '',
          'func run() {',
          '\tflush()',
          '}',
          '',
        ].join('\n'),
      },
      'run'
    );
    expect(out).toContain('function:flush@loop/loop.go');
    expect(out.filter((c) => c.startsWith('method:'))).toEqual([]);
  });

  it('keeps a real method call through a receiver', async () => {
    const out = await callees(
      {
        'go.mod': GO_MOD,
        'loop/loop.go': [
          'package loop',
          '',
          'type Loop struct{}',
          '',
          'func (l *Loop) relogin() error { return nil }',
          '',
          'func (l *Loop) run() error {',
          '\treturn l.relogin()',
          '}',
          '',
        ].join('\n'),
      },
      'run'
    );
    expect(out).toContain('method:relogin@loop/loop.go');
  });

  it('keeps a package-qualified factory chain onto the method', async () => {
    const out = await callees(
      {
        'go.mod': GO_MOD,
        'service/table.go': [
          'package service',
          '',
          'type Table struct{}',
          '',
          'func (t *Table) Reload() error { return nil }',
          '',
          'func SysTable() *Table { return &Table{} }',
          '',
        ].join('\n'),
        'controller/ctl.go': [
          'package controller',
          '',
          'import "example.com/app/service"',
          '',
          'func Handle() error {',
          '\treturn service.SysTable().Reload()',
          '}',
          '',
        ].join('\n'),
      },
      'Handle'
    );
    expect(out).toContain('method:Reload@service/table.go');
  });
});
