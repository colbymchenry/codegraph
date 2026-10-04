/**
 * Stored per-file analyses of the Lua/Rust bridge.
 *
 * An analysis is a pure function of its file's path and text, the analyzers'
 * code, the parse runtime and the grammars. The index directory keeps each one
 * under a fingerprint of that code, so every process — a CLI sync, a restarted
 * server, a pool worker — reads analyses back instead of parsing every Lua and
 * Rust file again, and a changed file is analyzed once. An analysis cut short
 * by the parse budget or a missing grammar is never stored. Storage is best
 * effort: a failed read or write only costs the analysis again.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { threadId } from 'node:worker_threads';
import { getCodeGraphDir } from '../directory';
import { resolveWasmPath } from '../extraction/grammars';
import { analyzeLua, type LuaAnalysis } from './lua-ffi-analysis';
import { analyzeRustFfiFile, type RustFfiFileAnalysis } from './rust-ffi-analysis';
import type { ResolutionContext } from './types';

const STORE = 'bridge-analyses';

let fingerprint: string | null | undefined;
/** The analyzers' code, the parse runtime and the grammars; null when any cannot be read. */
function analyzerFingerprint(): string | null {
  if (fingerprint !== undefined) return fingerprint;
  try {
    const ext = path.extname(__filename);
    const inputs = ['bridge-analysis-cache', 'lua-ffi-analysis', 'rust-ffi-analysis', 'syntax-mirror']
      .map(name => path.join(__dirname, name + ext));
    inputs.push(path.join(__dirname, '..', 'extraction', `parse-budget${ext}`), require.resolve('web-tree-sitter'),
      resolveWasmPath('lua'), resolveWasmPath('rust'));
    const hash = createHash('sha1');
    for (const input of inputs) hash.update(fs.readFileSync(input));
    fingerprint = hash.digest('hex').slice(0, 16);
  } catch {
    fingerprint = null;
  }
  return fingerprint;
}

function storeOf(context: ResolutionContext): string | null {
  const version = analyzerFingerprint();
  return version === null ? null : path.join(getCodeGraphDir(context.getProjectRoot()), STORE, version);
}

const keyOf = (kind: string, file: string, source: string): string =>
  createHash('sha1').update(kind).update('\0').update(file).update('\0').update(source).digest('hex');

function read<T>(store: string | null, key: string): T | undefined {
  if (store === null) return undefined;
  try {
    return JSON.parse(fs.readFileSync(path.join(store, `${key}.json`), 'utf8')) as T;
  } catch {
    return undefined;
  }
}

function write(store: string | null, key: string, analysis: unknown): void {
  if (store === null) return;
  const file = path.join(store, `${key}.json`);
  const temporary = `${file}.${process.pid}-${threadId}.tmp`;
  try {
    fs.mkdirSync(store, { recursive: true });
    fs.writeFileSync(temporary, JSON.stringify(analysis));
    fs.renameSync(temporary, file);
  } catch {
    fs.rmSync(temporary, { force: true });
  }
}

/**
 * Callers treat the result as read-only. `live` collects the stored entries a
 * whole-project pass uses, for {@link pruneStoredAnalyses}.
 */
export function cachedLuaAnalysis(context: ResolutionContext, file: string, source: string, live?: Set<string>): LuaAnalysis {
  const store = storeOf(context);
  const key = keyOf('lua', file, source);
  let analysis = read<LuaAnalysis>(store, key);
  if (!analysis) {
    analysis = analyzeLua(source);
    if (analysis.partial) return analysis;
    write(store, key, analysis);
  }
  live?.add(key);
  return analysis;
}

export async function cachedRustAnalysis(context: ResolutionContext, file: string, source: string, live?: Set<string>): Promise<RustFfiFileAnalysis> {
  const store = storeOf(context);
  const key = keyOf('rust', file, source);
  let analysis = read<RustFfiFileAnalysis>(store, key);
  if (!analysis) {
    analysis = await analyzeRustFfiFile(file, source);
    if (analysis.partial) return analysis;
    write(store, key, analysis);
  }
  live?.add(key);
  return analysis;
}

/** After a pass over every Lua and Rust file: drop entries no current file uses, and other analyzers' stores. */
export function pruneStoredAnalyses(context: ResolutionContext, live: ReadonlySet<string>): void {
  const store = storeOf(context);
  if (store === null) return;
  const root = path.dirname(store);
  try {
    for (const version of fs.readdirSync(root)) {
      if (path.join(root, version) !== store) fs.rmSync(path.join(root, version), { recursive: true, force: true });
    }
    for (const entry of fs.readdirSync(store)) {
      if (!(entry.endsWith('.json') && live.has(entry.slice(0, -'.json'.length)))) fs.rmSync(path.join(store, entry), { force: true });
    }
  } catch {
    // Another process may be pruning or writing; the next pass prunes again.
  }
}
