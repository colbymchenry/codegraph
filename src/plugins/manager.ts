import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { version as engineVersion } from '../../package.json';
import { clearProjectConfigCache, loadPluginEntries } from '../project-config';
import { packageDigest, parsePackage, sha256, MAX_PACKAGE_BYTES } from './package';
import { pluginDirectory } from './loader';
import type { PluginEntry } from './api';
import * as semver from 'semver';
import { resolveRelease, validateExtensionId, type ExtensionRelease } from './releases';

export interface ExtensionProgress { state: 'downloading' | 'installing' | 'indexing' | 'ready' | 'failed'; message: string }
export interface InstallRequest { bytes: Buffer; source?: string; integrity?: string; replaces?: string[]; expected?: { id: string; version: string }; automatic?: boolean }

export interface RegistryRequest {
  registry: string; id: string; version?: string; update?: boolean; replaces?: string[];
  /** Optional preview binding: refuse a catalog change after the user saw a selection. */
  selected?: { version: string; integrity: string };
}

export function atomicWrite(file: string, data: string): void {
  const temp = file + '.' + randomUUID() + '.tmp';
  fs.writeFileSync(temp, data, { mode: 0o600, flag: 'wx' });
  try { fs.renameSync(temp, file); } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
}

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
  constructor(readonly root: string, private onProgress: (progress: ExtensionProgress) => void = () => {}) {
    this.root = fs.realpathSync(root);
  }
  list(): PluginEntry[] { return loadPluginEntries(this.root); }

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
      const packages = path.join(pluginDirectory(this.root), 'packages');
      fs.mkdirSync(packages, { recursive: true, mode: 0o700 });
      const destination = path.join(packages, integrity);
      if (!fs.existsSync(destination)) {
        const stage = fs.mkdtempSync(path.join(packages, 'stage-'));
        for (const [file, content] of Object.entries(p.files)) {
          const dest = path.join(stage, file);
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          fs.writeFileSync(dest, content, { flag: 'wx', mode: 0o600 });
        }
        // Reconstruct only supported metadata, never execute install scripts.
        fs.writeFileSync(path.join(stage, 'package.json'), JSON.stringify(p.package, null, 2));
        fs.renameSync(stage, destination);
      }
      const expected = { ...p.files, 'package.json': JSON.stringify(p.package, null, 2) };
      for (const [file, content] of Object.entries(expected)) {
        if (fs.readFileSync(path.join(destination, file), 'utf8') !== content) throw new Error('Installed package was modified');
      }
      const trustFile = path.join(pluginDirectory(this.root), 'trust.json');
      let trust: Record<string, string> = {};
      try { trust = JSON.parse(fs.readFileSync(trustFile, 'utf8')); } catch { /* first install */ }
      trust[fs.realpathSync(destination)] = packageDigest(destination);
      atomicWrite(trustFile, JSON.stringify(trust));
      const previous = entries.find(e => e.name === entry.name);
      entry.options = previous?.options;
      if (!request.replaces) entry.replaces = previous?.replaces ?? [];
      const index = entries.findIndex(e => e.name === entry.name);
      if (index < 0) entries.push(entry); else entries[index] = entry;
      return entries;
    });
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

  private async change(update: (entries: PluginEntry[]) => Promise<PluginEntry[]>, successMessage = 'Extension activated and graph refreshed'): Promise<void> {
    if (this.busy) throw new Error('An extension operation is already running');
    this.busy = true;
    const dir = pluginDirectory(this.root);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    // A no-timeout exclusive lock: long indexes must not be stolen mid-update.
    const lock = path.join(dir, 'operation.lock');
    let ownsLock = false;
    const configFile = path.join(this.root, 'codegraph.json');
    let previous: string | undefined;
    let written: string | undefined;
    try {
      fs.writeFileSync(lock, String(process.pid), { flag: 'wx', mode: 0o600 }); ownsLock = true;
      if (fs.existsSync(configFile)) previous = fs.readFileSync(configFile, 'utf8');
      const config = previous === undefined ? {} : JSON.parse(previous);
      if (!config || Array.isArray(config) || typeof config !== 'object') throw new Error('codegraph.json must be an object');
      const entries = await update(structuredClone(this.list()));
      config.plugins = entries;
      written = JSON.stringify(config, null, 2) + '\n';
      atomicWrite(configFile, written); clearProjectConfigCache();
      this.onProgress({ state: 'indexing', message: 'Building and checking the updated graph' });
      const { CodeGraph } = await import('../index');
      const graph = CodeGraph.isInitialized(this.root) ? await CodeGraph.open(this.root) : await CodeGraph.init(this.root);
      try { await graph.refreshPluginIndex(); } finally { graph.close(); }
      this.onProgress({ state: 'ready', message: successMessage });
    } catch (err) {
      // Restore only our own write; a user edit during indexing is preserved.
      if (written !== undefined && fs.readFileSync(configFile, 'utf8') === written) {
        if (previous === undefined) fs.unlinkSync(configFile); else atomicWrite(configFile, previous);
        clearProjectConfigCache();
      }
      this.onProgress({ state: 'failed', message: String(err) });
      throw err;
    } finally {
      if (ownsLock) fs.unlinkSync(lock);
      this.busy = false;
    }
  }
}
