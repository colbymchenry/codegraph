/**
 * CODEGRAPH_SYNTH_MIN_INTERVAL_MS bounds how often a long-lived instance's
 * syncs rebuild the synthesized edges (#2911). The synthesis passes read the
 * whole graph, and nearly every TypeScript or Vue file is one of their inputs,
 * so the daemon's watcher paid for a repo-wide pass on almost every edit. With
 * the variable set, a sync within the interval of the last synthesis puts the
 * rebuild off: `synthesis_pending` stays set, and a timer runs it when the
 * interval is up even if no edit follows.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph, parseSynthMinIntervalEnv } from '../src';
import { createDatabase } from '../src/db/sqlite-adapter';

const INTERVAL_MS = 3000;
const ENV = 'CODEGRAPH_SYNTH_MIN_INTERVAL_MS';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

  afterEach(() => {
    delete process.env[ENV];
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
    process.env[ENV] = String(INTERVAL_MS);
    addRemovedEvent(dir);
    const result = await graph.sync();
    expect(result.filesModified).toBe(2);
    expect(pending(dir)).toBe('1');
    expect(synthesized(graph)).not.toContain('remove->onRemoved');

    await waitUntil(() => pending(dir) === '0', INTERVAL_MS + 20_000);
    expect(pending(dir)).toBe('0');
    expect(synthesized(graph)).toContain('remove->onRemoved');
  }, 60_000);

  it('a sync after the interval synthesizes at once', async () => {
    const graph = await indexed();
    process.env[ENV] = String(INTERVAL_MS);
    await sleep(INTERVAL_MS + 100);
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
    process.env[ENV] = String(INTERVAL_MS);
    addRemovedEvent(dir);
    await graph.sync();
    expect(pending(dir)).toBe('1');
    graph.close();
    cg = null;
    await sleep(INTERVAL_MS + 500);
    expect(pending(dir)).toBe('1');

    // The next instance's first sync runs it: it has no synthesis of its own to measure from.
    const again = await CodeGraph.open(dir);
    cg = again;
    await again.sync();
    expect(pending(dir)).toBe('0');
    expect(synthesized(again)).toContain('remove->onRemoved');
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
