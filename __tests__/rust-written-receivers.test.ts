/**
 * A Rust call resolves by the type its receiver is written with, where the
 * source writes it (#2614):
 *
 * - a field chain, which the extractor records by the bare method name —
 *   `vis.map.get("a")` on a `HashMap` field, `self.inner.cfg.port()` — is a
 *   call on the type the struct declares for the last field;
 * - a struct literal, `Xyz { x: 1.0 }.to_val()`, is a call on its own type;
 * - a path through a type from std or a dependency — `J::from(i)` under
 *   `use serde_json::Value as J`, `serde_json::Value::from(i)` — reaches only
 *   the project's own impls of a trait for that type.
 *
 * By the name alone, the reporter's `vis.map.get("a")` went to `Ext::get` (an
 * associated function, at that), `Xyz { … }.to_val()` to `Stat::to_val` (the
 * same trait's other impl) and `J::from(i)` to `impl From<io::Error> for Fail`.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

const roots: string[] = [];
const graphs: Record<'issue' | 'variants' | 'keeps', CodeGraph> = {} as never;

async function index(name: keyof typeof graphs, files: Record<string, string>): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `cg-rust-written-${name}-`));
  roots.push(root);
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  graphs[name] = await CodeGraph.init(root, { index: true });
}

const manifest = (name: string): string =>
  `[package]\nname = "${name}"\nversion = "0.1.0"\nedition = "2021"\n\n[dependencies]\nserde_json = "1"\n`;

beforeAll(async () => {
  // The issue's crate, verbatim.
  await index('issue', {
    'Cargo.toml': manifest('repro'),
    'src/main.rs': [
      'use std::collections::HashMap;',
      'use serde_json::Value as J;',
      '',
      'pub enum Val {',
      '    Null,',
      '    Int(i64),',
      '    List(Vec<Val>),',
      '}',
      '',
      'pub struct Obj {',
      '    keys: Vec<String>,',
      '}',
      '',
      'impl Obj {',
      '    pub fn contains(&self, k: &str) -> bool {',
      '        self.keys.iter().any(|x| x == k)',
      '    }',
      '}',
      '',
      'pub struct Ext;',
      '',
      'impl Ext {',
      '    pub fn get(name: &str) -> Ext {',
      '        let _ = name;',
      '        Ext',
      '    }',
      '}',
      '',
      'pub struct Fail;',
      '',
      'impl From<std::io::Error> for Fail {',
      '    fn from(_: std::io::Error) -> Fail {',
      '        Fail',
      '    }',
      '}',
      '',
      'pub struct Xyz {',
      '    x: f64,',
      '}',
      '',
      'pub struct Stat {',
      '    n: f64,',
      '}',
      '',
      'pub trait ToVal {',
      '    fn to_val(&self) -> Val;',
      '}',
      '',
      'impl ToVal for Xyz {',
      '    fn to_val(&self) -> Val {',
      '        Val::Int(self.x as i64)',
      '    }',
      '}',
      '',
      'impl ToVal for Stat {',
      '    fn to_val(&self) -> Val {',
      '        Val::Int(self.n as i64)',
      '    }',
      '}',
      '',
      '// 1. slice::contains, not Obj::contains',
      'fn slice_has(names: &[&str], k: &str) -> bool {',
      '    names.contains(&k)',
      '}',
      '',
      '// 2. HashMap::get on a struct field, not Ext::get',
      'pub struct Vis {',
      '    map: HashMap<String, i32>,',
      '}',
      '',
      'fn map_get(vis: &Vis) -> Option<&i32> {',
      '    vis.map.get("a")',
      '}',
      '',
      '// 3. serde_json::Value::from via alias J, not Fail::from',
      'fn to_json(i: i64) -> J {',
      '    J::from(i)',
      '}',
      '',
      '// 4. method on struct literal: Xyz::to_val, not Stat::to_val',
      'fn centroid() -> Val {',
      '    Xyz { x: 1.0 }.to_val()',
      '}',
      '',
      'fn main() {',
      '    let o = Obj { keys: vec![] };',
      '    let _ = o.contains("a");',
      '    let _ = Ext::get("x");',
      '    let _ = Stat { n: 0.0 }.to_val();',
      '    let _ = slice_has(&["a"], "a");',
      '    let _ = map_get(&Vis { map: HashMap::new() });',
      '    let _ = to_json(1);',
      '    let _ = centroid();',
      '    let _ = Val::List(vec![Val::Null]);',
      '}',
      '',
    ].join('\n'),
  });

  // Field chains and struct literals of other shapes, beside namesakes of the
  // methods they call; and paths through types from outside the project, with
  // one `from` in the crate for a guess by the name to take.
  await index('variants', {
    'Cargo.toml': manifest('variants'),
    'src/main.rs': 'mod chains;\nmod config;\nmod paths;\n\nfn main() {}\n',
    'src/config.rs': [
      'pub struct Config {',
      '    pub port: u16,',
      '}',
      '',
      'impl Config {',
      '    pub fn load() -> Config {',
      '        Config { port: 1 }',
      '    }',
      '',
      '    pub fn port(&self) -> u16 {',
      '        self.port',
      '    }',
      '}',
      '',
      '/// A project type named like `serde_json::Value`.',
      'pub struct Value;',
      '',
      'impl Default for Value {',
      '    fn default() -> Value {',
      '        Value',
      '    }',
      '}',
      '',
      'pub struct Fail;',
      '',
      'impl From<std::io::Error> for Fail {',
      '    fn from(_: std::io::Error) -> Fail {',
      '        Fail',
      '    }',
      '}',
      '',
    ].join('\n'),
    'src/chains.rs': [
      'use std::collections::HashMap;',
      '',
      'use crate::config::Config;',
      '',
      'pub struct Inner {',
      '    pub map: HashMap<String, i32>,',
      '    pub cfg: Config,',
      '}',
      '',
      'pub struct Outer {',
      '    pub inner: Inner,',
      '    pub pair: (Config, u8),',
      '}',
      '',
      'pub struct Wrap(pub Config);',
      '',
      '/// Namesakes of the methods the calls below make, beside them.',
      'pub struct Dial;',
      '',
      'impl Dial {',
      '    pub fn port(&self) -> u16 {',
      '        0',
      '    }',
      '',
      '    pub fn get(&self, _k: &str) -> Option<&i32> {',
      '        None',
      '    }',
      '}',
      '',
      'pub enum Shape {',
      '    Circle { r: f64 },',
      '}',
      '',
      'impl Shape {',
      '    pub fn area(&self) -> f64 {',
      '        0.0',
      '    }',
      '}',
      '',
      'pub struct Room {',
      '    pub w: f64,',
      '}',
      '',
      'impl Room {',
      '    pub fn area(&self) -> f64 {',
      '        self.w',
      '    }',
      '',
      '    pub fn fresh(&self) -> f64 {',
      '        Self { w: 2.0 }.area()',
      '    }',
      '}',
      '',
      'impl Outer {',
      '    pub fn deep_std(&self) -> Option<&i32> {',
      '        self.inner.map.get("a")',
      '    }',
      '',
      '    pub fn deep_project(&self) -> u16 {',
      '        self.inner.cfg.port()',
      '    }',
      '',
      '    pub fn tuple_field(&self) -> u16 {',
      '        self.pair.0.port()',
      '    }',
      '}',
      '',
      'impl Wrap {',
      '    pub fn tuple_self(&self) -> u16 {',
      '        self.0.port()',
      '    }',
      '}',
      '',
      'pub fn param_chain(o: &Outer) -> u16 {',
      '    o.inner.cfg.port()',
      '}',
      '',
      'pub fn param_chain_std(o: &Outer) -> i32 {',
      '    o.inner',
      '        .map',
      '        .get("b")',
      '        .copied()',
      '        .unwrap_or(0)',
      '}',
      '',
      'pub fn local_chain() -> u16 {',
      '    let w = Wrap(Config::load());',
      '    w.0.port()',
      '}',
      '',
      'pub fn literal() -> u16 {',
      '    Config { port: 2 }.port()',
      '}',
      '',
      'pub fn literal_in_parens() -> u16 {',
      '    (&Config { port: 3 }).port()',
      '}',
      '',
      'pub fn variant_literal() -> f64 {',
      '    Shape::Circle { r: 1.0 }.area()',
      '}',
      '',
      '/// A trait a derive implements (axum-extra\'s `#[derive(TypedPath)]`): the impl is the macro\'s.',
      'pub trait TypedPath {',
      '    fn with_query_params(self, q: u8) -> u8',
      '    where',
      '        Self: Sized,',
      '    {',
      '        q',
      '    }',
      '}',
      '',
      '#[derive(TypedPath, Debug)]',
      'pub struct UsersShow {',
      '    pub id: u32,',
      '}',
      '',
      'pub fn derived() -> u8 {',
      '    UsersShow { id: 1 }.with_query_params(2)',
      '}',
      '',
    ].join('\n'),
    'src/paths.rs': [
      'use serde_json as json;',
      'use serde_json::Value;',
      '',
      'pub fn written_outside(i: i64) -> serde_json::Value {',
      '    serde_json::Value::from(i)',
      '}',
      '',
      'pub fn crate_alias(i: i64) -> json::Value {',
      '    json::Value::from(i)',
      '}',
      '',
      'pub fn unrenamed_outside() -> Value {',
      '    Value::default()',
      '}',
      '',
      'pub fn written_default() -> serde_json::Value {',
      '    serde_json::Value::default()',
      '}',
      '',
    ].join('\n'),
  });

  // The project's own impls on types from outside it, which those paths do reach.
  await index('keeps', {
    'Cargo.toml': manifest('keeps'),
    'src/main.rs': [
      'use std::io::Write as W;',
      'use std::path::PathBuf;',
      '',
      'use serde_json::Value;',
      '',
      'pub struct Fail;',
      '',
      'impl From<Fail> for PathBuf {',
      '    fn from(_: Fail) -> PathBuf {',
      '        PathBuf::new()',
      '    }',
      '}',
      '',
      'pub trait Blank {',
      '    fn blank() -> Self;',
      '}',
      '',
      'impl Blank for serde_json::Value {',
      '    fn blank() -> Self {',
      '        serde_json::Value::Null',
      '    }',
      '}',
      '',
      'pub struct Sink;',
      '',
      'impl std::io::Write for Sink {',
      '    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {',
      '        Ok(buf.len())',
      '    }',
      '',
      '    fn flush(&mut self) -> std::io::Result<()> {',
      '        Ok(())',
      '    }',
      '}',
      '',
      'fn to_path(f: Fail) -> PathBuf {',
      '    PathBuf::from(f)',
      '}',
      '',
      'fn blank() -> Value {',
      '    Value::blank()',
      '}',
      '',
      'fn drain(s: &mut Sink) {',
      '    let _ = W::flush(s);',
      '}',
      '',
      'fn main() {',
      '    let _ = to_path(Fail);',
      '    let _ = blank();',
      '}',
      '',
    ].join('\n'),
  });
}, 120_000);

afterAll(() => {
  for (const cg of Object.values(graphs)) cg?.close();
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

/** The calls on `line` of `file`, as `qualifiedName resolvedBy`, sorted. */
const callsAt = (name: keyof typeof graphs, file: string, line: number): string[] => {
  const cg = graphs[name];
  const out: string[] = [];
  for (const node of cg.getNodesInFile(file)) {
    for (const edge of cg.getOutgoingEdges(node.id)) {
      if (edge.kind !== 'calls' || edge.line !== line || edge.provenance === 'heuristic') continue;
      out.push(`${cg.getNode(edge.target)!.qualifiedName} ${String(edge.metadata?.resolvedBy)}`);
    }
  }
  return [...new Set(out)].sort();
};

