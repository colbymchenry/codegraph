/**
 * `codegraph.json` `includeIgnored` loader (#970, #976 / #622, #699).
 *
 * Parsing, validation, and mtime-caching of the opt-in patterns that re-include
 * gitignored directories for embedded-repo discovery. The behavioral end of this
 * feature (scanDirectory / discoverEmbeddedRepoRoots / sync honoring the patterns)
 * lives in `multi-repo-workspace.test.ts`; these are the loader unit tests,
 * mirroring the `extensions` loader coverage in `extension-mapping.test.ts`.
 *
 * Invariant under test: every failure mode degrades to the zero-config default
 * (empty patterns → `.gitignore` fully respected), never a throw.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { loadIncludeIgnoredPatterns, loadExtensionOverrides, clearProjectConfigCache } from '../src/project-config';

describe('includeIgnored loader (codegraph.json)', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-includeignored-'));
    clearProjectConfigCache();
  });
  afterEach(() => {
    clearProjectConfigCache();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const writeConfig = (obj: unknown) =>
    fs.writeFileSync(
      path.join(dir, 'codegraph.json'),
      typeof obj === 'string' ? obj : JSON.stringify(obj)
    );

  it('returns an empty list when there is no codegraph.json (the default)', () => {
    expect(loadIncludeIgnoredPatterns(dir)).toEqual([]);
  });

  it('loads a well-formed pattern array', () => {
    writeConfig({ includeIgnored: ['packages/', 'services/'] });
    expect(loadIncludeIgnoredPatterns(dir)).toEqual(['packages/', 'services/']);
  });

  it('trims whitespace and drops blank / non-string entries', () => {
    writeConfig({ includeIgnored: ['  packages/  ', '', '   ', 42, null, 'services/'] });
    expect(loadIncludeIgnoredPatterns(dir)).toEqual(['packages/', 'services/']);
  });

  it('ignores a non-array includeIgnored value without throwing', () => {
    writeConfig({ includeIgnored: 'packages/' });
    expect(loadIncludeIgnoredPatterns(dir)).toEqual([]);
  });

  it('ignores malformed JSON without throwing', () => {
    writeConfig('{ not: valid json ');
    expect(loadIncludeIgnoredPatterns(dir)).toEqual([]);
  });

  it('returns [] when the field is absent but other config is present', () => {
    writeConfig({ extensions: { '.foo': 'typescript' } });
    expect(loadIncludeIgnoredPatterns(dir)).toEqual([]);
  });

  it('coexists with extensions in one file (shared single parse)', () => {
    writeConfig({ extensions: { '.foo': 'typescript' }, includeIgnored: ['vendor/'] });
    expect(loadExtensionOverrides(dir)).toEqual({ '.foo': 'typescript' });
    expect(loadIncludeIgnoredPatterns(dir)).toEqual(['vendor/']);
  });

  it('picks up a changed config (mtime-invalidated cache)', () => {
    writeConfig({ includeIgnored: ['packages/'] });
    expect(loadIncludeIgnoredPatterns(dir)).toEqual(['packages/']);

    writeConfig({ includeIgnored: ['services/'] });
    // Force a distinct mtime in case the filesystem clock is coarse.
    const future = new Date(Date.now() + 2000);
    fs.utimesSync(path.join(dir, 'codegraph.json'), future, future);

    expect(loadIncludeIgnoredPatterns(dir)).toEqual(['services/']);
  });

  it('drops the patterns again when the config file is removed', () => {
    writeConfig({ includeIgnored: ['packages/'] });
    expect(loadIncludeIgnoredPatterns(dir)).toEqual(['packages/']);

    fs.rmSync(path.join(dir, 'codegraph.json'));
    expect(loadIncludeIgnoredPatterns(dir)).toEqual([]);
  });
});
