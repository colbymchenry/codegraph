/**
 * A Rust `Self::x(…)` call is `x` of the type `Self` is where it is written:
 * `Self::new(…)` in `impl Error` is `Error::new`, `Self::Text(…)` in `impl
 * Message` its variant, and in a trait's own body the trait's method. The
 * receiver names no type of its own, so a guess by the name alone took such a
 * call only when nothing else shared the name: clap's 118 `Self::new(…)`-style
 * calls stayed unresolved, as did dioxus's `Self::current()` in `impl
 * Workspace` once its Android tooling's `AndroidTools::current` was indexed.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

let root = '';
let cg: CodeGraph;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-rust-self-path-'));
  const files: Record<string, string> = {
    'Cargo.toml': '[package]\nname = "cli"\nversion = "0.1.0"\n',
    'src/main.rs': 'mod android;\nmod bound;\nmod config;\nmod error;\nmod frame;\nmod listener;\nmod message;\nmod parse;\nmod parser;\nmod store;\nmod workspace;\n\nfn main() {}\n',
    'src/error.rs': [
      'pub struct Error {',
      '    kind: u8,',
      '}',
      '',
      'impl Error {',
      '    pub fn new(kind: u8) -> Self {',
      '        Error { kind }',
      '    }',
      '',
      '    pub fn io() -> Self {',
      '        Self::new(1)',
      '    }',
      '}',
      '',
    ].join('\n'),
    'src/config.rs': [
      'use crate::store::Store;',
      '',
      'pub struct Config;',
      '',
      'impl Config {',
      '    pub fn new() -> Self {',
      '        Config',
      '    }',
      '}',
      '',
      'impl Store for Config {',
      '    fn open() -> Self {',
      '        Self::new()',
      '    }',
      '}',
      '',
    ].join('\n'),
    'src/store.rs': [
      'pub trait Store {',
      '    fn open() -> Self;',
      '',
      '    fn open_default() -> Self',
      '    where',
      '        Self: Sized,',
      '    {',
      '        Self::open()',
      '    }',
      '}',
      '',
      'pub fn open() {}',
      '',
    ].join('\n'),
    'src/message.rs': [
      'pub enum Message {',
      '    Text(String),',
      '    Binary(Vec<u8>),',
      '}',
      '',
      'impl Message {',
      '    pub fn text(s: &str) -> Self {',
      '        Self::Text(s.to_string())',
      '    }',
      '}',
      '',
    ].join('\n'),
    'src/frame.rs': 'pub enum Frame {\n    Text(String),\n}\n',
    'src/workspace.rs': [
      'pub struct Workspace;',
      '',
      'impl Workspace {',
      '    pub fn current() -> Workspace {',
      '        Workspace',
      '    }',
      '',
      '    pub fn reload() -> Workspace {',
      '        Self::current()',
      '    }',
      '',
      '    pub fn depth(n: u32) -> u32 {',
      '        if n == 0 { 0 } else { Self::depth(n - 1) + 1 }',
      '    }',
      '}',
      '',
    ].join('\n'),
    'src/android.rs': 'pub struct AndroidTools;\n\nimpl AndroidTools {\n    pub fn current() -> Option<AndroidTools> {\n        None\n    }\n}\n',
    // `Self` is `Box<T>`: `Self::new` is `Box::new`, from outside the project,
    // not the `new` of a struct that shares the trait's name.
    'src/parse.rs': [
      'pub trait Parser {',
      '    fn parse() -> Self;',
      '}',
      '',
      'impl<T: Parser> Parser for Box<T> {',
      '    fn parse() -> Self {',
      '        Self::new(T::parse())',
      '    }',
      '}',
      '',
    ].join('\n'),
    'src/parser.rs': 'pub struct Parser;\n\nimpl Parser {\n    pub fn new() -> Self {\n        Parser\n    }\n}\n',
    // An outside type's own `local_addr` is std's: nothing the index holds.
    'src/bound.rs': [
      'use std::net::{SocketAddr, TcpListener};',
      '',
      'pub trait Bound {',
      '    fn local_addr(&self) -> std::io::Result<SocketAddr>;',
      '}',
      '',
      'impl Bound for TcpListener {',
      '    fn local_addr(&self) -> std::io::Result<SocketAddr> {',
      '        Self::local_addr(self)',
      '    }',
      '}',
      '',
    ].join('\n'),
    // A trait impl's method handing on to the type's own function of its name.
    'src/listener.rs': [
      'pub trait Listener {',
      '    fn local_addr(&self) -> u16;',
      '}',
      '',
      'pub struct TcpListener;',
      '',
      'impl TcpListener {',
      '    pub fn local_addr(&self) -> u16 {',
      '        0',
      '    }',
      '}',
      '',
      'impl Listener for TcpListener {',
      '    fn local_addr(&self) -> u16 {',
      '        Self::local_addr(self)',
      '    }',
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

/** What the `calls` edges out of `fn`, declared in `file` (at `line`, if given), reach, as `file@line`, sorted. */
const callsFrom = (file: string, fn: string, line?: number): string[] => {
  const out: string[] = [];
  for (const node of cg.getNodesInFile(file).filter((n) => n.name === fn && (line === undefined || n.startLine === line))) {
    for (const edge of cg.getOutgoingEdges(node.id)) {
      if (edge.kind !== 'calls') continue;
      const target = cg.getNode(edge.target)!;
      out.push(`${target.filePath}@${target.startLine}`);
    }
  }
  return [...new Set(out)].sort();
};

describe('a Rust `Self::x(…)` call', () => {
  it('is the impl\'s own type\'s function, whatever else shares its name', () => {
    expect(callsFrom('src/error.rs', 'io')).toEqual(['src/error.rs@6']);
    expect(callsFrom('src/workspace.rs', 'reload')).toEqual(['src/workspace.rs@4']);
    // A recursion, in the type's own impl.
    expect(callsFrom('src/workspace.rs', 'depth')).toEqual(['src/workspace.rs@12']);
  });

  it('is its variant, for a tuple variant built through `Self`', () => {
    expect(callsFrom('src/message.rs', 'text')).toEqual(['src/message.rs@2']);
  });

  it('is the type\'s own in a trait impl, and the trait\'s in the trait\'s own body', () => {
    expect(callsFrom('src/config.rs', 'open')).toEqual(['src/config.rs@6']);
    expect(callsFrom('src/store.rs', 'open_default')).toEqual(['src/store.rs@2']);
  });

  it('is never another type\'s that shares the trait\'s name', () => {
    expect(callsFrom('src/parse.rs', 'parse').filter((t) => t.startsWith('src/parser.rs'))).toEqual([]);
  });

  it('is the type\'s own function first, never the trait method it is written in', () => {
    // The trait impl's `local_addr` (line 14) calls the type's own, at line 8.
    expect(callsFrom('src/listener.rs', 'local_addr', 14)).toEqual(['src/listener.rs@8']);
    expect(callsFrom('src/bound.rs', 'local_addr', 8)).toEqual([]);
  });
});
