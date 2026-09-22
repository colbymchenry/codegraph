import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import * as semver from 'semver';
import type { PluginManifest } from './api';

export const MAX_PACKAGE_BYTES = 8 * 1024 * 1024;
export interface ExtensionPackage {
  format: 'codegraph-extension-1';
  package: { name: string; version: string; main: string; codegraph: PluginManifest; description?: string; repository?: string; license?: string };
  /** UTF-8 source files; dependencies must be bundled, no install scripts run. */
  files: Record<string, string>;
}
export function inside(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}
export function safeFile(file: string): boolean {
  return file.length > 0 && file.length < 240 && !file.includes('\\') && !file.includes(':') &&
    !file.startsWith('/') && file.split('/').every(p => p !== '.' && p !== '..' && p !== '' && !p.startsWith('.')) &&
    /\.(?:[cm]?js|json|md|txt)$/.test(file) && file !== 'package.json';
}
export function validateManifest(raw: unknown, engineVersion?: string): PluginManifest {
  const m = raw as PluginManifest;
  if (!m || typeof m !== 'object' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(m.id) || m.apiVersion !== 1 ||
      !Array.isArray(m.capabilities) || m.capabilities.length === 0 ||
      m.capabilities.some(c => c !== 'frameworks' && c !== 'synthPasses')) throw new Error('Invalid extension manifest or unsupported API version');
  if (m.engines !== undefined && (typeof m.engines !== 'string' || !semver.validRange(m.engines))) throw new Error('Invalid CodeGraph version range');
  if (engineVersion && m.engines && !semver.satisfies(engineVersion, m.engines)) throw new Error(`Extension requires CodeGraph ${m.engines}; running ${engineVersion}`);
  return m;
}
export function parsePackage(bytes: Buffer, engineVersion?: string): ExtensionPackage {
  if (bytes.length > MAX_PACKAGE_BYTES) throw new Error('Extension package exceeds 8 MiB');
  const p = JSON.parse(bytes.toString('utf8')) as ExtensionPackage;
  if (p?.format !== 'codegraph-extension-1' || !p.package || typeof p.package.name !== 'string' ||
      !semver.valid(p.package.version) || !p.files || Array.isArray(p.files) || typeof p.files !== 'object') throw new Error('Invalid extension package');
  validateManifest(p.package.codegraph, engineVersion);
  const files = Object.entries(p.files);
  if (files.length > 256 || files.some(([f, s]) => !safeFile(f) || typeof s !== 'string')) throw new Error('Package has an unsafe path, binary, or too many files');
  if (!safeFile(p.package.main) || !/\.[cm]?js$/.test(p.package.main) || !Object.hasOwn(p.files, p.package.main)) throw new Error('Package entry point is missing');
  return p;
}
export const sha256 = (bytes: string | Buffer): string => createHash('sha256').update(bytes).digest('hex');

/** Hash all package bytes, not just its entry point; symlink escapes are refused. */
export function packageDigest(root: string): string {
  const hash = createHash('sha256');
  let total = 0;
  function walk(dir: string): void {
    for (const name of fs.readdirSync(dir).sort()) {
      if (name === '.git') continue;
      const file = path.join(dir, name);
      const stat = fs.lstatSync(file);
      if (stat.isSymbolicLink()) throw new Error('Extension packages cannot contain symlinks');
      if (stat.isDirectory()) walk(file);
      else {
        if (file.endsWith('.node')) throw new Error('Native addons are unsupported; bundle portable JavaScript');
        total += stat.size;
        if (total > MAX_PACKAGE_BYTES) throw new Error('Extension package exceeds 8 MiB');
        hash.update(path.relative(root, file).split(path.sep).join('/') + '\0');
        hash.update(fs.readFileSync(file));
      }
    }
  }
  walk(root);
  return hash.digest('hex');
}
