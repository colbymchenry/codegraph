import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Telemetry } from '../src/telemetry';

describe('telemetry opt-out across running instances (#1869)', () => {
  let dir: string;
  let now: Date;
  let sends: any[];
  const make = (env = {}, fetchImpl: typeof fetch = async (_url, init) => {
    sends.push(JSON.parse(String(init?.body)));
    return new Response(null, { status: 204 });
  }) => new Telemetry({ dir, env, fetchImpl, now: () => now, stderr: () => {}, installExitHook: false });
  const queued = () => fs.readdirSync(dir).filter(n => n.startsWith('telemetry-queue'));
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-telemetry-off-')); now = new Date('2026-06-12T08:00:00Z'); sends = []; });
  afterEach(() => { vi.useRealTimers(); fs.rmSync(dir, { recursive: true, force: true }); });

  it('removes the identity on off and assigns a new one on on', () => {
    const a = make(); a.setEnabled(true, 'cli'); const old = a.getStatus().machineId;
    make().setEnabled(false, 'cli');
    expect(a.getStatus()).toMatchObject({ enabled: false, machineId: null });
    expect(fs.readFileSync(a.configPath, 'utf8')).not.toContain(old!);
    make().setEnabled(true, 'cli');
    expect(a.getStatus().machineId).toBeTruthy(); expect(a.getStatus().machineId).not.toBe(old);
  });

  it.each(['persist', 'flush'] as const)('drops memory and new recording after another instance opts out: %s', async action => {
    const a = make(); a.setEnabled(true, 'cli'); a.recordLifecycle('install', {});
    make().setEnabled(false, 'cli'); a.recordLifecycle('index', {}); a.recordUsage('mcp_tool', 'codegraph_explore', true);
    if (action === 'persist') a.persistSync(); else await a.flushNow();
    expect(sends).toEqual([]); expect(queued()).toEqual([]);
    make().setEnabled(true, 'cli'); await a.flushNow();
    expect(sends).toEqual([]); expect(queued()).toEqual([]);
  });

  it('observes external off at the completed-day interval', async () => {
    vi.useFakeTimers(); const a = make(); a.setEnabled(true, 'cli'); a.recordUsage('cli_command', 'query', true);
    a.startInterval(); await vi.advanceTimersByTimeAsync(0);
    make().setEnabled(false, 'cli'); now = new Date('2026-06-13T08:00:00Z');
    try { await vi.advanceTimersByTimeAsync(6 * 60 * 60_000); expect(sends).toEqual([]); expect(queued()).toEqual([]); }
    finally { a.stopInterval(); }
  });

  it('does not reuse pre-opt-out memory after an off/on cycle the process missed', async () => {
    const a = make(); a.setEnabled(true, 'cli'); a.recordLifecycle('install', {});
    const b = make(); b.setEnabled(false, 'cli'); b.setEnabled(true, 'cli');
    a.recordLifecycle('index', {}); await a.flushNow();
    expect(sends).toHaveLength(1); expect(sends[0].events.map((e: any) => e.event)).toEqual(['index']);
    expect(sends[0].machine_id).toBe(b.getStatus().machineId);
  });

  it.each([false, true])('in-flight failure cannot recreate old data after off (re-enable=%s)', async reEnable => {
    let reject!: (error: Error) => void;
    const a = make({}, async () => { sends.push('started'); return new Promise((_resolve, fail) => { reject = fail; }); });
    a.setEnabled(true, 'cli'); a.recordLifecycle('install', {}); a.recordUsage('cli_command', 'query', true);
    const flushing = a.flushNow(); expect(sends).toEqual(['started']);
    const b = make(); b.setEnabled(false, 'cli'); if (reEnable) b.setEnabled(true, 'cli');
    reject(new Error('network failure')); await flushing;
    expect(queued()).toEqual([]); await b.flushNow(); expect(sends).toEqual(['started']);
  });

  it('checks consent before each request chunk after an in-flight request returns', async () => {
    let finish!: (r: Response) => void;
    const a = make({}, async () => { sends.push('started'); if (sends.length > 1) return new Response(null, { status: 204 }); return new Promise(resolve => { finish = resolve; }); });
    a.setEnabled(true, 'cli'); for (let i = 0; i < 105; i++) a.recordLifecycle('index', {});
    const flushing = a.flushNow(); expect(sends).toHaveLength(1);
    make().setEnabled(false, 'cli'); finish(new Response(null, { status: 204 })); await flushing;
    expect(sends).toHaveLength(1); expect(queued()).toEqual([]);
  });

  it('off removes stale claims as well as the queue so on cannot revive them', async () => {
    const a = make(); a.setEnabled(true, 'cli');
    const claim = path.join(dir, 'telemetry-queue.sending.98765.jsonl');
    fs.writeFileSync(claim, JSON.stringify({ v: 2, ev: 'install', ts: now.toISOString(), props: {} }) + '\n');
    const old = new Date(now.getTime() - 2 * 60 * 60_000); fs.utimesSync(claim, old, old);
    a.setEnabled(false, 'cli'); expect(queued()).toEqual([]); a.setEnabled(true, 'cli'); await a.flushNow(); expect(sends).toEqual([]);
  });

  it.each(['DO_NOT_TRACK', 'CODEGRAPH_TELEMETRY'])('environment off drops pending memory: %s', async key => {
    const env: NodeJS.ProcessEnv = {}; const a = make(env); a.setEnabled(true, 'cli'); a.recordLifecycle('install', {});
    env[key] = key === 'DO_NOT_TRACK' ? '1' : '0'; await a.flushNow(); a.persistSync(); delete env[key]; await a.flushNow();
    expect(sends).toEqual([]); expect(queued()).toEqual([]);
  });

  it('retains the documented explicit environment-on override without resurrecting the old identity', async () => {
    const a = make(); a.setEnabled(true, 'cli'); const old = a.getStatus().machineId; a.setEnabled(false, 'cli');
    const forced = make({ CODEGRAPH_TELEMETRY: '1' }); forced.recordLifecycle('index', {}); await forced.flushNow();
    expect(sends).toHaveLength(1); expect(sends[0].machine_id).toMatch(/^[0-9a-f-]{36}$/); expect(sends[0].machine_id).not.toBe(old);
    expect(make().isEnabled()).toBe(false);
  });
});
