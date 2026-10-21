/**
 * A crate can't declare a method on `String`, `Vec`, `Arc` or `NonNull`, only
 * implement a trait for one. A call reaches such an impl only as Rust picks it:
 * - a std trait the crate implements for one of its own types (`impl
 *   From<IDI> for String`) is what `String::from(x)` calls only when `x` is an
 *   `IDI`. dioxus's CLI's `String::from("…")` calls all went to that impl,
 *   tokio's `NonNull::from(waiter)` to its `impl From<&Handle> for NonNull<Entry>`;
 * - a trait of the crate's own (`impl Storage for Vec<Slot>`) is reached only
 *   where it is in scope: tokio's tests' `files.iter()` on a `Vec` went to its
 *   `Storage` impl, in files that never import `Storage`.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

let root = '';
let cg: CodeGraph;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-rust-foreign-impl-'));
  const files: Record<string, string> = {
    'Cargo.toml': '[package]\nname = "cli"\nversion = "0.1.0"\n',
    'src/main.rs': 'mod cli;\nmod names;\nmod slots;\nmod store;\nmod windows;\n\nfn main() {}\n',
    'src/windows.rs': [
      'pub enum Idi {',
      '    Install,',
      '}',
      '',
      'impl From<Idi> for String {',
      '    fn from(_e: Idi) -> Self {',
      '        String::new()',
      '    }',
      '}',
      '',
      'pub fn label() -> String {',
      '    String::from(Idi::Install)',
      '}',
      '',
    ].join('\n'),
    'src/names.rs': [
      'use std::ffi::OsString;',
      '',
      'pub struct Str;',
      '',
      'impl From<Str> for OsString {',
      '    fn from(_name: Str) -> Self {',
      '        OsString::new()',
      '    }',
      '}',
      '',
      'pub fn os_name(name: Str) -> OsString {',
      '    OsString::from(name)',
      '}',
      '',
    ].join('\n'),
    'src/cli.rs': [
      'use std::ffi::OsString;',
      '',
      'pub fn banner() -> String {',
      '    String::from("dx")',
      '}',
      '',
      'pub fn arg() -> OsString {',
      '    OsString::from("--release")',
      '}',
      '',
    ].join('\n'),
    'src/store.rs': [
      'pub trait Storage {',
      '    fn iter(&self) -> usize;',
      '}',
      '',
      'pub struct Slot;',
      '',
      'impl Storage for Vec<Slot> {',
      '    fn iter(&self) -> usize {',
      '        self.len()',
      '    }',
      '}',
      '',
    ].join('\n'),
    // Storage in scope: its `iter`.
    'src/slots.rs': [
      'use crate::store::{Slot, Storage};',
      '',
      'pub fn count(slots: Vec<Slot>) -> usize {',
      '    slots.iter()',
      '}',
      '',
    ].join('\n'),
    // No Storage here: a Vec's own `iter`.
    'tests/files.rs': [
      'pub fn paths(files: Vec<String>) -> usize {',
      '    files.iter().count()',
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

/** What `name`, called in `file`, links to, as `file@line` of each target, sorted. */
const callsOf = (file: string, name: string): string[] => {
  const out: string[] = [];
  for (const node of cg.getNodesInFile(file)) {
    for (const edge of cg.getOutgoingEdges(node.id)) {
      if (edge.kind !== 'calls') continue;
      const target = cg.getNode(edge.target)!;
      if (target.name === name) out.push(`${target.filePath}@${target.startLine}`);
    }
  }
  return [...new Set(out)].sort();
};

describe('a Rust call into a project impl on a std type', () => {
  it('is not a std trait impl unless its argument is the impl\'s own type', () => {
    expect(callsOf('src/cli.rs', 'from')).toEqual([]);
  });

  it('reaches it when the argument is that type: built from it, or declared with it', () => {
    expect(callsOf('src/windows.rs', 'from')).toEqual(['src/windows.rs@6']);
    expect(callsOf('src/names.rs', 'from')).toEqual(['src/names.rs@6']);
  });

  it('reaches a project trait\'s impl only where the trait is in scope', () => {
    expect(callsOf('src/slots.rs', 'iter')).toEqual(['src/store.rs@8']);
    expect(callsOf('tests/files.rs', 'iter')).toEqual([]);
  });
});
