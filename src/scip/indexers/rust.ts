/**
 * rust-analyzer's built-in SCIP emitter (`rust-analyzer scip`) for Cargo
 * projects and workspaces. Needs `cargo` on PATH (it loads cargo metadata and
 * runs build scripts / proc macros, as the IDE does). With rustup, install it
 * with `rustup component add rust-analyzer` — the rustup shim on PATH fails
 * until the component exists.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { IndexerSpec } from './index';

export const rustIndexer: IndexerSpec = {
  lang: 'rust',
  detect: root => fs.existsSync(path.join(root, 'Cargo.toml')),
  cmd: 'rust-analyzer',
  invocation: (_root, outFile) => ({ args: ['scip', '.', '--output', outFile] }),
};
