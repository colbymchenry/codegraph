import { describe, it, expect } from 'vitest';
import {
  formatUptime,
  buildPickItems,
  runDaemonPicker,
  STOP_ALL,
  CANCEL,
  type PickerDeps,
} from '../src/mcp/daemon-manager';
import type { DaemonRecord, StopResult } from '../src/mcp/daemon-registry';

const rec = (root: string, pid: number, startedAt: number): DaemonRecord => ({
  root, pid, version: '1.0.0', socketPath: `${root}/.codegraph/daemon.sock`, startedAt,
});

describe('formatUptime', () => {
  it('formats seconds / minutes / hours', () => {
    expect(formatUptime(45_000)).toBe('45s');
    expect(formatUptime(12 * 60_000)).toBe('12m');
    expect(formatUptime((3 * 60 + 5) * 60_000)).toBe('3h 5m');
  });
});

describe('buildPickItems', () => {
  const old = rec('/p/old', 1, 1000);
  const fresh = rec('/p/new', 2, 2000);
  const cwd = rec('/p/cwd', 3, 500);

  it('orders newest-first and appends Stop all + Cancel', () => {
    const items = buildPickItems([old, fresh], null, 3000);
    expect(items.map((i) => i.value)).toEqual(['/p/new', '/p/old', STOP_ALL, CANCEL]);
    expect(items[0].hint).toContain('pid 2');
    expect(items[0].hint).toContain('Running');
  });

  it('omits Stop all for a single daemon (but keeps Cancel)', () => {
    expect(buildPickItems([old], null, 3000).map((i) => i.value)).toEqual(['/p/old', CANCEL]);
  });

  it('floats the current project to the top, auto-selected and labelled', () => {
    const items = buildPickItems([old, fresh, cwd], '/p/cwd', 3000);
    expect(items[0].value).toBe('/p/cwd');
    expect(items[0].label).toContain('(current project)');
    expect(items.slice(1, 3).map((i) => i.value)).toEqual(['/p/new', '/p/old']); // rest newest-first
  });
});

describe('runDaemonPicker', () => {
  // A fake registry whose list shrinks as daemons are stopped (like the real one).
  function harness(initial: DaemonRecord[], choices: unknown[]) {
    let daemons = [...initial];
    const stopped: string[] = [];
    const notes: string[] = [];
    let doneMsg = '';
    let i = 0;
    const CANCEL_SYMBOL = Symbol('cancel');
    const deps: PickerDeps = {
      list: () => daemons,
      stop: async (root): Promise<StopResult> => {
        daemons = daemons.filter((d) => d.root !== root);
        stopped.push(root);
        return { root, pid: 0, outcome: 'term' };
      },
      stopAll: async (): Promise<StopResult[]> => {
        const all = daemons.map((d) => ({ root: d.root, pid: d.pid, outcome: 'term' as const }));
        daemons = [];
        stopped.push('ALL');
        return all;
      },
      cwdRoot: null,
      now: () => 5000,
      select: async () => choices[i++],
      isCancel: (v) => v === CANCEL_SYMBOL,
      note: (m) => notes.push(m),
      done: (m) => { doneMsg = m; },
    };
    return { deps, stopped, notes, getDone: () => doneMsg, CANCEL_SYMBOL };
  }

  it('stops the chosen daemon, then re-prompts and exits on Cancel', async () => {
    const h = harness([rec('/p/a', 1, 1), rec('/p/b', 2, 2)], ['/p/b', CANCEL]);
    await runDaemonPicker(h.deps);
    expect(h.stopped).toEqual(['/p/b']);
    expect(h.getDone()).toContain('Cancelled');
  });

  it('keeps stopping until none remain', async () => {
    const h = harness([rec('/p/a', 1, 1), rec('/p/b', 2, 2)], ['/p/a', '/p/b']);
    await runDaemonPicker(h.deps);
    expect(h.stopped).toEqual(['/p/a', '/p/b']);
    expect(h.getDone()).toContain('All daemons stopped');
  });

  it('Stop all stops everything in one shot', async () => {
    const h = harness([rec('/p/a', 1, 1), rec('/p/b', 2, 2)], [STOP_ALL]);
    await runDaemonPicker(h.deps);
    expect(h.stopped).toEqual(['ALL']);
    expect(h.getDone()).toBe('Done.');
  });

  it('Cancel (and Esc/Ctrl-C) stop nothing', async () => {
    const h1 = harness([rec('/p/a', 1, 1)], [CANCEL]);
    await runDaemonPicker(h1.deps);
    expect(h1.stopped).toEqual([]);
    expect(h1.getDone()).toContain('Cancelled');

    const h2 = harness([rec('/p/a', 1, 1)], [/* will use the cancel symbol */]);
    h2.deps.select = async () => h2.CANCEL_SYMBOL;
    await runDaemonPicker(h2.deps);
    expect(h2.stopped).toEqual([]);
    expect(h2.getDone()).toContain('Cancelled');
  });
});
