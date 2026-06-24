import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { loadIgnorePatterns, clearProjectConfigCache } from '../src/project-config';
import { scanDirectory, buildDefaultIgnore, discoverEmbeddedRepoRoots } from '../src/extraction';
import { execFileSync } from 'child_process';

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cg-ignore-'));
}

function cleanupTempDir(dir: string): void {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const writeConfig = (dir: string, obj: unknown) =>
  fs.writeFileSync(
    path.join(dir, 'codegraph.json'),
    typeof obj === 'string' ? obj : JSON.stringify(obj),
  );

const write = (dir: string, rel: string, body: string) => {
  const p = path.join(dir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
};

// ---------------------------------------------------------------------------
// Unit: loadIgnorePatterns
// ---------------------------------------------------------------------------

describe('loadIgnorePatterns', () => {
  let dir: string;
  beforeEach(() => {
    dir = createTempDir();
    clearProjectConfigCache();
  });
  afterEach(() => {
    clearProjectConfigCache();
    cleanupTempDir(dir);
  });

  it('returns empty array when no codegraph.json exists', () => {
    expect(loadIgnorePatterns(dir)).toEqual([]);
  });

  it('returns empty array when codegraph.json has no ignore field', () => {
    writeConfig(dir, { extensions: { '.foo': 'typescript' } });
    expect(loadIgnorePatterns(dir)).toEqual([]);
  });

  it('loads valid ignore patterns', () => {
    writeConfig(dir, { ignore: ['resource/', 'data/', '*.generated.*'] });
    expect(loadIgnorePatterns(dir)).toEqual(['resource/', 'data/', '*.generated.*']);
  });

  it('skips non-string entries with a warning', () => {
    writeConfig(dir, { ignore: ['valid/', 123, null, 'also-valid/'] });
    const result = loadIgnorePatterns(dir);
    expect(result).toEqual(['valid/', 'also-valid/']);
  });

  it('skips empty/whitespace-only strings', () => {
    writeConfig(dir, { ignore: ['keep/', '', '   ', 'also-keep/'] });
    expect(loadIgnorePatterns(dir)).toEqual(['keep/', 'also-keep/']);
  });

  it('returns empty array for malformed JSON', () => {
    fs.writeFileSync(path.join(dir, 'codegraph.json'), '{not valid json');
    expect(loadIgnorePatterns(dir)).toEqual([]);
  });

  it('returns empty array when ignore is not an array', () => {
    writeConfig(dir, { ignore: 'resource/' });
    expect(loadIgnorePatterns(dir)).toEqual([]);
  });

  it('is mtime-cached (same result without re-reading)', () => {
    writeConfig(dir, { ignore: ['a/'] });
    const first = loadIgnorePatterns(dir);
    const second = loadIgnorePatterns(dir);
    expect(first).toBe(second);
  });
});

// ---------------------------------------------------------------------------
// Integration: buildDefaultIgnore respects codegraph.json ignore
// ---------------------------------------------------------------------------

describe('buildDefaultIgnore with codegraph.json ignore', () => {
  let dir: string;
  beforeEach(() => {
    dir = createTempDir();
    clearProjectConfigCache();
  });
  afterEach(() => {
    clearProjectConfigCache();
    cleanupTempDir(dir);
  });

  it('ignores paths matching codegraph.json patterns', () => {
    writeConfig(dir, { ignore: ['vendor/', '*.log'] });
    const ig = buildDefaultIgnore(dir);
    expect(ig.ignores('vendor/lib.ts')).toBe(true);
    expect(ig.ignores('output.log')).toBe(true);
    expect(ig.ignores('src/index.ts')).toBe(false);
  });

  it('merges with .gitignore patterns', () => {
    write(dir, '.gitignore', 'build/\n');
    writeConfig(dir, { ignore: ['data/'] });
    const ig = buildDefaultIgnore(dir);
    expect(ig.ignores('build/out.js')).toBe(true);
    expect(ig.ignores('data/file.csv')).toBe(true);
    expect(ig.ignores('src/app.ts')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Integration: scanDirectory excludes files matching codegraph.json ignore
// ---------------------------------------------------------------------------

describe('scanDirectory with codegraph.json ignore', () => {
  let dir: string;
  beforeEach(() => {
    dir = createTempDir();
    clearProjectConfigCache();
  });
  afterEach(() => {
    clearProjectConfigCache();
    cleanupTempDir(dir);
  });

  it('excludes files in ignored directories', () => {
    write(dir, 'src/index.ts', 'export const x = 1;');
    write(dir, 'vendor/lib.ts', 'export const y = 2;');
    writeConfig(dir, { ignore: ['vendor/'] });

    const files = scanDirectory(dir);
    expect(files).toContain('src/index.ts');
    expect(files.every((f) => !f.startsWith('vendor/'))).toBe(true);
  });

  it('excludes files matching glob patterns', () => {
    write(dir, 'src/app.ts', 'export const a = 1;');
    write(dir, 'src/app.generated.ts', 'export const b = 2;');
    writeConfig(dir, { ignore: ['*.generated.*'] });

    const files = scanDirectory(dir);
    expect(files).toContain('src/app.ts');
    expect(files.every((f) => !f.includes('.generated.'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Integration: embedded-repo discovery respects codegraph.json ignore
// ---------------------------------------------------------------------------

describe('discoverEmbeddedRepoRoots with codegraph.json ignore', () => {
  let dir: string;
  beforeEach(() => {
    dir = createTempDir();
    clearProjectConfigCache();
  });
  afterEach(() => {
    clearProjectConfigCache();
    cleanupTempDir(dir);
  });

  it('skips embedded repos in user-ignored directories', () => {
    // Initialize a parent git repo
    execFileSync('git', ['init'], { cwd: dir, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: dir, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir, stdio: 'pipe' });

    // Create a file and commit so the repo is non-empty
    write(dir, 'main.ts', 'export const main = 1;');
    execFileSync('git', ['add', '.'], { cwd: dir, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: dir, stdio: 'pipe' });

    // Create a nested git repo inside repos/child/
    const childDir = path.join(dir, 'repos', 'child');
    fs.mkdirSync(childDir, { recursive: true });
    execFileSync('git', ['init'], { cwd: childDir, stdio: 'pipe' });
    write(dir, 'repos/child/lib.ts', 'export const lib = 1;');

    // Gitignore the repos/ dir (so it becomes an "ignored embedded repo")
    write(dir, '.gitignore', 'repos/\n');

    // Without codegraph.json ignore — the embedded repo IS discovered
    clearProjectConfigCache();
    const withoutIgnore = discoverEmbeddedRepoRoots(dir);
    expect(withoutIgnore.some((r) => r.includes('repos/'))).toBe(true);

    // With codegraph.json ignore — the embedded repo is NOT discovered
    writeConfig(dir, { ignore: ['repos/'] });
    clearProjectConfigCache();
    const withIgnore = discoverEmbeddedRepoRoots(dir);
    expect(withIgnore.every((r) => !r.includes('repos/'))).toBe(true);
  });
});
