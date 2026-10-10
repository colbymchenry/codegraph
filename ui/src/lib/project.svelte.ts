let projectEpoch = 0;
/** 同一项目的读取刷新也只接收最新请求；不影响保存操作的项目生命周期。 */
let readGeneration = 0;
/**
 * The project's own facts — loaded once, read everywhere.
 *
 * `/api/stats` describes the index rather than any one symbol, so every screen
 * that needs a piece of it (the top bar's counts, the Symbol view's blast
 * scale) would otherwise re-fetch the same payload. The promise is memoised,
 * not the value, so callers made before it lands still get the same request.
 */

import { fetchStats, type WireStats } from './api';

let stats = $state<WireStats | null>(null);
let error = $state<string | null>(null);
let inflight: Promise<void> | null = null;

function load(): Promise<void> {
  if (inflight) return inflight;
  const epoch = projectEpoch;
  const generation = ++readGeneration;
  inflight = fetchStats()
    .then((value) => {
      if (epoch !== projectEpoch || generation !== readGeneration) return;
      stats = value;
      error = null;
    })
    .catch((cause: unknown) => {
      if (epoch !== projectEpoch || generation !== readGeneration) return;
      // A failure here costs a couple of numbers in the top bar and the blast
      // bar's denominator — never the screen. It is recorded, not thrown.
      error = cause instanceof Error ? cause.message : String(cause);
    });
  return inflight;
}

export const project = {
  resetProject(initial?: WireStats): void {
    projectEpoch++; readGeneration++; stats = initial ?? null; error = null;
    // 工作区概览已经读取过同一版本的摘要。把它作为本项目第一次读取，
    // 避免项目激活后立刻重复扫描百万级索引；索引事件仍会走 reload。
    inflight = initial ? Promise.resolve() : null;
  },
  get stats(): WireStats | null {
    return stats;
  },
  get error(): string | null {
    return error;
  },
  /** "codegraph" — the indexed project's directory name. */
  get name(): string | null {
    return stats?.project.name ?? null;
  },
  /** "13,495 symbols · 47,433 edges · 632 files indexed". */
  get summary(): string | null {
    if (!stats) return null;
    const n = (value: number): string => value.toLocaleString();
    return `${n(stats.graph.nodes)} symbols · ${n(stats.graph.edges)} edges · ${n(stats.graph.files)} files indexed`;
  },
  ensure: load,
  /**
   * Re-read `/api/stats` because the index moved (the live channel's `index`
   * event). Distinct from `ensure`, which memoises the first request forever —
   * memoising this one would mean the top bar's counts never move again.
   */
  reload(): Promise<void> {
    inflight = null;
    return load();
  },
};
