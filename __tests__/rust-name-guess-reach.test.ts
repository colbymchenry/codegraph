/**
 * What a Rust call can't reach by its name alone (#3252): an associated
 * function without `self` through a method call; a method of an
 * `impl <std trait> for T` by a guess whose receiver says nothing of `T`;
 * another type's method for `Type::m` where `Type`'s own `m` is derived. The
 * issue's two crates side by side, only `app` indexed, so `ext` stays outside
 * the project. Calls whose receiver type is read keep their edges.
 */
import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CodeGraph } from '../src';

let root = '';
let cg: CodeGraph | undefined;

afterEach(() => {
  cg?.close();
  cg = undefined;
  if (root) fs.rmSync(root, { recursive: true, force: true });
  root = '';
});

const EXT = `pub struct Builder { on: bool }
impl Builder {
    pub fn new() -> Self { Builder { on: false } }
    pub fn enable(mut self) -> Self { self.on = true; self }
    pub fn build(self) -> bool { self.on }
}
pub struct GzBuilder { m: u32 }
impl GzBuilder {
    pub fn new() -> Self { GzBuilder { m: 0 } }
    pub fn mtime(mut self, m: u32) -> Self { self.m = m; self }
    pub fn write(self, sink: Vec<u8>, level: u32) -> Encoder { Encoder { sink, level: level + self.m } }
}
pub struct Encoder { sink: Vec<u8>, level: u32 }
impl Encoder {
    pub fn finish(self) -> Result<Sink, ()> { Ok(Sink { data: self.sink, level: self.level }) }
}
pub struct Sink { data: Vec<u8>, level: u32 }
impl Sink {
    pub fn flush(&mut self) -> Result<(), ()> { self.data.clear(); Ok(()) }
}
pub fn stdout() -> Sink { Sink { data: vec![], level: 0 } }
`;

const APP = `use std::io::Write;

#[derive(Default)]
pub struct Rules {
    n: u32,
}

pub struct Tokens {
    n: u32,
}

impl Default for Tokens {
    fn default() -> Self {
        Tokens { n: 1 }
    }
}

fn rules() -> Rules {
    Rules::default()
}

pub struct Graph {
    n: u32,
}

impl Graph {
    pub fn build(n: u32) -> Graph {
        Graph { n }
    }
}

fn runtime() -> bool {
    ext::Builder::new().enable().build()
}

pub struct Log {
    buf: Vec<u8>,
}

impl Write for Log {
    fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
        self.buf.extend_from_slice(b);
        Ok(b.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        self.write(b"")?;
        Ok(())
    }
}

fn take_lock(p: &str) -> std::io::Result<std::fs::File> {
    let open = move || -> std::io::Result<std::fs::File> {
        std::fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .open(p)
    };
    open()
}

fn write_single(data: Vec<u8>) -> Result<(), ()> {
    let enc = ext::GzBuilder::new().mtime(0).write(data, 6);
    enc.finish()?.flush()?;
    Ok(())
}

fn to_stdout() -> Result<(), ()> {
    let mut stdout = ext::stdout();
    stdout.flush()
}

fn main() {
    let r = rules();
    let t = Tokens::default();
    let g = Graph::build(r.n + t.n);
    let mut l = Log { buf: vec![] };
    let _ = l.write(b"x");
    let _ = l.flush();
    let _ = (runtime(), g.n, take_lock("x").is_ok(), write_single(vec![]), to_stdout());
}
`;

async function index(): Promise<CodeGraph> {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-rust-name-guess-'));
  const files: Record<string, string> = {
    'ext/Cargo.toml': '[package]\nname = "ext"\nversion = "0.1.0"\nedition = "2021"\n',
    'ext/src/lib.rs': EXT,
    'app/Cargo.toml': '[package]\nname = "repro_receiver"\nversion = "0.1.0"\nedition = "2021"\n\n[dependencies]\next = { path = "../ext" }\n',
    'app/src/main.rs': APP,
  };
  for (const [rel, text] of Object.entries(files)) {
    const dest = path.join(root, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, text);
  }
  cg = await CodeGraph.init(path.join(root, 'app'), { index: true });
  return cg;
}

/** The project functions and methods `fn` calls, by qualified name, sorted. */
function callsOf(graph: CodeGraph, fn: string): string[] {
  const node = graph.getNodesByName(fn).find((n) => n.kind === 'function' || n.kind === 'method');
  expect(node, fn).toBeDefined();
  return graph.getOutgoingEdges(node!.id)
    .filter((e) => e.kind === 'calls')
    .map((e) => graph.getNode(e.target)!.qualifiedName)
    .sort();
}

describe('Rust: what a call can\'t reach by its name alone (#3252)', () => {
  it('links none of the issue\'s five shapes to a same-named project method', async () => {
    const graph = await index();
    expect(callsOf(graph, 'rules')).toEqual([]);
    expect(callsOf(graph, 'runtime')).toEqual([]);
    expect(callsOf(graph, 'take_lock').filter((n) => n.startsWith('Log::'))).toEqual([]);
    expect(callsOf(graph, 'write_single')).toEqual([]);
    expect(callsOf(graph, 'to_stdout')).toEqual([]);
  });

  it('keeps calls through a path, a typed receiver and `self`', async () => {
    const graph = await index();
    expect(callsOf(graph, 'main')).toEqual([
      'Graph::build', 'Log::flush', 'Log::write', 'Tokens::default',
      'rules', 'runtime', 'take_lock', 'to_stdout', 'write_single',
    ]);
    expect(callsOf(graph, 'flush')).toEqual(['Log::write']);
  });
});
