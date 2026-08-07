/**
 * Interactive daemon manager — the logic behind `codegraph daemon` / `daemons`.
 *
 * Kept separate from the CLI (which owns the @clack/prompts wiring) so the
 * selection/stop loop is unit-testable with a fake `select`: no TTY, no clack,
 * no real daemons. The CLI passes the real clack `select`/`isCancel` plus the
 * registry's list/stop functions.
 */
import * as path from 'path';
import type { DaemonRecord, StopResult } from './daemon-registry';

/** Sentinel option values (not real roots, so they can't collide with a project path). */
export const STOP_ALL = '__stop_all__';
export const CANCEL = '__cancel__';

export interface PickItem {
  value: string;
  label: string;
  hint?: string;
}

/** Compact uptime: `45s`, `12m`, `3h 5m`. */
export function formatUptime(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

/**
 * Build the ordered, UI-ready option list: the current project's daemon first
 * (so it's the auto-selected default), the rest newest-first, then "Stop all"
 * (only when there's more than one) and "Cancel".
 */
export function buildPickItems(daemons: DaemonRecord[], cwdRoot: string | null, now: number): PickItem[] {
  const cwd = cwdRoot != null ? path.resolve(cwdRoot) : null;
  const ordered = [...daemons].sort((a, b) => {
    if (cwd) {
      const aCur = path.resolve(a.root) === cwd;
      const bCur = path.resolve(b.root) === cwd;
      if (aCur && !bCur) return -1;
      if (bCur && !aCur) return 1;
    }
    return b.startedAt - a.startedAt; // newest first
  });

  const items: PickItem[] = ordered.map((d) => {
    const current = cwd != null && path.resolve(d.root) === cwd;
    return {
      value: d.root,
      label: current ? `${d.root}  (current project)` : d.root,
      hint: `pid ${d.pid} · up ${formatUptime(now - d.startedAt)} · Running`,
    };
  });

  if (items.length > 1) items.push({ value: STOP_ALL, label: 'Stop all', hint: '' });
  items.push({ value: CANCEL, label: 'Cancel', hint: '' });
  return items;
}

export interface PickerDeps {
  list: () => DaemonRecord[];
  stop: (root: string) => Promise<StopResult>;
  stopAll: () => Promise<StopResult[]>;
  /** Realpath'd root of the current project's daemon, or null. */
  cwdRoot: string | null;
  now: () => number;
  /** Render the picker; returns the chosen value or a cancel sentinel. */
  select: (opts: { message: string; options: PickItem[]; initialValue: string }) => Promise<unknown>;
  isCancel: (v: unknown) => boolean;
  /** Per-action note (e.g. "Stopped daemon …"). */
  note: (msg: string) => void;
  /** Final line + teardown (clack outro). */
  done: (msg: string) => void;
}

/**
 * Pick a daemon → stop it → re-prompt with what's left, until the user cancels
 * (Esc / Ctrl-C / "Cancel"), picks "Stop all", or nothing remains.
 */
export async function runDaemonPicker(deps: PickerDeps): Promise<void> {
  for (;;) {
    const daemons = deps.list();
    if (daemons.length === 0) {
      deps.done('All daemons stopped.');
      return;
    }

    const items = buildPickItems(daemons, deps.cwdRoot, deps.now());
    const choice = await deps.select({
      message: 'Select a daemon to stop',
      options: items,
      initialValue: items[0]?.value ?? CANCEL, // daemons.length > 0 here, so items[0] is a daemon
    });

    if (deps.isCancel(choice) || choice === CANCEL) {
      deps.done('Cancelled.');
      return;
    }

    if (choice === STOP_ALL) {
      const results = await deps.stopAll();
      const n = results.filter((r) => r.outcome === 'term' || r.outcome === 'kill').length;
      deps.note(`Stopped ${n} daemon${n === 1 ? '' : 's'}.`);
      deps.done('Done.');
      return;
    }

    const result = await deps.stop(String(choice));
    const forced = result.outcome === 'kill' ? ', forced' : '';
    deps.note(`Stopped daemon (pid ${result.pid}${forced}) — ${choice}`);
    // Loop: the next iteration re-lists; if more remain it re-prompts, otherwise
    // the top-of-loop empty check prints "All daemons stopped."
  }
}
