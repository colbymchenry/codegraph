/**
 * Session-scoped explore call state (CG-17).
 *
 * The tracker is the foundation for cross-call dedup (CG-18) and budget decay
 * (CG-19), so what it must get right is what those two will trust: the count of
 * calls, the line ranges already served, and — above all — WHOSE they are. Two
 * agents on one daemon share a ToolHandler and a worker pool; if their histories
 * blend, a dedup built on this would withhold source from an agent that never
 * saw it, and the agent Reads the file. That is the failure this suite guards.
 *
 * Three layers:
 *   1. the state container itself — keying, monotonic call index, bounds;
 *   2. the handler seam — a real explore against a real index records real
 *      ranges, and the emission side-channel NEVER reaches the response;
 *   3. the session seam — separate sessions on one engine, separate state.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import CodeGraph from '../src/index';
import { ToolHandler } from '../src/mcp/tools';
import { MCPSession } from '../src/mcp/session';
import type { MCPEngine } from '../src/mcp/engine';
import type { JsonRpcTransport, JsonRpcRequest, JsonRpcNotification } from '../src/mcp/transport';
import {
  EXPLORE_EMISSION_KEY,
  EXPLORE_SESSION_LIMITS,
  EXPLORE_SESSION_VIEW_ARG,
  ExploreSessionState,
  coalesceRanges,
  exploreProjectKey,
  rangesCover,
  readExploreSessionView,
  viewForProject,
  type ExploreEmission,
} from '../src/mcp/explore-session-state';

const FIXTURE_SRC = path.join(__dirname, 'fixtures', 'payroll-go');
const QUERY = 'how does payroll cycle create and calculate payslips?';

/** An emission shaped like a real one, for the container-level tests. */
function emission(root: string, over: Partial<ExploreEmission> = {}): ExploreEmission {
  return {
    projectRoot: root,
    query: 'q',
    files: [{ path: 'a.ts', ranges: [{ start: 1, end: 10 }], bytes: 100 }],
    sourceBytes: 100,
    responseBytes: 400,
    ...over,
  };
}

