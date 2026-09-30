/**
 * scip-go (https://github.com/scip-code/scip-go) for Go modules.
 * Needs the Go toolchain; packages must build (`go list` succeeds), since
 * scip-go type-checks them.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { IndexerSpec } from './index';

export const goIndexer: IndexerSpec = {
  lang: 'go',
  detect: root => fs.existsSync(path.join(root, 'go.mod')),
  cmd: 'scip-go',
  invocation: (_root, outFile) => ({ args: ['index', '--quiet', '--output', outFile] }),
};
