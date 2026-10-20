/**
 * A Rust name written through a path is an item of what the path names: a
 * module (`ast::Pattern`, `io::Error`), a type (`Position::Record { … }`) or a
 * crate (`mio::Interest`, `std::ffi::OsStr`). An item of the file the path is
 * written in is that only when the path leads there: an inline `mod` of the
 * file, the item's own type, or the file's own module. A path's file was
 * enough before: clap's `std::ffi::OsStr` linked to its own `struct OsStr`,
 * its `io::Error` and `fmt::Error` to `error/mod.rs`'s `struct Error`, tokio's
 * `mio::Interest` to its own `Interest`, gleam's `ast::Pattern` to the
 * `enum Pattern` beside it, and a `Source::Record { … }` to another enum's
 * `Record` variant.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

/** What `file` links `name` to on `line`, as `kind qualifiedName file@line`, sorted. */
const targetsOn = (cg: CodeGraph, file: string, line: number, name: string): string[] => {
  const out: string[] = [];
  for (const node of cg.getNodesInFile(file)) {
    for (const edge of cg.getOutgoingEdges(node.id)) {
      if (edge.line !== line) continue;
      const target = cg.getNode(edge.target)!;
      if (target.name === name) out.push(`${target.kind} ${target.qualifiedName} ${target.filePath}@${target.startLine}`);
    }
  }
  return [...new Set(out)].sort();
};

describe('a Rust path into another module, type or crate', () => {
  let root = '';
  let cg: CodeGraph;

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-rust-path-file-'));
    const files: Record<string, string> = {
      'Cargo.toml': '[package]\nname = "rt"\nversion = "0.1.0"\n\n[dependencies]\nmio = "1"\n',
      'src/lib.rs': 'pub mod ast;\npub mod error;\npub mod exhaustiveness;\npub mod interest;\npub mod os_str;\npub mod position;\n',
      'src/ast.rs': 'pub enum Pattern {\n    Int,\n    Discard,\n}\n',
      // gleam: `ast::Pattern` is the ast module's, not this file's own `Pattern`.
      'src/exhaustiveness.rs': [
        'use crate::ast;',
        '',
        'pub enum Pattern {',
        '    Variable,',
        '}',
        '',
        'pub fn check(pattern: &ast::Pattern) -> bool {',
        '    true',
        '}',
        '',
        'pub fn own() -> Pattern {',
        '    Pattern::Variable',
        '}',
        '',
      ].join('\n'),
      // clap: `io::Error`, `fmt::Error` and `fmt::Result` are std's, though this file is `error`.
      'src/error/mod.rs': [
        'use std::{error, fmt, io};',
        '',
        'pub type Result<T, E = Error> = std::result::Result<T, E>;',
        '',
        'pub struct Error;',
        '',
        'impl From<io::Error> for Error {',
        '    fn from(e: io::Error) -> Self {',
        '        Error',
        '    }',
        '}',
        '',
        'impl fmt::Display for Error {',
        '    fn fmt(&self, f: &mut fmt::Formatter<\'_>) -> fmt::Result {',
        '        Ok(())',
        '    }',
        '}',
        '',
        'impl error::Error for Error {}',
        '',
      ].join('\n'),
      // tokio: `mio::Interest` is the mio crate's.
      'src/interest.rs': 'pub struct Interest(usize);\n\nimpl Interest {\n    pub fn to_mio(self) -> mio::Interest {\n        todo!()\n    }\n}\n',
      // clap: `std::ffi::OsStr` is std's.
      'src/os_str.rs': 'pub struct OsStr;\n\nimpl OsStr {\n    pub fn as_os_str(&self) -> &std::ffi::OsStr {\n        todo!()\n    }\n}\n',
      // gleam: two enums share a variant name; a path names its own enum's.
      'src/position.rs': [
        'pub enum Source {',
        '    Record { first: bool },',
        '}',
        '',
        'pub enum Builder {',
        '    Record { fields: usize },',
        '}',
        '',
        'pub fn source() -> Source {',
        '    Source::Record { first: true }',
        '}',
        '',
        'mod inner {',
        '    pub struct Cell;',
        '}',
        '',
        'pub fn cell() -> inner::Cell {',
        '    inner::Cell',
        '}',
        '',
        // Braces, not indentation, say what a module holds.
        'mod flat {',
        'pub struct Flat;',
        '}',
        '',
        'pub fn flat() -> flat::Flat {',
        '    flat::Flat',
        '}',
        '',
        // `outer::Shell` is `outer`'s own, not the one in `outer::deep`.
        'mod outer {',
        '    pub struct Shell;',
        '    pub mod deep {',
        '        pub struct Shell;',
        '    }',
        '}',
        '',
        'pub fn shell() -> outer::Shell {',
        '    todo!()',
        '}',
        '',
      ].join('\n'),
    };
    for (const [rel, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), content);
    }
    cg = await CodeGraph.init(root, { index: true });
  }, 60_000);

  afterAll(() => {
    cg?.close();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it('names the module a path writes, not an item of the file of that name', () => {
    expect(targetsOn(cg, 'src/exhaustiveness.rs', 7, 'Pattern')).toEqual(['enum Pattern src/ast.rs@1']);
    expect(targetsOn(cg, 'src/exhaustiveness.rs', 11, 'Pattern')).toEqual(['enum Pattern src/exhaustiveness.rs@3']);
  });

  it('names std through `io::`, `fmt::` and `error::`, whatever the file is called', () => {
    expect(targetsOn(cg, 'src/error/mod.rs', 8, 'Error')).toEqual([]);
    expect(targetsOn(cg, 'src/error/mod.rs', 14, 'Result')).toEqual([]);
    expect(targetsOn(cg, 'src/error/mod.rs', 19, 'Error')).toEqual([]);
  });

  it('names an outside crate through its own name or `std::`', () => {
    expect(targetsOn(cg, 'src/interest.rs', 4, 'Interest')).toEqual([]);
    expect(targetsOn(cg, 'src/os_str.rs', 4, 'OsStr')).toEqual([]);
  });

  it('names the variant of the enum the path writes', () => {
    expect(targetsOn(cg, 'src/position.rs', 10, 'Record')).toEqual(['enum_member Source::Record src/position.rs@2']);
  });

  it('still names an inline module\'s item', () => {
    expect(targetsOn(cg, 'src/position.rs', 17, 'Cell')).toEqual(['struct Cell src/position.rs@14']);
  });

  it('reads an inline module from its braces: an item at any indentation, and not one in a module inside it', () => {
    expect(targetsOn(cg, 'src/position.rs', 25, 'Flat')).toEqual(['struct Flat src/position.rs@22']);
    expect(targetsOn(cg, 'src/position.rs', 36, 'Shell')).toEqual(['struct Shell src/position.rs@30']);
  });
});

