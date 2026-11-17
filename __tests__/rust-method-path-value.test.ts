/**
 * A Rust method passed as a value through its path, `g.map(Graph::counts)`,
 * references that method, as a free function passed by name already does
 * (#3254). The path names what the same path written as a call names: its
 * module, the file's `use` lines and `Self` decide, so a std type that only
 * shares a project type's name (`std::io::Error::other`) and another module's
 * type of the same name never take the edge. Variants and constants take none.
 */
import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

let root = '';
let cg: CodeGraph | undefined;

afterEach(() => {
  cg?.close();
  cg = undefined;
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

async function index(files: Record<string, string>): Promise<CodeGraph> {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-rust-method-path-'));
  for (const [rel, content] of Object.entries({ 'Cargo.toml': '[package]\nname = "app"\nversion = "0.1.0"\nedition = "2021"\n', ...files })) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  cg = await CodeGraph.init(root, { index: true });
  return cg;
}

/** What `fn` references or calls, as `<kind> <file>:<qualified name>`, sorted. */
function outOf(graph: CodeGraph, fn: string): string[] {
  const node = graph.getNodesByName(fn).find((n) => n.kind === 'function' || n.kind === 'method');
  expect(node, fn).toBeDefined();
  return graph.getOutgoingEdges(node!.id)
    .filter((e) => e.kind === 'references' || e.kind === 'calls')
    .map((e) => { const t = graph.getNode(e.target)!; return `${e.kind} ${t.filePath}:${t.qualifiedName}`; })
    .sort();
}

const GRAPH = 'pub struct Graph { n: u32 }\n\nimpl Graph {\n    pub fn counts(&self) -> u32 { self.n }\n}\n';

describe('a Rust method passed as a value through its path', () => {
  it('references the method, as a free function passed by name does (the #3254 repro)', async () => {
    const graph = await index({
      'src/main.rs': `${GRAPH}\nfn helper(x: u32) -> u32 { x + 1 }\n\nfn report(g: Option<&Graph>) -> Option<u32> { g.map(Graph::counts) }\n\nfn plain(v: Vec<u32>) -> Vec<u32> { v.into_iter().map(helper).collect() }\n\nfn main() {}\n`,
    });
    expect(outOf(graph, 'report')).toContain('references src/main.rs:Graph::counts');
    expect(outOf(graph, 'plain')).toContain('references src/main.rs:helper');
  });

  it('follows the use line, a module path and Self', async () => {
    const graph = await index({
      'src/main.rs': 'mod graph;\nmod other;\nuse crate::graph::Graph;\n\nfn report(g: Option<&Graph>) -> Option<u32> { g.map(Graph::counts) }\n\nfn elsewhere(g: Option<&other::Graph>) -> Option<u32> { g.map(other::Graph::counts) }\n\nfn main() {}\n',
      'src/graph.rs': `${GRAPH}\nimpl Graph {\n    fn double(x: u32) -> u32 { x * 2 }\n    pub fn all(v: Vec<u32>) -> Vec<u32> { v.into_iter().map(Self::double).collect() }\n}\n`,
      'src/other.rs': GRAPH,
    });
    expect(outOf(graph, 'report').filter((e) => e.includes('counts'))).toEqual(['references src/graph.rs:Graph::counts']);
    expect(outOf(graph, 'elsewhere').filter((e) => e.includes('counts'))).toEqual(['references src/other.rs:Graph::counts']);
    expect(outOf(graph, 'all').filter((e) => e.includes('double'))).toEqual(['references src/graph.rs:Graph::double']);
  });

  it('never takes a project type that only shares the name of a std or dependency type', async () => {
    const graph = await index({
      'src/main.rs': 'mod error;\nmod use_io;\nfn main() {}\n',
      'src/error.rs': 'pub struct Error { m: String }\n\nimpl Error {\n    pub fn new(m: String) -> Error { Error { m } }\n    pub fn other(m: String) -> Error { Error { m } }\n}\n',
      'src/use_io.rs': [
        'use std::io::Error;',
        'pub fn imported(r: Result<u8, String>) -> Result<u8, Error> { r.map_err(Error::other) }',
        'pub fn called(m: String) -> Error { Error::other(m) }',
        'pub fn by_path(r: Result<u8, String>) -> Result<u8, std::io::Error> { r.map_err(std::io::Error::other) }',
        'pub fn dependency(r: Result<u8, String>) -> Result<u8, anyhow::Error> { r.map_err(anyhow::Error::new) }',
        '',
      ].join('\n'),
    });
    for (const fn of ['imported', 'called', 'by_path', 'dependency']) {
      expect(outOf(graph, fn).filter((e) => e.includes('error.rs')), fn).toEqual([]);
    }
  });

  it('references what the same path reaches as a call, and nothing for a variant or a constant', async () => {
    const graph = await index({
      'src/main.rs': [
        'use std::io;',
        'pub trait SinkError { fn error_message(m: &str) -> Self; }',
        'impl SinkError for io::Error { fn error_message(m: &str) -> io::Error { io::Error::other(m.to_string()) } }',
        'pub trait Sink { type Error: SinkError; }',
        'pub enum Kind { Wrap(u32) }',
        'pub struct Limits;',
        'impl Limits { pub const MAX: u32 = 3; }',
        '',
        'fn as_value<S: Sink>(r: Result<u8, &str>, q: Result<u8, &str>) -> u32 {',
        '    let _ = r.map_err(S::Error::error_message);',
        '    let _ = q.map_err(io::Error::error_message);',
        '    let _: Vec<Kind> = vec![1u32].into_iter().map(Kind::Wrap).collect();',
        '    let m = Limits::MAX;',
        '    m',
        '}',
        'fn as_call<S: Sink>() {',
        '    let _ = S::Error::error_message("x");',
        '    let _ = io::Error::error_message("x");',
        '}',
        '',
        'fn main() {}',
        '',
      ].join('\n'),
    });
    const targets = (fn: string, kind: string) => outOf(graph, fn).filter((e) => e.startsWith(kind) && e.includes('error_message')).map((e) => e.slice(kind.length));
    expect(targets('as_value', 'references')).toEqual(targets('as_call', 'calls'));
    // A variant or a constant is no function: only the reads main already makes (the enum, the const).
    expect(outOf(graph, 'as_value').filter((e) => e.includes('Wrap') || e.includes('MAX'))).toEqual(['references src/main.rs:Limits::MAX']);
  });

  it('references nothing for a std type\'s method that a project impl may or may not be', async () => {
    const graph = await index({
      'src/main.rs': [
        'pub enum Idi { Install }',
        'impl From<Idi> for String { fn from(_e: Idi) -> Self { String::new() } }',
        'pub fn labels(v: Vec<&str>) -> Vec<String> { v.into_iter().map(String::from).collect() }',
        'pub fn installs(v: Vec<Idi>) -> Vec<String> {',
        '    let _x = String::from(Idi::Install);',
        '    v.into_iter().map(String::from).collect()',
        '}',
        '',
        'fn main() {}',
        '',
      ].join('\n'),
    });
    for (const fn of ['labels', 'installs']) {
      expect(outOf(graph, fn).filter((e) => e.startsWith('references') && e.includes('from')), fn).toEqual([]);
    }
  });

  it('never takes a project method for a std type\'s, or for a primitive\'s', async () => {
    const graph = await index({
      'src/main.rs': [
        'pub struct Name;',
        'impl Name {',
        '    pub fn from(s: &str) -> Name { Name }',
        '    pub fn max(a: u32, b: u32) -> u32 { a }',
        '}',
        'fn convert(v: Vec<&str>) -> Vec<String> { v.into_iter().map(String::from).collect() }',
        'fn biggest(v: Vec<u32>) -> Option<u32> { v.into_iter().reduce(u32::max) }',
        '',
        'fn main() {}',
        '',
      ].join('\n'),
    });
    for (const fn of ['convert', 'biggest']) expect(outOf(graph, fn).filter((e) => e.includes('Name')), fn).toEqual([]);
  });

  it('references nothing for String::from when a project type is also named String', async () => {
    const graph = await index({
      'src/main.rs': [
        'mod s { pub struct String; }',
        'pub enum Idi { Install }',
        'impl From<Idi> for String { fn from(_e: Idi) -> Self { String::new() } }',
        'pub fn labels(v: Vec<&str>) -> Vec<String> { v.into_iter().map(String::from).collect() }',
        '',
        'fn main() {}',
        '',
      ].join('\n'),
    });
    expect(outOf(graph, 'labels').filter((e) => e.startsWith('references') && e.includes('from'))).toEqual([]);
  });

  it('references a macro-declared type\'s inherent method and a trait\'s own method', async () => {
    const graph = await index({
      'src/main.rs': [
        'macro_rules! mk { ($n:ident) => { pub struct $n { n: u32 } }; }',
        'mk!(Graph);',
        'impl Graph { pub fn counts(&self) -> u32 { self.n } }',
        'pub trait Shape {',
        '    fn area(&self) -> u32;',
        '}',
        'pub fn report(g: Option<&Graph>) -> Option<u32> { g.map(Graph::counts) }',
        'pub fn areas(v: Vec<Box<dyn Shape>>) -> Vec<u32> { v.iter().map(Shape::area).collect() }',
        '',
        'fn main() {}',
        '',
      ].join('\n'),
    });
    expect(outOf(graph, 'report')).toContain('references src/main.rs:Graph::counts');
    expect(outOf(graph, 'areas')).toContain('references src/main.rs:Shape::area');
  });

  // Which impl Rust picks for a value is past what the index can tell: one it
  // doesn't hold (derived, macro-written), the one the argument's type would
  // choose, or the type's own method of the name.
  it('references no method of an impl Trait for T block', async () => {
    const graph = await index({
      'src/main.rs': [
        'use std::path::{Path, PathBuf};',
        'pub trait Probe {',
        '    fn exists(&self) -> bool;',
        '}',
        'impl Probe for Path {',
        '    fn exists(&self) -> bool { true }',
        '}',
        'pub trait PathExt {',
        '    fn normalize(&self) -> PathBuf;',
        '}',
        'impl PathExt for Path {',
        '    fn normalize(&self) -> PathBuf { self.to_path_buf() }',
        '}',
        '#[derive(Default)]',
        'pub struct SignalInfo { n: u32 }',
        'pub struct EventInfo { n: u32 }',
        'impl Default for EventInfo {',
        '    fn default() -> Self { EventInfo { n: 0 } }',
        '}',
        'pub struct ParseErr;',
        'pub struct One { code: u32 }',
        'impl From<ParseErr> for One {',
        '    fn from(_e: ParseErr) -> Self { One { code: 1 } }',
        '}',
        'pub struct V(u32);',
        'impl std::ops::Add for V {',
        '    type Output = V;',
        '    fn add(self, o: V) -> V { V(self.0 + o.0) }',
        '}',
        'pub struct E;',
        'pub struct A;',
        'impl E { pub fn new() -> E { E } } impl From<A> for E { fn from(_x: A) -> Self { E } }',
        'pub fn present(v: Vec<&Path>) -> bool { v.into_iter().any(Path::exists) }',
        'pub fn paths(v: Vec<&Path>) -> Vec<PathBuf> { v.into_iter().map(Path::normalize).collect() }',
        'pub fn infos() -> Vec<SignalInfo> { std::iter::repeat_with(SignalInfo::default).take(3).collect() }',
        'pub fn single(r: Result<u32, ParseErr>) -> Result<u32, One> { r.map_err(One::from) }',
        'pub fn total(v: Vec<V>) -> Option<V> { v.into_iter().reduce(V::add) }',
        'pub fn conv(r: Result<u32, A>) -> Result<u32, E> { r.map_err(E::from) }',
        '',
        'fn main() {}',
        '',
      ].join('\n'),
    });
    for (const fn of ['present', 'paths', 'infos', 'single', 'total', 'conv']) {
      expect(outOf(graph, fn).filter((e) => e.startsWith('references') && e.includes('::')), fn).toEqual([]);
    }
  });

  it('references an inherent method written on one line before a trait impl', async () => {
    const graph = await index({
      'src/main.rs': [
        'pub struct E;',
        'pub struct A;',
        'impl E { pub fn new() -> E { E } } impl From<A> for E { fn from(_x: A) -> Self { E } }',
        'pub fn ctor() -> Option<E> { let f = E::new; Some(f()) }',
        '',
        'fn main() {}',
        '',
      ].join('\n'),
    });
    expect(outOf(graph, 'ctor')).toContain('references src/main.rs:E::new');
  });

  it('adds no reference to a path that is called', async () => {
    const graph = await index({
      'src/main.rs': `${GRAPH}\nfn run(g: &Graph) -> u32 { Graph::counts(g) }\n\nfn main() {}\n`,
    });
    expect(outOf(graph, 'run').filter((e) => e.includes('counts'))).toEqual(['calls src/main.rs:Graph::counts']);
  });
});
