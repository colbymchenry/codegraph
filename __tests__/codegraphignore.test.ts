/**
 * .codegraphignore Tests
 *
 * The project-root `.codegraphignore` is the final authority over what the
 * indexer includes — it overrides the built-in default-ignores AND every
 * `.gitignore` (root, nested, and git's own view). Force-include is code-aware:
 * a broad `!dir/` re-includes that subtree's source but NOT built-in dependency
 * dirs (node_modules, dist, …) unless an anchor reaches into them specifically.
 *
 * These tests exercise both scan paths: the filesystem walk (non-git temp dirs)
 * and the git fast path (real `git init` repos, where force-include must route
 * the scan onto the walk so git-ignored files can be resurfaced).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFileSync } from 'child_process';
import { scanDirectory, loadCodegraphOverride } from '../src/extraction';

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-cgi-'));
}

function cleanupTempDir(dir: string): void {
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

function write(root: string, rel: string, content = 'export const x = 1;\n'): void {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

function gitInit(dir: string): void {
  const opts = { cwd: dir, stdio: 'pipe' as const };
  execFileSync('git', ['init', '-q'], opts);
  execFileSync('git', ['config', 'user.email', 'test@test.com'], opts);
  execFileSync('git', ['config', 'user.name', 'Test'], opts);
}

function gitCommitAll(dir: string): void {
  const opts = { cwd: dir, stdio: 'pipe' as const };
  execFileSync('git', ['add', '-A'], opts);
  execFileSync('git', ['commit', '-q', '-m', 'init'], opts);
}

describe('.codegraphignore — loader', () => {
  let tempDir: string;
  beforeEach(() => { tempDir = createTempDir(); });
  afterEach(() => { cleanupTempDir(tempDir); });

  it('returns null when the file is absent', () => {
    expect(loadCodegraphOverride(tempDir)).toBeNull();
  });

  it('returns null for an empty or comments-only file', () => {
    fs.writeFileSync(path.join(tempDir, '.codegraphignore'), '\n  \n# just a comment\n');
    expect(loadCodegraphOverride(tempDir)).toBeNull();
  });

  it('reports hasForceInclude only when a "!" line exists', () => {
    fs.writeFileSync(path.join(tempDir, '.codegraphignore'), 'build/\n');
    expect(loadCodegraphOverride(tempDir)?.hasForceInclude).toBe(false);

    fs.writeFileSync(path.join(tempDir, '.codegraphignore'), '!vendor/\n');
    expect(loadCodegraphOverride(tempDir)?.hasForceInclude).toBe(true);
  });
});

describe('.codegraphignore — filesystem walk (non-git)', () => {
  let tempDir: string;
  beforeEach(() => { tempDir = createTempDir(); });
  afterEach(() => { cleanupTempDir(tempDir); });

  it('force-excludes a path that would otherwise be indexed', () => {
    write(tempDir, 'src/keep.ts');
    write(tempDir, 'src/drop.ts');
    fs.writeFileSync(path.join(tempDir, '.codegraphignore'), 'src/drop.ts\n');

    const files = scanDirectory(tempDir);
    expect(files).toContain('src/keep.ts');
    expect(files).not.toContain('src/drop.ts');
  });

  it('force-includes a file hidden by the root .gitignore', () => {
    write(tempDir, 'src/app.ts');
    write(tempDir, 'generated/out.ts');
    fs.writeFileSync(path.join(tempDir, '.gitignore'), 'generated/\n');
    fs.writeFileSync(path.join(tempDir, '.codegraphignore'), '!generated/\n');

    const files = scanDirectory(tempDir);
    expect(files).toContain('src/app.ts');
    expect(files).toContain('generated/out.ts');
  });

  it('force-includes files hidden by a NESTED .gitignore', () => {
    write(tempDir, 'app/src/app-admin/index.ts');
    write(tempDir, 'app/src/common/util.ts');
    // nested gitignore (relative to app/) hides the very dirs we want
    fs.writeFileSync(path.join(tempDir, 'app', '.gitignore'), 'src/app-*\nsrc/common\n');
    fs.writeFileSync(path.join(tempDir, '.codegraphignore'), '!app/src/\n');

    const files = scanDirectory(tempDir);
    expect(files).toContain('app/src/app-admin/index.ts');
    expect(files).toContain('app/src/common/util.ts');
  });

  it('descends into a dir excluded by .gitignore to reach a buried include', () => {
    // Mirrors the real repo: root ignores `environment`, which itself ignores
    // src/app-* and src/common; `!environment/src/` must reach all of it.
    write(tempDir, 'environment/src/app-fund/page.ts');
    write(tempDir, 'environment/src/common/links.ts');
    write(tempDir, 'environment/src/base/main.ts');
    fs.writeFileSync(path.join(tempDir, '.gitignore'), 'environment\n');
    fs.writeFileSync(path.join(tempDir, 'environment', '.gitignore'), 'src/app-*\nsrc/common\n');
    fs.writeFileSync(path.join(tempDir, '.codegraphignore'), '!environment/src/\n');

    const files = scanDirectory(tempDir);
    expect(files).toContain('environment/src/app-fund/page.ts');
    expect(files).toContain('environment/src/common/links.ts');
    expect(files).toContain('environment/src/base/main.ts');
  });

  it('code-aware: a broad include indexes code but NOT built-in dep dirs', () => {
    write(tempDir, 'environment/src/app-fund/page.ts');
    write(tempDir, 'environment/vite.config.ts');
    write(tempDir, 'environment/node_modules/pkg/index.js');
    write(tempDir, 'environment/dist/bundle.js');
    fs.writeFileSync(path.join(tempDir, '.gitignore'), 'environment\n');
    fs.writeFileSync(path.join(tempDir, '.codegraphignore'), '!environment/\n');

    const files = scanDirectory(tempDir);
    expect(files).toContain('environment/src/app-fund/page.ts');
    expect(files).toContain('environment/vite.config.ts'); // config IS code
    expect(files.some((f) => f.includes('node_modules'))).toBe(false);
    expect(files.some((f) => f.includes('/dist/') || f.startsWith('environment/dist/'))).toBe(false);
  });

  it('code-aware: an explicit anchor reaches surgically INTO a dep dir', () => {
    write(tempDir, 'env/node_modules/keep/index.js');
    write(tempDir, 'env/node_modules/other/index.js');
    fs.writeFileSync(path.join(tempDir, '.gitignore'), 'env\n');
    fs.writeFileSync(
      path.join(tempDir, '.codegraphignore'),
      '!env/\n!env/node_modules/keep/\n'
    );

    const files = scanDirectory(tempDir);
    expect(files).toContain('env/node_modules/keep/index.js');
    expect(files).not.toContain('env/node_modules/other/index.js');
  });

  it('does not affect an unrelated project (regression guard)', () => {
    write(tempDir, 'src/a.ts');
    write(tempDir, 'lib/b.ts');
    fs.writeFileSync(path.join(tempDir, '.codegraphignore'), '!only-this-dir/\n');

    // Force-include of a non-existent dir must not stop normal dirs being walked.
    const files = scanDirectory(tempDir);
    expect(files).toContain('src/a.ts');
    expect(files).toContain('lib/b.ts');
  });
});

describe('.codegraphignore — git fast path', () => {
  let tempDir: string;
  beforeEach(() => { tempDir = createTempDir(); });
  afterEach(() => { cleanupTempDir(tempDir); });

  it('routes to the walk and resurfaces a git-ignored file', () => {
    const root = path.join(tempDir, 'repo');
    fs.mkdirSync(root, { recursive: true });
    gitInit(root);
    write(root, 'src/tracked.ts');
    write(root, 'secret/buried.ts');
    fs.writeFileSync(path.join(root, '.gitignore'), 'secret/\n');
    gitCommitAll(root); // secret/ is git-ignored, never committed

    // Without override: git fast path drops the ignored file.
    expect(scanDirectory(root)).not.toContain('secret/buried.ts');

    // With force-include: routed to the walk, file resurfaces.
    fs.writeFileSync(path.join(root, '.codegraphignore'), '!secret/\n');
    const files = scanDirectory(root);
    expect(files).toContain('src/tracked.ts');
    expect(files).toContain('secret/buried.ts');
  });

  it('force-exclude works on the git fast path (no force-include present)', () => {
    const root = path.join(tempDir, 'repo');
    fs.mkdirSync(root, { recursive: true });
    gitInit(root);
    write(root, 'src/keep.ts');
    write(root, 'src/drop.ts');
    gitCommitAll(root);

    fs.writeFileSync(path.join(root, '.codegraphignore'), 'src/drop.ts\n');
    const files = scanDirectory(root);
    expect(files).toContain('src/keep.ts');
    expect(files).not.toContain('src/drop.ts');
  });
});
