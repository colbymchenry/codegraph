/**
 * Front-load hook project resolution (#964).
 *
 * The Claude `UserPromptSubmit` front-load hook must inject CodeGraph context
 * for the RIGHT project — including the monorepo case where the agent's cwd is
 * an un-indexed workspace root and the index lives in a sub-project. These test
 * `planFrontload` / `findIndexedSubprojectRoots` directly (the hook's decision
 * logic), since the end-to-end hook is validated by a live agent run, not a
 * unit test.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { planFrontload, findIndexedSubprojectRoots } from '../src/directory';

/** Make `dir` look indexed (isInitialized needs `.codegraph/codegraph.db`). */
function mkIndexed(dir: string): string {
  fs.mkdirSync(path.join(dir, '.codegraph'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.codegraph', 'codegraph.db'), '');
  return dir;
}
/** A workspace-root manifest so the down-scan gate (looksLikeProjectRoot) passes. */
function mkWorkspaceRoot(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), '{"private":true,"workspaces":["packages/*"]}');
  return dir;
}

describe('planFrontload — front-load hook project resolution (#964)', () => {
  let tmp: string;
  beforeEach(() => { tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-frontload-'))); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('cwd is itself indexed → front-load cwd (the common single-project case)', () => {
    mkIndexed(tmp);
    const plan = planFrontload(tmp, 'how does login work');
    expect(plan.exploreRoot).toBe(tmp);
    expect(plan.viaSubScan).toBe(false);
    expect(plan.nudgeProjects).toEqual([]);
  });

  it('a nested file under an indexed project resolves up to that project', () => {
    mkIndexed(tmp);
    const nested = path.join(tmp, 'src', 'deep');
    fs.mkdirSync(nested, { recursive: true });
    expect(planFrontload(nested, 'trace the flow').exploreRoot).toBe(tmp);
  });

  it('un-indexed workspace root with ONE indexed sub-project → front-load it (the #964 case)', () => {
    mkWorkspaceRoot(tmp);
    const api = mkIndexed(path.join(tmp, 'packages', 'api'));
    const plan = planFrontload(tmp, 'how does the request get handled');
    expect(plan.exploreRoot).toBe(api);
    expect(plan.viaSubScan).toBe(true);
    expect(plan.nudgeProjects).toEqual([]);
  });

  it('multiple indexed sub-projects, prompt names one by path → front-load it, nudge the rest', () => {
    mkWorkspaceRoot(tmp);
    const api = mkIndexed(path.join(tmp, 'packages', 'api'));
    const web = mkIndexed(path.join(tmp, 'packages', 'web'));
    const plan = planFrontload(tmp, 'in packages/api, how does the handler validate the token?');
    expect(plan.exploreRoot).toBe(api);
    expect(plan.viaSubScan).toBe(true);
    expect(plan.nudgeProjects).toEqual([web]);
  });

  it('multiple indexed sub-projects, prompt names one by package name → front-load it', () => {
    mkWorkspaceRoot(tmp);
    mkIndexed(path.join(tmp, 'packages', 'api'));
    const web = mkIndexed(path.join(tmp, 'packages', 'web'));
    const plan = planFrontload(tmp, 'how does the web frontend render the dashboard?');
    expect(plan.exploreRoot).toBe(web);
  });

  it('multiple indexed sub-projects, NO clear match → nudge the full list, do not guess', () => {
    mkWorkspaceRoot(tmp);
    const api = mkIndexed(path.join(tmp, 'packages', 'api'));
    const web = mkIndexed(path.join(tmp, 'packages', 'web'));
    const plan = planFrontload(tmp, 'how does authentication work end to end?');
    expect(plan.exploreRoot).toBeNull();
    expect(plan.viaSubScan).toBe(true);
    expect(plan.nudgeProjects.sort()).toEqual([api, web].sort());
  });

  it('un-indexed dir that is NOT a workspace root → no-op (guards $HOME-style crawls)', () => {
    // Indexed project exists below, but cwd has no manifest, so the down-scan is skipped.
    mkIndexed(path.join(tmp, 'some', 'project'));
    const plan = planFrontload(tmp, 'how does it work');
    expect(plan.exploreRoot).toBeNull();
    expect(plan.nudgeProjects).toEqual([]);
  });

  it('nothing indexed anywhere → no-op', () => {
    mkWorkspaceRoot(tmp);
    fs.mkdirSync(path.join(tmp, 'packages', 'api'), { recursive: true });
    const plan = planFrontload(tmp, 'how does it work');
    expect(plan.exploreRoot).toBeNull();
    expect(plan.nudgeProjects).toEqual([]);
  });
});

describe('findIndexedSubprojectRoots', () => {
  let tmp: string;
  beforeEach(() => { tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-subscan-'))); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('finds indexed projects a couple levels down and skips node_modules/.git', () => {
    mkIndexed(path.join(tmp, 'packages', 'api'));
    mkIndexed(path.join(tmp, 'services', 'auth'));
    // Decoys that must NOT be scanned into.
    mkIndexed(path.join(tmp, 'node_modules', 'dep'));
    mkIndexed(path.join(tmp, '.git', 'x'));
    const found = findIndexedSubprojectRoots(tmp).map((p) => path.relative(tmp, p)).sort();
    expect(found).toEqual([path.join('packages', 'api'), path.join('services', 'auth')].sort());
  });

  it('does not descend INTO an indexed project (a project\'s sub-dirs are not separate projects)', () => {
    const api = mkIndexed(path.join(tmp, 'packages', 'api'));
    mkIndexed(path.join(api, 'submodule')); // nested index under an already-indexed project
    const found = findIndexedSubprojectRoots(tmp);
    expect(found).toEqual([api]);
  });

  it('respects the depth bound', () => {
    mkIndexed(path.join(tmp, 'a', 'b', 'c', 'd', 'e', 'deep'));
    expect(findIndexedSubprojectRoots(tmp, { maxDepth: 2 })).toEqual([]);
  });
});
