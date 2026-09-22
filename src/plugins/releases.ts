import * as semver from 'semver';
import { validateManifest } from './package';

/** Catalog metadata is only a selection hint. The installer validates the artifact again. */
export interface ExtensionRelease {
  id: string; version: string; apiVersion: number; engines: string;
  capabilities: string[]; integrity: string;
}
export interface ReleaseSelection {
  engineVersion: string;
  /** Exact pins, including prereleases, never fall back to another release. */
  version?: string;
  /** Automatic selection cannot replace an installed version with an older release. */
  currentVersion?: string;
}
export function validateExtensionId(id: unknown): asserts id is string {
  if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) throw new Error('Expected a lowercase extension id');
}
export function resolveRelease(raw: unknown, id: string, options: ReleaseSelection): ExtensionRelease {
  validateExtensionId(id);
  if (!semver.valid(options.engineVersion)) throw new Error('Cannot determine the connected CodeGraph version');
  if (options.version !== undefined && (typeof options.version !== 'string' || semver.valid(options.version) !== options.version)) throw new Error('Request an exact semantic version, such as 1.2.3 (prereleases require an exact pin)');
  if (!Array.isArray(raw)) throw new Error('Registry returned an invalid release catalog');
  if (options.currentVersion !== undefined && !semver.valid(options.currentVersion)) throw new Error('Installed version is invalid; request an explicit version to repair it');
  const candidates: ExtensionRelease[] = [], reasons: string[] = [];
  const versions = new Set<string>();
  for (const item of raw) {
    const r = item as ExtensionRelease;
    if (options.version !== undefined && r?.version !== options.version) continue;
    try {
      if (!r || r.id !== id || typeof r.version !== 'string' || semver.valid(r.version) !== r.version ||
          typeof r.integrity !== 'string' || !/^[a-f0-9]{64}$/.test(r.integrity) || typeof r.engines !== 'string') throw new Error('invalid release identity, version, integrity or engine range');
      if (versions.has(r.version)) throw new Error(`Registry returned duplicate immutable version ${r.version}`);
      versions.add(r.version);
      validateManifest({ id: r.id, apiVersion: r.apiVersion, capabilities: r.capabilities, engines: r.engines }, options.engineVersion);
      if (options.version === undefined && semver.prerelease(r.version)) throw new Error('prerelease requires an exact --version pin');
      if (options.version === undefined && options.currentVersion && semver.lt(r.version, options.currentVersion)) throw new Error(`would downgrade installed ${options.currentVersion}`);
      candidates.push(r);
    } catch (error) { reasons.push(`${r?.version ?? 'unknown'}: ${error instanceof Error ? error.message : String(error)}`); }
  }
  // A duplicate cannot be resolved safely by publication order or array order.
  if (reasons.some(r => r.includes('duplicate immutable version'))) throw new Error(reasons.find(r => r.includes('duplicate immutable version')));
  candidates.sort((a, b) => semver.rcompare(a.version, b.version) || a.version.localeCompare(b.version));
  if (candidates.length) return candidates[0]!;
  const requested = options.version === undefined ? 'compatible stable release' : `compatible exact release ${options.version}`;
  throw new Error(`No ${requested} for ${id} on CodeGraph ${options.engineVersion} (API 1)${options.currentVersion ? `; installed ${options.currentVersion} is unchanged` : ''}. ${reasons.slice(0, 8).join('; ') || 'Release not found.'}`);
}
