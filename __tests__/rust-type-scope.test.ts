/**
 * A bare Rust type or function from another file is in scope only through a
 * `use` that binds it (or a glob over its module), and one the file imports
 * from outside the project — `use std::task::{Context, Poll}` — is that
 * outside item: tokio's 1,221 `io::Result<…>` bound to a private
 * `runtime::task::Result` alias, its 642 `Context<'_>` to
 * `runtime::context::Context`. A path names its module (`io::Result` is no
 * `task` alias; `std::io::Error` is std's), a project crate's name
 * (`clap::Command`) re-exports as `crate::` does, and an inline test module
 * (`mod support { pub mod panic; }`) is the project's own.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

let root = '';
let cg: CodeGraph;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-rust-scope-'));
  const files: Record<string, string> = {
    'Cargo.toml': `[package]\nname = "app"\nversion = "0.1.0"\n\n[dependencies]\nfutures = "0.3"\n`,
    'src/lib.rs': `pub mod runtime;\npub mod io;\npub mod net;\n`,
    'src/runtime/mod.rs': `pub mod context;\npub mod task;\npub mod driver;\n`,
    'src/runtime/context.rs': `pub struct Context {\n    pub depth: u8,\n}\n`,
    'src/runtime/task/mod.rs': `pub type Result<T> = std::result::Result<T, ()>;\n`,
    'src/io/mod.rs': `pub mod copy;\n`,
    'src/io/copy.rs': `pub struct Error;\n`,
    'src/net.rs': `use std::io;
use std::task::{Context, Poll};

pub fn poll_ready(cx: &mut Context<'_>) -> Poll<io::Result<()>> {
    let _ = cx;
    Poll::Ready(Ok(()))
}

pub fn fail() -> std::io::Error {
    std::io::Error::other("x")
}
`,
    'src/runtime/driver.rs': `use crate::runtime::context::Context;

pub fn enter(ctx: &Context) -> u8 {
    ctx.depth
}
`,
    'tests/support/panic.rs': `pub fn test_panic() {}\n`,
    'tests/io_panic.rs': `mod support {
    pub mod panic;
}
use support::panic::test_panic;

#[test]
fn panics() {
    test_panic();
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

const targetsFrom = (file: string) => {
  const ids = cg.getNodesInFile(file).map((n) => n.id);
  return cg.getOutgoingEdgesFrom(ids).filter((e) => e.kind !== 'contains').map((e) => cg.getNode(e.target)!.filePath);
};

describe('Rust names in scope', () => {
  it('an outside import, or a path through one, is never a project item', () => {
    const targets = targetsFrom('src/net.rs');
    expect(targets).not.toContain('src/runtime/context.rs');
    expect(targets).not.toContain('src/runtime/task/mod.rs');
    expect(targets).not.toContain('src/io/copy.rs');
  });

  it('a crate-local use, and an inline test module, still reach the project item', () => {
    expect(targetsFrom('src/runtime/driver.rs')).toContain('src/runtime/context.rs');
    expect(targetsFrom('tests/io_panic.rs')).toContain('tests/support/panic.rs');
  });
});
