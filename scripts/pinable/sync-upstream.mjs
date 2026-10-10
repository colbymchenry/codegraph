#!/usr/bin/env node
// Fork-only maintenance: preserve merge ancestry; never commit, push, reset or stash.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const manifestPath = '.pinable/upstream.json';
let root = process.cwd();
function git(args, allowFailure = false) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0 && !allowFailure) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || `git ${args.join(' ')} failed`);
  }
  return result;
}
const text = args => git(args).stdout.trim();
const ok = args => git(args, true).status === 0;
const ancestor = (a, b) => ok(['merge-base', '--is-ancestor', a, b]);
function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}
function manifest() {
  const config = JSON.parse(readFileSync(resolve(root, manifestPath), 'utf8'));
  requireCondition(config.repository === 'colbymchenry/codegraph' && config.branch === 'main',
    'Unexpected upstream. Review the maintenance script before changing the upstream repository/branch.');
  requireCondition(/^[0-9a-f]{40}$/.test(config.commit), 'Manifest must contain a full upstream commit SHA.');
  return config;
}
function writableBranch() {
  const branch = git(['symbolic-ref', '--quiet', '--short', 'HEAD'], true).stdout.trim();
  requireCondition(branch && branch.startsWith('sync/'),
    'Create a dedicated sync branch first: git switch -c sync/upstream-YYYY-MM-DD');
}
function check(config) {
  requireCondition(ancestor(config.commit, 'HEAD'), 'Recorded upstream commit is not an ancestor of HEAD. Do not squash sync merges.');
  requireCondition(text(['rev-parse', 'HEAD:README.md']) === text(['rev-parse', `${config.commit}:README.md`]),
    'README.md differs from the recorded upstream. Move fork documentation to FORK.md.');
  requireCondition(ok(['diff', '--quiet', 'HEAD', '--', 'README.md']), 'README.md has uncommitted changes.');
}
function finish(config) {
  writableBranch();
  const pending = git(['rev-parse', '--verify', 'MERGE_HEAD'], true);
  requireCondition(pending.status === 0, 'No merge in progress. Start with sync-upstream.mjs.');
  const target = pending.stdout.trim();
  requireCondition(/^[0-9a-f]{40}$/.test(target), 'Only a single upstream merge is supported.');
  requireCondition(ancestor(config.commit, target), 'Merge target does not descend from the recorded upstream.');
  requireCondition(ancestor(target, text(['rev-parse', '--verify', 'refs/remotes/upstream/main^{commit}'])),
    'Merge target is not part of the fetched upstream branch. Review it manually.');
  requireCondition(text(['diff', '--name-only', '--diff-filter=U']) === '',
    'Unresolved conflicts remain. Review the resolution and git add each resolved file.');
  requireCondition(ok(['diff', '--quiet']), 'Unstaged tracked changes remain. Review and stage them before --finish.');
  requireCondition(text(['rev-parse', ':README.md']) === text(['rev-parse', `${target}:README.md`]),
    'Staged README.md must match upstream. Keep fork documentation in FORK.md.');
  writeFileSync(resolve(root, manifestPath), JSON.stringify({ ...config, commit: target }, null, 2) + '\n');
  git(['add', '--', manifestPath]);
  console.log(`Prepared upstream ${target}. Review git diff --cached, run checks/tests, then git commit.\nMerge the resulting PR with a merge commit, never squash/rebase. Nothing was committed or pushed.`);
}
function prepare(config, noFetch) {
  writableBranch();
  for (const state of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply']) {
    requireCondition(!existsSync(resolve(root, text(['rev-parse', '--git-path', state]))),
      'Another Git operation is in progress. Resolve it first; use --finish after resolving this sync.');
  }
  requireCondition(text(['status', '--porcelain']) === '', 'Working tree is not clean (including untracked files). Commit or move your changes first.');
  check(config);
  if (!noFetch) {
    const url = `https://github.com/${config.repository}.git`;
    const remote = git(['remote', 'get-url', 'upstream'], true);
    if (remote.status !== 0) git(['remote', 'add', 'upstream', url]);
    else requireCondition([url, url.slice(0, -4), `git@github.com:${config.repository}.git`].includes(remote.stdout.trim()),
      'The upstream remote points elsewhere. Review it manually; it will not be overwritten.');
    git(['fetch', '--no-tags', 'upstream', `refs/heads/${config.branch}:refs/remotes/upstream/${config.branch}`]);
  }
  const target = text(['rev-parse', '--verify', `refs/remotes/upstream/${config.branch}^{commit}`]);
  requireCondition(ancestor(config.commit, target), 'Upstream history was rewritten or is unrelated. Stop and review manually.');
  if (ancestor(target, 'HEAD')) {
    requireCondition(config.commit === target, 'Upstream is already integrated but the manifest is stale. Review and update the manifest separately.');
    console.log('Already synchronized; no changes.');
    return;
  }
  // Replayed conflict resolutions still require review and explicit git add.
  git(['config', '--local', 'rerere.enabled', 'true']);
  git(['config', '--local', 'rerere.autoupdate', 'false']);
  const merged = git(['merge', '--no-ff', '--no-commit', target], true);
  if (merged.stdout) process.stdout.write(merged.stdout);
  if (merged.stderr) process.stderr.write(merged.stderr);
  requireCondition(merged.status === 0,
    'Merge stopped. Review git status; resolve and git add conflicts, then run --finish. To cancel: git merge --abort. No side was selected automatically.');
  finish(config);
}
try {
  const args = process.argv.slice(2);
  requireCondition(args.length <= 1 && args.every(a => ['--check', '--finish', '--no-fetch', '--help'].includes(a)),
    'Usage: node scripts/pinable/sync-upstream.mjs [--check|--finish|--no-fetch|--help]');
  if (args[0] === '--help') {
    console.log('Default: fetch and prepare an uncommitted merge on a clean sync branch.\n--no-fetch: use reviewed local upstream/main.\n--finish: validate staged conflict resolutions and update the upstream manifest.\n--check: check committed ancestry and README ownership (safe in CI/detached HEAD).');
  } else {
    root = text(['rev-parse', '--show-toplevel']);
    requireCondition(text(['rev-parse', '--is-shallow-repository']) === 'false', 'Full Git history is required. Run git fetch --unshallow first.');
    const config = manifest();
    if (args[0] === '--check') { check(config); console.log('Upstream ancestry and README ownership verified.'); }
    else if (args[0] === '--finish') finish(config);
    else prepare(config, args[0] === '--no-fetch');
  }
} catch (error) {
  console.error(`upstream-sync: ${error.message}`);
  process.exitCode = 1;
}
