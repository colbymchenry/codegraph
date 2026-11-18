/**
 * A call written in the arguments of a Rust expression macro — `format!`,
 * `assert_eq!`, `vec!`, `write!`, `println!`, `json!` — links as it does
 * outside one, and a variant path in a `matches!` pattern references its enum
 * (#3251). A macro with a syntax of its own is left alone.
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

async function index(main: string): Promise<CodeGraph> {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-rust-macro-calls-'));
  const files: Record<string, string> = {
    'Cargo.toml': '[package]\nname = "repro_macro"\nversion = "0.1.0"\nedition = "2021"\n\n[dependencies]\nserde_json = "1"\n',
    'src/main.rs': main,
  };
  for (const [rel, text] of Object.entries(files)) {
    const dest = path.join(root, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, text);
  }
  cg = await CodeGraph.init(root, { index: true });
  return cg;
}

/** `kind target` for each edge out of `fn` (calls and references), sorted. */
function outOf(graph: CodeGraph, fn: string): string[] {
  const node = graph.getNodesByName(fn).find((n) => n.kind === 'function' || n.kind === 'method');
  expect(node, fn).toBeDefined();
  return graph.getOutgoingEdges(node!.id)
    .filter((e) => e.kind === 'calls' || e.kind === 'references')
    .map((e) => `${e.kind} ${graph.getNode(e.target)!.qualifiedName}`)
    .sort();
}

const ISSUE = `use serde_json::json;
use std::fmt;

pub enum Code {
    Bad,
    Good,
}

impl Code {
    pub fn is_known(self) -> bool {
        matches!(self, Code::Bad | Code::Good)
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            Code::Bad => "bad",
            Code::Good => "good",
        }
    }
}

pub struct Error {
    code: Code,
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        write!(f, "error {}", self.code.as_str())
    }
}

fn label() -> String {
    "x".to_string()
}

fn count() -> usize {
    3
}

fn size() -> usize {
    2
}

fn in_format() -> String {
    format!("label {}", label())
}

fn in_assert() {
    assert_eq!(count(), 3);
}

fn in_vec() -> Vec<bool> {
    vec![false; size()]
}

fn in_json() -> serde_json::Value {
    json!({"label": label(), "count": count()})
}

fn plain() -> String {
    label()
}

fn main() {
    let e = Error { code: Code::Good };
    println!("{e} {} {} {:?}", in_format(), plain(), in_vec());
    in_assert();
    let _ = in_json();
    let _ = Code::Good.is_known();
}
`;

describe('Rust: calls in the arguments of an expression macro (#3251)', () => {
  it('links the issue\'s calls in format!, assert_eq!, vec!, json!, write! and println!', async () => {
    const graph = await index(ISSUE);
    expect(outOf(graph, 'in_format')).toEqual(['calls label']);
    expect(outOf(graph, 'in_assert')).toEqual(['calls count']);
    expect(outOf(graph, 'in_vec')).toEqual(['calls size']);
    expect(outOf(graph, 'in_json')).toEqual(['calls count', 'calls label']);
    expect(outOf(graph, 'fmt')).toContain('calls Code::as_str');
    expect(outOf(graph, 'main')).toEqual(expect.arrayContaining(['calls in_format', 'calls in_vec', 'calls plain']));
  });

  it('references an enum through the variants of a matches! pattern', async () => {
    const graph = await index(ISSUE);
    expect([...new Set(outOf(graph, 'is_known'))]).toEqual(['references Code']);
  });

  it('leaves a macro with a syntax of its own, a pattern\'s tuple variant and a literal\'s method alone', async () => {
    const graph = await index(`macro_rules! dsl { ($($t:tt)*) => {}; }
fn helper() -> u8 { 1 }
fn other() -> u8 { 2 }
fn guarded(x: Option<u8>) -> bool {
    matches!(x, Some(helper) if other() > 0)
}
fn untouched() {
    dsl!(helper() => other());
    println!("{}", dsl!(helper()));
    let _ = format!("{}", "s".len());
}
fn main() { let _ = guarded(None); untouched(); }
`);
    expect(outOf(graph, 'guarded')).toEqual(['calls other']);
    expect(outOf(graph, 'untouched')).toEqual([]);
  });
});
