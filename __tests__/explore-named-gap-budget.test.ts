/**
 * Naming what a trim skipped (#1711) must never cost a file its source.
 *
 * Every cluster fit was measured with the gap names in, and on a long path a
 * named gap runs to several hundred chars. A class that had to be shrunk into
 * its file's room then overran the room by its gap names alone and was
 * dropped whole: vscode's `rpcProtocol.ts` came back as a 3-line stub instead
 * of ~5,200 chars of the RPCProtocol body, and the fixture below came back as
 * an empty code fence. Fits now measure bare gaps; names are added at assembly
 * from whatever the file's budget has left.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import CodeGraph from '../src/index';
import { ToolHandler, joinPartsWithNamedGaps } from '../src/mcp/tools';

describe('joinPartsWithNamedGaps spare budget', () => {
  const parts = [
    { range: { start: 1, end: 5 }, text: 'ONE' },
    { range: { start: 40, end: 45 }, text: 'TWO' },
    { range: { start: 80, end: 85 }, text: 'THREE' },
  ];
  const nodes = [
    { name: 'first', kind: 'function', startLine: 20, endLine: 25 },
    { name: 'second', kind: 'function', startLine: 60, endLine: 65 },
  ];
  const bare = 'ONE\n\n... (gap) ...\n\nTWO\n\n... (gap) ...\n\nTHREE';

  it('names every gap when the spare is unbounded', () => {
    const text = joinPartsWithNamedGaps('f.ts', parts, nodes);
    expect(text).toContain('first (f.ts:20)');
    expect(text).toContain('second (f.ts:60)');
  });

  it('leaves every gap bare with no spare', () => {
    expect(joinPartsWithNamedGaps('f.ts', parts, nodes, 0)).toBe(bare);
  });

  it('names gaps in order while the spare lasts, then goes bare', () => {
    const oneNamed = joinPartsWithNamedGaps('f.ts', parts, nodes, 'first (f.ts:20)'.length + 8);
    expect(oneNamed).toContain('first (f.ts:20)');
    expect(oneNamed).not.toContain('second (f.ts:60)');
    expect(oneNamed.length).toBeLessThanOrEqual(bare.length + 'first (f.ts:20)'.length + 8);
  });
});

describe('explore — gap names never displace a shrunk class', () => {
  const rel = 'src/workbench/services/extensions/common/protocol/implementation/rpcProtocolHost.ts';
  let dir: string;
  let cg: CodeGraph;
  let response: string;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-gap-budget-'));
    fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"gap-budget","version":"1.0.0"}\n');
    fs.mkdirSync(path.join(dir, path.dirname(rel)), { recursive: true });
    // A class too big to ship whole but under half its file (so it is not
    // dropped as an envelope), a tiny entry function far below it, and a deep
    // path so every named gap is long.
    const lines = ['export interface MessageSink { accept(payload: string): void }', ''];
    lines.push('export class RPCProtocolHost {');
    lines.push('  private readonly pending = new Map<number, string>();');
    for (let i = 0; i < 70; i++) {
      lines.push(
        `  receiveIncomingMessageNumber${i}(payload: string): string {`,
        `    const value = payload + ':${i}:' + this.pending.size;`,
        `    this.pending.set(${i}, value);`,
        "    const extra = value.split(':').map((part) => part.toUpperCase()).join('-');",
        '    return (value + extra).trim();',
        '  }',
        '',
      );
    }
    lines.push('}', '');
    for (let i = 0; i < 160; i++) {
      lines.push(`export function unrelatedHelperNumber${i}(n: number): number {`, `  return n * ${i} + 1;`, '}', '');
    }
    lines.push(
      'export function dispatchRequestNow(host: RPCProtocolHost): string {',
      "  return host.receiveIncomingMessageNumber3('x');",
      '}',
      '',
    );
    fs.writeFileSync(path.join(dir, rel), lines.join('\n'));
    for (let i = 1; i <= 12; i++) {
      fs.writeFileSync(path.join(dir, 'src', `noise${i}.ts`), `export const n${i} = ${i};\n`);
    }

    cg = CodeGraph.initSync(dir);
    await cg.indexAll();
    const result = await new ToolHandler(cg).execute('codegraph_explore', {
      query:
        'RPCProtocolHost receiveIncomingMessageNumber3 receiveIncomingMessageNumber40 receiveIncomingMessageNumber66 dispatchRequestNow',
    });
    response = result.content?.[0]?.text ?? '';
  }, 120_000);

  afterAll(() => {
    cg?.destroy();
    if (dir && fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('renders the named methods inside the class', () => {
    expect(response, response.slice(0, 3000)).toContain('receiveIncomingMessageNumber3(payload: string): string {');
    expect(response).toContain('receiveIncomingMessageNumber40(payload: string): string {');
    expect(response).toContain('export function dispatchRequestNow(host: RPCProtocolHost)');
  });

  it('never emits an empty source fence for the file', () => {
    expect(response).not.toMatch(/```typescript\n```/);
  });

  it('still names a gap when the budget has room for it', () => {
    expect(response).toMatch(/\.\.\. \(gap: \w+ \([^\s)]+:\d+\)/);
  });
});
