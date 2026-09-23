import * as fs from 'node:fs';
import * as path from 'node:path';
import { version as engineVersion } from '../../package.json';
import { loadPluginEntries } from '../project-config';
import { parsePackage, sha256, MAX_PACKAGE_BYTES, type ExtensionPackage } from './package';
import type { PluginEntry } from './api';
import * as semver from 'semver';
import { recoverExtensions, withExtensionGuard, ExtensionTransaction, durableWrite } from './recovery';
import { resolveRelease, validateExtensionId, type ExtensionRelease } from './releases';

export interface ExtensionProgress { state: 'downloading' | 'installing' | 'indexing' | 'ready' | 'failed'; message: string }
export interface InstallRequest { bytes: Buffer; source?: string; integrity?: string; replaces?: string[]; expected?: { id: string; version: string }; automatic?: boolean }

export interface RegistryRequest {
  registry: string; id: string; version?: string; update?: boolean; replaces?: string[];
  /** Optional preview binding: refuse a catalog change after the user saw a selection. */
  selected?: { version: string; integrity: string };
}

export const atomicWrite = durableWrite;

/** Download only bounded HTTPS artifacts (loopback HTTP for local development). */
export async function downloadPackage(url: string, expectedOrigin?: string): Promise<Buffer> {
  const parsed = new URL(url);
  if (parsed.username || parsed.password || (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(parsed.hostname)))) throw new Error('Package URL must use HTTPS');
  if (expectedOrigin && parsed.origin !== expectedOrigin) throw new Error('Artifact must come from the connected marketplace');
  const response = await fetch(parsed, { redirect: 'error', signal: AbortSignal.timeout(30_000) });
  if (!response.ok || !response.body) throw new Error(`Download failed (${response.status})`);
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    size += chunk.byteLength;
    if (size > MAX_PACKAGE_BYTES) { await response.body.cancel().catch(() => {}); throw new Error('Package exceeds 8 MiB'); }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export class ExtensionManager {
  private busy = false;
  private visibleEntries?: PluginEntry[];
  constructor(readonly root: string, private onProgress: (progress: ExtensionProgress) => void = () => {}) {
    this.root = fs.realpathSync(root);
  }
  list(): PluginEntry[] {
    if (this.visibleEntries) return structuredClone(this.visibleEntries);
    recoverExtensions(this.root);
    return loadPluginEntries(this.root);
  }

  async resolve(request: RegistryRequest): Promise<ExtensionRelease> {
    validateExtensionId(request.id);
    const current = this.list().find(e => e.name === `managed:${request.id}`);
    if (request.update && !current) throw new Error(`${request.id} is not installed in this destination`);
    const registry = new URL(request.registry);
    if (registry.username || registry.password) throw new Error('Registry URL must not contain credentials');
    const url = new URL(`/api/extensions/${request.id}`, registry);
    const raw = JSON.parse((await downloadPackage(url.href)).toString('utf8'));
    return resolveRelease(raw, request.id, { engineVersion, version: request.version,
      currentVersion: request.version === undefined ? current?.version : undefined });
  }

  async installFromRegistry(request: RegistryRequest): Promise<PluginEntry> {
    this.onProgress({ state: 'downloading', message: `Resolving ${request.id} for CodeGraph ${engineVersion} (API 1)` });
    const release = await this.resolve(request);
    if (request.selected && (request.selected.version !== release.version || request.selected.integrity !== release.integrity)) throw new Error('Compatible release changed since selection. Refresh the marketplace and try again.');
    const url = new URL(`/api/download/${request.id}/${encodeURIComponent(release.version)}`, request.registry);
    const bytes = await downloadPackage(url.href);
    return this.install({ bytes, source: url.href, integrity: release.integrity, replaces: request.replaces,
      expected: { id: request.id, version: release.version }, automatic: request.version === undefined });
  }

  async install(request: InstallRequest): Promise<PluginEntry> {
    const p = parsePackage(request.bytes, engineVersion);
    if (request.expected && (p.package.codegraph.id !== request.expected.id || p.package.version !== request.expected.version)) throw new Error('Downloaded extension identity/version does not match the selected release');
    const integrity = sha256(request.bytes);
    if (request.integrity && request.integrity !== integrity) throw new Error('Downloaded extension integrity does not match its release');
    const entry: PluginEntry = { name: `managed:${p.package.codegraph.id}`, version: p.package.version, integrity,
      enabled: true, replaces: request.replaces ?? [], ...(request.source ? { source: request.source } : {}) };
    await this.change(async entries => {
      // Recheck under the operation lock: another completed install may have
      // advanced the destination while registry metadata was being fetched.
      const installed = entries.find(e => e.name === entry.name);
      if (request.automatic && installed?.version && (!semver.valid(installed.version) || semver.lt(p.package.version, installed.version))) throw new Error(`Automatic install would downgrade installed ${installed.version}; request an exact version explicitly`);
      this.onProgress({ state: 'installing', message: `Installing ${p.package.codegraph.id} ${p.package.version}` });
      const previous = entries.find(e => e.name === entry.name);
      entry.options = previous?.options;
      if (!request.replaces) entry.replaces = previous?.replaces ?? [];
      const index = entries.findIndex(e => e.name === entry.name);
      if (index < 0) entries.push(entry); else entries[index] = entry;
      return entries;
    }, 'Extension activated and graph refreshed', { contents: p, integrity });
    return entry;
  }

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    await this.change(async entries => {
      const entry = entries.find(e => e.name === `managed:${id}` || e.name === id);
      if (!entry) throw new Error('Extension is not installed');
      entry.enabled = enabled;
      return entries;
    }, enabled ? 'Extension activated and graph refreshed' : 'Extension disabled and graph refreshed');
  }
  async remove(id: string): Promise<void> {
    await this.change(async entries => entries.filter(e => e.name !== `managed:${id}` && e.name !== id), 'Extension removed and graph refreshed');
  }

  private async change(update: (entries: PluginEntry[]) => Promise<PluginEntry[]>, successMessage = 'Extension activated and graph refreshed', pkg?: { contents: ExtensionPackage; integrity: string }): Promise<void> {
    if (this.busy) throw new Error('An extension operation is already running');
    this.busy = true;
    try {
      await withExtensionGuard(this.root, async () => {
        this.visibleEntries = structuredClone(loadPluginEntries(this.root));
        const file = path.join(this.root, 'codegraph.json');
        const config = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
        if (!config || Array.isArray(config) || typeof config !== 'object') throw new Error('codegraph.json must be an object');
        config.plugins = await update(structuredClone(this.visibleEntries));
        const transaction = new ExtensionTransaction(this.root, JSON.stringify(config, null, 2) + '\n', pkg);
        try {
          transaction.stage(pkg);
          this.onProgress({ state: 'indexing', message: 'Building and checking the updated graph' });
          const { CodeGraph } = await import('../index');
          const graph = CodeGraph.isInitialized(this.root) ? await CodeGraph.open(this.root) : await CodeGraph.init(this.root);
          try { await graph.refreshPluginIndex({ extensionTransactionId: transaction.record.id, beforeExtensionCommit: () => transaction.assertStaged() }); } finally { graph.close(); }
          transaction.reconcile();
        } catch (error) {
          // The durable graph marker decides rollback vs completion, including
          // exceptions after SQLite committed. Conflicts retain the journal.
          transaction.reconcile(); throw error;
        }
        this.visibleEntries = undefined;
        this.onProgress({ state: 'ready', message: successMessage });
      });
    } catch (error) { this.onProgress({ state: 'failed', message: String(error) }); throw error; }
    finally { this.visibleEntries = undefined; this.busy = false; }
  }
}
