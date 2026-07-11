/**
 * `codegraph.json` `include` — force first-party source INTO the index even when
 * `.gitignore` would drop it.
 *
 * The whitelist `includeIgnored` never was: that one only revives *embedded git
 * repos* inside ignored dirs (#622/#699), so pure source gitignored out of Git
 * (the SVN+Git dual-VCS case — committed to SVN, `.gitignore`d so it never lands
 * in Git) had no way in. Three layers under test:
 *   1. Loader: parse/validate/cache, mirroring the `exclude` loader.
 *   2. Behavior: `scanDirectory` adds included paths on BOTH the git
 *      (`git ls-files`) and non-git (filesystem walk) enumeration paths.
 *   3. Scope: `buildScopeIgnore` (the watcher's source of truth) treats an
 *      included file — and the gitignored dirs leading to it — as not-ignored.
 *
 * Invariants: an explicit `exclude` still wins; built-in default-ignored dirs
 * (`node_modules`, …) are never resurfaced; every loader failure mode degrades
 * to the zero-config default (force nothing in), never a throw.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFileSync } from 'node:child_process';
import {
  loadIncludePatterns,
  loadExcludePatterns,
  loadExtensionOverrides,
  loadIncludeIgnoredPatterns,
  clearProjectConfigCache,
} from '../src/project-config';
import { scanDirectory, buildScopeIgnore } from '../src/extraction';

describe('include loader (codegraph.json)', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-include-'));
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
    expect(loadIncludePatterns(dir)).toEqual([]);
  });

  it('loads a well-formed pattern array', () => {
    writeConfig({ include: ['Tools/', 'Local/**'] });
    expect(loadIncludePatterns(dir)).toEqual(['Tools/', 'Local/**']);
  });

  it('trims whitespace and drops blank / non-string entries', () => {
    writeConfig({ include: ['  Tools/  ', '', '   ', 42, null, 'Local/'] });
    expect(loadIncludePatterns(dir)).toEqual(['Tools/', 'Local/']);
  });

  it('ignores a non-array include value without throwing', () => {
    writeConfig({ include: 'Tools/' });
    expect(loadIncludePatterns(dir)).toEqual([]);
  });

  it('ignores malformed JSON without throwing', () => {
    writeConfig('{ not: valid json ');
    expect(loadIncludePatterns(dir)).toEqual([]);
  });

  it('coexists with extensions / includeIgnored / exclude in one file (shared single parse)', () => {
    writeConfig({
      extensions: { '.foo': 'typescript' },
      includeIgnored: ['pkgs/'],
      exclude: ['static/'],
      include: ['Tools/'],
    });
    expect(loadExtensionOverrides(dir)).toEqual({ '.foo': 'typescript' });
    expect(loadIncludeIgnoredPatterns(dir)).toEqual(['pkgs/']);
    expect(loadExcludePatterns(dir)).toEqual(['static/']);
    expect(loadIncludePatterns(dir)).toEqual(['Tools/']);
  });

  it('picks up a changed config (mtime-invalidated cache)', () => {
    writeConfig({ include: ['Tools/'] });
    expect(loadIncludePatterns(dir)).toEqual(['Tools/']);

    writeConfig({ include: ['Local/'] });
    const future = new Date(Date.now() + 2000);
    fs.utimesSync(path.join(dir, 'codegraph.json'), future, future);

    expect(loadIncludePatterns(dir)).toEqual(['Local/']);
  });

  it('drops the patterns again when the config file is removed', () => {
    writeConfig({ include: ['Tools/'] });
    expect(loadIncludePatterns(dir)).toEqual(['Tools/']);
    fs.rmSync(path.join(dir, 'codegraph.json'));
    expect(loadIncludePatterns(dir)).toEqual([]);
  });
});

describe('include behavior — scanDirectory force-indexes gitignored source', () => {
  let dir: string;
  const mk = (rel: string, content = 'export const x = 1;\n') => {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  };
  const writeConfig = (obj: unknown) =>
    fs.writeFileSync(path.join(dir, 'codegraph.json'), JSON.stringify(obj));
  const scan = () => scanDirectory(dir).map((f) => f.replace(/\\/g, '/'));

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-include-scan-'));
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

  it('indexes a .gitignored source dir when include opts it in (git path) — the core fix', () => {
    mk('app/main.ts');
    mk('Tools/gen.py', 'def gen():\n    return 1\n');
    fs.writeFileSync(path.join(dir, '.gitignore'), 'Tools/\n'); // SVN-only source, kept out of Git
    gitInit(); // Tools/ is gitignored → NOT tracked

    // Sanity: without include the gitignored source is invisible.
    let files = scan();
    expect(files).toContain('app/main.ts');
    expect(files.some((f) => f.startsWith('Tools/'))).toBe(false);

    // With include the gitignored source is forced in, app code still there.
    writeConfig({ include: ['Tools/'] });
    clearProjectConfigCache();
    files = scan();
    expect(files).toContain('app/main.ts');
    expect(files).toContain('Tools/gen.py');
  });

  it('forces gitignored source in on the non-git filesystem-walk path too', () => {
    mk('app/main.ts');
    mk('Tools/gen.py', 'def gen():\n    return 1\n');
    fs.writeFileSync(path.join(dir, '.gitignore'), 'Tools/\n');
    // No git init → scanDirectory falls back to the filesystem walk (which still
    // honours .gitignore), so Tools/ must be re-added by include.
    writeConfig({ include: ['Tools/'] });
    clearProjectConfigCache();
    const files = scan();
    expect(files).toContain('app/main.ts');
    expect(files).toContain('Tools/gen.py');
  });

  it('supports a recursive ** glob and nested dirs', () => {
    mk('src/a.ts');
    mk('Local/ts/a.ts');
    mk('Local/ts/nested/b.ts');
    fs.writeFileSync(path.join(dir, '.gitignore'), 'Local/\n');
    gitInit();
    writeConfig({ include: ['Local/**'] });
    clearProjectConfigCache();
    const files = scan();
    expect(files).toContain('Local/ts/a.ts');
    expect(files).toContain('Local/ts/nested/b.ts');
  });

  it('lets an explicit exclude win over include', () => {
    mk('Tools/keep.py', 'def k():\n    return 1\n');
    mk('Tools/secret/drop.py', 'def d():\n    return 1\n');
    fs.writeFileSync(path.join(dir, '.gitignore'), 'Tools/\n');
    gitInit();
    writeConfig({ include: ['Tools/'], exclude: ['Tools/secret/'] });
    clearProjectConfigCache();
    const files = scan();
    expect(files).toContain('Tools/keep.py');
    expect(files.some((f) => f.startsWith('Tools/secret/'))).toBe(false);
  });

  it('prunes an explicitly-excluded subtree under an included dir (a frontend own deps stay out)', () => {
    // The real-world case: an SVN-committed frontend is force-included, but its
    // own vendored deps live in a NON-default-named dir (`third_party/`) the
    // built-in ignore list does not cover, so it is excluded explicitly. The
    // whole subtree - nested files and all - must stay out, while sibling source
    // stays in.
    mk('Local/frontend/src/app.ts');
    mk('Local/frontend/src/util.ts');
    mk('Local/frontend/third_party/lib/a.ts');
    mk('Local/frontend/third_party/lib/nested/b.ts');
    fs.writeFileSync(path.join(dir, '.gitignore'), 'Local/\n');
    gitInit();
    writeConfig({ include: ['Local/frontend/'], exclude: ['Local/frontend/third_party/'] });
    clearProjectConfigCache();
    const files = scan();
    expect(files).toContain('Local/frontend/src/app.ts');
    expect(files).toContain('Local/frontend/src/util.ts');
    expect(files.some((f) => f.startsWith('Local/frontend/third_party/'))).toBe(false);
  });

  it('never resurrects a built-in default-ignored dir (node_modules) via include', () => {
    mk('src/a.ts');
    mk('node_modules/pkg/index.js');
    gitInit();
    // Even explicitly opting node_modules in must not pull it into the graph.
    writeConfig({ include: ['node_modules/'] });
    clearProjectConfigCache();
    const files = scan();
    expect(files).toContain('src/a.ts');
    expect(files.some((f) => f.startsWith('node_modules/'))).toBe(false);
  });

  it('is a no-op with no include config (gitignored source stays out)', () => {
    mk('app/main.ts');
    mk('Tools/gen.py', 'def gen():\n    return 1\n');
    fs.writeFileSync(path.join(dir, '.gitignore'), 'Tools/\n');
    gitInit();
    const files = scan();
    expect(files).toContain('app/main.ts');
    expect(files.some((f) => f.startsWith('Tools/'))).toBe(false);
  });
});

describe('include scope — buildScopeIgnore keeps included paths watchable', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-include-scope-'));
    clearProjectConfigCache();
    execFileSync('git', ['init', '-q'], { cwd: dir });
    fs.writeFileSync(path.join(dir, '.gitignore'), 'Tools/\nOther/\n');
    fs.writeFileSync(path.join(dir, 'codegraph.json'), JSON.stringify({ include: ['Tools/'] }));
  });
  afterEach(() => {
    clearProjectConfigCache();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('does not ignore an included file, nor the gitignored dir leading to it', () => {
    const scope = buildScopeIgnore(dir);
    // The included file and its (gitignored) directory are watchable.
    expect(scope.ignores('Tools/gen.py')).toBe(false);
    expect(scope.ignores('Tools/')).toBe(false);
    // A different gitignored dir that was NOT opted in stays ignored.
    expect(scope.ignores('Other/')).toBe(true);
    expect(scope.ignores('Other/x.py')).toBe(true);
  });

  it('still ignores everything when no include is configured', () => {
    fs.writeFileSync(path.join(dir, 'codegraph.json'), JSON.stringify({}));
    clearProjectConfigCache();
    const scope = buildScopeIgnore(dir);
    expect(scope.ignores('Tools/gen.py')).toBe(true);
    expect(scope.ignores('Tools/')).toBe(true);
  });
});