describe('ExploreSessionState — the container', () => {
  it('counts calls per project and hands back a 1-based session index', () => {
    const state = new ExploreSessionState();
    expect(state.record(emission('/repo/a'))?.index).toBe(1);
    expect(state.record(emission('/repo/a'))?.index).toBe(2);
    expect(state.callCount('/repo/a')).toBe(2);
    expect(state.forProject('/repo/a')?.responseBytes).toBe(800);
  });

  it('keys state per project — a second project starts its own count', () => {
    const state = new ExploreSessionState();
    state.record(emission('/repo/a'));
    state.record(emission('/repo/a'));
    expect(state.record(emission('/repo/b'))?.index).toBe(1);
    expect(state.callCount('/repo/a')).toBe(2);
    expect(state.callCount('/repo/b')).toBe(1);
    expect(state.forProject('/repo/b')?.calls).toHaveLength(1);
  });

  it('treats trailing slashes and `.` segments as the same project', () => {
    const state = new ExploreSessionState();
    state.record(emission('/repo/a'));
    state.record(emission('/repo/a/'));
    state.record(emission('/repo/a/./'));
    expect(state.callCount('/repo/a')).toBe(3);
    expect(state.snapshot()).toHaveLength(1);
  });

  it('never reports a project it was never told about', () => {
    const state = new ExploreSessionState();
    expect(state.forProject('/never/queried')).toBeNull();
    expect(state.callCount('/never/queried')).toBe(0);
  });

  it('keeps counting past the retained-call bound — decay must not reset itself', () => {
    const state = new ExploreSessionState();
    const total = EXPLORE_SESSION_LIMITS.MAX_CALLS_RETAINED + 5;
    for (let i = 0; i < total; i++) state.record(emission('/repo/a'));
    const project = state.forProject('/repo/a')!;
    expect(project.callCount).toBe(total);
    expect(project.calls).toHaveLength(EXPLORE_SESSION_LIMITS.MAX_CALLS_RETAINED);
    // Detail is dropped from the OLDEST end; the newest call is always retained.
    expect(project.calls[project.calls.length - 1]!.index).toBe(total);
    expect(project.calls[0]!.index).toBe(total - EXPLORE_SESSION_LIMITS.MAX_CALLS_RETAINED + 1);
  });

  it('bounds the number of projects, evicting the least recently used', () => {
    const state = new ExploreSessionState();
    const roots = Array.from({ length: EXPLORE_SESSION_LIMITS.MAX_PROJECTS + 2 }, (_, i) => `/repo/${i}`);
    for (const root of roots) state.record(emission(root));
    expect(state.snapshot()).toHaveLength(EXPLORE_SESSION_LIMITS.MAX_PROJECTS);
    expect(state.forProject(roots[0]!)).toBeNull();
    expect(state.forProject(roots[roots.length - 1]!)).not.toBeNull();
  });

  it('keeps a re-queried project alive past newer ones', () => {
    const state = new ExploreSessionState();
    const roots = Array.from({ length: EXPLORE_SESSION_LIMITS.MAX_PROJECTS }, (_, i) => `/repo/${i}`);
    for (const root of roots) state.record(emission(root));
    state.record(emission(roots[0]!));        // touch the oldest
    state.record(emission('/repo/newcomer')); // forces one eviction
    expect(state.forProject(roots[0]!)?.callCount).toBe(2);
    expect(state.forProject(roots[1]!)).toBeNull();
  });

  it('bounds files per call, keeping the ones that got the most source', () => {
    const state = new ExploreSessionState();
    const files = Array.from({ length: EXPLORE_SESSION_LIMITS.MAX_FILES_PER_CALL + 6 }, (_, i) => ({
      path: `f${i}.ts`,
      ranges: [{ start: 1, end: 5 }],
      bytes: i + 1,
    }));
    state.record(emission('/repo/a', { files }));
    const kept = state.forProject('/repo/a')!.calls[0]!.files;
    expect(kept).toHaveLength(EXPLORE_SESSION_LIMITS.MAX_FILES_PER_CALL);
    expect(kept.map((f) => f.path)).toContain(`f${files.length - 1}.ts`);
    expect(kept.map((f) => f.path)).not.toContain('f0.ts');
  });

  it('ignores an emission with no project root rather than filing it under ""', () => {
    const state = new ExploreSessionState();
    expect(state.record({ ...emission(''), projectRoot: '' })).toBeNull();
    expect(state.snapshot()).toHaveLength(0);
  });

  it('hands out copies — a caller cannot mutate the record it read', () => {
    const state = new ExploreSessionState();
    state.record(emission('/repo/a'));
    const snap = state.forProject('/repo/a')!;
    snap.calls[0]!.files[0]!.ranges.push({ start: 999, end: 1000 });
    expect(state.forProject('/repo/a')!.calls[0]!.files[0]!.ranges).toHaveLength(1);
  });

  it('view() carries only the most recent calls per project', () => {
    const state = new ExploreSessionState();
    for (let i = 0; i < EXPLORE_SESSION_LIMITS.MAX_CALLS_RETAINED; i++) state.record(emission('/repo/a'));
    const view = state.view();
    expect(view.projects[0]!.callCount).toBe(EXPLORE_SESSION_LIMITS.MAX_CALLS_RETAINED);
    expect(view.projects[0]!.calls).toHaveLength(EXPLORE_SESSION_LIMITS.MAX_VIEW_CALLS);
    expect(viewForProject(view, '/repo/a')?.callCount).toBe(EXPLORE_SESSION_LIMITS.MAX_CALLS_RETAINED);
    // A tracked session that hasn't touched this project yet reads as EMPTY,
    // not untracked — only a missing view (nobody tracking) is null.
    expect(viewForProject(view, '/repo/other')?.callCount).toBe(0);
    expect(viewForProject(null, '/repo/a')).toBeNull();
  });
});

