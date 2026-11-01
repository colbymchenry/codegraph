/**
 * A resolver worker takes what the main thread read from the whole project
 * rather than reading it again. What it takes has to be what reading would have
 * given it, and a worker that takes nothing has to read for itself.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { ReferenceResolver } from '../src/resolution';
import { cppIncludeTargets } from '../src/resolution/cpp-includers';
import { cppNameMacros, cppNamespaceAliases } from '../src/resolution/cpp-namespaces';
import { MAX_FILES_SCANNED_ON_MAIN, readProjectScans } from '../src/resolution/project-scans';
import { ResolverPool } from '../src/resolution/resolver-pool';

type Queries = ConstructorParameters<typeof ReferenceResolver>[1];

describe('project scans', () => {
  let root: string;
  let cg: CodeGraph;
  const queries = (): Queries => (cg as unknown as { queries: Queries }).queries;
  const fresh = (): ReferenceResolver => {
    const resolver = new ReferenceResolver(root, queries());
    resolver.initialize([]);
    return resolver;
  };

  afterEach(() => {
    cg.destroy();
    fs.rmSync(root, { recursive: true, force: true });
  });

  describe('of a C++ project', () => {
    beforeEach(async () => {
      root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-project-scans-'));
      fs.mkdirSync(path.join(root, 'include'));
      fs.writeFileSync(path.join(root, 'include/names.h'), '#define MY_NAMESPACE acme\nnamespace py = pybind11;\nclass Base {};\n');
      fs.writeFileSync(path.join(root, 'main.cc'), '#include "include/names.h"\n#include <string>\nint main() { return 0; }\n');
      cg = await CodeGraph.init(root, { index: true });
    });

    it('gives a worker what reading gives it', () => {
      const reader = fresh();
      const scans = readProjectScans(reader.getResolutionContext(), queries(), new Map());
      expect(scans.cpp?.namespaces.aliases).toEqual(new Map([['py', 'pybind11']]));

      const worker = fresh();
      const context = worker.getResolutionContext();
      // Nothing is left to read: a read here would fail the test.
      const readFile = context.readFile;
      context.readFile = () => { throw new Error('read the project again'); };
      worker.adoptProjectScans(structuredClone(scans));
      expect(cppNamespaceAliases(context)).toEqual(cppNamespaceAliases(reader.getResolutionContext()));
      expect(cppNameMacros(context)).toEqual(new Map([['MY_NAMESPACE', 'acme']]));
      context.readFile = readFile;
      expect(cppIncludeTargets(context)).toEqual(cppIncludeTargets(reader.getResolutionContext()));
    });

    it('reads nothing on this thread for a project past the bound', () => {
      const context = fresh().getResolutionContext();
      context.readFile = () => { throw new Error('read the project on the main thread'); };
      expect(readProjectScans(context, queries(), new Map(), 1)).toEqual({});
    });

    it('takes the bound as the most it reads', () => {
      const scans = readProjectScans(fresh().getResolutionContext(), queries(), new Map(), 2);
      expect(scans.cpp?.namespaces.aliases).toEqual(new Map([['py', 'pybind11']]));
    });

    it('sends the pool scans from a full index, and nothing from a sync', async () => {
      const shareScans = vi.fn();
      vi.stubEnv('CODEGRAPH_PARALLEL_RESOLVE_MIN', '0');
      vi.spyOn(ResolverPool, 'tryCreate').mockReturnValue({
        ready: async () => undefined,
        destroy: async () => undefined,
        shareScans,
      } as unknown as ResolverPool);
      try {
        const dbPath = path.join(root, '.codegraph', 'codegraph.db');
        await fresh().resolveAndPersistBatched(undefined, 10, undefined, { dbPath }, false);
        expect(shareScans).not.toHaveBeenCalled();
        await fresh().resolveAndPersistBatched(undefined, 10, undefined, { dbPath, shareFrameworks: true }, false);
        expect(shareScans).toHaveBeenCalledTimes(1);
      } finally {
        vi.restoreAllMocks();
        vi.unstubAllEnvs();
      }
    });

    it('resolves each include the way the graph does', () => {
      const targets = cppIncludeTargets(fresh().getResolutionContext());
      expect([...targets.values()].sort((a, b) => String(a).localeCompare(String(b)))).toEqual(['include/names.h', null]);
    });
  });

  it('makes the same graph past the bound, each worker reading for itself', () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-project-scans-'));
    const repo = path.resolve(__dirname, '..');
    fs.writeFileSync(path.join(root, 'names.h'), 'namespace acme { void shared(); }\nnamespace py = acme;\n');
    const files = MAX_FILES_SCANNED_ON_MAIN + 1;
    for (let f = 0; f < files; f++) {
      fs.writeFileSync(path.join(root, `unit${f}.cc`), [
        '#include "names.h"',
        `void first${f}() { py::shared(); }`,
        `void second${f}() { first${f}(); py::shared(); }`,
        `void third${f}() { second${f}(); first${f}(); }`,
        '',
      ].join('\n'));
    }
    const graphOf = (env: NodeJS.ProcessEnv): { graph: string; log: string } => {
      const result = spawnSync(process.execPath, [path.join(repo, 'dist/bin/codegraph.js'), 'init', '-y', root], {
        cwd: root,
        encoding: 'utf8',
        env: { ...process.env, CODEGRAPH_NO_DAEMON: '1', CODEGRAPH_NO_UPDATE_CHECK: '1', DO_NOT_TRACK: '1', ...env },
      });
      expect(result.status, result.stderr).toBe(0);
      const graph = execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(repo, 'scripts/dump-graph.mjs'), root], { encoding: 'utf8', maxBuffer: 1 << 28 });
      fs.rmSync(path.join(root, '.codegraph'), { recursive: true, force: true });
      return { graph, log: result.stderr };
    };
    const alone = graphOf({ CODEGRAPH_NO_PARALLEL_RESOLVE: '1' });
    const pooled = graphOf({ CODEGRAPH_PARALLEL_RESOLVE_MIN: '0', CODEGRAPH_RESOLVE_WORKERS: '2', CODEGRAPH_SYNTH_TIMINGS: '1' });
    expect(pooled.log).toMatch(/project scans: none/);
    expect(pooled.log).toMatch(/batch pool: \d+ refs/);
    expect(alone.graph.length).toBeGreaterThan(1000);
    expect(pooled.graph === alone.graph).toBe(true);
    cg = { destroy: () => undefined } as unknown as CodeGraph;
  }, 180_000);

  it('holds nothing for a project with no C or C++', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-project-scans-'));
    fs.writeFileSync(path.join(root, 'app.ts'), 'export const app = 1;\n');
    cg = await CodeGraph.init(root, { index: true });
    const resolver = fresh();
    expect(readProjectScans(resolver.getResolutionContext(), queries(), new Map())).toEqual({});
    resolver.adoptProjectScans({});
  });
});
