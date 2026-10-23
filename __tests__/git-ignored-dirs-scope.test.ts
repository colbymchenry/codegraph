/**
 * The folders git reports as ignored are scoped as literal paths (#2849).
 *
 * The scope matcher the indexer, sync and watcher share also takes in the
 * folders `git ls-files -o -i --exclude-standard --directory` reports (#1728).
 * They used to be added as gitignore patterns, where a path of one segment has
 * no anchor: an ignored root `src/` (holding only a gitignored jib agent) hid
 * every `src/` in a Maven monorepo, and the index came up empty. A pattern
 * also reads a folder's name as syntax: `[draft]` as a character class, `a[b`
 * as a regex that throws on the first match, `#tmp` as a comment and `!keep`
 * as a negation. The CLI's `includeIgnored` hint wrote repo paths into
 * codegraph.json the same unanchored way.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import ignore from 'ignore';
import CodeGraph from '../src/index';
import {
  buildScopeIgnore,
  findUnindexedIgnoredRepos,
  includeIgnoredPatternFor,
  scanDirectory,
  scanDirectoryAsync,
} from '../src/extraction';
import { FileWatcher } from '../src/sync/watcher';
import { clearProjectConfigCache } from '../src/project-config';

const BIN = path.resolve(__dirname, '../dist/bin/codegraph.js');

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function write(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

/** A repo at `dir` with `tracked` committed, then `untracked` written for `.gitignore` to hide. */
function makeRepo(dir: string, tracked: Record<string, string>, untracked: Record<string, string> = {}): void {
  for (const [rel, content] of Object.entries(tracked)) write(path.join(dir, rel), content);
  git(dir, 'init', '-q');
  git(dir, 'add', '-A');
  git(dir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init');
  for (const [rel, content] of Object.entries(untracked)) write(path.join(dir, rel), content);
}

/** What git reports as ignored-untracked, relative to `cwd`. */
function gitIgnored(cwd: string): string[] {
  return git(cwd, 'ls-files', '-z', '-o', '-i', '--exclude-standard', '--directory').split('\0').filter(Boolean);
}

/** `rel` and every folder above it, in the forms the watcher asks about. */
function pathAndFolders(rel: string): string[] {
  const parts = rel.split('/');
  return [rel, ...parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join('/') + '/')];
}

const sorted = (files: Iterable<string>): string[] => [...files].sort();

