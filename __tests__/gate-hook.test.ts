/**
 * `codegraph gate-hook` — the opt-in Claude Code "CodeGraph first" gate.
 *
 * In an indexed repo, text search (Grep / Glob / rg|grep|find|fd via Bash) is
 * denied until the session has made one CodeGraph query. These test the hook's
 * decision logic (`runGateHook` + helpers) directly and the built CLI command's
 * process contract (stdin/stdout wiring, exit codes, kill-switch).
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'node:child_process';
import { CodeGraph } from '../src';
import { runGateHook, runGateHookDetailed, isSearchHead, isCodegraphCommand, isIndexed, localPath } from '../src/hooks/gate';

// Make `os`'s property descriptors configurable so tests can mock `homedir`
// (e.g. for `~` expansion) without touching the process environment.
vi.mock('os', async (importOriginal) => ({ ...await importOriginal<typeof import('os')>() }));

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
  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

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
    // The deny reason names the CLI alternatives so the model knows them...
    expect(o.permissionDecisionReason).toContain('codegraph explore|query|node');
    // ...and stays short enough to not bloat the model's context.
    expect(o.permissionDecisionReason.length).toBeLessThan(300);
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

  it('treats ag/ack and Windows .exe search heads as searches', () => {
    expect(isSearchHead('ag foo')).toBe(true);
    expect(isSearchHead('ack --ignore-dir=x foo')).toBe(true);
    expect(isSearchHead('rg.exe foo')).toBe(true);
    expect(isSearchHead('grep.exe -rn foo .')).toBe(true);
    denied(runGateHook(pre('Bash', { command: 'ag foo' }), env));
    denied(runGateHook(pre('Bash', { command: 'ack foo' }), env));
  });

  it.runIf(process.platform !== 'win32')('expands `~` in search paths relative to the home dir', () => {
    const home = path.join(tmp, 'home');
    fs.mkdirSync(path.join(home, 'repo'), { recursive: true });
    CodeGraph.initSync(path.join(home, 'repo')).close();
    vi.spyOn(os, 'homedir').mockReturnValue(home);
    expect(localPath('~/repo', repo)).toBe(path.join(home, 'repo'));
    expect(localPath('~', repo)).toBe(home);
    denied(runGateHook(pre('Grep', { pattern: 'foo', path: '~/repo' }), env));
  });

  it.runIf(process.platform === 'win32')('maps Git Bash `/c/x` drive paths on Windows', () => {
    expect(localPath('/c/tmp/x', 'C:\\work')).toBe(path.resolve('C:\\work', 'c:/tmp/x'));
  });

  it('records gate-hook-allow/deny only on PreToolUse search events', () => {
    expect(runGateHookDetailed(pre('Grep', { pattern: 'foo' }), env).telemetry).toBe('deny');
    runGateHook(post('mcp__codegraph__codegraph_explore', { query: 'x' }), env);
    expect(runGateHookDetailed(pre('Grep', { pattern: 'foo' }), env).telemetry).toBe('allow');
    // Non-search events carry no telemetry: PostToolUse, non-search tools, no-op.
    expect(runGateHookDetailed(post('mcp__codegraph__codegraph_explore', { query: 'x' }), env).telemetry).toBeNull();
    expect(runGateHookDetailed(pre('Read', { file_path: 'a.ts' }), env).telemetry).toBeNull();
    expect(runGateHookDetailed(pre('Bash', { command: 'ls' }), env).telemetry).toBeNull();
    expect(runGateHookDetailed(pre('mcp__codegraph__codegraph_explore', { query: 'x' }), env).telemetry).toBeNull();
    expect(runGateHookDetailed('', env).telemetry).toBeNull();
    expect(runGateHookDetailed(pre('Grep', { pattern: 'foo' }), { ...env, CODEGRAPH_NO_GATE_HOOK: '1' }).telemetry).toBeNull();
  });

  it('unlocks only on graph-query subcommands — not files/status', () => {
    for (const sub of ['explore', 'query', 'node', 'callers', 'callees', 'impact', 'affected', 'context']) {
      expect(isCodegraphCommand(`codegraph ${sub} x`)).toBe(true);
    }
    for (const sub of ['files', 'status', 'install', 'init', 'index', 'sync', 'serve', 'upgrade']) {
      expect(isCodegraphCommand(`codegraph ${sub}`)).toBe(false);
    }
    // `codegraph status` does not write an unlock marker.
    runGateHook(post('Bash', { command: 'codegraph status' }), env);
    denied(runGateHook(pre('Grep', { pattern: 'foo' }), env));
  });
});

describe('gate-hook marker TTL', () => {
  let tmp: string;
  let repo: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-gate-ttl-')));
    repo = path.join(tmp, 'repo');
    fs.mkdirSync(repo);
    CodeGraph.initSync(repo).close();
    env = { CODEGRAPH_GATE_DIR: path.join(tmp, 'markers') };
  });
  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const pre = () =>
    JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 's1', cwd: repo, tool_name: 'Grep', tool_input: { pattern: 'foo' } });
  const post = () =>
    JSON.stringify({ hook_event_name: 'PostToolUse', session_id: 's1', cwd: repo, tool_name: 'mcp__codegraph__codegraph_explore', tool_input: { query: 'x' } });
  const denied = (out: string | null) => {
    expect(out).not.toBeNull();
    expect(JSON.parse(out!).hookSpecificOutput.permissionDecision).toBe('deny');
  };

  it('a stale marker expires and does not keep the session unlocked', () => {
    const markersDir = env.CODEGRAPH_GATE_DIR!;
    const marker = path.join(markersDir, 's1-main');
    fs.mkdirSync(markersDir, { recursive: true });
    fs.writeFileSync(marker, '');
    // A fresh marker keeps the session unlocked.
    expect(runGateHook(pre(), env)).toBeNull();
    // Age it past the TTL; the next search sees it as expired and denies.
    const past = Date.now() - 25 * 60 * 60 * 1000;
    fs.utimesSync(marker, new Date(past), new Date(past));
    denied(runGateHook(pre(), env));
    // The expired marker is cleaned up.
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('prunes stale markers when a new unlock marker is written', () => {
    const markersDir = env.CODEGRAPH_GATE_DIR!;
    fs.mkdirSync(markersDir, { recursive: true });
    const stale = path.join(markersDir, 'old-session-main');
    fs.writeFileSync(stale, '');
    const past = Date.now() - 25 * 60 * 60 * 1000;
    fs.utimesSync(stale, new Date(past), new Date(past));
    runGateHook(post(), env);
    expect(fs.existsSync(stale)).toBe(false);
  });
});

describe('gate-hook CLI process contract', () => {
  let bin: string;
  let tmp: string;
  let repo: string;
  let gateDir: string;

  beforeAll(() => { bin = path.resolve(__dirname, '../dist/bin/codegraph.js'); });

  beforeEach(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-gate-cli-')));
    repo = path.join(tmp, 'repo');
    fs.mkdirSync(repo);
    CodeGraph.initSync(repo).close();
    gateDir = path.join(tmp, 'markers');
  });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  const pre = (tool_name: string, tool_input: object) =>
    JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 's1', cwd: repo, tool_name, tool_input });
  const post = (tool_name: string, tool_input: object) =>
    JSON.stringify({ hook_event_name: 'PostToolUse', session_id: 's1', cwd: repo, tool_name, tool_input });

  const run = (payload: string, kill = false) =>
    spawnSync(process.execPath, [bin, 'gate-hook'], {
      cwd: repo,
      input: payload,
      encoding: 'utf8',
      timeout: 15_000,
      env: {
        ...process.env,
        CODEGRAPH_TELEMETRY: '0', DO_NOT_TRACK: '1', CODEGRAPH_NO_DAEMON: '1',
        CODEGRAPH_GATE_DIR: gateDir,
        ...(kill ? { CODEGRAPH_NO_GATE_HOOK: '1' } : {}),
      },
    });

  it('denies a real PreToolUse Grep payload on stdout with exit 0', () => {
    const r = run(pre('Grep', { pattern: 'foo' }));
    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');
    const o = JSON.parse(r.stdout.trim()).hookSpecificOutput;
    expect(o.hookEventName).toBe('PreToolUse');
    expect(o.permissionDecision).toBe('deny');
  });

  it('after a PostToolUse codegraph query, Grep is allowed with empty stdout', () => {
    expect(run(post('mcp__codegraph__codegraph_explore', { query: 'x' })).stdout).toBe('');
    const r = run(pre('Grep', { pattern: 'foo' }));
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
  });

  it('exits 0 with no stdout on malformed stdin', () => {
    const r = run('not json');
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
    expect(r.stderr).toBe('');
  });

  it('kill-switch at the CLI level produces no stdout', () => {
    const r = run(pre('Grep', { pattern: 'foo' }), true);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
  });

  it.runIf(process.platform === 'linux')('bypasses when stdin is a TTY (no piped payload)', () => {
    const r = spawnSync('script', ['-qec', `node ${bin} gate-hook`, '/dev/null'], {
      cwd: repo,
      timeout: 15_000,
      env: {
        ...process.env,
        CODEGRAPH_TELEMETRY: '0', DO_NOT_TRACK: '1', CODEGRAPH_NO_DAEMON: '1',
        CODEGRAPH_GATE_DIR: gateDir,
      },
    });
    expect(r.status).toBe(0);
    expect(String(r.stdout)).not.toContain('permissionDecision');
    expect(String(r.stderr)).toBe('');
  });
});
