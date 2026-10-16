/**
 * A Rust method call resolves by the type its receiver is written with, when
 * it is written down (#2614). `names.contains(&k)` on a `&[&str]` parameter
 * went to `Obj::contains`, `vis.map.get("a")` on a `HashMap` field to
 * `Ext::get`, `J::from(i)` under `use serde_json::Value as J` to a local
 * `impl From<io::Error> for Fail`, and `Xyz { x: 1.0 }.to_val()` to
 * `Stat::to_val` — each a same-named method of another type, picked by name
 * while the type stood in the source. A receiver of a project type calls that
 * type's method; one of a type from outside the project calls nothing of the
 * project's; one whose type is not written resolves as before.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

let root = '';
let cg: CodeGraph;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-rust-receiver-'));
  const files: Record<string, string> = {
    'Cargo.toml': `[package]
name = "repro"
version = "0.1.0"
edition = "2021"

[dependencies]
serde_json = "1"
`,
    'src/main.rs': `use std::collections::HashMap;
use serde_json::Value as J;

pub enum Val {
    Null,
    Int(i64),
}

pub struct Obj {
    keys: Vec<String>,
}

impl Obj {
    pub fn contains(&self, k: &str) -> bool {
        self.keys.iter().any(|x| x == k)
    }
}

pub struct Ext;

impl Ext {
    pub fn get(name: &str) -> Ext {
        let _ = name;
        Ext
    }
}

pub struct Fail;

impl From<std::io::Error> for Fail {
    fn from(_: std::io::Error) -> Fail {
        Fail
    }
}

pub struct Xyz {
    x: f64,
}

pub struct Stat {
    n: f64,
}

pub trait ToVal {
    fn to_val(&self) -> Val;
}

impl ToVal for Xyz {
    fn to_val(&self) -> Val {
        Val::Int(self.x as i64)
    }
}

impl ToVal for Stat {
    fn to_val(&self) -> Val {
        Val::Int(self.n as i64)
    }
}

// 1. slice::contains, not Obj::contains
fn slice_has(names: &[&str], k: &str) -> bool {
    names.contains(&k)
}

// 2. HashMap::get on a struct field, not Ext::get
pub struct Vis {
    map: HashMap<String, i32>,
}

fn map_get(vis: &Vis) -> Option<&i32> {
    vis.map.get("a")
}

// 3. serde_json::Value::from via alias J, not Fail::from
fn to_json(i: i64) -> J {
    J::from(i)
}

// 4. method on struct literal: Xyz::to_val, not Stat::to_val
fn centroid() -> Val {
    Xyz { x: 1.0 }.to_val()
}

// A project type written on the parameter, on a local, on a field read.
pub struct Holder {
    obj: Obj,
    stats: Vec<Stat>,
}

fn typed_param(o: &Obj) -> bool {
    o.contains("a")
}

fn typed_local() -> bool {
    let o = Obj { keys: vec![] };
    o.contains("b")
}

fn through_field(h: &Holder) -> bool {
    h.obj.contains("c")
}

// A field whose container does not auto-deref: nothing of the project's.
fn vec_field(h: &Holder) -> usize {
    h.stats.len()
}

// A receiver nothing types: resolved as before (the one \`contains\` a name alone finds).
fn untyped(items: Vec<Obj>) -> bool {
    items.iter().any(|it| it.contains("d"))
}

fn main() {
    let o = Obj { keys: vec![] };
    let _ = o.contains("a");
    let _ = Ext::get("x");
    let _ = Stat { n: 0.0 }.to_val();
    let _ = slice_has(&["a"], "a");
    let _ = map_get(&Vis { map: HashMap::new() });
    let _ = to_json(1);
    let _ = centroid();
    let h = Holder { obj: Obj { keys: vec![] }, stats: vec![] };
    let _ = (typed_param(&o), typed_local(), through_field(&h), vec_field(&h), untyped(vec![]));
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

/** The project methods `fn` calls, as `Owner::method`, sorted. */
const callsOf = (fn: string): string[] => {
  const caller = cg.getNodesInFile('src/main.rs').find((n) => n.name === fn && n.kind === 'function')!;
  return cg.getOutgoingEdges(caller.id).filter((e) => e.kind === 'calls')
    .map((e) => cg.getNode(e.target)!).filter((t) => t.kind === 'method').map((t) => t.qualifiedName).sort();
};

describe('a Rust method call resolves by the receiver type the source writes (#2614)', () => {
  it('a slice parameter, a HashMap field and an aliased serde_json path call nothing of the project', () => {
    expect(callsOf('slice_has')).toEqual([]);
    expect(callsOf('map_get')).toEqual([]);
    expect(callsOf('to_json')).toEqual([]);
    expect(callsOf('vec_field')).toEqual([]);
  });

  it('a struct literal calls its own type\'s method, not a namesake', () => {
    expect(callsOf('centroid')).toEqual(['Xyz::to_val']);
  });

  it('a project type on a parameter, a local or a field read calls its method', () => {
    expect(callsOf('typed_param')).toEqual(['Obj::contains']);
    expect(callsOf('typed_local')).toEqual(['Obj::contains']);
    expect(callsOf('through_field')).toEqual(['Obj::contains']);
    expect(callsOf('main')).toEqual(expect.arrayContaining(['Obj::contains', 'Ext::get', 'Stat::to_val']));
    expect(callsOf('main')).not.toContain('Xyz::to_val');
  });

  it('a receiver nothing types resolves as before', () => {
    expect(callsOf('untyped')).toEqual(['Obj::contains']);
  });
});
