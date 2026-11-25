/**
 * A Delphi method's declaration and implementation are one symbol (#3453).
 * Its stored range must cover the body so node/explore can return the code,
 * while calls still belong to that same method. Keep the implementation far
 * below the class so a whole-file excerpt cannot conceal a declaration range.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CodeGraph } from '../src';
import { ToolHandler } from '../src/mcp/tools';
import { WASM_RUNTIME_FLAGS } from '../src/extraction/wasm-runtime-flags';

const BIN = path.resolve(__dirname, '../dist/bin/codegraph.js');
const QUERY = 'TWorker.AfterDisconnect TWorker.Stop TWorker.Reset';
const SOURCE = [
  'unit Demo;',
  '',
  'interface',
  '',
  'type',
  '  TWorker = class',
  '  public',
  '    procedure Stop;',
  '    procedure Reset;',
  '    procedure AfterDisconnect;',
  '  end;',
  '',
  'implementation',
  '',
  ...Array.from({ length: 400 }, () => '// Padding keeps the implementation outside a declaration-centered source excerpt.'),
  '',
  'procedure TWorker.Stop;',
  'begin',
  "  WriteLn('Stop');",
  'end;',
  '',
  'procedure TWorker.Reset;',
  'begin',
  "  WriteLn('Reset');",
  'end;',
  '',
  'procedure TWorker.AfterDisconnect;',
  'begin',
  '  Stop;',
  '  Reset;',
  "  WriteLn('AfterDisconnect');",
  'end;',
  '',
  'end.',
  '',
].join('\n');

describe('Pascal implementation source across retrieval tools (#3453)', () => {
  let dir: string;
  let cg: CodeGraph;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-pascal-implementation-'));
    fs.writeFileSync(path.join(dir, 'Demo.pas'), SOURCE);
    cg = CodeGraph.initSync(dir);
    await cg.indexAll();
  }, 60_000);

  afterAll(() => {
    cg?.destroy();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  function method(name: string) {
    const matches = cg.getNodesByName(name).filter((n) => n.qualifiedName === `TWorker::${name}`);
    expect(matches, `one indexed method for TWorker.${name}`).toHaveLength(1);
    return matches[0]!;
  }

  async function tool(name: string, args: Record<string, unknown>): Promise<string> {
    const result = await new ToolHandler(cg).execute(name, args);
    expect(result.isError ?? false).toBe(false);
    return result.content[0]?.text ?? '';
  }

  function cli(args: string[]): string {
    const result = spawnSync(process.execPath, [...WASM_RUNTIME_FLAGS, BIN, ...args, '-p', dir], {
      encoding: 'utf-8',
      env: { ...process.env, CODEGRAPH_NO_DAEMON: '1', CODEGRAPH_WASM_RELAUNCHED: '1', NO_COLOR: '1' },
      timeout: 30_000,
    });
    expect(result.status, result.stderr).toBe(0);
    return result.stdout;
  }

  function expectAfterDisconnectBody(text: string): void {
    // A name or a trail entry is insufficient: these must be rendered source lines.
    expect(text).toContain('426\tprocedure TWorker.AfterDisconnect;');
    expect(text).toContain('428\t  Stop;');
    expect(text).toContain('429\t  Reset;');
    expect(text).toContain("430\t  WriteLn('AfterDisconnect');");
    expect(text).toContain('431\tend;');
  }

  it.each([
    ['Stop', 416, 419],
    ['Reset', 421, 424],
    ['AfterDisconnect', 426, 431],
  ])('the SDK locates %s at its implementation rather than its declaration', (name, startLine, endLine) => {
    const node = method(name);
    expect(node.kind).toBe('method');
    expect(node.filePath).toBe('Demo.pas');
    expect([node.startLine, node.endLine]).toEqual([startLine, endLine]);
  });

  it('MCP node returns the implementation including its parameterless calls', async () => {
    expectAfterDisconnectBody(await tool('codegraph_node', { symbol: 'TWorker.AfterDisconnect', includeCode: true }));
  });

  it('MCP explore returns every named method implementation', async () => {
    const text = await tool('codegraph_explore', { query: QUERY });
    expectAfterDisconnectBody(text);
    expect(text).toContain('416\tprocedure TWorker.Stop;');
    expect(text).toContain("418\t  WriteLn('Stop');");
    expect(text).toContain('421\tprocedure TWorker.Reset;');
    expect(text).toContain("423\t  WriteLn('Reset');");
  });

  it('CLI node returns the implementation rather than the class declaration', () => {
    expectAfterDisconnectBody(cli(['node', 'TWorker.AfterDisconnect']));
  });

  it('CLI explore returns the implementation calls and bodies', () => {
    const text = cli(['explore', QUERY]);
    expectAfterDisconnectBody(text);
    expect(text).toContain("418\t  WriteLn('Stop');");
    expect(text).toContain("423\t  WriteLn('Reset');");
  });

  it('callers and callees use the same method nodes and the implementation call sites', () => {
    const after = method('AfterDisconnect');
    const stop = method('Stop');
    const reset = method('Reset');
    expect(cg.getCallees(after.id).map(({ node, edge }) => [node.id, edge.line]).sort()).toEqual([
      [reset.id, 429],
      [stop.id, 428],
    ].sort());
    expect(cg.getCallers(stop.id).map(({ node }) => node.id)).toEqual([after.id]);
    expect(cg.getCallers(reset.id).map(({ node }) => node.id)).toEqual([after.id]);
    expect(cg.getCallers(after.id)).toEqual([]);
  });
});
