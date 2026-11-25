/**
 * A private Rust item — no `pub` of any form — can be named only in its own
 * module and the modules inside it. dioxus's CLI declares a private `type
 * Result<T, E = PatchError>` in `src/build/patch.rs` beside the crate's own
 * `pub(crate) type Result<T, E = Error>` in `error.rs`, which 21 files bring
 * in with `use crate::Result`. Both read as in scope (`Result` is a prelude
 * name, and the file `use`s one), and the private alias took 158 of those
 * references. Type aliases now record their visibility, as functions and
 * structs already did, in both engines, and a private item outside its
 * module is out of scope.
 *
 * And a name a `use` binds is an item of the crate its path starts from, or
 * of a project crate that one depends on. Once tokio's private `fn spawn` in
 * `io/blocking.rs` stopped outranking the rest, its tests' `use
 * tokio_test::task::spawn` calls went to the examples crate's `pub fn spawn`.
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

describe('a private Rust item outside its module', () => {
  let root = '';
  let cg: CodeGraph;

  beforeAll(async () => {
    ({ root, cg } = await indexProject('cg-rust-private-', {
      'Cargo.toml': '[package]\nname = "cli"\nversion = "0.1.0"\n',
      'src/main.rs': 'mod error;\nmod codegen;\nmod serve;\nmod watch;\n\npub(crate) use error::*;\npub(crate) use codegen::*;\n\nfn main() {}\n',
      'src/error.rs': 'pub(crate) type Result<T, E = Error> = std::result::Result<T, E>;\n\npub struct Error;\n',
      'src/codegen/mod.rs': 'mod patch;\n\npub(crate) use patch::*;\n',
      'src/codegen/patch.rs': [
        'mod jump;',
        '',
        'type Result<T, E = PatchError> = std::result::Result<T, E>;',
        '',
        'pub struct PatchError;',
        '',
        'fn checksum(bytes: &[u8]) -> u32 {',
        '    bytes.len() as u32',
        '}',
        '',
        'pub fn apply(bytes: &[u8]) -> Result<u32> {',
        '    Ok(checksum(bytes))',
        '}',
        '',
      ].join('\n'),
      // A module inside `patch` sees its private items.
      'src/codegen/patch/jump.rs': 'use super::*;\n\npub fn jump(bytes: &[u8]) -> Result<u32> {\n    Ok(checksum(bytes))\n}\n',
      'src/serve.rs': 'use crate::Result;\n\npub fn serve() -> Result<()> {\n    Ok(())\n}\n',
      'src/watch.rs': 'use crate::{Error, Result};\n\npub fn watch() -> Result<(), Error> {\n    Ok(())\n}\n\nfn checksum(bytes: &[u8]) -> u32 {\n    bytes.len() as u32\n}\n\npub fn scan(bytes: &[u8]) -> u32 {\n    checksum(bytes)\n}\n',
    }));
  }, 60_000);

  afterAll(() => {
    cg?.close();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it('records the visibility of a type alias', () => {
    const aliases = (file: string) => cg.getNodesInFile(file).filter((n) => n.kind === 'type_alias').map((n) => n.visibility);
    expect(aliases('src/error.rs')).toEqual(['public']);
    expect(aliases('src/codegen/patch.rs')).toEqual(['private']);
  });

  it('is out of scope: `use crate::Result` names the crate\'s own alias', () => {
    expect(targetsOf(cg, 'src/serve.rs', 'Result', ['references'])).toEqual(['src/error.rs@1']);
    expect(targetsOf(cg, 'src/watch.rs', 'Result', ['references'])).toEqual(['src/error.rs@1']);
  });

  it('stays in scope in its own module and the modules inside it', () => {
    expect(targetsOf(cg, 'src/codegen/patch.rs', 'Result', ['references'])).toEqual(['src/codegen/patch.rs@3']);
    expect(targetsOf(cg, 'src/codegen/patch/jump.rs', 'Result', ['references'])).toEqual(['src/codegen/patch.rs@3']);
    expect(targetsOf(cg, 'src/codegen/patch/jump.rs', 'checksum', ['calls'])).toEqual(['src/codegen/patch.rs@7']);
  });

  it('keeps a private function to its module too', () => {
    expect(targetsOf(cg, 'src/watch.rs', 'checksum', ['calls'])).toEqual(['src/watch.rs@7']);
    expect(targetsOf(cg, 'src/codegen/patch.rs', 'checksum', ['calls'])).toEqual(['src/codegen/patch.rs@7']);
  });
});

describe('a name a Rust `use` binds, across a workspace', () => {
  let root = '';
  let cg: CodeGraph;

  beforeAll(async () => {
    ({ root, cg } = await indexProject('cg-rust-use-crate-', {
      'Cargo.toml': '[workspace]\nmembers = ["app", "examples", "facade", "helper"]\n\n[workspace.dependencies]\nhelper = { path = "helper" }\n',
      // helper through the workspace's table, written as a dotted key.
      'app/Cargo.toml': '[package]\nname = "app"\nversion = "0.1.0"\n\n[dependencies]\nfacade = { path = "../facade" }\n\n[dev-dependencies]\nhelper.workspace = true\n',
      'app/src/lib.rs': 'mod io;\n',
      'app/src/io/mod.rs': 'mod blocking;\n',
      // A private namesake nearer the test than the crate it names.
      'app/src/io/blocking.rs': 'fn spawn<F: FnOnce()>(f: F) {\n    f()\n}\n\npub(crate) fn run() {\n    spawn(|| {});\n}\n',
      'app/tests/notify.rs': [
        'use facade::Thing;',
        'use helper::task::spawn;',
        '',
        '#[test]',
        'fn notified() {',
        '    let _task = spawn(());',
        '}',
        '',
        'fn keep(thing: Thing) -> Thing {',
        '    thing',
        '}',
        '',
      ].join('\n'),
      // Nothing depends on the examples crate: its `pub fn spawn` is no one else's.
      'examples/Cargo.toml': '[package]\nname = "examples"\nversion = "0.1.0"\n\n[dependencies]\napp = { path = "../app" }\n',
      'examples/custom.rs': 'mod runtime {\n    pub fn spawn<T>(task: T) -> T {\n        task\n    }\n}\n\nfn main() {\n    runtime::spawn(());\n}\n',
      // A facade re-exports a crate it depends on: renamed, and no member of the workspace.
      'facade/Cargo.toml': '[package]\nname = "facade"\nversion = "0.1.0"\n\n[dependencies]\nshared = { package = "shared-types", path = "../types" }\n',
      'facade/src/lib.rs': 'pub use shared::Thing;\n',
      'helper/Cargo.toml': '[package]\nname = "helper"\nversion = "0.1.0"\n',
      'helper/src/lib.rs': 'pub mod task;\n',
      'helper/src/task.rs': 'pub fn spawn<T>(task: T) -> T {\n    task\n}\n',
      'types/Cargo.toml': '[package]\nname = "shared-types"\nversion = "0.1.0"\n',
      'types/src/lib.rs': 'pub struct Thing;\n',
    }));
  }, 60_000);

  afterAll(() => {
    cg?.close();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it('is an item of the crate its path names: `use helper::task::spawn` is helper\'s', () => {
    expect(targetsOf(cg, 'app/tests/notify.rs', 'spawn', ['calls'])).toEqual(['helper/src/task.rs@1']);
  });

  it('or one that crate re-exports from a crate it depends on', () => {
    expect(targetsOf(cg, 'app/tests/notify.rs', 'Thing', ['references'])).toEqual(['types/src/lib.rs@1']);
  });

  it('leaves a private item to its own module', () => {
    expect(targetsOf(cg, 'app/src/io/blocking.rs', 'spawn', ['calls'])).toEqual(['app/src/io/blocking.rs@1']);
  });
});