describe('the issue\'s crate (#2614)', () => {
  it('a `HashMap` field\'s `get` is no project method', () => {
    expect(callsAt('issue', 'src/main.rs', 72)).toEqual([]);
  });

  it('`J::from(i)` under `use serde_json::Value as J` is no project method', () => {
    expect(callsAt('issue', 'src/main.rs', 77)).toEqual([]);
  });

  it('a struct literal calls its own type\'s method', () => {
    expect(callsAt('issue', 'src/main.rs', 82)).toEqual(['Xyz::to_val instance-method']);
    expect(callsAt('issue', 'src/main.rs', 89)).toEqual(['Stat::to_val instance-method']);
  });

  it('keeps what was already right', () => {
    expect(callsAt('issue', 'src/main.rs', 63)).toEqual([]);
    expect(callsAt('issue', 'src/main.rs', 87)).toEqual(['Obj::contains instance-method']);
    expect(callsAt('issue', 'src/main.rs', 88)).toEqual(['Ext::get qualified-name']);
  });
});

describe('a Rust call on a field chain', () => {
  it('of a std type is no project method', () => {
    expect(callsAt('variants', 'src/chains.rs', 56)).toEqual([]);
    expect(callsAt('variants', 'src/chains.rs', 79)).toEqual([]);
  });

  it('of a project type is that type\'s method, not a namesake beside the call', () => {
    expect(callsAt('variants', 'src/chains.rs', 60)).toEqual(['Config::port instance-method']);
    expect(callsAt('variants', 'src/chains.rs', 64)).toEqual(['Config::port instance-method']);
    expect(callsAt('variants', 'src/chains.rs', 70)).toEqual(['Config::port instance-method']);
    expect(callsAt('variants', 'src/chains.rs', 75)).toEqual(['Config::port instance-method']);
    expect(callsAt('variants', 'src/chains.rs', 88)).toEqual(['Config::port instance-method']);
  });
});

