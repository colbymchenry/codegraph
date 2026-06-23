/**
 * Anonymous usage telemetry — client module.
 *
 * Pins the four invariants from docs/design/telemetry.md: zero stdout, off is
 * off (no socket, no files), fail silent, and local rollup aggregation with
 * completed-days-only sending. All seams (dir, fetch, clock, env, stderr) are
 * injected — no network, no real home directory.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { Telemetry, getTelemetry, TELEMETRY_ENDPOINT } from '../src/telemetry';

type FetchCall = { url: string; body: Record<string, unknown> };

function mockFetch(calls: FetchCall[], opts: { fail?: boolean } = {}) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (opts.fail) throw new Error('network down');
    calls.push({ url: String(input), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
    return new Response(null, { status: 204 });
  }) as unknown as typeof globalThis.fetch;
}

describe('Telemetry', () => {
  let dir: string;
  let calls: FetchCall[];
  let stderrLines: string[];
  let nowValue: Date;

  const make = (overrides: Partial<ConstructorParameters<typeof Telemetry>[0]> = {}) =>
    new Telemetry({
      dir,
      fetchImpl: mockFetch(calls),
      now: () => nowValue,
      env: {},
      stderr: (line) => stderrLines.push(line),
      installExitHook: false,
      ...overrides,
    });

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-telemetry-'));
    calls = [];
    stderrLines = [];
    nowValue = new Date('2026-06-12T08:00:00.000Z');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  describe('consent precedence', () => {
    it('defaults to enabled when nothing decides otherwise', () => {
      const t = make();
      expect(t.getStatus()).toMatchObject({ enabled: true, decidedBy: 'default', machineId: null });
    });

    it('DO_NOT_TRACK beats everything, including a forced-on env and config', () => {
      const t = make({ env: { DO_NOT_TRACK: '1', CODEGRAPH_TELEMETRY: '1' } });
      t.setEnabled(true, 'cli');
      expect(t.getStatus()).toMatchObject({ enabled: false, decidedBy: 'DO_NOT_TRACK' });
    });

    it('CODEGRAPH_TELEMETRY env beats the stored config in both directions', () => {
      const t = make({ env: { CODEGRAPH_TELEMETRY: '0' } });
      t.setEnabled(true, 'cli');
      expect(t.getStatus()).toMatchObject({ enabled: false, decidedBy: 'CODEGRAPH_TELEMETRY' });

      const t2 = make({ env: { CODEGRAPH_TELEMETRY: '1' } });
      t2.setEnabled(false, 'cli');
      expect(t2.getStatus()).toMatchObject({ enabled: true, decidedBy: 'CODEGRAPH_TELEMETRY' });
    });

    it('stored config decides when no env is set', () => {
      const t = make();
      t.setEnabled(false, 'installer');
      expect(t.getStatus()).toMatchObject({ enabled: false, decidedBy: 'config' });
    });
  });

  describe('off is off', () => {
    it('disabled: records nothing, sends nothing, creates no files', async () => {
      const fetchSpy = mockFetch(calls);
      const t = make({ env: { CODEGRAPH_TELEMETRY: '0' }, fetchImpl: fetchSpy });
      t.recordUsage('mcp_tool', 'codegraph_explore', true);
      t.recordLifecycle('install', { scope: 'local', kind: 'fresh' });
      t.persistSync();
      await t.flushNow();
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(fs.existsSync(t.configPath)).toBe(false);
      expect(fs.existsSync(t.queuePath)).toBe(false);
      expect(stderrLines).toEqual([]);
    });

    it('turning telemetry off deletes buffered unsent data', () => {
      const t = make();
      t.recordUsage('cli_command', 'init', true);
      t.persistSync();
      expect(fs.existsSync(t.queuePath)).toBe(true);
      t.setEnabled(false, 'cli');
      expect(fs.existsSync(t.queuePath)).toBe(false);
    });
  });

  describe('first-run notice & machine id', () => {
    it('recording only buffers — no notice, no config until something is sent', async () => {
      const t = make();
      t.recordUsage('mcp_tool', 'codegraph_explore', true);
      t.recordUsage('mcp_tool', 'codegraph_node', true);
      expect(stderrLines).toEqual([]); // local buffering is silent
      expect(fs.existsSync(t.configPath)).toBe(false);
      // Same-day rollups aren't sendable yet — even a flush stays silent.
      await t.flushNow();
      expect(stderrLines).toEqual([]);
      expect(calls).toHaveLength(0);
    });

    it('prints the notice exactly once, before the first actual send', async () => {
      const t = make();
      t.recordLifecycle('index', { languages: ['go'] });
      await t.flushNow();
      t.recordLifecycle('index', { languages: ['rust'] });
      await t.flushNow();
      expect(calls).toHaveLength(2);
      expect(stderrLines).toHaveLength(1);
      expect(stderrLines[0]).toContain('codegraph telemetry off');
      expect(stderrLines[0]).toContain('CODEGRAPH_TELEMETRY=0');
      const config = JSON.parse(fs.readFileSync(t.configPath, 'utf8'));
      expect(config.machine_id).toMatch(/^[0-9a-f-]{36}$/);
      expect(config.consent_source).toBe('default-notice');
    });

    it('keeps the machine id stable across instances and explicit toggles', async () => {
      const t = make();
      t.recordLifecycle('install', { scope: 'local', kind: 'fresh' });
      await t.flushNow();
      const id1 = t.getStatus().machineId;
      expect(id1).toBeTruthy();
      const t2 = make();
      t2.setEnabled(true, 'cli');
      expect(t2.getStatus().machineId).toBe(id1);
    });

    it('an explicit installer choice suppresses the notice', async () => {
      const t = make();
      t.setEnabled(true, 'installer');
      t.recordLifecycle('install', { scope: 'local', kind: 'fresh' });
      await t.flushNow();
      expect(calls).toHaveLength(1); // sent…
      expect(stderrLines).toEqual([]); // …without ever showing the notice
    });
  });

  describe('rollups & sending', () => {
    it('aggregates per (day, kind, name, client) and sends only completed days', async () => {
      const t = make();
      const client = { name: 'Claude Code', version: '2.1' };
      t.recordUsage('mcp_tool', 'codegraph_explore', true, client);
      t.recordUsage('mcp_tool', 'codegraph_explore', false, client);
      t.recordUsage('mcp_tool', 'codegraph_explore', true, client);
      t.recordUsage('cli_command', 'query', true);

      // Same day: nothing is sendable yet.
      await t.flushNow();
      expect(calls).toHaveLength(0);

      // Next day: yesterday's rollups go out.
      nowValue = new Date('2026-06-13T08:00:00.000Z');
      t.recordUsage('cli_command', 'status', true); // today's — must stay queued
      await t.flushNow();
      expect(calls).toHaveLength(1);
      const body = calls[0]!.body;
      expect(body.machine_id).toBe(t.getStatus().machineId);
      expect(body.schema_version).toBe(2);
      const events = body.events as Array<{ event: string; ts: string; props: Record<string, unknown> }>;
      expect(events).toHaveLength(2);
      const explore = events.find((e) => e.props.name === 'codegraph_explore')!;
      expect(explore).toMatchObject({
        event: 'usage_rollup',
        ts: '2026-06-12T12:00:00.000Z',
        props: { kind: 'mcp_tool', count: 3, error_count: 1, client_name: 'Claude Code', client_version: '2.1' },
      });
      // Today's delta is still buffered for tomorrow.
      expect(fs.readFileSync(t.queuePath, 'utf8')).toContain('"status"');
    });

    it('lifecycle events send on the next flush regardless of day', async () => {
      const t = make();
      t.recordLifecycle('install', { targets: ['claude'], scope: 'local', kind: 'fresh' });
      await t.flushNow();
      expect(calls).toHaveLength(1);
      const events = calls[0]!.body.events as Array<{ event: string; props: Record<string, unknown> }>;
      expect(events[0]).toMatchObject({ event: 'install', props: { scope: 'local', kind: 'fresh' } });
    });

    it('uses the production endpoint by default and honors the env override', async () => {
      const t = make();
      t.recordLifecycle('uninstall', {});
      await t.flushNow();
      expect(calls[0]!.url).toBe(TELEMETRY_ENDPOINT);

      const t2 = make({ env: { CODEGRAPH_TELEMETRY_ENDPOINT: 'http://localhost:9999/v1/events' } });
      t2.recordLifecycle('uninstall', {});
      await t2.flushNow();
      expect(calls[1]!.url).toBe('http://localhost:9999/v1/events');
    });

    it('re-queues on network failure and delivers on the next flush', async () => {
      const t = make({ fetchImpl: mockFetch(calls, { fail: true }) });
      t.recordLifecycle('install', { scope: 'global', kind: 'upgrade' });
      await expect(t.flushNow()).resolves.toBeUndefined(); // fail silent
      expect(calls).toHaveLength(0);
      expect(fs.readFileSync(t.queuePath, 'utf8')).toContain('"install"');
      // No claim files left behind.
      expect(fs.readdirSync(dir).filter((f) => f.includes('.sending.'))).toEqual([]);

      const t2 = make();
      await t2.flushNow();
      expect(calls).toHaveLength(1);
      expect(fs.existsSync(t2.queuePath)).toBe(false);
    });

    it('a hung endpoint is bounded by the flush timeout', async () => {
      const hangingFetch = ((_url: RequestInfo | URL, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        })) as unknown as typeof globalThis.fetch;
      const t = make({ fetchImpl: hangingFetch });
      t.recordLifecycle('install', { scope: 'local', kind: 'fresh' });
      const started = Date.now();
      await t.flushNow(100);
      expect(Date.now() - started).toBeLessThan(2000);
      expect(fs.readFileSync(t.queuePath, 'utf8')).toContain('"install"'); // re-queued
    });
  });

  describe('buffer robustness', () => {
    it('caps the queue and drops oldest lines without leaving partial JSON', () => {
      const t = make();
      const bigProps = { targets: Array.from({ length: 50 }, (_, i) => `agent-${i}`) };
      for (let i = 0; i < 600; i++) {
        t.recordLifecycle('install', { ...bigProps, kind: `fresh`, scope: `local`, seq: i });
        t.persistSync();
      }
      const content = fs.readFileSync(t.queuePath, 'utf8');
      expect(content.length).toBeLessThanOrEqual(256 * 1024);
      const first = content.slice(0, content.indexOf('\n'));
      expect(() => JSON.parse(first)).not.toThrow(); // no partial first line
      expect(JSON.parse(first).props.seq).toBeGreaterThan(0); // oldest dropped
    });

    it('skips corrupt lines and still delivers the valid ones', async () => {
      const t = make();
      t.recordLifecycle('index', { languages: ['typescript'] });
      t.persistSync();
      fs.appendFileSync(t.queuePath, 'NOT JSON{{{\n');
      await t.flushNow();
      expect(calls).toHaveLength(1);
      expect((calls[0]!.body.events as unknown[])).toHaveLength(1);
    });

    it('merges back stale claim files from a crashed sender', async () => {
      const t = make();
      const stale = path.join(dir, 'telemetry-queue.sending.99999.jsonl');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(stale, JSON.stringify({ v: 2, ev: 'uninstall', ts: '2026-06-11T00:00:00.000Z', props: {} }) + '\n');
      const old = new Date(nowValue.getTime() - 2 * 60 * 60_000);
      fs.utimesSync(stale, old, old);
      t.setEnabled(true, 'cli'); // config so send() has a machine id
      await t.flushNow();
      expect(fs.existsSync(stale)).toBe(false);
      expect(calls).toHaveLength(1);
      expect((calls[0]!.body.events as Array<{ event: string }>)[0]!.event).toBe('uninstall');
    });
  });

  describe('protocol safety', () => {
    it('never writes to stdout', async () => {
      const stdoutSpy = vi.spyOn(process.stdout, 'write');
      const t = make({ env: { CODEGRAPH_TELEMETRY_DEBUG: '1' } });
      t.recordUsage('mcp_tool', 'codegraph_explore', true);
      t.recordLifecycle('install', { scope: 'local', kind: 'fresh' });
      await t.flushNow();
      expect(stdoutSpy).not.toHaveBeenCalled();
      stdoutSpy.mockRestore();
    });
  });

  it('getTelemetry returns a process-wide singleton', () => {
    expect(getTelemetry()).toBe(getTelemetry());
  });
});
