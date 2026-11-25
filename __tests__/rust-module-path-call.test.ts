/**
 * A Rust call written through a module path — `crate::util::take(3)`,
 * `super::util::take(3)`, `self::util::take(3)`, `util::take(3)` after
 * `use crate::util;` — is the free function that module declares, and so is
 * a `use crate::util::take;`. A path never names a method (that takes
 * `Type::method`), nor a function local to another function's body, even when
 * the module's file declares one of the same name above the free function.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

let root = '';
let cg: CodeGraph;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-rust-module-path-'));
  const files: Record<string, string> = {
    'Cargo.toml': '[package]\nname = "app"\nversion = "0.1.0"\n',
    'src/lib.rs': `mod util;
mod only;
mod a;
mod caller;
mod importer;
mod handle;
mod worker;
mod twice;
mod inline_reexport;
mod fs;
mod uses_std;
mod b;
mod x;
mod types;
mod type_;
mod decoy_list;
mod uses_config;
mod walks;
mod plat;

pub struct Config;

pub fn root_fn() -> usize {
    0
}

pub fn via_self() -> usize {
    self::util::take(1)
}
`,
    // `super::x` and `crate::x`, with no module between them and the item.
    'src/b/mod.rs': 'pub mod c;\npub fn helper() -> usize {\n    1\n}\n',
    'src/b/c.rs': 'pub fn helper() -> usize {\n    2\n}\npub fn via_bare_super() -> usize {\n    super::helper()\n}\npub fn via_bare_crate() -> usize {\n    crate::root_fn()\n}\n',
    // `super` in an inline `mod tests { }` is the file's own module, not its directory's parent.
    'src/x/mod.rs': 'pub mod tested;\npub mod shared;\npub struct Config;\npub fn root_fn() -> usize {\n    9\n}\n',
    'src/x/shared.rs': 'pub fn helper() -> usize {\n    3\n}\n',
    'src/x/tested.rs': `mod shared;

pub fn tested_helper() -> usize {
    4
}

#[cfg(test)]
mod tests {
    use super::tested_helper;

    fn via_inline_super() -> usize {
        super::shared::helper() + tested_helper()
    }
}
`,
    'src/x/tested/shared.rs': 'pub fn helper() -> usize {\n    5\n}\n',
    // A module's item it passes on: a `pub use`, a `pub use …::*`.
    'src/types/mod.rs': 'mod list;\npub use self::list::make_list;\n',
    'src/types/list.rs': 'pub fn make_list() -> usize {\n    6\n}\n',
    'src/decoy_list.rs': 'pub fn make_list() -> usize {\n    7\n}\n',
    'src/type_/mod.rs': 'pub mod prelude;\npub use prelude::*;\n\npub struct Type;\n\nimpl Type {\n    pub fn list() -> usize {\n        8\n    }\n}\n',
    'src/type_/prelude.rs': 'pub fn list() -> usize {\n    9\n}\n',
    'src/uses_config.rs': 'use crate::{Config};\n',
    // A re-export written in a macro's braces, as `cfg_if!` takes them, is the module's.
    'src/plat/mod.rs': 'cfg_if::cfg_if! {\n    if #[cfg(unix)] {\n        mod unix;\n        pub use self::unix::open;\n    }\n}\n',
    'src/plat/unix.rs': 'pub fn open() -> usize {\n    10\n}\n',
    'src/decoy_open.rs': 'pub fn open() -> usize {\n    11\n}\n',
    'src/walks.rs': `pub fn via_reexport() -> usize {
    crate::types::make_list()
}

pub fn via_glob() -> usize {
    crate::type_::list()
}

pub fn via_macro_reexport() -> usize {
    crate::plat::open()
}

pub fn via_block_std() {
    use std::fs;
    let _ = fs::read("config.toml");
}
`,
    // A namesake in an inline module, before the module's own item.
    'src/twice.rs': `#[cfg(test)]
mod tests {
    pub fn pick() -> usize {
        0
    }
}

pub fn pick() -> usize {
    1
}

pub fn via_twice() -> usize {
    crate::twice::pick()
}
`,
    // The item lives in an inline module the file passes on with a glob.
    'src/inline_reexport.rs': `#[cfg(unix)]
mod imp {
    pub fn lone() {}
}
pub use imp::*;

pub fn via_inline() {
    crate::inline_reexport::lone();
}
`,
    // A project module named like a module of the standard library.
    'src/fs/mod.rs': 'pub fn read(path: &str) -> usize {\n    path.len()\n}\n',
    'src/uses_std.rs': `use std::fs;

pub fn loads() {
    let _ = fs::read("config.toml");
}
`,
    'src/util.rs': `pub struct Buf;

impl Buf {
    pub fn take(&self, n: usize) -> usize {
        n
    }
}

pub trait Take {
    fn take(&self) -> usize;
}

fn outer() -> usize {
    fn take() -> usize {
        0
    }
    take()
}

pub fn take(n: usize) -> usize {
    n
}
`,
    'src/only.rs': `pub struct Only;

impl Only {
    pub fn grab(&self) -> usize {
        0
    }
}
`,
    'src/a/mod.rs': 'pub mod b;\n',
    'src/a/b.rs': `pub struct Deep;

impl Deep {
    pub fn get(&self) -> usize {
        0
    }
}

pub fn get() -> usize {
    1
}
`,
    'src/importer.rs': 'use crate::util::take;\n',
    'src/handle.rs': 'pub struct Handle;\n',
    'src/worker.rs': `pub use crate::handle::Handle;
mod dump;

pub trait Lock {
    type Handle;
}

pub struct Guard;

impl Lock for Guard {
    type Handle = u8;
}
`,
    'src/worker/dump.rs': 'use super::Handle;\n',
    'src/caller.rs': `use crate::util;

pub fn via_crate() -> usize {
    crate::util::take(1)
}

pub fn via_super() -> usize {
    super::util::take(1)
}

pub fn via_module() -> usize {
    util::take(1)
}

pub fn via_nested() -> usize {
    crate::a::b::get()
}

pub fn via_method_only() -> usize {
    crate::only::grab()
}

pub fn via_missing() -> usize {
    crate::nowhere::take(1)
}
`,
  };
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  cg = await CodeGraph.init(root, { index: true });
});

afterAll(() => {
  cg?.close();
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

/** What the function `name` in `file` calls, as `kind qualifiedName file:line`. */
const callsFrom = (file: string, name: string): string[] => {
  const fn = cg.getNodesInFile(file).find((n) => n.name === name)!;
  return cg.getOutgoingEdgesFrom([fn.id]).filter((e) => e.kind === 'calls')
    .map((e) => cg.getNode(e.target)!).map((t) => `${t.kind} ${t.qualifiedName} ${t.filePath}:${t.startLine}`);
};

