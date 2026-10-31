/**
 * CODEGRAPH_SYNTH_MIN_INTERVAL_MS bounds how often a long-lived instance's
 * syncs rebuild the synthesized edges (#2911). The synthesis passes read the
 * whole graph, and nearly every TypeScript or Vue file is one of their inputs,
 * so the daemon's watcher paid for a repo-wide pass on almost every edit. With
 * the variable set, a sync within the interval of the last synthesis puts the
 * rebuild off: `synthesis_pending` stays set, and a timer runs it when the
 * interval is up even if no edit follows.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph, parseSynthMinIntervalEnv } from '../src';
import { createDatabase } from '../src/db/sqlite-adapter';

// A sync on a saturated machine can take seconds, and it has to fall inside this.
const HOLD_MS = 10_000;
const SHORTEST_MS = 1000;
const ENV = 'CODEGRAPH_SYNTH_MIN_INTERVAL_MS';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The parts of an instance these tests reach past the public API. */
interface Internals {
  resolver: { refreshSynthesis(...args: unknown[]): Promise<number> };
  db: { getWalAutocheckpoint(): number };
  deferredSynthesisTimer: NodeJS.Timeout | null;
  runDeferredSynthesis(): Promise<void>;
}
const internals = (graph: CodeGraph) => graph as unknown as Internals;

