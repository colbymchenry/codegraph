/**
 * A name only a Rust glob brings in is an item of the module the glob walks
 * to. dioxus's examples write `use dioxus::prelude::*;` and then `Element` or
 * `use_signal(…)`, and the prelude re-exports them from dioxus-core and
 * dioxus-hooks — `pub use dioxus_core::{Element, …}`, `pub use crate::hooks::*`
 * through `pub use dioxus_hooks as hooks;`. Only an item declared in a file
 * named like the glob's last segment read as brought in, so all of those went
 * unlinked, while a glob over another crate's `types` module brought in this
 * crate's `types.rs` too.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

/** Writes `files` into a fresh temp dir and indexes it. */
async function indexProject(prefix: string, files: Record<string, string>): Promise<{ root: string; cg: CodeGraph }> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  return { root, cg: await CodeGraph.init(root, { index: true }) };
}

/** What `name`, written in `file`, links to, as `file@line` of each target, sorted. */
const targetsOf = (cg: CodeGraph, file: string, name: string, kinds: string[]): string[] => {
  const out: string[] = [];
  for (const node of cg.getNodesInFile(file)) {
    for (const edge of cg.getOutgoingEdges(node.id)) {
      if (!kinds.includes(edge.kind)) continue;
      const target = cg.getNode(edge.target)!;
      if (target.name === name) out.push(`${target.filePath}@${target.startLine}`);
    }
  }
  return [...new Set(out)].sort();
};

describe('a name a Rust glob brings in, by the module the glob walks', () => {
  let root = '';
  let cg: CodeGraph;

  beforeAll(async () => {
    ({ root, cg } = await indexProject('cg-rust-glob-', {
      'Cargo.toml': '[workspace]\nmembers = ["app", "core", "dioxus", "hooks", "rsx"]\n',
      'dioxus/Cargo.toml': '[package]\nname = "dioxus"\nversion = "0.1.0"\n\n[dependencies]\ndioxus-core = { path = "../core" }\ndioxus-hooks = { path = "../hooks" }\n',
      'dioxus/src/lib.rs': [
        'pub use dioxus_core::Ok;',
        'pub use dioxus_hooks as hooks;',
        '',
        'pub mod error;',
        'pub mod types;',
        '',
        'pub mod prelude {',
        '    pub use crate::hooks::*;',
        '    pub use crate::macros::*;',
        '    pub use dioxus_core::{Element, ScopeId};',
        '}',
        '',
      ].join('\n'),
      'dioxus/src/error.rs': 'pub type Result<T> = std::result::Result<T, String>;\n',
      'dioxus/src/types.rs': 'pub struct Config;\n',
      'core/Cargo.toml': '[package]\nname = "dioxus-core"\nversion = "0.1.0"\n',
      'core/src/lib.rs': 'pub type Element = Option<u8>;\n\npub struct ScopeId(pub usize);\n\n#[allow(non_snake_case)]\npub fn Ok<T>(value: T) -> Result<T, ()> {\n    Result::Ok(value)\n}\n',
      'hooks/Cargo.toml': '[package]\nname = "dioxus-hooks"\nversion = "0.1.0"\n\n[dependencies]\ndioxus-core = { path = "../core" }\n',
      // A module's own glob is its business: `pub use use_effect::*` passes on `use_effect`, not `Ok`.
      'hooks/src/lib.rs': 'mod use_effect;\nmod use_signal;\n\npub use use_effect::*;\npub use use_signal::*;\n',
      'hooks/src/use_effect.rs': 'use dioxus_core::*;\n\npub fn use_effect() {}\n',
      'hooks/src/use_signal.rs': 'pub fn use_signal<T>(init: T) -> T {\n    init\n}\n',
      // Namesakes nothing brings in.
      'rsx/Cargo.toml': '[package]\nname = "dioxus-rsx"\nversion = "0.1.0"\n',
      'rsx/src/lib.rs': 'pub struct Element;\n\npub struct ScopeId;\n\npub fn use_signal() {}\n',
      'app/Cargo.toml': '[package]\nname = "app"\nversion = "0.1.0"\n\n[dependencies]\ndioxus = { path = "../dioxus" }\n',
      'app/src/main.rs': [
        'mod a;',
        'mod error;',
        'mod run;',
        'mod types;',
        '',
        'use dioxus::prelude::*;',
        '',
        'fn app(scope: ScopeId) -> Element {',
        '    let count = use_signal(0);',
        '    use_effect();',
        '    None',
        '}',
        '',
        'fn parse() -> Result<u8, ()> {',
        '    Ok(1)',
        '}',
        '',
        'fn main() {}',
        '',
      ].join('\n'),
      'app/src/a/mod.rs': 'mod b;\nmod c;\n\npub fn helper() {}\n',
      'app/src/a/b.rs': 'use super::*;\n\npub fn run() {\n    helper();\n}\n',
      // A sibling's function: `use super::*` brings in the module `c`, not what it declares.
      'app/src/a/c.rs': 'pub fn helper() {}\n',
      'app/src/error.rs': 'pub type Result<T> = std::result::Result<T, ()>;\n',
      'app/src/types.rs': 'pub struct Config;\n',
      'app/src/run.rs': 'use crate::error::*;\nuse dioxus::types::*;\n\npub fn go(config: Config) -> Result<()> {\n    Ok(())\n}\n',
    }));
  }, 60_000);

  afterAll(() => {
    cg?.close();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it('`use dioxus::prelude::*` brings in what the prelude re-exports from another crate', () => {
    expect(targetsOf(cg, 'app/src/main.rs', 'Element', ['references'])).toEqual(['core/src/lib.rs@1']);
    expect(targetsOf(cg, 'app/src/main.rs', 'ScopeId', ['references'])).toEqual(['core/src/lib.rs@3']);
  });

  it('and what it globs in through a crate it passes on as a module', () => {
    expect(targetsOf(cg, 'app/src/main.rs', 'use_signal', ['calls'])).toEqual(['hooks/src/use_signal.rs@1']);
    expect(targetsOf(cg, 'app/src/main.rs', 'use_effect', ['calls'])).toEqual(['hooks/src/use_effect.rs@3']);
  });

  it('but only what each module passes on: a module\'s own `use … ::*` stays its own', () => {
    // `Ok(1)` is std's: the prelude never re-exports dioxus-core's `Ok`, only the crate root does.
    expect(targetsOf(cg, 'app/src/main.rs', 'Ok', ['calls'])).toEqual([]);
  });

  it('`use super::*` brings in the parent\'s items, not a sibling module\'s', () => {
    expect(targetsOf(cg, 'app/src/a/b.rs', 'helper', ['calls'])).toEqual(['app/src/a/mod.rs@4']);
  });

  it('a glob over another crate\'s module is that module, not a namesake of this crate\'s', () => {
    expect(targetsOf(cg, 'app/src/run.rs', 'Config', ['references'])).toEqual(['dioxus/src/types.rs@1']);
    expect(targetsOf(cg, 'app/src/run.rs', 'Result', ['references'])).toEqual(['app/src/error.rs@1']);
  });
});