describe('Rust calls through a module path', () => {
  it('reach the free function the module declares, never a same-named method or local fn', () => {
    const take = 'function take src/util.rs:20';
    expect(callsFrom('src/caller.rs', 'via_crate')).toEqual([take]);
    expect(callsFrom('src/caller.rs', 'via_super')).toEqual([take]);
    expect(callsFrom('src/caller.rs', 'via_module')).toEqual([take]);
    expect(callsFrom('src/lib.rs', 'via_self')).toEqual([take]);
  });

  it('bind a use of the function to it', () => {
    const ids = cg.getNodesInFile('src/importer.rs').map((n) => n.id);
    const targets = cg.getOutgoingEdgesFrom(ids).filter((e) => e.kind === 'imports')
      .map((e) => cg.getNode(e.target)!).map((t) => `${t.kind} ${t.qualifiedName} ${t.filePath}:${t.startLine}`);
    expect(targets).toEqual(['function take src/util.rs:20']);
  });

  it('never bind a use to an associated type of the module\'s impl or trait', () => {
    const ids = cg.getNodesInFile('src/worker/dump.rs').map((n) => n.id);
    const targets = cg.getOutgoingEdgesFrom(ids).filter((e) => e.kind === 'imports')
      .map((e) => cg.getNode(e.target)!).map((t) => `${t.kind} ${t.qualifiedName} ${t.filePath}:${t.startLine}`);
    expect(targets.filter((t) => t.includes('src/worker.rs'))).toEqual([]);
  });

  it('walk a nested module path to its file', () => {
    expect(callsFrom('src/caller.rs', 'via_nested')).toEqual(['function get src/a/b.rs:9']);
  });

  it('link nothing when the module declares no such free function, or is not in the index', () => {
    expect(callsFrom('src/caller.rs', 'via_method_only')).toEqual([]);
    expect(callsFrom('src/caller.rs', 'via_missing')).toEqual([]);
  });

  it('prefer the module\'s own item to a namesake in a module it declares inline', () => {
    expect(callsFrom('src/twice.rs', 'via_twice')).toEqual(['function pick src/twice.rs:8']);
  });

  it('reach an inline module\'s item the module passes on, from the module\'s own file', () => {
    expect(callsFrom('src/inline_reexport.rs', 'via_inline')).toEqual(['function lone src/inline_reexport.rs:3']);
  });

  it('leave a path through a module a `use` takes from the standard library to it', () => {
    // `fs::read` under `use std::fs;` is std's, not `src/fs/mod.rs`'s `read`.
    expect(callsFrom('src/uses_std.rs', 'loads')).toEqual([]);
    expect(callsFrom('src/walks.rs', 'via_block_std')).toEqual([]);
  });

  it('reach the item of the module `super` and `crate` name, with no module between', () => {
    expect(callsFrom('src/b/c.rs', 'via_bare_super')).toEqual(['function helper src/b/mod.rs:2']);
    expect(callsFrom('src/b/c.rs', 'via_bare_crate')).toEqual(['function root_fn src/lib.rs:23']);
  });

  it('read `super` in an inline module as the module of its file', () => {
    expect(callsFrom('src/x/tested.rs', 'via_inline_super').sort()).toEqual([
      'function helper src/x/tested/shared.rs:1',
      'function tested_helper src/x/tested.rs:3',
    ]);
    const ids = cg.getNodesInFile('src/x/tested.rs').map((n) => n.id);
    const imported = cg.getOutgoingEdgesFrom(ids).filter((e) => e.kind === 'imports')
      .map((e) => cg.getNode(e.target)!).map((t) => `${t.kind} ${t.qualifiedName} ${t.filePath}:${t.startLine}`);
    expect(imported).toEqual(['function tested_helper src/x/tested.rs:3']);
  });

  it('reach an item the module passes on with a `pub use`, or a glob of one', () => {
    expect(callsFrom('src/walks.rs', 'via_reexport')).toEqual(['function make_list src/types/list.rs:1']);
    expect(callsFrom('src/walks.rs', 'via_glob')).toEqual(['function list src/type_/prelude.rs:1']);
    expect(callsFrom('src/walks.rs', 'via_macro_reexport')).toEqual(['function open src/plat/unix.rs:1']);
  });

  it('bind a `use crate::{Item}` to the crate root\'s item', () => {
    const ids = cg.getNodesInFile('src/uses_config.rs').map((n) => n.id);
    const imported = cg.getOutgoingEdgesFrom(ids).filter((e) => e.kind === 'imports')
      .map((e) => cg.getNode(e.target)!).map((t) => `${t.kind} ${t.qualifiedName} ${t.filePath}:${t.startLine}`);
    expect(imported).toEqual(['struct Config src/lib.rs:21']);
  });
});
