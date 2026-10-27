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

pub fn via_self() -> usize {
    self::util::take(1)
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
  });
});
