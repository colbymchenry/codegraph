/**
 * scripts/add-lang/check-grammar.mjs decides whether a grammar wasm is safe to
 * vendor. It must judge the grammar by how the process running it ends, not by
 * a line printed before that: a grammar can finish every parse and then take
 * the process down, as V8 does when a background compile job runs out of Zone
 * memory, and the old check had already printed PASS by then (#2464). It must
 * also run the grammar the way indexing does, with indexing's V8 flags.
 *
 * A preload stands in for such a grammar. It marks the process that runs
 * WebAssembly, records how that process was launched, and on request makes it
 * die or hang at exit, after the parses are done.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { WASM_RUNTIME_FLAGS } from '../src/extraction/wasm-runtime-flags';

const SCRIPT = path.resolve('scripts/add-lang/check-grammar.mjs');
const PYTHON = path.resolve('src/extraction/wasm/tree-sitter-python.wasm');
const roots: string[] = [];

const PRELOAD = `
const fs = require('fs');
const instantiate = WebAssembly.instantiate;
let ranWasm = false;
WebAssembly.instantiate = function (...args) { ranWasm = true; return instantiate.apply(this, args); };
process.on('exit', () => {
  if (!ranWasm) return;
  fs.appendFileSync(process.env.CG_TEST_RECORD, JSON.stringify({ execArgv: process.execArgv }) + '\\n');
  // A hard kill rather than abort(): no crash report on macOS.
  if (process.env.CG_TEST_AT_EXIT === 'die') process.kill(process.pid, 'SIGKILL');
  if (process.env.CG_TEST_AT_EXIT === 'hang') for (;;) {}
});
`;

function kit() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-check-grammar-'));
  roots.push(root);
  const preload = path.join(root, 'grammar-process.cjs');
  fs.writeFileSync(preload, PRELOAD);
  const python = path.join(root, 'sample.py');
  fs.writeFileSync(python, 'def add(a, b):\n    return a + b\n\n\nclass Box:\n    def size(self):\n        return add(1, 2)\n');
  const lua = path.join(root, 'sample.lua');
  fs.writeFileSync(lua, 'local M = {}\n\nlocal function helper(x)\n  return x * 2\nend\n\nfunction M.run(items)\n  local out = {}\n  for i, v in ipairs(items) do\n    out[i] = helper(v)\n  end\n  return out\nend\n');
  return { root, preload, python, lua, record: path.join(root, 'record.jsonl') };
}

function check(k: ReturnType<typeof kit>, args: string[], env: NodeJS.ProcessEnv = {}) {
  const preload = `--require "${k.preload.replace(/\\/g, '/')}"`;
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    timeout: 60_000,
    env: {
      ...process.env,
      NODE_OPTIONS: [process.env.NODE_OPTIONS, preload].filter(Boolean).join(' '),
      CG_TEST_RECORD: k.record,
      ...env,
    },
  });
}

function records(k: ReturnType<typeof kit>): Array<{ execArgv: string[] }> {
  if (!fs.existsSync(k.record)) return [];
  return fs.readFileSync(k.record, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('add-lang check-grammar (#2464)', () => {
  it('passes a healthy grammar, run in a child process with the V8 flags indexing uses', () => {
    const k = kit();
    const run = check(k, [PYTHON, k.python]);
    expect(run.status, run.stdout + run.stderr).toBe(0);
    expect(run.stdout).toMatch(/RESULT: PASS/);
    const ran = records(k);
    expect(ran).toHaveLength(1);
    for (const flag of WASM_RUNTIME_FLAGS) expect(ran[0]?.execArgv).toContain(flag);
  }, 90_000);

  it('fails when the process running the grammar dies after the parses', () => {
    const k = kit();
    const run = check(k, [PYTHON, k.python], { CG_TEST_AT_EXIT: 'die' });
    expect(run.status, run.stdout + run.stderr).toBe(1);
    expect(run.stdout).not.toMatch(/RESULT: PASS/);
    expect(run.stdout).toMatch(/RESULT: FAIL — the parses finished, but the process running them then died/);
  }, 90_000);

  it('fails when the process running the grammar hangs instead of exiting', () => {
    const k = kit();
    const run = check(k, [PYTHON, k.python], { CG_TEST_AT_EXIT: 'hang', CODEGRAPH_CHECK_GRAMMAR_TIMEOUT_MS: '5000' });
    expect(run.status, run.stdout + run.stderr).toBe(1);
    expect(run.stdout).not.toMatch(/RESULT: PASS/);
    expect(run.stdout).toMatch(/RESULT: FAIL — the parses finished, but the process running them had not exited/);
  }, 90_000);

  it('still fails the tree-sitter-wasms Lua grammar, which corrupts the shared heap on reuse', () => {
    const k = kit();
    const run = check(k, ['lua', k.lua]);
    expect(run.status, run.stdout + run.stderr).toBe(1);
    expect(run.stdout).toMatch(/ABI version: 13/);
    expect(run.stdout).toMatch(/RESULT: FAIL — \d+\/20 parses produced ERROR trees/);
  }, 90_000);

  it('refuses an iteration count that is not a whole number above 0', () => {
    const k = kit();
    for (const iterations of ['0', 'many']) {
      const run = check(k, [PYTHON, k.python, iterations]);
      expect(run.status, `${iterations}: ${run.stdout}${run.stderr}`).toBe(2);
      expect(run.stdout).not.toMatch(/RESULT:/);
    }
  }, 90_000);
});
