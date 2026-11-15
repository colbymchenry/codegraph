/**
 * Interactive daemon manager — the logic behind `codegraph daemon` / `daemons`.
 *
 * Kept separate from the CLI (which owns the @clack/prompts wiring) so the
 * selection/stop loop is unit-testable with a fake `select`: no TTY, no clack,
 * no real daemons. The CLI passes the real clack `select`/`isCancel` plus the
 * registry's list/stop functions.
 */
import * as path from 'path';
import { canonicalProjectRoot } from '../directory';
import { getDaemonIndexDir, isDefaultDaemonIndex, sameDaemonIndex } from './daemon-paths';
import type { DaemonRecord, StopResult } from './daemon-registry';

/** Sentinel option values (not paths, so they can't collide with a daemon's registry file). */
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
 * Which index `daemon` serves, worded for a list of `daemons`, or null where its
 * root says enough: an index other than its project's default is named, and so
 * is every index of a project that runs more than one daemon, so no two rows
 * read the same. A record from an older release that shows no index is
 * `index unknown` when that matters.
 */
export function describeDaemonIndex(daemon: DaemonRecord, daemons: readonly DaemonRecord[]): string | null {
  const root = canonicalProjectRoot(daemon.root);
  const sharesRoot = daemons.some((other) => other.file !== daemon.file && canonicalProjectRoot(other.root) === root);
  if (daemon.indexDir === null) return sharesRoot ? 'index unknown' : null;
  if (!sharesRoot && isDefaultDaemonIndex(daemon.root, daemon.indexDir)) return null;
  return `index ${path.basename(daemon.indexDir)}`;
}

/** A daemon's root, with its index when {@link describeDaemonIndex} names it. */
export function describeDaemon(daemon: DaemonRecord, daemons: readonly DaemonRecord[]): string {
  const index = describeDaemonIndex(daemon, daemons);
  return index ? `${daemon.root} (${index})` : daemon.root;
}

/**
 * Build the ordered, UI-ready option list: the daemon of the current project's
 * index first (so it's the auto-selected default), the rest newest-first, then
 * "Stop all" (only when there's more than one) and "Cancel". Each daemon's
 * value is its registry file, which no other row shares.
 */
export function buildPickItems(daemons: DaemonRecord[], cwdRoot: string | null, now: number): PickItem[] {
  // The current project's index is the one this process's CODEGRAPH_DIR names;
  // another index of the same project is not the current one.
  const cwdIndex = cwdRoot != null ? getDaemonIndexDir(cwdRoot) : null;
  const isCurrent = (d: DaemonRecord): boolean =>
    cwdIndex !== null && d.indexDir !== null && sameDaemonIndex(d.indexDir, cwdIndex);
  const ordered = [...daemons].sort((a, b) => {
    const aCur = isCurrent(a);
    const bCur = isCurrent(b);
    if (aCur && !bCur) return -1;
    if (bCur && !aCur) return 1;
    return b.startedAt - a.startedAt; // newest first
  });

  const items: PickItem[] = ordered.map((d) => {
    const index = describeDaemonIndex(d, daemons);
    return {
      value: d.file,
      label: isCurrent(d) ? `${d.root}  (current project)` : d.root,
      hint: `${index ? `${index} · ` : ''}pid ${d.pid} · up ${formatUptime(now - d.startedAt)} · Running`,
    };
  });

  if (items.length > 1) items.push({ value: STOP_ALL, label: 'Stop all', hint: '' });
  items.push({ value: CANCEL, label: 'Cancel', hint: '' });
  return items;
}

export interface PickerDeps {
  list: () => DaemonRecord[] | Promise<DaemonRecord[]>;
  /** Stop the daemon a listed record names. */
  stop: (daemon: DaemonRecord) => Promise<StopResult>;
  stopAll: () => Promise<StopResult[]>;
  /** Realpath'd root of the current project, or null. Its index is the one `CODEGRAPH_DIR` names. */
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
    const daemons = await deps.list();
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

    const selected = daemons.find((daemon) => daemon.file === choice);
    if (!selected) continue;
    const result = await deps.stop(selected);
    const where = describeDaemon(selected, daemons);
    if (result.outcome === 'still-running') {
      deps.note(`Could not stop daemon (pid ${result.pid}); left its artifacts intact — ${where}`);
      continue;
    }
    if (result.outcome === 'unverified') {
      deps.note(
        `Could not verify daemon (pid ${result.pid}); left it running with its artifacts intact — ${where}`
      );
      continue;
    }
    if (result.outcome === 'not-running') {
      deps.note(`Daemon was no longer running; removed stale artifacts — ${where}`);
      continue;
    }
    if (result.outcome === 'no-daemon') {
      deps.note(`No daemon was found — ${where}`);
      continue;
    }
    const forced = result.outcome === 'kill' ? ', forced' : '';
    deps.note(`Stopped daemon (pid ${result.pid}${forced}) — ${where}`);
    // Loop: the next iteration re-lists; if more remain it re-prompts, otherwise
    // the top-of-loop empty check prints "All daemons stopped."
  }
}