describe('range bookkeeping', () => {
  it('merges overlapping and adjacent spans into one', () => {
    const { ranges, truncated } = coalesceRanges([
      { start: 10, end: 20 },
      { start: 15, end: 25 },  // overlaps
      { start: 26, end: 30 },  // adjacent — one contiguous block of source
      { start: 60, end: 61 },
    ]);
    expect(ranges).toEqual([{ start: 10, end: 30 }, { start: 60, end: 61 }]);
    expect(truncated).toBe(false);
  });

  it('drops junk spans instead of recording a range that was never served', () => {
    const { ranges } = coalesceRanges([
      { start: 5, end: 1 },      // inverted
      { start: 0, end: 3 },      // before line 1
      { start: NaN, end: 4 },
      { start: 7, end: 9 },
    ]);
    expect(ranges).toEqual([{ start: 7, end: 9 }]);
  });

  it('caps the range list by KEEPING the largest spans, and says it truncated', () => {
    // Spaced far enough apart that none of them merge — this is about the cap.
    const many = Array.from({ length: EXPLORE_SESSION_LIMITS.MAX_RANGES_PER_FILE + 5 }, (_, i) => ({
      start: i * 200 + 1,
      end: i * 200 + 2 + i, // later spans are longer
    }));
    const { ranges, truncated } = coalesceRanges(many);
    expect(truncated).toBe(true);
    expect(ranges).toHaveLength(EXPLORE_SESSION_LIMITS.MAX_RANGES_PER_FILE);
    // Still in line order, and the biggest span survived.
    expect(ranges.map((r) => r.start)).toEqual([...ranges.map((r) => r.start)].sort((a, b) => a - b));
    expect(ranges.some((r) => r.start === many[many.length - 1]!.start)).toBe(true);
  });

  it('flags truncation on the stored record so a consumer knows it under-knows', () => {
    const state = new ExploreSessionState();
    const ranges = Array.from({ length: EXPLORE_SESSION_LIMITS.MAX_RANGES_PER_FILE + 3 }, (_, i) => ({
      start: i * 10 + 1, end: i * 10 + 4,
    }));
    state.record(emission('/repo/a', { files: [{ path: 'big.ts', ranges, bytes: 900 }] }));
    expect(state.forProject('/repo/a')!.calls[0]!.files[0]!.rangesTruncated).toBe(true);
  });

  it('answers whether a line was already served', () => {
    const ranges = [{ start: 10, end: 20 }, { start: 40, end: 41 }];
    expect(rangesCover(ranges, 10)).toBe(true);
    expect(rangesCover(ranges, 20)).toBe(true);
    expect(rangesCover(ranges, 21)).toBe(false);
    expect(rangesCover(ranges, 40)).toBe(true);
  });

  it('folds case only on the case-insensitive platforms', () => {
    const insensitive = process.platform === 'darwin' || process.platform === 'win32';
    expect(exploreProjectKey('/Repo/A') === exploreProjectKey('/repo/a')).toBe(insensitive);
  });
});

describe('session view arriving on tool args', () => {
  it('reads a well-formed view and ignores anything else', () => {
    const state = new ExploreSessionState();
    state.record(emission('/repo/a'));
    expect(readExploreSessionView({ [EXPLORE_SESSION_VIEW_ARG]: state.view() })?.projects).toHaveLength(1);
    expect(readExploreSessionView({})).toBeNull();
    expect(readExploreSessionView({ [EXPLORE_SESSION_VIEW_ARG]: 'nope' })).toBeNull();
    expect(readExploreSessionView({ [EXPLORE_SESSION_VIEW_ARG]: { projects: 'nope' } })).toBeNull();
  });

  it('drops malformed project entries rather than trusting them', () => {
    const view = readExploreSessionView({
      [EXPLORE_SESSION_VIEW_ARG]: { projects: [{ projectRoot: '/repo/a', calls: [] }, { nope: 1 }, null] },
    });
    expect(view?.projects).toHaveLength(1);
  });
});