describe('a Rust path through a module a `use` binds', () => {
  let root = '';
  let cg: CodeGraph;

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-rust-path-use-'));
    const files: Record<string, string> = {
      'Cargo.toml': '[workspace]\nmembers = ["rt", "rt-test"]\n',
      'rt/Cargo.toml': '[package]\nname = "rt"\nversion = "0.1.0"\n\n[dev-dependencies]\nrt-test = { path = "../rt-test" }\n',
      'rt/src/lib.rs': 'pub mod runtime;\n',
      'rt/src/runtime/mod.rs': 'pub mod io;\npub mod signal;\n',
      'rt/src/runtime/io/mod.rs': 'pub struct Handle;\n',
      // tokio: `io::Handle` under `use crate::runtime::io` is tokio's own, not tokio-test's.
      'rt/src/runtime/signal.rs': 'use crate::runtime::io;\n\npub struct Handle;\n\npub fn new(io_handle: &io::Handle) -> Handle {\n    Handle\n}\n',
      'rt-test/Cargo.toml': '[package]\nname = "rt-test"\nversion = "0.1.0"\n\n[dependencies]\nrt = { path = "../rt" }\n',
      'rt-test/src/lib.rs': 'pub mod io;\n',
      'rt-test/src/io.rs': 'pub struct Handle;\n',
    };
    for (const [rel, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), content);
    }
    cg = await CodeGraph.init(root, { index: true });
  }, 60_000);

  afterAll(() => {
    cg?.close();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it('names an item of a crate that `use`\'s path can reach', () => {
    expect(targetsOn(cg, 'rt/src/runtime/signal.rs', 5, 'Handle')).toEqual([
      'struct Handle rt/src/runtime/io/mod.rs@1',
      'struct Handle rt/src/runtime/signal.rs@3',
    ]);
  });
});
