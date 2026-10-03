/**
 * `codegraph gate-hook` — the opt-in Claude Code "CodeGraph first" gate.
 *
 * In an indexed repo, text search (Grep / Glob / rg|grep|find|fd via Bash) is
 * denied until the session has made one CodeGraph query. These test the hook's
 * decision logic (`runGateHook` + helpers) directly; the CLI command is a thin
 * stdin/stdout wrapper around it.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { runGateHook, isSearchHead, isCodegraphCommand, isIndexed } from '../src/hooks/gate';

describe('gate-hook', () => {
  let tmp: string;
  let repo: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-gate-')));
    repo = path.join(tmp, 'repo');
    fs.mkdirSync(repo);
    CodeGraph.initSync(repo).close();
    env = { CODEGRAPH_GATE_DIR: path.join(tmp, 'markers') };
  });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  const pre = (tool_name: string, tool_input: object, extra: object = {}) =>
    JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 's1', cwd: repo, tool_name, tool_input, ...extra });
  const post = (tool_name: string, tool_input: object, extra: object = {}) =>
    JSON.stringify({ hook_event_name: 'PostToolUse', session_id: 's1', cwd: repo, tool_name, tool_input, ...extra });
  const denied = (out: string | null) => {
    expect(out).not.toBeNull();
    const o = JSON.parse(out!).hookSpecificOutput;
    expect(o.hookEventName).toBe('PreToolUse');
    expect(o.permissionDecision).toBe('deny');
    expect(o.permissionDecisionReason).toMatch(/codegraph_explore/);
  };

  it('denies Grep and Glob before any CodeGraph query', () => {
    denied(runGateHook(pre('Grep', { pattern: 'foo' }), env));
    denied(runGateHook(pre('Glob', { pattern: '**/*.ts' }), env));
  });

  it('denies Bash search heads (rg, grep, find, fd) incl. after && and absolute paths', () => {
    denied(runGateHook(pre('Bash', { command: 'rg foo' }), env));
    denied(runGateHook(pre('Bash', { command: 'cd src && /usr/bin/grep -rn foo .' }), env));
    expect(isSearchHead('find . -name x')).toBe(true);
    expect(isSearchHead('fd foo')).toBe(true);
  });

  it('allows a search that is only a pipe target (pnpm test | grep FAIL)', () => {
    expect(isSearchHead('pnpm test | grep FAIL')).toBe(false);
    expect(runGateHook(pre('Bash', { command: 'pnpm test | grep FAIL' }), env)).toBeNull();
  });

  it('allows searches inside node_modules', () => {
    expect(runGateHook(pre('Grep', { pattern: 'x', path: path.join(repo, 'node_modules', 'pkg') }), env)).toBeNull();
    expect(runGateHook(pre('Bash', { command: 'grep -rn x node_modules/pkg' }), env)).toBeNull();
  });

  it('still denies a repo-wide search that only excludes node_modules', () => {
    denied(runGateHook(pre('Bash', { command: 'grep -rn foo . --exclude-dir node_modules' }), env));
    denied(runGateHook(pre('Bash', { command: 'grep -rn foo . --exclude-dir=node_modules' }), env));
    denied(runGateHook(pre('Bash', { command: "rg foo -g '!node_modules'" }), env));
    denied(runGateHook(pre('Glob', { pattern: '**/*.ts', path: repo }), env));
  });

  it('allows everything outside an indexed repo', () => {
    const plain = path.join(tmp, 'plain');
    fs.mkdirSync(plain);
    expect(isIndexed(plain)).toBe(false);
    expect(isIndexed(path.join(repo, 'nested'))).toBe(true);
    expect(runGateHook(pre('Grep', { pattern: 'foo' }, { cwd: plain }), env)).toBeNull();
  });

  it('allows searches that read outside the indexed project, even when run from it', () => {
    const plain = path.join(tmp, 'plain');
    fs.mkdirSync(plain);
    expect(runGateHook(pre('Bash', { command: `pnpm test > ${plain}/out.log; grep -c FAIL ${plain}/out.log` }), env)).toBeNull();
    expect(runGateHook(pre('Bash', { command: `cd ${plain} && grep -rn foo .` }), env)).toBeNull();
    expect(runGateHook(pre('Bash', { command: `cd ${plain}; for f in a b; do grep -n x "$f"; done` }), env)).toBeNull();
    expect(runGateHook(pre('Grep', { pattern: 'foo', path: plain }), env)).toBeNull();
    expect(runGateHook(pre('Glob', { pattern: '*.md', path: path.join(plain, 'docs') }), env)).toBeNull();
  });

  it('denies searches that reach the project: own line, loop body, or explicit path from elsewhere', () => {
    const plain = path.join(tmp, 'plain');
    fs.mkdirSync(plain);
    denied(runGateHook(pre('Bash', { command: 'echo start\ngrep -rn foo .' }), env));
    denied(runGateHook(pre('Bash', { command: 'for f in a b; do grep -n foo src/$f; done' }), env));
    denied(runGateHook(pre('Bash', { command: `cd ${plain} && rg foo ${repo}/src` }), env));
    denied(runGateHook(pre('Grep', { pattern: 'foo' }, { cwd: plain, tool_input: { pattern: 'foo', path: repo } }), env));
  });

  it('unlocks Grep for the session after a PostToolUse on a codegraph MCP tool', () => {
    denied(runGateHook(pre('Grep', { pattern: 'foo' }), env));
    expect(runGateHook(post('mcp__codegraph__codegraph_explore', { query: 'x' }), env)).toBeNull();
    expect(runGateHook(pre('Grep', { pattern: 'foo' }), env)).toBeNull();
  });

  it('unlocks on PostToolUseFailure and on a Bash `codegraph explore` command', () => {
    runGateHook(post('Bash', { command: 'codegraph explore "x"' }, { hook_event_name: 'PostToolUseFailure' }), env);
    expect(runGateHook(pre('Grep', { pattern: 'foo' }), env)).toBeNull();
    expect(isCodegraphCommand('codegraph.cmd query foo')).toBe(true);
    expect(isCodegraphCommand('echo codegraph explore')).toBe(false);
    expect(isCodegraphCommand('codegraph install')).toBe(false);
  });

  it('does not unlock on an unrelated Bash command', () => {
    runGateHook(post('Bash', { command: 'ls' }), env);
    denied(runGateHook(pre('Grep', { pattern: 'foo' }), env));
  });

  it('keeps sessions (and agents) independent', () => {
    runGateHook(post('mcp__codegraph__codegraph_explore', {}, { session_id: 'a' }), env);
    expect(runGateHook(pre('Grep', { pattern: 'x' }, { session_id: 'a' }), env)).toBeNull();
    denied(runGateHook(pre('Grep', { pattern: 'x' }, { session_id: 'b' }), env));
    denied(runGateHook(pre('Grep', { pattern: 'x' }, { session_id: 'a', agent_id: 'sub' }), env));
  });

  it('honors the CODEGRAPH_NO_GATE_HOOK=1 kill-switch', () => {
    expect(runGateHook(pre('Grep', { pattern: 'foo' }), { ...env, CODEGRAPH_NO_GATE_HOOK: '1' })).toBeNull();
  });

  it('never throws on malformed or empty stdin — allows with no output', () => {
    for (const raw of ['', 'not json', '[]', 'null', '{"tool_name": 5}']) {
      expect(runGateHook(raw, env)).toBeNull();
    }
  });
});
