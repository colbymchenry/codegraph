/**
 * Dynamic-boundary surfacing (#687).
 *
 * When the flow an agent asked codegraph_explore about does NOT fully connect,
 * the Flow section announces WHERE the static path ends — the dynamic-dispatch
 * site (computed member call, getattr, typed bus, runtime-keyed emit), with
 * candidate targets when a key is statically visible — instead of silently
 * showing nothing. Deterministic, query-time only, no graph mutation, and a
 * fully connected flow must never produce the section.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import CodeGraph from '../src/index';
import { ToolHandler } from '../src/mcp/tools';
import { scanDynamicDispatch } from '../src/mcp/dynamic-boundaries';

// ---------------------------------------------------------------------------
// Unit: the scanner
// ---------------------------------------------------------------------------

describe('scanDynamicDispatch', () => {
  it('detects a computed member call with a literal key', () => {
    const body = `function go(p) {\n  table['save'](p);\n}`;
    const m = scanDynamicDispatch(body, 'typescript', 10);
    expect(m).toHaveLength(1);
    expect(m[0]!.form).toBe('computed-call');
    expect(m[0]!.key).toBe('save');
    expect(m[0]!.line).toBe(11); // absolute: body starts at file line 10
    expect(m[0]!.snippet).toContain("table['save'](p)");
  });

  it('detects a computed member call with a runtime key (no key extracted)', () => {
    const body = `dispatch(action) {\n  this.handlers[action.type](action.payload);\n}`;
    const m = scanDynamicDispatch(body, 'typescript', 1);
    expect(m).toHaveLength(1);
    expect(m[0]!.form).toBe('computed-call');
    expect(m[0]!.key).toBeUndefined();
  });

  it('does not fire on dispatch shapes inside comments or strings', () => {
    const body = [
      'function safe() {',
      "  // this.handlers[action.type](payload) — commented out",
      '  const doc = "call handlers[key](p) to dispatch";',
      '  return 1;',
      '}',
    ].join('\n');
    expect(scanDynamicDispatch(body, 'typescript', 1)).toHaveLength(0);
  });

  it('does not treat plain indexing or array literals as dispatch', () => {
    const body = `function f(xs) {\n  const a = xs[0];\n  const b = [1, 2, 3];\n  return a + b[1];\n}`;
    expect(scanDynamicDispatch(body, 'typescript', 1)).toHaveLength(0);
  });

  it('detects python getattr immediate-call', () => {
    const body = `def run(self, name):\n    return getattr(self, name)(1)`;
    const m = scanDynamicDispatch(body, 'python', 5);
    expect(m).toHaveLength(1);
    expect(m[0]!.form).toBe('getattr-call');
  });

  it('detects two-step getattr only when the assigned name is called later', () => {
    const called = `def process(self, kind, p):\n    handler = getattr(self, 'handle_' + kind)\n    return handler(p)`;
    const m = scanDynamicDispatch(called, 'python', 1);
    expect(m).toHaveLength(1);
    expect(m[0]!.form).toBe('getattr-assign');
    expect(m[0]!.key).toBe('handle_'); // the literal prefix — enough to shortlist

    const notCalled = `def peek(self, kind):\n    handler = getattr(self, 'handle_' + kind)\n    return handler`;
    expect(scanDynamicDispatch(notCalled, 'python', 1)).toHaveLength(0);
  });

  it('detects ruby send with a symbol key', () => {
    const body = `def run(name)\n  target.send(:handle_save, 1)\nend`;
    const m = scanDynamicDispatch(body, 'ruby', 1);
    expect(m).toHaveLength(1);
    expect(m[0]!.form).toBe('ruby-send');
    expect(m[0]!.key).toBe('handle_save');
  });

  it('detects typed message dispatch and marks the key as a type', () => {
    const body = `public async Task<int> Create(CreateCmd c) {\n  return await _mediator.Send(new CreateTodoItemCommand(c));\n}`;
    const m = scanDynamicDispatch(body, 'csharp', 1);
    expect(m).toHaveLength(1);
    expect(m[0]!.form).toBe('typed-bus');
    expect(m[0]!.key).toBe('CreateTodoItemCommand');
    expect(m[0]!.keyIsType).toBe(true);
  });

  it('detects runtime-keyed emit but not literal-keyed emit', () => {
    const runtime = `notify(name, data) {\n  this.emitter.emit(name, data);\n}`;
    const m = scanDynamicDispatch(runtime, 'typescript', 1);
    expect(m).toHaveLength(1);
    expect(m[0]!.form).toBe('var-key-dispatch');

    // Literal keys are the edge synthesizer's territory — not a boundary.
    const literal = `notify(data) {\n  this.emitter.emit('saved', data);\n}`;
    expect(scanDynamicDispatch(literal, 'typescript', 1)).toHaveLength(0);
  });

  it('dedupes repeated same-form/same-key sites and counts the extras', () => {
    const body = [
      'route(a) {',
      '  this.table[a.type](a.p);',
      '  this.table[a.kind](a.p);',
      '  this.table[a.name](a.p);',
      '}',
    ].join('\n');
    const m = scanDynamicDispatch(body, 'typescript', 1);
    expect(m).toHaveLength(1);
    expect(m[0]!.moreSites).toBe(2);
  });

  it('detects reflective dispatch with a literal method name as key', () => {
    const body = `public void run(Object o) {\n  o.getClass().getMethod("handlePing").invoke(o);\n}`;
    const m = scanDynamicDispatch(body, 'java', 1);
    expect(m.length).toBeGreaterThanOrEqual(1);
    expect(m[0]!.form).toBe('reflection');
    expect(m[0]!.key).toBe('handlePing');
  });
});

// ---------------------------------------------------------------------------
// Integration: codegraph_explore output
// ---------------------------------------------------------------------------

describe('codegraph_explore — dynamic boundaries', () => {
  let testDir: string;
  let cg: CodeGraph;
  let handler: ToolHandler;

  const setup = async (files: Record<string, string>, include: string[]) => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-boundary-'));
    const src = path.join(testDir, 'src');
    fs.mkdirSync(src, { recursive: true });
    for (const [name, content] of Object.entries(files)) {
      fs.writeFileSync(path.join(src, name), content);
    }
    cg = CodeGraph.initSync(testDir, { config: { include, exclude: [] } });
    await cg.indexAll();
    handler = new ToolHandler(cg);
  };

  afterEach(() => {
    if (cg) cg.destroy();
    if (testDir && fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('announces the boundary site and shortlists the keyed candidate', async () => {
    await setup({
      'router.ts': [
        'type Handler = (p: unknown) => void;',
        'export class Router {',
        '  private table: Record<string, Handler> = {};',
        '  add(key: string, fn: Handler) { this.table[key] = fn; }',
        '  routeSave(payload: unknown) {',
        "    this.table['save'](payload);",
        '  }',
        '}',
      ].join('\n'),
      'handlers.ts': [
        "import { Router } from './router';",
        'export function onSave(payload: unknown) { return payload; }',
        'export function wire(r: Router) { r.add("save", onSave); }',
      ].join('\n'),
    }, ['**/*.ts']);

    const res = await handler.execute('codegraph_explore', { query: 'routeSave onSave' });
    const text = res.content[0].text as string;

    expect(text).toContain('## Dynamic boundaries');
    expect(text).toContain('computed member call');
    expect(text).toMatch(/router\.ts:6/); // the exact dispatch site
    expect(text).toContain('candidates for key `save`');
    expect(text).toContain('onSave');
    expect(text).toContain('← you named this');
    // Honesty constraint: never steer the agent to Read.
    expect(text).not.toMatch(/\buse Read\b/i);
  });

  it('announces a runtime-keyed boundary with no candidate list', async () => {
    await setup({
      'bus.ts': [
        'type Action = { type: string; payload?: unknown };',
        'type Handler = (p: unknown) => void;',
        'export class Bus {',
        '  private table: Record<string, Handler> = {};',
        '  route(action: Action) {',
        '    this.table[action.type](action.payload);',
        '  }',
        '}',
      ].join('\n'),
      'handlers.ts': 'export function onSave(payload: unknown) { return payload; }',
    }, ['**/*.ts']);

    const res = await handler.execute('codegraph_explore', { query: 'route onSave' });
    const text = res.content[0].text as string;

    expect(text).toContain('## Dynamic boundaries');
    expect(text).toContain('computed member call');
    expect(text).not.toContain('candidates for key'); // runtime key → no shortlist to claim
  });

  it('surfaces the boundary even when the other symbol is not in the graph', async () => {
    await setup({
      'bus.ts': [
        'type Action = { type: string; payload?: unknown };',
        'type Handler = (p: unknown) => void;',
        'export class Bus {',
        '  private table: Record<string, Handler> = {};',
        '  route(action: Action) {',
        '    this.table[action.type](action.payload);',
        '  }',
        '}',
      ].join('\n'),
    }, ['**/*.ts']);

    // `processPayment` does not exist anywhere — only `route` resolves.
    const res = await handler.execute('codegraph_explore', { query: 'route processPayment' });
    const text = res.content[0].text as string;
    expect(text).toContain('## Dynamic boundaries');
  });

  it('renders a direct synthesized emit→handler hop as a dynamic-dispatch link (#687 criterion 1)', async () => {
    // Custom EventBus with a LITERAL key: the event-emitter synthesizer
    // bridges emit→handler, but the 2-node chain was invisible — too short
    // for the Flow section and skipped by the links section as "in-chain".
    await setup({
      'bus.ts': [
        'type Handler = (p: unknown) => void;',
        'export class EventBus {',
        '  private listeners: Record<string, Handler[]> = {};',
        '  on(event: string, fn: Handler) { (this.listeners[event] ??= []).push(fn); }',
        '  emit(event: string, payload: unknown) { for (const fn of this.listeners[event] ?? []) fn(payload); }',
        '}',
        'export const bus = new EventBus();',
      ].join('\n'),
      'billing.ts': [
        "import { bus } from './bus';",
        'export function settleInvoice(payload: unknown) { return payload; }',
        "bus.on('invoice.settled', settleInvoice);",
      ].join('\n'),
      'checkout.ts': [
        "import { bus } from './bus';",
        'export function completeCheckout(order: unknown) {',
        "  bus.emit('invoice.settled', order);",
        '}',
      ].join('\n'),
    }, ['**/*.ts']);

    const res = await handler.execute('codegraph_explore', { query: 'completeCheckout settleInvoice' });
    const text = res.content[0].text as string;

    expect(text).toContain('## Dynamic-dispatch links among your symbols');
    expect(text).toMatch(/completeCheckout → settleInvoice/);
    expect(text).toContain('invoice.settled');
    // Connected via the synthesized edge — no boundary to announce.
    expect(text).not.toContain('## Dynamic boundaries');
  });

  it('never adds the section to a fully connected flow', async () => {
    await setup({
      'pipeline.ts': [
        'export function stepOne() { return stepTwo(); }',
        'export function stepTwo() { return stepThree(); }',
        'export function stepThree() { return 3; }',
      ].join('\n'),
    }, ['**/*.ts']);

    const res = await handler.execute('codegraph_explore', { query: 'stepOne stepThree' });
    const text = res.content[0].text as string;
    expect(text).toContain('## Flow');
    expect(text).not.toContain('## Dynamic boundaries');
  });

  it('python getattr dispatch surfaces with a prefix-key candidate', async () => {
    await setup({
      'service.py': [
        'class Service:',
        '    def handle_save(self, payload):',
        '        return payload',
        '',
        '    def process(self, kind, payload):',
        "        handler = getattr(self, 'handle_' + kind)",
        '        return handler(payload)',
      ].join('\n'),
    }, ['**/*.py']);

    const res = await handler.execute('codegraph_explore', { query: 'process handle_save' });
    const text = res.content[0].text as string;

    expect(text).toContain('## Dynamic boundaries');
    expect(text).toContain('getattr');
    expect(text).toContain('handle_save');
  });
});
