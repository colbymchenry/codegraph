/**
 * scip-go (https://github.com/scip-code/scip-go) for Go modules.
 * Needs the Go toolchain; packages must build (`go list` succeeds), since
 * scip-go type-checks them.
 */

import * as fs from 'fs';
import * as path from 'path';
import { skipGroup } from '../syntax';
import type { IndexerSpec } from './index';

export const goIndexer: IndexerSpec = {
  lang: 'go',
  tool: 'scip-go',
  codegraphLanguages: ['go'],
  detect: root => fs.existsSync(path.join(root, 'go.mod')),
  cmd: 'scip-go',
  invocation: (_root, outFile) => ({ runs: [{ label: 'go', args: ['index', '--quiet', '--output', outFile], output: outFile }] }),
  // Composite literals `&T{…}`, `pkg.T{…}`, `Box[int]{…}` build a T. `[]T{`, `map[K]T{`, `[]*T{`
  // build the container; `) T {` / `) *pkg.T {` is a return type before a function body.
  literalShape: (tail, head) => {
    const t = skipGroup(tail.trimStart(), '[', ']');
    return !!t?.startsWith('{') && !/[\])]\s*\**\s*(\w+\.)?$/.test(head.trimEnd());
  },
};
