/**
 * scip-go (https://github.com/scip-code/scip-go) for Go modules.
 * Needs the Go toolchain; packages must build (`go list` succeeds), since
 * scip-go type-checks them.
 */

import { skipGroup } from '../syntax';
import type { IndexerSpec } from './index';
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
  // Composite literals `&T{…}`, `pkg.T{…}`, `Box[int]{…}` build a T. `[]T{`, `map[K]T{`, `[]*T{`
  // build the container; `) T {` / `) *pkg.T {` is a return type before a function body.
  literalShape: (tail, head) => {
    const t = skipGroup(tail.trimStart(), '[', ']');
    return !!t?.startsWith('{') && !/[\])]\s*\**\s*(\w+\.)?$/.test(head.trimEnd());
  },
};