function write(dir: string, rel: string, content: string): void {
  const full = path.join(dir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

/** A bus, a handler registered on it, and a service that emits: one event-emitter edge. */
function fixture(dir: string): void {
  write(dir, 'package.json', JSON.stringify({ name: 'app' }));
  write(dir, 'src/bus.js', "const { EventEmitter } = require('events');\nconst bus = new EventEmitter();\nmodule.exports = { bus };\n");
  write(dir, 'src/handlers.js', "const { bus } = require('./bus');\nfunction onSaved(doc) { return doc; }\nbus.on('saved', onSaved);\nmodule.exports = { onSaved };\n");
  write(dir, 'src/service.js', "const { bus } = require('./bus');\nfunction save(doc) { bus.emit('saved', doc); return doc; }\nmodule.exports = { save };\n");
}

/** A second event on the bus: the edit that makes a sync rebuild the synthesized edges. */
function addRemovedEvent(dir: string): void {
  write(dir, 'src/handlers.js', "const { bus } = require('./bus');\nfunction onSaved(doc) { return doc; }\nfunction onRemoved(doc) { return doc; }\nbus.on('saved', onSaved);\nbus.on('removed', onRemoved);\nmodule.exports = { onSaved, onRemoved };\n");
  write(dir, 'src/service.js', "const { bus } = require('./bus');\nfunction save(doc) { bus.emit('saved', doc); return doc; }\nfunction remove(doc) { bus.emit('removed', doc); return doc; }\nmodule.exports = { save, remove };\n");
}

/** `synthesis_pending` as stored, read through a connection of its own. */
function pending(dir: string): string | null {
  const { db } = createDatabase(path.join(dir, '.codegraph', 'codegraph.db'), { readOnly: true });
  try {
    const row = db.prepare("SELECT value FROM project_metadata WHERE key = 'synthesis_pending'").get() as { value: string } | undefined;
    return row?.value ?? null;
  } finally {
    db.close();
  }
}

/** Every synthesized edge between functions, as `caller->callee`. */
function synthesized(cg: CodeGraph): string[] {
  const out: string[] = [];
  for (const n of cg.getNodesByKind('function')) {
    for (const e of cg.getOutgoingEdges(n.id)) {
      if (e.metadata?.synthesizedBy) out.push(`${n.name}->${cg.getNode(e.target)!.name}`);
    }
  }
  return out.sort();
}

async function waitUntil(check: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check() && Date.now() < deadline) await sleep(50);
}

describe('CODEGRAPH_SYNTH_MIN_INTERVAL_MS holds a sync\'s synthesis (#2911)', () => {
  let dir = '';
  let cg: CodeGraph | null = null;

  afterEach(async () => {
    delete process.env[ENV];
    vi.restoreAllMocks();
    // A put-off synthesis clears the flag and then runs its maintenance off-thread:
    // close only when it has finished, or the database file is still busy on Windows.
    const open = cg;
    if (open) await waitUntil(() => !open.isIndexing(), 20_000);
    cg?.close();
    cg = null;
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    dir = '';
  });

  async function indexed(): Promise<CodeGraph> {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-synth-interval-'));
    fixture(dir);
    cg = await CodeGraph.init(dir, { index: true });
    expect(synthesized(cg)).toEqual(['save->onSaved']);
    expect(pending(dir)).not.toBe('1');
    return cg;
  }

  it('a sync within the interval keeps the synthesis pending, and the timer runs it when the interval is up', async () => {
    const graph = await indexed();
    // The index just synthesized: this sync falls inside the interval.
    process.env[ENV] = String(HOLD_MS);
    addRemovedEvent(dir);
    const result = await graph.sync();
    expect(result.filesModified).toBe(2);
    expect(pending(dir)).toBe('1');
    expect(synthesized(graph)).not.toContain('remove->onRemoved');

    await waitUntil(() => pending(dir) === '0', HOLD_MS + 20_000);
    expect(pending(dir)).toBe('0');
    expect(synthesized(graph)).toContain('remove->onRemoved');
  }, 60_000);

  it('a sync after the interval synthesizes at once', async () => {
    const graph = await indexed();
    process.env[ENV] = String(SHORTEST_MS);
    await sleep(SHORTEST_MS + 100);
    addRemovedEvent(dir);
    await graph.sync();
    expect(pending(dir)).toBe('0');
    expect(synthesized(graph)).toContain('remove->onRemoved');
  }, 60_000);

  it('without the variable a sync synthesizes as before', async () => {
    const graph = await indexed();
    addRemovedEvent(dir);
    await graph.sync();
    expect(pending(dir)).toBe('0');
    expect(synthesized(graph)).toContain('remove->onRemoved');
  }, 60_000);

  it('close() cancels the timer; the pending flag stays for the next sync', async () => {
    const graph = await indexed();
    process.env[ENV] = String(HOLD_MS);
    addRemovedEvent(dir);
    await graph.sync();
    expect(pending(dir)).toBe('1');
    expect(internals(graph).deferredSynthesisTimer).not.toBeNull();
    graph.close();
    cg = null;
    expect(internals(graph).deferredSynthesisTimer).toBeNull();
    expect(pending(dir)).toBe('1');

    // The next instance's first sync runs it: it has no synthesis of its own to measure from.
    const again = await CodeGraph.open(dir);
    cg = again;
    await again.sync();
    expect(pending(dir)).toBe('0');
    expect(synthesized(again)).toContain('remove->onRemoved');
  }, 60_000);

  // The run comes from a timer, so a rejection reaches nothing but the process's
  // fatal handler: a `database is locked` here used to end the daemon.
  it('a put-off synthesis that fails stays pending and tries again, without rejecting', async () => {
    const graph = await indexed();
    process.env[ENV] = String(HOLD_MS);
    addRemovedEvent(dir);
    await graph.sync();
    const inner = internals(graph);
    clearTimeout(inner.deferredSynthesisTimer!);
    inner.deferredSynthesisTimer = null;

    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(inner.resolver, 'refreshSynthesis').mockRejectedValueOnce(new Error('database is locked'));
    await expect(inner.runDeferredSynthesis()).resolves.toBeUndefined();
    expect(pending(dir)).toBe('1');
    expect(inner.deferredSynthesisTimer).not.toBeNull();

    await inner.runDeferredSynthesis();
    expect(pending(dir)).toBe('0');
    expect(synthesized(graph)).toContain('remove->onRemoved');
  }, 60_000);

  it('a put-off synthesis that fails after close() arms nothing', async () => {
    const graph = await indexed();
    process.env[ENV] = String(HOLD_MS);
    addRemovedEvent(dir);
    await graph.sync();
    graph.close();
    cg = null;
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(internals(graph).runDeferredSynthesis()).resolves.toBeUndefined();
    expect(internals(graph).deferredSynthesisTimer).toBeNull();
  }, 60_000);

  it('a put-off synthesis defers WAL checkpoints as a sync does', async () => {
    const graph = await indexed();
    process.env[ENV] = String(HOLD_MS);
    addRemovedEvent(dir);
    await graph.sync();
    const inner = internals(graph);
    const before = inner.db.getWalAutocheckpoint();
    const real = inner.resolver.refreshSynthesis.bind(inner.resolver);
    let during: number | undefined;
    let backpressure: unknown;
    vi.spyOn(inner.resolver, 'refreshSynthesis').mockImplementation(async (...args: unknown[]) => {
      during = inner.db.getWalAutocheckpoint();
      backpressure = args[2];
      return real(...args);
    });

    await inner.runDeferredSynthesis();
    expect(pending(dir)).toBe('0');
    expect(during).toBe(0);
    expect(typeof backpressure).toBe('function');
    expect(inner.db.getWalAutocheckpoint()).toBe(before);
  }, 60_000);

  it('parseSynthMinIntervalEnv reads whole milliseconds from one second to a day', () => {
    expect(parseSynthMinIntervalEnv(undefined)).toBeUndefined();
    expect(parseSynthMinIntervalEnv('')).toBeUndefined();
    expect(parseSynthMinIntervalEnv('abc')).toBeUndefined();
    expect(parseSynthMinIntervalEnv('500')).toBeUndefined();
    expect(parseSynthMinIntervalEnv('1500.5')).toBeUndefined();
    expect(parseSynthMinIntervalEnv('86400001')).toBeUndefined();
    expect(parseSynthMinIntervalEnv('1000')).toBe(1000);
    expect(parseSynthMinIntervalEnv('300000')).toBe(300_000);
  });
});
