/**
 * Highlighting that cannot take the server down.
 *
 * The viewer's server answers every request on one thread, and a slice is
 * classified by handing it to a tree-sitter grammar — which can loop forever on
 * a fragment it was never written for: cobolcraft's free-format COBOL, cut to a
 * Flow card's window, kept the fixed-format grammar's scanner spinning inside
 * WebAssembly, and every request after it — the page's own `/api/stats`
 * included — waited behind it for good. A parse inside WebAssembly cannot be
 * interrupted from JavaScript, so the slice is classified in a worker the
 * server can terminate: past the deadline the worker is ended, the slice is
 * served plain, and the next slice gets a fresh worker.
 */

import { existsSync } from 'fs';
import * as path from 'path';
import { Worker } from 'worker_threads';
import { tokenizeSource, type TokenizeResult } from '../../extraction/syntax-tokens';
import type { Language } from '../../types';

/** Longest a slice may take to classify — far past any file the grammars can parse at all. */
export const TOKENIZE_DEADLINE_MS = 2000;

/** What a bounded classification came to: the result, or that it ran out of time. */
export type BoundedTokenize = { result: TokenizeResult | null } | { timedOut: true };

interface Pending {
  resolve: (outcome: BoundedTokenize) => void;
  timer: NodeJS.Timeout;
}

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, Pending>();

/**
 * The compiled worker beside us; Vitest loads `src/` but builds `dist/` before
 * the tests, so it uses that copy. Null when neither exists.
 */
function workerFile(): string | null {
  const sibling = path.join(__dirname, 'tokenize-worker.js');
  if (existsSync(sibling)) return sibling;
  const built = path.resolve(__dirname, '../../../dist/ui-server/highlight/tokenize-worker.js');
  return existsSync(built) ? built : null;
}

/** Settle everything waiting on the current worker and forget it. */
function retire(outcome: BoundedTokenize): void {
  const dead = worker;
  worker = null;
  for (const [id, p] of pending) {
    clearTimeout(p.timer);
    pending.delete(id);
    p.resolve(outcome);
  }
  if (dead) void dead.terminate().catch(() => {});
}

function ensureWorker(file: string): Worker {
  if (worker) return worker;
  const w = new Worker(file);
  w.unref();
  w.on('message', (msg: { id: number; result: TokenizeResult | null }) => {
    const p = pending.get(msg.id);
    if (!p) return;
    clearTimeout(p.timer);
    pending.delete(msg.id);
    p.resolve({ result: msg.result });
  });
  w.on('error', () => {
    if (worker === w) retire({ result: null });
  });
  w.on('exit', () => {
    if (worker === w) retire({ result: null });
  });
  worker = w;
  return w;
}

/** Classify `text` in the highlight worker, giving up after {@link TOKENIZE_DEADLINE_MS}. */
export async function tokenizeBounded(
  text: string,
  language: Language,
  deadlineMs = TOKENIZE_DEADLINE_MS
): Promise<BoundedTokenize> {
  const file = workerFile();
  // No compiled worker (a source checkout that was never built): classify
  // in-process, as before.
  if (!file) return { result: await tokenizeSource(text, language) };
  let w: Worker;
  try {
    w = ensureWorker(file);
  } catch {
    return { result: await tokenizeSource(text, language) };
  }
  const id = nextId++;
  return new Promise<BoundedTokenize>((resolve) => {
    const timer = setTimeout(() => {
      // Everything queued behind the slice that hung waits on the same
      // worker: end it, serve them all plain, and start over next time.
      if (worker === w) retire({ timedOut: true });
    }, deadlineMs);
    timer.unref();
    pending.set(id, { resolve, timer });
    w.postMessage({ id, text, language });
  });
}

/** End the highlight worker — for tests, and for a server that is shutting down. */
export function stopHighlightWorker(): void {
  retire({ result: null });
}
