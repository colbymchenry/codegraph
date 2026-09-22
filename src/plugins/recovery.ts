/** Process-death recovery for managed extensions; no PID/age based lock stealing. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { channel } from 'node:diagnostics_channel';
import { createDatabase } from '../db/sqlite-adapter';
import { clearProjectConfigCache } from '../project-config';
import { sha256, packageDigest, type ExtensionPackage } from './package';

const context = new AsyncLocalStorage<string>();
const transitions = channel('codegraph.extension.transaction');
const dir = (root: string) => path.join(root, '.codegraph', 'plugins');
const recordPath = (root: string) => path.join(dir(root), 'transaction.json');
const ownerPath = (root: string) => path.join(dir(root), 'operation.lock');
const uuid = /^[a-f0-9-]{36}$/;
interface RecordV1 {
  format: 1; id: string; pid: number; graphExisted: boolean; previousConfig: string | null; nextConfig: string;
  previousTrust: string | null; nextTrust: string | null;
  package?: { integrity: string; existed: boolean };
}
export function extensionTransition(root: string, id: string, phase: string): void {
  transitions.publish({ root, id, phase });
}
function syncDirectory(directory: string): void {
  // Directory fsync is unavailable on Windows; file writes are still flushed.
  if (process.platform === 'win32') return;
  const fd = fs.openSync(directory, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
export function durableWrite(file: string, data: string): void {
  const temp = file + '.' + randomUUID() + '.tmp';
  const fd = fs.openSync(temp, 'wx', 0o600);
  try { fs.writeFileSync(fd, data); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  try { fs.renameSync(temp, file); syncDirectory(path.dirname(file)); }
  finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
}
function remove(file: string): void {
  try { fs.unlinkSync(file); syncDirectory(path.dirname(file)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}
function read(file: string): string | null {
  try { return fs.readFileSync(file, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}
function object(raw: string | null): Record<string, unknown> {
  const value = raw === null ? {} : JSON.parse(raw);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a JSON object');
  return value;
}
function fail(root: string, detail: string): never {
  throw new Error(`Extension recovery required: ${detail}. Preserve ${recordPath(root)} and the project files; resolve the reported conflict using its previousConfig/nextConfig (graph commit decides the required side), then run codegraph extensions recover --path ${root}. Do not delete a live lock.`);
}
function loadRecord(root: string): RecordV1 | undefined {
  const raw = read(recordPath(root));
  if (raw === null) return;
  try {
    const envelope = JSON.parse(raw);
    if (typeof envelope.payload !== 'string' || sha256(envelope.payload) !== envelope.sha256) throw new Error('record checksum mismatch');
    const r = JSON.parse(envelope.payload) as RecordV1;
    if (r.format !== 1 || !uuid.test(r.id) || !Number.isSafeInteger(r.pid) || r.pid <= 0 || typeof r.graphExisted !== 'boolean' ||
        !(r.previousConfig === null || typeof r.previousConfig === 'string') || typeof r.nextConfig !== 'string' ||
        !(r.previousTrust === null || typeof r.previousTrust === 'string') || !(r.nextTrust === null || typeof r.nextTrust === 'string') ||
        (r.package && (!/^[a-f0-9]{64}$/.test(r.package.integrity) || typeof r.package.existed !== 'boolean'))) throw new Error('invalid record fields');
    object(r.previousConfig); object(r.nextConfig); object(r.previousTrust); object(r.nextTrust);
    return r;
  } catch (error) { return fail(root, `invalid transaction record (${String(error)}); restore a verified backup, do not guess or discard it`); }
}
function saveRecord(root: string, record: RecordV1): void {
  const payload = JSON.stringify(record);
  durableWrite(recordPath(root), JSON.stringify({ payload, sha256: sha256(payload) }));
}
function acquire(root: string): () => void {
  fs.mkdirSync(dir(root), { recursive: true, mode: 0o700 });
  const { db } = createDatabase(path.join(dir(root), 'coordination.sqlite'));
  try {
    db.exec('PRAGMA busy_timeout=0; CREATE TABLE IF NOT EXISTS lifecycle_mutex (id INTEGER); BEGIN IMMEDIATE');
  } catch (error) {
    db.close();
    throw new Error(`Extension/index operation is active or its coordinator is unavailable at ${root}. Retry after the owner finishes; no live lock is stolen. ${String(error)}`);
  }
  return () => { try { db.exec('ROLLBACK'); } finally { db.close(); } };
}
function checkOwner(root: string, journal?: RecordV1): void {
  const raw = read(ownerPath(root));
  if (raw === null) return;
  try {
    const owner = JSON.parse(raw);
    // For current writers, the acquired SQLite lock is authoritative even if
    // this PID is alive/reused. It cannot be acquired during a live operation.
    if (owner?.format === 'codegraph-operation-lock-1' && uuid.test(owner.id) && Number.isSafeInteger(owner.pid)) return;
  } catch { /* legacy/torn */ }
  if (journal) return; // durable v1 journal + acquired SQLite lock prove orphan
  if (/^[1-9]\d*$/.test(raw.trim())) {
    const pid = Number(raw.trim());
    try { process.kill(pid, 0); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return; }
    fail(root, `legacy PID lock ${pid} may still have a live owner (including PID reuse); confirm the old process has ended before archiving this legacy lock`);
  }
  fail(root, 'torn/unknown owner record without a valid transaction; confirm no legacy installer is running before archiving the owner record');
}
function marker(root: string, graphExisted: boolean): string | null {
  const file = path.join(root, '.codegraph', 'codegraph.db');
  if (!fs.existsSync(file)) return null;
  const { db } = createDatabase(file);
  try {
    return (db.prepare("SELECT value FROM project_metadata WHERE key='extension_transaction'").get() as { value: string } | undefined)?.value ?? null;
  } catch (error) {
    if (!graphExisted && /no such table/.test(String(error))) return null;
    throw error;
  } finally { db.close(); }
}
function replaceObserved(root: string, file: string, observed: string | null, target: string | null): void {
  if (read(file) !== observed) fail(root, `${path.basename(file)} changed during recovery; retry with editors/other writers paused`);
  if (target === observed) return;
  if (target === null) remove(file); else durableWrite(file, target);
}
function cleanup(root: string, r: RecordV1, committed: boolean): void {
  const stage = path.join(root, '.codegraph', `extension-stage-${r.id}.db`);
  for (const suffix of ['', '-wal', '-shm', '.lock']) remove(stage + suffix);
  fs.rmSync(path.join(dir(root), `stage-${r.id}`), { recursive: true, force: true });
  if (!committed && r.package && !r.package.existed) {
    const entries = object(read(path.join(root, 'codegraph.json'))).plugins;
    if (!Array.isArray(entries) || !entries.some(e => e?.integrity === r.package!.integrity))
      fs.rmSync(path.join(dir(root), 'packages', r.package.integrity), { recursive: true, force: true });
  }
  // All modern graph writers use the coordinator. Only remove the killed
  // transaction's own old graph lock; never someone else's legacy lock.
  if (!committed && !r.graphExisted) {
    for (const suffix of ['', '-wal', '-shm']) remove(path.join(root, '.codegraph', 'codegraph.db') + suffix);
  }
  const graphLock = path.join(root, '.codegraph', 'codegraph.lock');
  if (read(graphLock)?.trim() === String(r.pid)) remove(graphLock);
}
/** Reconcile synchronously under the coordinator; never evaluates extension code. */
function reconcile(root: string): boolean {
  const r = loadRecord(root); checkOwner(root, r);
  if (!r) { remove(ownerPath(root)); return false; }
  const committed = marker(root, r.graphExisted) === r.id;
  const configFile = path.join(root, 'codegraph.json'), trustFile = path.join(dir(root), 'trust.json');
  const configRaw = read(configFile), trustRaw = read(trustFile);
  let targetConfig: string | null, targetTrust: string | null;
  try {
    const previous = object(r.previousConfig), next = object(r.nextConfig), current = object(configRaw);
    const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
    const wanted = committed ? next.plugins : previous.plugins;
    if (!same(current.plugins, wanted) && (committed || !same(current.plugins, next.plugins)))
      fail(root, `plugins were edited externally; graph ${committed ? 'committed the new version (restore nextConfig.plugins)' : 'retains the old version (restore previousConfig.plugins)'}`);
    if (configRaw === r.nextConfig || configRaw === r.previousConfig) targetConfig = committed ? r.nextConfig : r.previousConfig;
    else {
      if (wanted === undefined) delete current.plugins; else current.plugins = wanted;
      targetConfig = JSON.stringify(current, null, 2) + '\n';
    }
    const beforeTrust = object(r.previousTrust), afterTrust = object(r.nextTrust), currentTrust = object(trustRaw);
    for (const key of new Set([...Object.keys(beforeTrust), ...Object.keys(afterTrust)])) {
      if (same(beforeTrust[key], afterTrust[key])) continue;
      const target = committed ? afterTrust[key] : beforeTrust[key];
      if (!same(currentTrust[key], target) && !same(currentTrust[key], committed ? beforeTrust[key] : afterTrust[key])) fail(root, 'transaction-owned trust entry was edited externally');
      if (target === undefined) delete currentTrust[key]; else currentTrust[key] = target;
    }
    targetTrust = trustRaw === r.nextTrust || trustRaw === r.previousTrust ? (committed ? r.nextTrust : r.previousTrust) : JSON.stringify(currentTrust);
  } catch (error) { return fail(root, String(error)); }
  replaceObserved(root, configFile, configRaw, targetConfig);
  extensionTransition(root, r.id, 'recovery_config');
  replaceObserved(root, trustFile, trustRaw, targetTrust);
  clearProjectConfigCache();
  cleanup(root, r, committed);
  remove(recordPath(root)); remove(ownerPath(root));
  extensionTransition(root, r.id, committed ? 'recovered_commit' : 'recovered_rollback');
  return true;
}
/** Fast no-op on ordinary reads. Pending state is reconciled or rejected. */
export function recoverExtensions(root: string): boolean {
  root = path.resolve(root);
  if (context.getStore() === root) return false;
  if (!fs.existsSync(recordPath(root)) && !fs.existsSync(ownerPath(root))) return false;
  root = fs.realpathSync(root);
  if (context.getStore() === root) return false;
  const release = acquire(root);
  try { return context.run(root, () => reconcile(root)); } finally { release(); }
}
/** Indexers and lifecycle writers share this OS-released lock for their full run. */
export async function withExtensionGuard<T>(root: string, work: () => Promise<T>): Promise<T> {
  root = fs.realpathSync(root);
  if (context.getStore() === root) return work();
  const release = acquire(root);
  try { return await context.run(root, async () => { reconcile(root); return work(); }); }
  finally { release(); }
}
export class ExtensionTransaction {
  readonly record: RecordV1;
  constructor(readonly root: string, nextConfig: string, pkg?: { contents: ExtensionPackage; integrity: string }) {
    if (fs.existsSync(recordPath(root))) throw new Error('An extension transaction is already active');
    this.record = { format: 1, id: randomUUID(), pid: process.pid, graphExisted: fs.existsSync(path.join(root, '.codegraph', 'codegraph.db')),
      previousConfig: read(path.join(root, 'codegraph.json')), nextConfig,
      previousTrust: read(path.join(dir(root), 'trust.json')), nextTrust: read(path.join(dir(root), 'trust.json')),
      ...(pkg ? { package: { integrity: pkg.integrity, existed: fs.existsSync(path.join(dir(root), 'packages', pkg.integrity)) } } : {}) };
    saveRecord(root, this.record);
    durableWrite(ownerPath(root), JSON.stringify({ format: 'codegraph-operation-lock-1', id: this.record.id, pid: process.pid, startedAt: Date.now() }));
    extensionTransition(root, this.record.id, 'prepared');
  }
  stage(pkg?: { contents: ExtensionPackage; integrity: string }): void {
    const r = this.record;
    if (pkg) {
      const destination = path.join(dir(this.root), 'packages', pkg.integrity);
      const expected = { ...pkg.contents.files, 'package.json': JSON.stringify(pkg.contents.package, null, 2) };
      if (!r.package!.existed) {
        const stage = path.join(dir(this.root), `stage-${r.id}`);
        fs.mkdirSync(stage, { recursive: true, mode: 0o700 });
        for (const [file, data] of Object.entries(expected)) {
          const target = path.join(stage, file); fs.mkdirSync(path.dirname(target), { recursive: true }); durableWrite(target, data);
        }
        fs.mkdirSync(path.dirname(destination), { recursive: true }); fs.renameSync(stage, destination); syncDirectory(path.dirname(destination));
      }
      for (const [file, data] of Object.entries(expected)) if (read(path.join(destination, file)) !== data) throw new Error('Installed package was modified');
      const trust = object(r.previousTrust); trust[fs.realpathSync(destination)] = packageDigest(destination);
      r.nextTrust = JSON.stringify(trust); saveRecord(this.root, r);
    }
    extensionTransition(this.root, r.id, 'package_ready');
    replaceObserved(this.root, path.join(dir(this.root), 'trust.json'), r.previousTrust, r.nextTrust);
    extensionTransition(this.root, r.id, 'trust_written');
    replaceObserved(this.root, path.join(this.root, 'codegraph.json'), r.previousConfig, r.nextConfig);
    clearProjectConfigCache(); extensionTransition(this.root, r.id, 'config_written');
  }
  reconcile(): void { reconcile(this.root); }
}
