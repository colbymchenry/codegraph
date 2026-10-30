/**
 * A Rust module loaded with `#[path = "…"]` is the module that declares it
 * (the Rust Reference, "The path attribute"): its `super` is the declaring
 * module, wherever the file lies, so `use super::*` brings in that module's
 * items, private ones included, and `crate::` is the declaring file's crate.
 * The path is read from the declaring file's directory, or from an inline
 * module's own directory. A module whose cfg alternatives each name a file,
 * or whose path a `cfg_attr` sets, depends on the build and stays unread.
 * A file several declarations load is each one's from its own side, and an
 * example the manifest places at a path of its own is its own crate's root.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

let root = '';
let cg: CodeGraph;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-rust-path-attr-'));
  const files: Record<string, string> = {
    'Cargo.toml': '[workspace]\nmembers = ["crates/core", "crates/py"]\nresolver = "2"\n',
    'crates/core/Cargo.toml': '[package]\nname = "core-crate"\nversion = "0.1.0"\nedition = "2021"\n\n[[example]]\nname = "demo"\npath = "examples/nested/demo.rs"\n',
    'crates/core/src/lib.rs': 'pub mod scaling;\npub mod platform;\npub mod util;\n\npub fn root_helper() -> i32 {\n    0\n}\n\npub mod gen_user;\n',
    'crates/core/src/util.rs': 'pub fn helper() -> i32 {\n    10\n}\n',
    // A folder whose name only starts with two dots is inside the project.
    'crates/core/src/gen_user.rs': '#[path = "..generated/gen.rs"]\nmod gen;\n\npub fn via_gen() -> i32 {\n    gen::make_gen()\n}\n',
    'crates/core/src/..generated/gen.rs': 'pub fn make_gen() -> i32 {\n    13\n}\n',
    // An example the manifest places at a path of its own: its own crate, whose `mod util;` is its sibling.
    'crates/core/examples/nested/demo.rs': 'mod util;\n\nfn main() {\n    let _ = crate::util::helper();\n}\n',
    'crates/core/examples/nested/util.rs': 'pub fn helper() -> i32 {\n    11\n}\n',
    // Two tests load one helper: from each, `support` is that file.
    'crates/core/tests/a.rs': '#[path = "support/helpers.rs"]\nmod support;\n\n#[test]\nfn uses_support() {\n    let _ = support::make();\n}\n',
    'crates/core/tests/b.rs': '#[path = "support/helpers.rs"]\nmod support;\n\n#[test]\nfn uses_support_too() {\n    let _ = support::make();\n}\n',
    'crates/core/tests/support/helpers.rs': 'pub fn make() -> i32 {\n    12\n}\n',
    'crates/core/src/scaling.rs': `pub fn predict_rating_multi(x: i32) -> i32 {
    x + 1
}

fn private_helper() -> i32 {
    2
}

#[cfg(test)]
#[path = "../../../tests/unit/scaling_tests.rs"]
mod tests;
`,
    'crates/core/src/platform.rs': `#[cfg(unix)]
#[path = "platform/unix_impl.rs"]
mod imp;
#[cfg(windows)]
#[path = "platform/windows_impl.rs"]
mod imp;

pub fn open() -> i32 {
    3
}

pub fn via_imp() -> i32 {
    imp::open_impl()
}

mod inline {
    #[path = "other.rs"]
    mod inner;
}

#[cfg_attr(docsrs, path = "docs_impl.rs")]
mod documented;

pub fn via_documented() -> i32 {
    documented::run()
}
`,
    'crates/core/src/platform/unix_impl.rs': 'pub fn open_impl() -> i32 {\n    1\n}\n',
    'crates/core/src/platform/windows_impl.rs': 'pub fn open_impl() -> i32 {\n    2\n}\n',
    // In a non-mod-rs file's inline module, the path starts at that module's own directory.
    'crates/core/src/platform/inline/other.rs': 'pub fn from_inner() -> i32 {\n    super::super::open()\n}\n',
    'crates/core/src/platform/other.rs': 'pub fn decoy() -> i32 {\n    4\n}\n',
    'crates/core/src/documented.rs': 'pub fn run() -> i32 {\n    5\n}\n',
    'crates/core/src/platform/docs_impl.rs': 'pub fn run() -> i32 {\n    6\n}\n',
    'crates/py/Cargo.toml': '[package]\nname = "py-crate"\nversion = "0.1.0"\nedition = "2021"\n',
    'crates/py/src/lib.rs': 'pub fn predict_rating_multi(x: i32) -> i32 {\n    x + 99\n}\n\npub fn private_helper() -> i32 {\n    98\n}\n\npub fn root_helper() -> i32 {\n    97\n}\n\npub fn open() -> i32 {\n    96\n}\n\npub fn make() -> i32 {\n    95\n}\n',
    'tests/unit/scaling_tests.rs': `use super::*;

#[test]
fn uses_private() {
    let _ = private_helper();
}

#[test]
fn uses_crate() {
    let _ = crate::root_helper();
}
`,
  };
  for (const [relative, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
    fs.writeFileSync(path.join(root, relative), content);
  }
  cg = await CodeGraph.init(root, { index: true });
});

afterAll(() => {
  cg?.close();
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

const calls = (file: string, name: string): string[] => {
  const fn = cg.getNodesInFile(file).find((n) => n.name === name && n.kind === 'function');
  expect(fn, `${file}:${name}`).toBeDefined();
  return cg.getOutgoingEdgesFrom([fn!.id]).filter((e) => e.kind === 'calls')
    .map((e) => cg.getNode(e.target)!).map((t) => `${t.qualifiedName} ${t.filePath}:${t.startLine}`).sort();
};

describe('Rust modules a #[path] attribute loads', () => {
  it('see the declaring module\'s private items through `use super::*`', () => {
    expect(calls('tests/unit/scaling_tests.rs', 'uses_private')).toEqual(['private_helper crates/core/src/scaling.rs:5']);
  });

  it('start `crate::` from the declaring file\'s crate', () => {
    expect(calls('tests/unit/scaling_tests.rs', 'uses_crate')).toEqual(['root_helper crates/core/src/lib.rs:5']);
  });

  it('read the path from an inline module\'s own directory', () => {
    expect(calls('crates/core/src/platform/inline/other.rs', 'from_inner')).toEqual(['open crates/core/src/platform.rs:8']);
  });

  it('follow each declaring file into a helper several tests load', () => {
    expect(calls('crates/core/tests/a.rs', 'uses_support')).toEqual(['make crates/core/tests/support/helpers.rs:1']);
    expect(calls('crates/core/tests/b.rs', 'uses_support_too')).toEqual(['make crates/core/tests/support/helpers.rs:1']);
  });

  it('read a path into a folder whose name only starts with two dots', () => {
    expect(calls('crates/core/src/gen_user.rs', 'via_gen')).toEqual(['make_gen crates/core/src/..generated/gen.rs:1']);
  });

  it('start an example the manifest places at a path of its own from that example', () => {
    expect(calls('crates/core/examples/nested/demo.rs', 'main')).toEqual(['helper crates/core/examples/nested/util.rs:1']);
  });

  it('leave a module whose cfg alternatives name a file each, or whose path a cfg_attr sets, unread', () => {
    expect(calls('crates/core/src/platform.rs', 'via_imp')).toEqual([]);
    expect(calls('crates/core/src/platform.rs', 'via_documented')).toEqual([]);
  });
});