describe('explore records what it actually served', () => {
  let testDir: string;
  let cg: CodeGraph;
  let handler: ToolHandler;

  beforeAll(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-cg17-'));
    fs.cpSync(FIXTURE_SRC, testDir, { recursive: true });
    fs.rmSync(path.join(testDir, '.codegraph'), { recursive: true, force: true });
    cg = CodeGraph.initSync(testDir);
    await cg.indexAll();
    handler = new ToolHandler(cg);
  }, 120_000);

  afterAll(() => {
    if (cg) cg.destroy();
    if (testDir && fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('files one record per call, with the files and line ranges it emitted', async () => {
    const session = new ExploreSessionState();
    await handler.execute('codegraph_explore', { query: QUERY }, session);

    const project = session.forProject(cg.getProjectRoot());
    expect(project).not.toBeNull();
    expect(project!.callCount).toBe(1);

    const call = project!.calls[0]!;
    expect(call.files.length).toBeGreaterThan(0);
    expect(call.sourceBytes).toBeGreaterThan(0);
    expect(call.responseBytes).toBeGreaterThan(call.sourceBytes);
    for (const file of call.files) {
      expect(file.ranges.length).toBeGreaterThan(0);
      for (const r of file.ranges) {
        expect(r.start).toBeGreaterThanOrEqual(1);
        expect(r.end).toBeGreaterThanOrEqual(r.start);
      }
    }
  }, 60_000);

  it('records only files whose source is really in the response', async () => {
    const session = new ExploreSessionState();
    const result = await handler.execute('codegraph_explore', { query: QUERY }, session);
    const text = result.content[0]!.text;
    for (const file of session.forProject(cg.getProjectRoot())!.calls[0]!.files) {
      expect(text).toContain(file.path);
    }
  }, 60_000);

  it('the recorded ranges name lines that are really in the emitted source', async () => {
    const session = new ExploreSessionState();
    await handler.execute('codegraph_explore', { query: QUERY }, session);
    for (const file of session.forProject(cg.getProjectRoot())!.calls[0]!.files) {
      const lineCount = fs.readFileSync(path.join(testDir, file.path), 'utf-8').split('\n').length;
      for (const r of file.ranges) expect(r.end).toBeLessThanOrEqual(lineCount);
    }
  }, 60_000);

  it('leaves the agent-facing response untouched — no side-channel on the wire', async () => {
    const session = new ExploreSessionState();
    const tracked = await handler.execute('codegraph_explore', { query: QUERY }, session);
    const untracked = await handler.execute('codegraph_explore', { query: QUERY });

    expect(tracked.content[0]!.text).toBe(untracked.content[0]!.text);
    for (const result of [tracked, untracked]) {
      expect(EXPLORE_EMISSION_KEY in result).toBe(false);
      expect(JSON.stringify(result)).not.toContain(EXPLORE_EMISSION_KEY);
    }
  }, 60_000);

  it('ignores a session view a client spelled itself — the record is the server\'s', async () => {
    const forged = {
      projects: [{ projectRoot: cg.getProjectRoot(), callCount: 99, responseBytes: 1e6, calls: [] }],
    };
    const result = await handler.execute('codegraph_explore', {
      query: QUERY,
      [EXPLORE_SESSION_VIEW_ARG]: forged,
    });
    const clean = await handler.execute('codegraph_explore', { query: QUERY });
    expect(result.content[0]!.text).toBe(clean.content[0]!.text);
  }, 60_000);

  it('counts an empty answer as a call, since it still spends the tier budget', async () => {
    const session = new ExploreSessionState();
    await handler.execute('codegraph_explore', { query: 'zzqqxx_no_such_symbol_anywhere' }, session);
    const project = session.forProject(cg.getProjectRoot());
    expect(project?.callCount).toBe(1);
    expect(project?.calls[0]!.files).toHaveLength(0);
  }, 60_000);

  it('two sessions on ONE handler never see each other\'s calls', async () => {
    const a = new ExploreSessionState();
    const b = new ExploreSessionState();
    await handler.execute('codegraph_explore', { query: QUERY }, a);
    await handler.execute('codegraph_explore', { query: QUERY }, a);
    await handler.execute('codegraph_explore', { query: QUERY }, b);

    expect(a.callCount(cg.getProjectRoot())).toBe(2);
    expect(b.callCount(cg.getProjectRoot())).toBe(1);
  }, 90_000);

  it('a caller that tracks nothing still gets a clean result', async () => {
    const result = await handler.execute('codegraph_explore', { query: QUERY });
    expect(result.isError).toBeFalsy();
    expect(result.content[0]!.text.length).toBeGreaterThan(0);
  }, 60_000);

  it('reports the session state through the CG-4 diagnostic', async () => {
    const sidecar = path.join(testDir, 'cg17-diagnostic.jsonl');
    const session = new ExploreSessionState();
    const previous = process.env.CODEGRAPH_EXPLORE_DEBUG;
    process.env.CODEGRAPH_EXPLORE_DEBUG = sidecar;
    try {
      await handler.execute('codegraph_explore', { query: QUERY }, session);
      await handler.execute('codegraph_explore', { query: QUERY }, session);
    } finally {
      if (previous === undefined) delete process.env.CODEGRAPH_EXPLORE_DEBUG;
      else process.env.CODEGRAPH_EXPLORE_DEBUG = previous;
    }

    const reports = fs.readFileSync(sidecar, 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
    expect(reports).toHaveLength(2);
    // The first call is the session's first: nothing served before it.
    expect(reports[0].session).toEqual({
      callIndex: 1, priorCalls: 0, priorResponseChars: 0, priorFiles: [],
    });
    // The second sees the first call's files and their ranges.
    expect(reports[1].session.callIndex).toBe(2);
    expect(reports[1].session.priorCalls).toBe(1);
    expect(reports[1].session.priorResponseChars).toBeGreaterThan(0);
    expect(reports[1].session.priorFiles.length).toBeGreaterThan(0);
    expect(reports[1].session.priorFiles[0].ranges[0]).toHaveLength(2);
  }, 90_000);

  it('omits the session block entirely when the caller tracks no state', async () => {
    const sidecar = path.join(testDir, 'cg17-untracked.jsonl');
    const previous = process.env.CODEGRAPH_EXPLORE_DEBUG;
    process.env.CODEGRAPH_EXPLORE_DEBUG = sidecar;
    try {
      await handler.execute('codegraph_explore', { query: QUERY });
    } finally {
      if (previous === undefined) delete process.env.CODEGRAPH_EXPLORE_DEBUG;
      else process.env.CODEGRAPH_EXPLORE_DEBUG = previous;
    }
    const report = JSON.parse(fs.readFileSync(sidecar, 'utf-8').trim());
    expect(report.session).toBeUndefined();
  }, 60_000);

  it('keys on the RESOLVED root, not the path the agent typed', async () => {
    // The same project reached two ways — bare, and via a `projectPath` pointing
    // at a subdirectory. Both resolve to one index, so both must land in one
    // bucket; keying on the typed path would split a session's history in two
    // and hand a later call a half-empty record.
    //
    // (Two genuinely DIFFERENT projects can't be exercised here: opening a
    // second index inside vitest fails on the lazy `require('../index')` — see
    // the ToolHandler cache notes. The container-level tests above cover the
    // multi-project keying itself.)
    const session = new ExploreSessionState();
    await handler.execute('codegraph_explore', { query: QUERY }, session);
    await handler.execute(
      'codegraph_explore',
      { query: QUERY, projectPath: path.join(testDir, 'internal') },
      session,
    );

    expect(session.snapshot()).toHaveLength(1);
    expect(session.callCount(cg.getProjectRoot())).toBe(2);
  }, 90_000);
});

describe('sessions sharing a daemon', () => {
  /** Minimal transport: captures the message handler so a test can drive it. */
  function fakeTransport(): JsonRpcTransport & { deliver: (m: JsonRpcRequest) => Promise<void>; results: unknown[] } {
    let handle: ((m: JsonRpcRequest | JsonRpcNotification) => Promise<void>) | null = null;
    const results: unknown[] = [];
    return {
      start(h) { handle = h as typeof handle; },
      stop() { /* nothing to tear down */ },
      send() { /* unused */ },
      notify() { /* unused */ },
      async request() { return {}; },
      sendResult(_id, result) { results.push(result); },
      sendError() { /* unused */ },
      results,
      async deliver(m: JsonRpcRequest) { await handle?.(m); },
    };
  }

  it('give each session its own state, and one session\'s calls stay there', async () => {
    const calls: Array<ExploreSessionState | undefined> = [];
    // A ToolHandler stand-in: the point here is WHICH state object arrives, not
    // what explore returns, so a real index would only slow the assertion down.
    const handler = {
      getTools: () => [],
      execute: async (_tool: string, _args: Record<string, unknown>, state?: ExploreSessionState) => {
        calls.push(state);
        state?.record(emission('/repo/shared'));
        return { content: [{ type: 'text' as const, text: 'ok' }] };
      },
    };
    const engine = {
      ensureInitialized: async () => { /* already open */ },
      hasDefaultCodeGraph: () => true,
      getProjectPath: () => '/repo/shared',
      retryInitializeSync: () => { /* nothing to retry */ },
      getToolHandler: () => handler,
    } as unknown as MCPEngine;

    const transportA = fakeTransport();
    const transportB = fakeTransport();
    const sessionA = new MCPSession(transportA, engine);
    const sessionB = new MCPSession(transportB, engine);
    sessionA.start();
    sessionB.start();

    expect(sessionA.getExploreSessionState()).not.toBe(sessionB.getExploreSessionState());

    const call = (id: number): JsonRpcRequest => ({
      jsonrpc: '2.0', id, method: 'tools/call',
      params: { name: 'codegraph_explore', arguments: { query: 'q' } },
    });
    await transportA.deliver(call(1));
    await transportA.deliver(call(2));
    await transportB.deliver(call(3));

    expect(calls[0]).toBe(sessionA.getExploreSessionState());
    expect(calls[2]).toBe(sessionB.getExploreSessionState());
    expect(sessionA.getExploreSessionState().callCount('/repo/shared')).toBe(2);
    expect(sessionB.getExploreSessionState().callCount('/repo/shared')).toBe(1);
  });
});
