// Portable package validation shared by the local installer and Worker registry.
import * as semver from 'semver';
import type { PluginManifest } from './api';

export const MAX_PACKAGE_BYTES = 8 * 1024 * 1024;
export interface ExtensionPackage {
  format: 'codegraph-extension-1';
  package: { name: string; version: string; main: string; codegraph: PluginManifest; description?: string; repository?: string; license?: string };
  /** UTF-8 source files; dependencies must be bundled, no install scripts run. */
  files: Record<string, string>;
}
export function safeFile(file: string): boolean {
  return file.length > 0 && file.length < 240 && !file.includes('\\') && !file.includes(':') &&
    !file.startsWith('/') && file.split('/').every(p => p !== '.' && p !== '..' && p !== '' && !p.startsWith('.')) &&
    /\.(?:[cm]?js|json|md|txt)$/.test(file) && file !== 'package.json';
}
export function validateManifest(raw: unknown, engineVersion?: string): PluginManifest {
  const m = raw as PluginManifest;
  if (!m || typeof m !== 'object' || Array.isArray(m)) throw new Error('package.json must contain a codegraph manifest object');
  if (m.apiVersion !== 1) throw new Error(`Extension uses unsupported API version ${String(m.apiVersion)}; this engine supports 1. Set codegraph.apiVersion to 1 and use the v1 author guide.`);
  if (typeof m.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(m.id) ||
      !Array.isArray(m.capabilities) || m.capabilities.length === 0 ||
      m.capabilities.some(c => c !== 'frameworks' && c !== 'synthPasses')) throw new Error('Invalid extension manifest: codegraph.id must use lowercase letters/digits/hyphens; capabilities must contain frameworks and/or synthPasses');
  if (m.engines !== undefined && (typeof m.engines !== 'string' || !semver.validRange(m.engines))) throw new Error('Invalid CodeGraph version range');
  if (engineVersion && m.engines && !semver.satisfies(engineVersion, m.engines)) throw new Error(`Extension requires CodeGraph ${m.engines}; running ${engineVersion}. Use a compatible engine or correct codegraph.engines after testing against that engine.`);
  return m;
}

export function parsePackage(bytes: Uint8Array, engineVersion?: string): ExtensionPackage {
  if (bytes.length > MAX_PACKAGE_BYTES) throw new Error('Extension package exceeds 8 MiB');
  const p = JSON.parse(new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes)) as ExtensionPackage;
  if (p?.format !== 'codegraph-extension-1' || !p.package || typeof p.package.name !== 'string' ||
      !semver.valid(p.package.version) || !p.files || Array.isArray(p.files) || typeof p.files !== 'object') throw new Error('Invalid extension package');
  validateManifest(p.package.codegraph, engineVersion);
  const files = Object.entries(p.files);
  if (files.length > 256 || files.some(([f, s]) => !safeFile(f) || typeof s !== 'string')) throw new Error('Package has an unsafe path, binary, or too many files');
  if (!safeFile(p.package.main) || !/\.[cm]?js$/.test(p.package.main) || !Object.hasOwn(p.files, p.package.main)) throw new Error('Package entry point is missing');
  return p;
}