describe('a Rust call on a struct literal', () => {
  it('is its own type\'s method, in parentheses too', () => {
    expect(callsAt('variants', 'src/chains.rs', 92)).toEqual(['Config::port instance-method']);
    expect(callsAt('variants', 'src/chains.rs', 96)).toEqual(['Config::port instance-method']);
  });

  it('of an enum\'s variant is the enum\'s method, and `Self { … }` the impl type\'s', () => {
    expect(callsAt('variants', 'src/chains.rs', 100)).toEqual(['Shape::area instance-method']);
    expect(callsAt('variants', 'src/chains.rs', 50)).toEqual(['Room::area instance-method']);
  });

  it('reaches the method a trait it derives provides', () => {
    expect(callsAt('variants', 'src/chains.rs', 119)).toEqual(['TypedPath::with_query_params instance-method']);
  });
});

describe('a Rust path through a type from outside the project', () => {
  it('written out or through a crate\'s alias is no project type\'s function', () => {
    expect(callsAt('variants', 'src/paths.rs', 5)).toEqual([]);
    expect(callsAt('variants', 'src/paths.rs', 9)).toEqual([]);
  });

  it('a `use` names, or the path writes, is not a project namesake\'s', () => {
    expect(callsAt('variants', 'src/paths.rs', 13)).toEqual([]);
    expect(callsAt('variants', 'src/paths.rs', 17)).toEqual([]);
  });

  it('still reaches the project\'s own impls for that type, or of that trait', () => {
    expect(callsAt('keeps', 'src/main.rs', 37)).toEqual(['PathBuf::from qualified-name']);
    expect(callsAt('keeps', 'src/main.rs', 41)).toEqual(['Value::blank qualified-name']);
    expect(callsAt('keeps', 'src/main.rs', 45)).toEqual(['Sink::flush instance-method']);
  });
});
