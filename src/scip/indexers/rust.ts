/**
 * rust-analyzer's built-in SCIP emitter (`rust-analyzer scip`) for Cargo
 * projects and workspaces. Needs `cargo` on PATH (it loads cargo metadata and
 * runs build scripts / proc macros, as the IDE does). With rustup, install it
 * with `rustup component add rust-analyzer` — the rustup shim on PATH fails
 * until the component exists, which the `--version` probe catches.
 */

import { skipGroup } from '../syntax';
import type { IndexerSpec } from './index';
import { markerDirs } from './repo-files';

/** Each topmost Cargo.toml is a run: a workspace's members are indexed with it. */
const workspaces = (root: string) => markerDirs(root, 'Cargo.toml', { topmost: true });

export const rustIndexer: IndexerSpec = {
  lang: 'rust',
  tools: ['rust-analyzer'],
  codegraphLanguages: ['rust'],
  detect: root => workspaces(root).length > 0,
  cmd: 'rust-analyzer',
  probe: ['--version'],
  variantCalls: true,
  chainCallsAtStart: true,
  // `impl<…> path::Trait<…> for Type<…> {` on one line; an inherent `impl Type {` has no `for`.
  implHeader: line => {
    const m = /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:unsafe\s+)?impl\b\s*/.exec(line);
    if (!m) return null;
    const rest = skipGroup(line.slice(m[0].length), '<', '>'); // the impl's own generics
    if (rest === null) return null;
    const traitFrom = line.length - rest.length;
    const f = /\bfor\b/.exec(rest);
    return f ? { traitFrom, selfFrom: traitFrom + f.index + 3 } : null;
  },
  invocation: (root, outFile) => {
    const dirs = workspaces(root);
    return {
      runs: dirs.map((cwd, i) => {
        const output = dirs.length === 1 ? outFile : `${outFile}.part${i}`;
        return { label: cwd === '.' ? 'rust' : `rust (${cwd})`, args: ['scip', '.', '--output', output], output, cwd };
      }),
    };
  },
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
