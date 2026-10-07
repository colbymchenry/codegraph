/**
 * scip-go (https://github.com/scip-code/scip-go) for Go modules.
 * Needs the Go toolchain; packages must build (`go list` succeeds), since
 * scip-go type-checks them.
 */

import * as path from 'path';
import { skipGroup } from '../syntax';
import type { IndexerRun, IndexerSpec } from './index';
import { markerDirs } from './repo-files';

/** Each module is its own run: a nested go.mod is a separate module, left out of the one around it. */
const modules = (root: string) => markerDirs(root, 'go.mod', { skip: ['testdata', 'vendor'] });

export const goIndexer: IndexerSpec = {
  lang: 'go',
  tools: ['scip-go'],
  codegraphLanguages: ['go'],
  detect: root => modules(root).length > 0,
  cmd: 'scip-go',
  invocation: (root, outFile) => {
    const dirs = modules(root);
    return {
      runs: dirs.map((cwd, i) => {
        const output = dirs.length === 1 ? outFile : `${outFile}.part${i}`;
        return { label: cwd === '.' ? 'go' : `go (${cwd})`, args: ['index', '--quiet', '--output', output], output, cwd };
      }),
    };
  },
  patch: {
    'scip-go': {
      units: (_root, files) => [...new Set(files.map(f => path.posix.dirname(f)))], // a package is its directory
      seconds: (_root, pkgs) => pkgs.length, // golang/tools: 2 packages in two modules re-indexed in 1.5 s
      runs(full, pkgs, outFile) {
        // Each package joins its module's run (the deepest module folder holding it), as a package pattern.
        const byModule = new Map<string, string[]>();
        const roots = full.map(r => r.cwd ?? '.').sort((a, b) => b.length - a.length);
        for (const pkg of pkgs) {
          const mod = roots.find(m => m === '.' || pkg === m || pkg.startsWith(`${m}/`));
          if (mod === undefined) return null; // not in any module we index
          byModule.set(mod, [...(byModule.get(mod) ?? []), pkg]);
        }
        const runs: IndexerRun[] = [];
        for (const [mod, list] of byModule) {
          const run = full.find(r => (r.cwd ?? '.') === mod)!;
          const at = run.args.indexOf('--output');
          if (at < 0) return null; // overridden args without an output we can redirect
          const output = `${outFile}.part${runs.length}`;
          const args = [...run.args];
          args[at + 1] = output;
          args.push(...list.map(p => `./${path.posix.relative(mod, p)}`.replace(/\/$/, '')));
          runs.push({ label: `${run.label}: ${list.length} package(s)`, args, output, cwd: mod, env: run.env });
        }
        return runs;
      },
    },
  },
  // Composite literals `&T{…}`, `pkg.T{…}`, `Box[int]{…}` build a T. `[]T{`, `map[K]T{`, `[]*T{`
  // build the container; `) T {` / `) *pkg.T {` is a return type before a function body.
  literalShape: (tail, head) => {
    const t = skipGroup(tail.trimStart(), '[', ']');
    return !!t?.startsWith('{') && !/[\])]\s*\**\s*(\w+\.)?$/.test(head.trimEnd());
  },
};
