/**
 * Regression test: a project that lives in a SUBDIRECTORY of its git repository
 * saw every change silently dropped, so `codegraph status` always printed
 * "Index is up to date" while `codegraph sync` immediately reindexed the files.
 *
 * `git status --porcelain` prints paths relative to the REPOSITORY root no
 * matter what `cwd` it runs in (porcelain deliberately ignores
 * `status.relativePaths`), and it reports the whole repo rather than just `cwd`.
 * getGitChangedFiles fed those repo-relative paths straight into
 * `path.join(projectRoot, …)`, producing `<repo>/<sub>/<sub>/file` — a path that
 * cannot be read, so getChangedFiles dropped every entry.
 *
 * getGitVisibleFiles (the scan path) is NOT affected — `git ls-files` is both
 * cwd-relative and cwd-scoped — which is exactly why the two commands disagreed.
 * It is pinned here so the asymmetry stays deliberate.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { getGitChangedFiles, scanDirectory } from '../src/extraction/index';
import CodeGraph from '../src/index';

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
}

describe('change detection for a project inside a subdirectory of its repo', () => {
  const dirs: string[] = [];
  const graphs: CodeGraph[] = [];

  /**
   * A repo with a source file at the root and a project living in `app/`, all
   * committed — the layout where `status` and `sync` disagreed.
   */
  function makeRepoWithSubProject(): { repo: string; project: string } {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-subdir-'));
    dirs.push(repo);
    git(repo, ['init']);
    git(repo, ['config', 'user.email', 'test@example.com']);
    git(repo, ['config', 'user.name', 'test']);
    fs.writeFileSync(path.join(repo, 'outside.js'), 'function outside() {}\n');
    const project = path.join(repo, 'app');
    fs.mkdirSync(path.join(project, 'src'), { recursive: true });
    fs.writeFileSync(path.join(project, 'src', 'index.js'), 'function hello() {}\n');
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-m', 'init']);
    return { repo, project };
  }

  afterEach(() => {
    while (graphs.length) {
      try { graphs.pop()!.destroy(); } catch { /* already closed */ }
    }
    while (dirs.length) {
      fs.rmSync(dirs.pop()!, { recursive: true, force: true });
    }
  });

  it('reports a modified tracked file with a project-relative path', () => {
    const { project } = makeRepoWithSubProject();
    fs.writeFileSync(path.join(project, 'src', 'index.js'), 'function hello() { return 1; }\n');

    const changes = getGitChangedFiles(project);

    expect(changes).not.toBeNull();
    expect(changes!.modified).toContain('src/index.js');
  });

  it('reports an untracked new file with a project-relative path', () => {
    const { project } = makeRepoWithSubProject();
    fs.writeFileSync(path.join(project, 'src', 'added.js'), 'function added() {}\n');

    const changes = getGitChangedFiles(project);

    expect(changes).not.toBeNull();
    expect(changes!.added).toContain('src/added.js');
  });

  it('reports a deleted tracked file with a project-relative path', () => {
    const { project } = makeRepoWithSubProject();
    fs.unlinkSync(path.join(project, 'src', 'index.js'));

    const changes = getGitChangedFiles(project);

    expect(changes).not.toBeNull();
    expect(changes!.deleted).toContain('src/index.js');
  });

  it('ignores changes that live outside the project root', () => {
    const { repo, project } = makeRepoWithSubProject();
    fs.writeFileSync(path.join(repo, 'outside.js'), 'function outside() { return 1; }\n');
    fs.writeFileSync(path.join(repo, 'sibling.js'), 'function sibling() {}\n');

    const changes = getGitChangedFiles(project);

    expect(changes).not.toBeNull();
    const all = [...changes!.modified, ...changes!.added, ...changes!.deleted];
    expect(all).toHaveLength(0);
  });

  it('scans a subdirectory project with project-relative paths (getGitVisibleFiles)', () => {
    const { project } = makeRepoWithSubProject();

    const files = scanDirectory(project);

    expect(files).toContain('src/index.js');
    expect(files).not.toContain('outside.js');
    expect(files.some((f) => f.startsWith('..') || f.includes('app/app/'))).toBe(false);
  });

  it('status agrees with sync for a subdirectory project (end to end)', async () => {
    const { project } = makeRepoWithSubProject();
    const cg = CodeGraph.initSync(project, { config: { include: ['**/*.js'], exclude: [] } });
    graphs.push(cg);
    await cg.indexAll();

    fs.writeFileSync(path.join(project, 'src', 'index.js'), 'function renamedHello() { return 2; }\n');

    const changes = cg.getChangedFiles();
    expect(changes.modified).toContain('src/index.js');

    const result = await cg.sync();
    expect(result.filesModified).toBe(1);
    expect(cg.searchNodes('renamedHello').length).toBeGreaterThan(0);
  });

  it('still recurses into an untracked embedded repo below a subdirectory project (#1213)', () => {
    const { project } = makeRepoWithSubProject();
    const embedded = path.join(project, 'embedded');
    fs.mkdirSync(embedded);
    git(embedded, ['init']);
    fs.writeFileSync(path.join(embedded, 'inner.js'), 'function inner() {}\n');

    const changes = getGitChangedFiles(project);

    expect(changes).not.toBeNull();
    expect(changes!.added).toContain('embedded/inner.js');
  });

  it("applies the project's own .gitignore to subdirectory-project paths (#766)", () => {
    const { repo, project } = makeRepoWithSubProject();
    fs.writeFileSync(path.join(project, '.gitignore'), 'skipped/\n');
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-m', 'ignore']);
    fs.mkdirSync(path.join(project, 'skipped'));
    fs.writeFileSync(path.join(project, 'skipped', 'gen.js'), 'function gen() {}\n');
    fs.writeFileSync(path.join(project, 'src', 'kept.js'), 'function kept() {}\n');

    const changes = getGitChangedFiles(project);

    expect(changes).not.toBeNull();
    expect(changes!.added).toContain('src/kept.js');
    expect(changes!.added).not.toContain('skipped/gen.js');
  });

  it('falls back to a full scan when the parent repo gitignores the project dir', () => {
    const { repo, project } = makeRepoWithSubProject();
    fs.writeFileSync(path.join(repo, '.gitignore'), 'app/\n');
    git(repo, ['rm', '-r', '--cached', 'app']);
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-m', 'ignore app']);

    // git sees nothing inside `app/`, so the git fast path cannot answer at all —
    // it must decline (null) exactly like getGitVisibleFiles does, leaving the
    // caller on the filesystem scan that DOES index this project.
    expect(getGitChangedFiles(project)).toBeNull();
    expect(scanDirectory(project)).toContain('src/index.js');
  });

  it('keeps working when the project IS the repository root', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-atroot-'));
    dirs.push(repo);
    git(repo, ['init']);
    git(repo, ['config', 'user.email', 'test@example.com']);
    git(repo, ['config', 'user.name', 'test']);
    fs.mkdirSync(path.join(repo, 'src'));
    fs.writeFileSync(path.join(repo, 'src', 'index.js'), 'function hello() {}\n');
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-m', 'init']);
    fs.writeFileSync(path.join(repo, 'src', 'index.js'), 'function hello() { return 1; }\n');
    fs.writeFileSync(path.join(repo, 'src', 'added.js'), 'function added() {}\n');

    const changes = getGitChangedFiles(repo);

    expect(changes).not.toBeNull();
    expect(changes!.modified).toContain('src/index.js');
    expect(changes!.added).toContain('src/added.js');
  });

  it('keeps working for a project that is not in git at all', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-nogit-'));
    dirs.push(dir);
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(path.join(dir, 'src', 'index.js'), 'function hello() {}\n');

    expect(getGitChangedFiles(dir)).toBeNull();
    expect(scanDirectory(dir)).toContain('src/index.js');
  });
});
