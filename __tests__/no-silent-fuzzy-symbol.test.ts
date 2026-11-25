/**
 * #1473 — callers/callees/impact must not silently answer for a different
 * symbol when the requested name has no exact match (or has an exact match
 * with zero callers). Fuzzy FTS hits may appear only as did-you-mean hints.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { initGrammars, loadAllGrammars } from '../src/extraction/grammars';

const BIN = path.resolve(__dirname, '../dist/bin/codegraph.js');

beforeAll(async () => {
  await initGrammars();
  await loadAllGrammars();
});

function hasSqliteBindings(): boolean {
  try {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(':memory:');
    db.close();
    return true;
  } catch {
    return false;
  }
}
const HAS_SQLITE = hasSqliteBindings();

function tmpRoot(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function rmTree(dir: string): void {
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

function runCli(args: string[], cwd: string): { stdout: string; status: number } {
  try {
    const stdout = execFileSync(process.execPath, [BIN, ...args], {
      cwd,
      encoding: 'utf-8',
      env: {
        ...process.env,
        CODEGRAPH_NO_DAEMON: '1',
        CODEGRAPH_TELEMETRY: '0',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { stdout, status: 0 };
  } catch (err: unknown) {
    const e = err as { stdout?: string; status?: number };
    return { stdout: e.stdout ?? '', status: typeof e.status === 'number' ? e.status : 1 };
  }
}

describe.skipIf(!HAS_SQLITE)('no silent fuzzy substitution (#1473) — MCP', () => {
  let projectRoot: string;
  let cg: any;
  let handler: any;

  beforeEach(async () => {
    projectRoot = tmpRoot('codegraph-1473-mcp-');
    const src = path.join(projectRoot, 'src', 'a', 'b', 'c');
    fs.mkdirSync(src, { recursive: true });
    fs.writeFileSync(
      path.join(src, 'D.java'),
      `package a.b.c;\n\npublic class D {\n    public void e()  { System.out.println("e"); }\n    public void ef() { System.out.println("ef"); }\n}\n`
    );
    fs.writeFileSync(
      path.join(src, 'Caller.java'),
      `package a.b.c;\n\npublic class Caller {\n    public void callsEfOnly() { D d = new D(); d.ef(); }\n    public void alsoCallsEf() { D d = new D(); d.ef(); }\n}\n`
    );
    // Case-differing pair: exact Fetch has 0 callers; lowercase fetch has callers.
    fs.writeFileSync(
      path.join(projectRoot, 'src', 'Fetch.cs'),
      `public class Torture {\n  public void Fetch() {}\n}\n`
    );
    fs.writeFileSync(
      path.join(projectRoot, 'src', 'fetch.py'),
      `def fetch():\n    return 1\n\ndef load():\n    return fetch()\n`
    );

    const CodeGraph = (await import('../src/index')).default;
    const { ToolHandler } = await import('../src/mcp/tools');
    cg = CodeGraph.initSync(projectRoot);
    await cg.indexAll();
    handler = new ToolHandler(cg);
  });

  afterEach(() => {
    handler?.closeAll();
    cg?.destroy();
    rmTree(projectRoot);
  });

  async function text(tool: string, args: Record<string, unknown>): Promise<string> {
    const res = await handler.execute(tool, args);
    return res.content?.[0]?.text ?? '';
  }

  it('callers: missing name is not found (with did-you-mean), not a fuzzy hit labelled as the typed name', async () => {
    const out = await text('codegraph_callers', { symbol: 'Calls' });
    expect(out).toMatch(/Symbol "Calls" not found/);
    expect(out).toMatch(/Did you mean:/);
    expect(out).not.toMatch(/Callees of Calls|Callers of Calls/);
    expect(out).not.toMatch(/\bef\b/);
  });

  it('callees: missing name does not return another method\'s callees', async () => {
    const out = await text('codegraph_callees', { symbol: 'Calls' });
    expect(out).toMatch(/Symbol "Calls" not found/);
    expect(out).not.toContain('Callees of Calls');
  });

  it('impact: missing prefix does not substitute a longer name', async () => {
    const out = await text('codegraph_impact', { symbol: 'callsEf' });
    expect(out).toMatch(/Symbol "callsEf" not found/);
    expect(out).toMatch(/Did you mean:.*callsEfOnly/);
    // Suggestion only — must not claim impact results for the mistyped name.
    expect(out).not.toMatch(/Impact:|"callsEf" affects|affected/);
  });

  it('callers: exact name with zero callers stays empty (no case-sibling substitution)', async () => {
    const out = await text('codegraph_callers', { symbol: 'Fetch' });
    expect(out).toMatch(/No callers found for "Fetch"/);
    expect(out).not.toContain('load');
  });

  it('callers: real exact name still resolves', async () => {
    const out = await text('codegraph_callers', { symbol: 'ef' });
    expect(out).toContain('Callers of ef');
    expect(out).toContain('callsEfOnly');
    expect(out).toContain('alsoCallsEf');
  });

  it('findAllSymbols returns no nodes for a fuzzy-only hit', async () => {
    const findAllSymbols = (handler as any).findAllSymbols.bind(handler);
    const all = findAllSymbols(cg, 'Calls');
    expect(all.nodes).toEqual([]);
    expect(all.note).toMatch(/Did you mean:/);
  });
});

describe.skipIf(!HAS_SQLITE || !fs.existsSync(BIN))('no silent fuzzy substitution (#1473) — CLI', () => {
  let projectRoot: string;

  beforeEach(async () => {
    projectRoot = tmpRoot('codegraph-1473-cli-');
    const src = path.join(projectRoot, 'src', 'a', 'b', 'c');
    fs.mkdirSync(src, { recursive: true });
    fs.writeFileSync(
      path.join(src, 'D.java'),
      `package a.b.c;\n\npublic class D {\n    public void e()  { System.out.println("e"); }\n    public void ef() { System.out.println("ef"); }\n}\n`
    );
    fs.writeFileSync(
      path.join(src, 'Caller.java'),
      `package a.b.c;\n\npublic class Caller {\n    public void callsEfOnly() { D d = new D(); d.ef(); }\n    public void alsoCallsEf() { D d = new D(); d.ef(); }\n}\n`
    );
    fs.writeFileSync(
      path.join(projectRoot, 'src', 'Fetch.cs'),
      `public class Torture {\n  public void Fetch() {}\n}\n`
    );
    fs.writeFileSync(
      path.join(projectRoot, 'src', 'fetch.py'),
      `def fetch():\n    return 1\n\ndef load():\n    return fetch()\n`
    );

    const CodeGraph = (await import('../src/index')).default;
    const cg = CodeGraph.initSync(projectRoot);
    await cg.indexAll();
    cg.close();
  });

  afterEach(() => {
    rmTree(projectRoot);
  });

  it('callers: fuzzy-only name → not found with did-you-mean (JSON stays empty)', () => {
    const { stdout } = runCli(['callers', 'Calls', '--json'], projectRoot);
    // JSON path is only taken on a successful resolve; not-found prints info text.
    expect(stdout).toMatch(/Symbol "Calls" not found/);
    expect(stdout).toMatch(/did you mean/i);
    expect(stdout).not.toMatch(/"name":\s*"ef"/);
  });

  it('callees: fuzzy-only name → not found', () => {
    const { stdout } = runCli(['callees', 'Calls', '--json'], projectRoot);
    expect(stdout).toMatch(/Symbol "Calls" not found/);
    expect(stdout).not.toMatch(/"name":\s*"ef"/);
  });

  it('impact: prefix of a real name → not found', () => {
    const { stdout } = runCli(['impact', 'callsEf', '--json'], projectRoot);
    expect(stdout).toMatch(/Symbol "callsEf" not found/);
    expect(stdout).toMatch(/did you mean:.*callsEfOnly/i);
    // Not a successful JSON impact payload for the fuzzy hit.
    expect(stdout).not.toMatch(/"affected"\s*:/);
    expect(stdout).not.toMatch(/"symbol":\s*"callsEf"/);
  });

  it('callers: exact Fetch with zero callers → empty list, not fetch\'s callers', () => {
    const { stdout } = runCli(['callers', 'Fetch', '--json'], projectRoot);
    expect(stdout).toContain('"symbol": "Fetch"');
    expect(stdout).toMatch(/"callers":\s*\[\s*\]/);
    expect(stdout).not.toContain('load');
  });

  it('callers: exact ef still lists real callers', () => {
    const { stdout } = runCli(['callers', 'ef', '--json'], projectRoot);
    expect(stdout).toContain('callsEfOnly');
    expect(stdout).toContain('alsoCallsEf');
  });
});