describe('folders git reports as ignored are scoped as literal paths (#2849)', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-git-ignored-dirs-'));
    clearProjectConfigCache();
  });

  afterEach(() => {
    clearProjectConfigCache();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const JAVA = 'services/example/src/main/java/Example.java';
  const javaClass = (method: string) => `public class Example { public int ${method}() { return 1; } }\n`;

  it('indexes and syncs a monorepo whose root src/ holds only a gitignored jib agent', async () => {
    makeRepo(root, { '.gitignore': '*jib*\n**/opt/datadog\n', [JAVA]: javaClass('run') }, {
      'src/main/jib/opt/datadog/dd-java-agent.jar': 'jar\n',
    });
    expect(gitIgnored(root)).toContain('src/');

    expect(scanDirectory(root)).toEqual([JAVA]);
    expect(await scanDirectoryAsync(root)).toEqual([JAVA]);
    const scope = buildScopeIgnore(root);
    for (const p of pathAndFolders(JAVA)) expect(scope.ignores(p), p).toBe(false);
    expect(scope.ignores('src/')).toBe(true);
    expect(scope.ignores('src/main/jib/opt/datadog/dd-java-agent.jar')).toBe(true);

    const cg = CodeGraph.initSync(root);
    try {
      expect((await cg.indexAll()).filesIndexed).toBe(1);
      // A scoped sync of an edit there updates the file rather than dropping it.
      write(path.join(root, JAVA), javaClass('stop'));
      await cg.sync({ paths: [JAVA] });
      expect(cg.getFiles().map((f) => f.path)).toEqual([JAVA]);
      expect(cg.getNodesInFile(JAVA).map((n) => n.name)).toContain('stop');
    } finally {
      cg.close();
    }
  });

  it.each([
    { name: 'lib', gitignore: '/lib/\n', nested: 'packages/util/lib/strings.ts', output: 'lib/index.js' },
    // A feature folder kept in src/build/ is indexed (#2681).
    { name: 'build', gitignore: '/build/\n', nested: 'app/src/build/feature.ts', output: 'build/out.js' },
    // A nested dist/ the project re-includes on purpose.
    { name: 'dist', gitignore: '/dist/\n!packages/legacy/dist/\n', nested: 'packages/legacy/dist/legacy.js', output: 'dist/bundle.js' },
  ])('keeps a tracked $name/ below the root when git reports the root $name/ ignored', ({ name, gitignore, nested, output }) => {
    makeRepo(root, { '.gitignore': gitignore, 'index.ts': 'export const main = 1;\n', [nested]: 'export const kept = 1;\n' }, {
      [output]: 'module.exports = 1;\n',
    });
    expect(gitIgnored(root)).toEqual([`${name}/`]);

    expect(sorted(scanDirectory(root))).toEqual(sorted(['index.ts', nested]));
    const scope = buildScopeIgnore(root);
    for (const p of pathAndFolders(nested)) expect(scope.ignores(p), p).toBe(false);
    expect(scope.ignores(`${name}/`)).toBe(true);
    expect(scope.ignores(output)).toBe(true);
  });

  it('reads a reported folder named like a character class as that one folder', () => {
    makeRepo(root, { '.gitignore': '*draft*\n', 'src/a/alpha.ts': 'export const alpha = 1;\n', 'src/b.ts': 'export const b = 1;\n' }, {
      '[draft]/notes.ts': 'export const draft = 1;\n',
    });
    expect(gitIgnored(root)).toEqual(['[draft]/']);

    // As a pattern, `[draft]/` matched any folder named d, r, a, f or t.
    expect(sorted(scanDirectory(root))).toEqual(['src/a/alpha.ts', 'src/b.ts']);
    const scope = buildScopeIgnore(root);
    for (const p of pathAndFolders('src/a/alpha.ts')) expect(scope.ignores(p), p).toBe(false);
    expect(scope.ignores('[draft]/notes.ts')).toBe(true);
  });

  it('keeps the watcher on files under a nested namesake and off the reported folders, whatever their names', async () => {
    makeRepo(root, { '.gitignore': '*jib*\nscratch*/\n', [JAVA]: javaClass('run') }, {
      'src/main/jib/Agent.java': 'public class Agent {}\n',
      // An unterminated character class: as a pattern it threw on every match.
      'scratch[1/s.ts': 'export const s = 1;\n',
    });
    expect(gitIgnored(root)).toEqual(expect.arrayContaining(['src/', 'scratch[1/']));

    const syncFn = vi.fn().mockResolvedValue({ filesChanged: 0, durationMs: 0 });
    const watcher = new FileWatcher(root, syncFn, { inertForTests: true, debounceMs: 60_000 });
    try {
      expect(watcher.start()).toBe(true);
      await watcher.waitUntilReady();
      watcher.ingestEventForTests(JAVA);
      watcher.ingestEventForTests('src/main/jib/Agent.java');
      watcher.ingestEventForTests('scratch[1/s.ts');
      expect(watcher.getPendingFiles().map((p) => p.path)).toEqual([JAVA]);
    } finally {
      watcher.stop();
    }
    const scope = buildScopeIgnore(root);
    for (const p of pathAndFolders(JAVA)) expect(scope.ignores(p), p).toBe(false);
    expect(scope.ignores('scratch[1/')).toBe(true);
  });

  it('anchors the folders reported for a project in a subfolder of the repo to that subfolder', () => {
    const java = 'services/a/src/main/java/A.java';
    makeRepo(root, {
      '.gitignore': '*jib*\n/proj/#tmp/\n/proj/!keep/\n',
      'src/outside.ts': 'export const outside = 1;\n',
      [`proj/${java}`]: 'public class A {}\n',
      'proj/lib/keep.ts': 'export const keep = 1;\n',
    }, {
      'proj/src/main/jib/agent.jar': 'jar\n',
      'proj/#tmp/t.ts': 'export const t = 1;\n',
      'proj/!keep/k.ts': 'export const k = 1;\n',
    });
    const proj = path.join(root, 'proj');
    // git prints them relative to its cwd, the project: `src/`, not `proj/src/`.
    expect(gitIgnored(proj)).toEqual(expect.arrayContaining(['src/', '#tmp/', '!keep/']));

    expect(sorted(scanDirectory(proj))).toEqual(['lib/keep.ts', java]);
    const scope = buildScopeIgnore(proj);
    for (const p of pathAndFolders(java)) expect(scope.ignores(p), p).toBe(false);
    expect(scope.ignores('src/main/jib/agent.jar')).toBe(true);
    // Neither the repo root's rules nor these names reach the matcher any other
    // way; as patterns, they were a comment and a negation.
    expect(scope.ignores('#tmp/t.ts')).toBe(true);
    expect(scope.ignores('!keep/k.ts')).toBe(true);
  });

  it('suggests an includeIgnored entry that opts in only the repo it found', () => {
    makeRepo(path.join(root, 'mtc-a'), { 'src/a.ts': 'export const a = 1;\n' });
    makeRepo(root, { '.gitignore': '/mtc-a/\n/archive/\n' });

    // An empty index at a super-repo prints the opt-in snippet (#1156).
    const out = execFileSync(process.execPath, [BIN, 'init', '-y', root], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 120_000,
      env: {
        ...process.env,
        CODEGRAPH_NO_DAEMON: '1',
        CODEGRAPH_WASM_RELAUNCHED: '1',
        CODEGRAPH_TELEMETRY: '0',
        DO_NOT_TRACK: '1',
        NO_COLOR: '1',
      },
    });
    const snippet = out.match(/\{ "includeIgnored": \[[^\]]*\] \}/)?.[0];
    expect(snippet, out).toBeDefined();
    const { includeIgnored } = JSON.parse(snippet!) as { includeIgnored: string[] };
    expect(includeIgnored).toEqual(['/mtc-a/']);
    fs.writeFileSync(path.join(root, 'codegraph.json'), JSON.stringify({ includeIgnored }));
    clearProjectConfigCache();

    // Later an old copy of the same repo lands in another gitignored folder.
    // The opt-in is for the repo the hint named, not for every `mtc-a/`.
    makeRepo(path.join(root, 'archive', 'mtc-a'), { 'src/old.ts': 'export const old = 1;\n' });
    expect(scanDirectory(root)).toEqual(['mtc-a/src/a.ts']);
    expect(findUnindexedIgnoredRepos(root)).toEqual(['archive/mtc-a/']);
  }, 120_000);

  it('includeIgnoredPatternFor anchors the path and escapes glob characters', () => {
    const optsIn = (repo: string, dir: string) => ignore().add(includeIgnoredPatternFor(repo)).ignores(dir);
    expect(includeIgnoredPatternFor('repos/a/')).toBe('/repos/a/');
    expect(optsIn('mtc-a/', 'mtc-a/')).toBe(true);
    expect(optsIn('mtc-a/', 'archive/mtc-a/')).toBe(false);
    expect(optsIn('[draft]/', '[draft]/')).toBe(true);
    expect(optsIn('[draft]/', 'd/')).toBe(false);
    expect(optsIn('a*b/', 'a*b/')).toBe(true);
    expect(optsIn('a*b/', 'axxb/')).toBe(false);
    expect(optsIn('#tmp/', '#tmp/')).toBe(true);
    expect(optsIn('!keep/', '!keep/')).toBe(true);
  });
});
