/**
 * rust-analyzer's built-in SCIP emitter (`rust-analyzer scip`) for Cargo
 * projects and workspaces. Needs `cargo` on PATH (it loads cargo metadata and
 * runs build scripts / proc macros, as the IDE does). With rustup, install it
 * with `rustup component add rust-analyzer` — the rustup shim on PATH fails
 * until the component exists, which the `--version` probe catches.
 */

import * as fs from 'fs';
import * as path from 'path';
import { skipGroup } from '../syntax';
import type { IndexerSpec } from './index';

export const rustIndexer: IndexerSpec = {
  lang: 'rust',
  tool: 'rust-analyzer',
  codegraphLanguages: ['rust'],
  detect: root => fs.existsSync(path.join(root, 'Cargo.toml')),
  cmd: 'rust-analyzer',
  probe: ['--version'],
  invocation: (_root, outFile) => ({ args: ['scip', '.', '--output', outFile] }),
  // Struct literals `T { … }`, `T::<U> { … }`, `path::T { … }` build a T.
  literalShape: (tail, head) => {
    let t: string | null = tail.trimStart();
    if (t.startsWith('::')) t = t.slice(2).trimStart(); // turbofish
    t = skipGroup(t, '<', '>');
    if (!t?.startsWith('{')) return false;
    // A type before a block: `-> T {`, `-> models::T {`, `impl T {`, `impl X for T {`, `where U: T {`.
    if (/(->|\bimpl\b[^{};]*|\bwhere\b[^{};]*)\s*[&'\w\s:]*$/.test(head)) return false;
    // A pattern, not a construction: `let T { a } = x`, `for T { a } in xs`,
    // `T { .. } =>`, `Some(T { a }) =>`, `T { a }: T`.
    if (/\b(let(\s+mut)?|for)\s+$/.test(head)) return false;
    const after = skipGroup(t, '{', '}');
    return after === null || !/^[)\]\s]*(=>|=(?!=)|:(?!:)|\||\bin\b)/.test(after);
  },
};
