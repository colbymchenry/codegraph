/**
 * `codegraph.json` `exclude` — keep paths out of the index even when git-TRACKED
 * (#999).
 *
 * The escape hatch for a committed vendor/theme/SDK directory (a checked-in
 * Metronic theme under `static/`) that `.gitignore` cannot drop because git
 * tracks it. Two layers under test:
 *   1. Loader: parse/validate/cache, mirroring the `includeIgnored` loader.
 *   2. Behavior: `scanDirectory` drops excluded paths on BOTH the git
 *      (`git ls-files`) and non-git (filesystem walk) enumeration paths — and
 *      crucially for TRACKED files, which is the whole point.
 *
 * Invariant: every loader failure mode degrades to the zero-config default
 * (exclude nothing), never a throw.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFileSync } from 'node:child_process';
import { loadExcludePatterns, loadExtensionOverrides, loadIncludeIgnoredPatterns, clearProjectConfigCache } from '../src/project-config';
import { scanDirectory } from '../src/extraction';

describe('exclude loader (codegraph.json)', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-exclude-'));
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
    expect(loadExcludePatterns(dir)).toEqual([]);
  });

  it('loads a well-formed pattern array', () => {
    writeConfig({ exclude: ['static/', '**/vendor/**'] });
    expect(loadExcludePatterns(dir)).toEqual(['static/', '**/vendor/**']);
  });

  it('trims whitespace and drops blank / non-string entries', () => {
    writeConfig({ exclude: ['  static/  ', '', '   ', 42, null, 'vendor/'] });
    expect(loadExcludePatterns(dir)).toEqual(['static/', 'vendor/']);
  });

  it('ignores a non-array exclude value without throwing', () => {
    writeConfig({ exclude: 'static/' });
    expect(loadExcludePatterns(dir)).toEqual([]);
  });

  it('ignores malformed JSON without throwing', () => {
    writeConfig('{ not: valid json ');
    expect(loadExcludePatterns(dir)).toEqual([]);
  });

  it('coexists with extensions and includeIgnored in one file (shared single parse)', () => {
    writeConfig({ extensions: { '.foo': 'typescript' }, includeIgnored: ['pkgs/'], exclude: ['static/'] });
    expect(loadExtensionOverrides(dir)).toEqual({ '.foo': 'typescript' });
    expect(loadIncludeIgnoredPatterns(dir)).toEqual(['pkgs/']);
    expect(loadExcludePatterns(dir)).toEqual(['static/']);
  });

  it('picks up a changed config (mtime-invalidated cache)', () => {
    writeConfig({ exclude: ['static/'] });
    expect(loadExcludePatterns(dir)).toEqual(['static/']);

    writeConfig({ exclude: ['assets/'] });
    const future = new Date(Date.now() + 2000);
    fs.utimesSync(path.join(dir, 'codegraph.json'), future, future);

    expect(loadExcludePatterns(dir)).toEqual(['assets/']);
  });

  it('drops the patterns again when the config file is removed', () => {
    writeConfig({ exclude: ['static/'] });
    expect(loadExcludePatterns(dir)).toEqual(['static/']);
    fs.rmSync(path.join(dir, 'codegraph.json'));
    expect(loadExcludePatterns(dir)).toEqual([]);
  });
});

describe('exclude behavior — scanDirectory drops excluded paths (#999)', () => {
  let dir: string;
  const mk = (rel: string, content = 'export const x = 1;\n') => {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  };
  const writeConfig = (obj: unknown) =>
    fs.writeFileSync(path.join(dir, 'codegraph.json'), JSON.stringify(obj));

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-exclude-scan-'));
    clearProjectConfigCache();
  });
  afterEach(() => {
    clearProjectConfigCache();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const gitInit = () => {
    execFileSync('git', ['init', '-q'], { cwd: dir });
    execFileSync('git', ['add', '-A'], { cwd: dir });
    execFileSync('git', ['-c', 'user.email=a@b.c', '-c', 'user.name=t', 'commit', '-qm', 'x'], { cwd: dir });
  };

  it('keeps a TRACKED excluded dir out of the index (git path) — the core fix', () => {
    mk('app/main.ts');
    mk('static/theme/widget1.js');
    mk('static/theme/widget2.js');
    gitInit(); // static/ is now git-TRACKED — .gitignore could not drop it

    // Sanity: without exclude the tracked theme IS indexed.
    let files = scanDirectory(dir).map((f) => f.replace(/\\/g, '/'));
    expect(files).toContain('app/main.ts');
    expect(files.some((f) => f.startsWith('static/'))).toBe(true);

    // With exclude the tracked theme is gone, app code stays.
    writeConfig({ exclude: ['static/'] });
    clearProjectConfigCache();
    files = scanDirectory(dir).map((f) => f.replace(/\\/g, '/'));
    expect(files).toContain('app/main.ts');
    expect(files.some((f) => f.startsWith('static/'))).toBe(false);
  });

  it('excludes a tracked dir on the non-git filesystem-walk path too', () => {
    mk('app/main.ts');
    mk('static/theme/widget1.js');
    // No git init → scanDirectory falls back to the filesystem walk.
    writeConfig({ exclude: ['static/'] });
    clearProjectConfigCache();
    const files = scanDirectory(dir).map((f) => f.replace(/\\/g, '/'));
    expect(files).toContain('app/main.ts');
    expect(files.some((f) => f.startsWith('static/'))).toBe(false);
  });

  it('supports a double-star glob', () => {
    mk('src/a.ts');
    mk('packages/x/vendor/lib1.js');
    mk('packages/y/vendor/lib2.js');
    gitInit();
    writeConfig({ exclude: ['**/vendor/**'] });
    clearProjectConfigCache();
    const files = scanDirectory(dir).map((f) => f.replace(/\\/g, '/'));
    expect(files).toContain('src/a.ts');
    expect(files.some((f) => f.includes('/vendor/'))).toBe(false);
  });

  it('is a no-op with no exclude config (everything indexed)', () => {
    mk('app/main.ts');
    mk('static/theme/widget1.js');
    gitInit();
    const files = scanDirectory(dir).map((f) => f.replace(/\\/g, '/'));
    expect(files).toContain('app/main.ts');
    expect(files.some((f) => f.startsWith('static/'))).toBe(true);
  });
});
