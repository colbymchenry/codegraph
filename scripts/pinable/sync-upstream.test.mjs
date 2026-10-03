import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./sync-upstream.mjs', import.meta.url));
function fixture(t, conflict = false) {
  const cwd = mkdtempSync(join(tmpdir(), 'pinable-upstream-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  // Isolate tests from the developer's global Git configuration and signing.
  const env = { ...process.env, GIT_CONFIG_GLOBAL: join(cwd, 'no-global-config'), GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' };
  function git(...args) {
    const result = spawnSync('git', args, { cwd, env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  }
  function write(name, value) {
    mkdirSync(dirname(join(cwd, name)), { recursive: true });
    writeFileSync(join(cwd, name), value);
  }
  const read = name => readFileSync(join(cwd, name), 'utf8');
  function run(...args) {
    const result = spawnSync(process.execPath, [script, ...args], { cwd, env, encoding: 'utf8' });
    return { ...result, output: result.stdout + result.stderr };
  }
  function commit(message) { git('add', '.'); git('commit', '-m', message); return git('rev-parse', 'HEAD'); }
  git('init', '-b', 'main');
  git('config', 'user.name', 'Sync Test');
  git('config', 'user.email', 'sync-test@example.invalid');
  git('config', 'commit.gpgsign', 'false');
  git('config', 'core.autocrlf', 'false');
  write('README.md', 'upstream readme\n');
  write('src/engine.txt', 'base\n');
  const base = commit('upstream base');
  write('.pinable/upstream.json', JSON.stringify({ repository: 'colbymchenry/codegraph', branch: 'main', commit: base }, null, 2) + '\n');
  write('FORK.md', 'Pinable UI and workspace documentation\n');
  write('src/fork-ui.txt', 'preserve me\n');
  if (conflict) write('src/engine.txt', 'fork behavior\n');
  const fork = commit('fork changes');
  git('switch', '-c', 'upstream-side', base);
  write('README.md', 'upstream revised readme\n');
  write('src/engine.txt', 'upstream behavior\n');
  const upstream = commit('upstream update');
  git('update-ref', 'refs/remotes/upstream/main', upstream);
  git('switch', '-c', 'sync/test', fork);
  return { cwd, git, write, read, run, commit, base, fork, upstream };
}
function success(result) { assert.equal(result.status, 0, result.output); }
function failure(result, pattern) { assert.notEqual(result.status, 0, result.output); assert.match(result.output, pattern); }

test('prepares a real merge, preserves fork changes, pins upstream, and is idempotent after commit', t => {
  const f = fixture(t);
  success(f.run('--no-fetch'));
  assert.equal(f.git('rev-parse', 'HEAD'), f.fork, 'must not auto-commit');
  assert.equal(f.git('rev-parse', 'MERGE_HEAD'), f.upstream);
  assert.equal(JSON.parse(f.read('.pinable/upstream.json')).commit, f.upstream);
  assert.equal(f.read('src/fork-ui.txt'), 'preserve me\n');
  assert.equal(f.git('config', 'rerere.autoupdate'), 'false');
  f.git('commit', '-m', 'merge upstream');
  assert.equal(f.git('rev-list', '--parents', '-n', '1', 'HEAD').split(' ').length, 3);
  success(f.run('--check'));
  const head = f.git('rev-parse', 'HEAD');
  success(f.run('--no-fetch'));
  assert.equal(f.git('rev-parse', 'HEAD'), head);
  assert.equal(f.git('status', '--porcelain'), '');
});

test('a subsequent upstream README update merges without repeating the documentation conflict', t => {
  const f = fixture(t);
  success(f.run('--no-fetch'));
  f.git('commit', '-m', 'first sync');
  f.git('switch', 'upstream-side');
  f.write('README.md', 'second upstream revision\n');
  const next = f.commit('next upstream');
  f.git('update-ref', 'refs/remotes/upstream/main', next);
  f.git('switch', 'sync/test');
  success(f.run('--no-fetch'));
  assert.equal(f.read('FORK.md'), 'Pinable UI and workspace documentation\n');
  assert.equal(f.read('README.md'), 'second upstream revision\n');
  f.git('commit', '-m', 'second sync');
  success(f.run('--check'));
});

test('code conflicts stop safely; rerere replays but never stages an unreviewed resolution', t => {
  const f = fixture(t, true);
  failure(f.run('--no-fetch'), /Merge stopped/);
  assert.match(f.git('diff', '--name-only', '--diff-filter=U'), /engine/);
  assert.equal(JSON.parse(f.read('.pinable/upstream.json')).commit, f.base);
  failure(f.run('--finish'), /Unresolved conflicts/);
  f.write('src/engine.txt', 'upstream and fork behavior\n');
  f.git('add', 'src/engine.txt');
  success(f.run('--finish'));
  f.git('commit', '-m', 'reviewed conflict resolution');
  f.git('switch', '-c', 'sync/replay', f.fork);
  failure(f.run('--no-fetch'), /Merge stopped/);
  assert.equal(f.read('src/engine.txt'), 'upstream and fork behavior\n');
  assert.match(f.git('diff', '--name-only', '--diff-filter=U'), /engine/);
  f.git('add', 'src/engine.txt');
  success(f.run('--finish'));
});

for (const kind of ['untracked', 'unstaged', 'staged']) {
  test(`refuses a ${kind} dirty tree without changing HEAD`, t => {
    const f = fixture(t);
    f.write(kind === 'untracked' ? 'notes.txt' : 'src/fork-ui.txt', 'local work\n');
    if (kind === 'staged') f.git('add', 'src/fork-ui.txt');
    failure(f.run('--no-fetch'), /not clean/);
    assert.equal(f.git('rev-parse', 'HEAD'), f.fork);
  });
}
for (const branch of ['main', '--detach']) {
  test(`refuses to prepare on ${branch}`, t => {
    const f = fixture(t);
    f.git('switch', branch);
    failure(f.run('--no-fetch'), /dedicated sync branch/);
  });
}

test('detects committed README drift', t => {
  const f = fixture(t);
  f.write('README.md', 'fork documentation in the wrong file\n');
  f.commit('readme drift');
  failure(f.run('--check'), /README.md differs/);
});

test('refuses unrelated or rewritten upstream history', t => {
  const f = fixture(t);
  const unrelated = f.git('commit-tree', 'HEAD^{tree}', '-m', 'unrelated root');
  f.git('update-ref', 'refs/remotes/upstream/main', unrelated);
  failure(f.run('--no-fetch'), /history was rewritten or is unrelated/);
});

test('requires real ancestry rather than a squash-equivalent file tree', t => {
  const f = fixture(t);
  f.git('merge', '--squash', f.upstream);
  f.write('.pinable/upstream.json', JSON.stringify({ repository: 'colbymchenry/codegraph', branch: 'main', commit: f.upstream }) + '\n');
  f.commit('squashed upstream');
  failure(f.run('--check'), /not an ancestor/);
});

test('finish requires an active merge and checks staged README ownership', t => {
  const f = fixture(t);
  failure(f.run('--finish'), /No merge in progress/);
  success(f.run('--no-fetch'));
  f.write('README.md', 'incorrect resolution\n');
  failure(f.run('--finish'), /Unstaged tracked changes/);
  f.git('add', 'README.md');
  failure(f.run('--finish'), /Staged README.md must match/);
});

test('requires full history', t => {
  const f = fixture(t);
  f.write('.git/shallow', f.base + '\n');
  failure(f.run('--check'), /Full Git history/);
});

test('does not overwrite a misconfigured upstream remote', t => {
  const f = fixture(t);
  f.git('remote', 'add', 'upstream', 'https://example.invalid/not-upstream.git');
  failure(f.run(), /remote points elsewhere/);
  assert.equal(f.git('remote', 'get-url', 'upstream'), 'https://example.invalid/not-upstream.git');
});
