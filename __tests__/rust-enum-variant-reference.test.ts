/**
 * A Rust enum used only through its variants is a dependency of the code that
 * uses them (#2328). `mode::Mode::A` in an expression, `Mode::B => …` in a
 * `match`, a `Mode::C(x)` / `Mode::D { .. }` pattern and `Self::A` in the
 * enum's impl reference the enum that declares the variant — the same
 * `references` edge a type annotation (`fn takes(_m: Mode)`) produces. Nothing
 * else read through a path does: not an associated const or function
 * (`Limits::MAX`, `Mode::new()`), not a standard-library enum's variant.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CodeGraph } from '../src';

let root: string;
let cg: CodeGraph | undefined;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-rust-variant-ref-')); });
afterEach(() => { cg?.close(); cg = undefined; fs.rmSync(root, { recursive: true, force: true }); });

async function index(files: Record<string, string>) {
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'Cargo.toml'), '[package]\nname = "repro"\nversion = "0.1.0"\nedition = "2021"\n');
  for (const [file, text] of Object.entries(files)) fs.writeFileSync(path.join(root, 'src', file), text);
  cg = await CodeGraph.init(root, { index: true });
}

/** The enum named `name` declared in `src/<file>`. */
function enumIn(file: string, name = 'Mode') {
  const node = cg!.getNodesByKind('enum').find((n) => n.filePath === `src/${file}` && n.name === name);
  expect(node, `enum ${name} in ${file}`).toBeDefined();
  return node!;
}

/** `file:name` of every symbol with a `references` edge to the node. */
function referencers(nodeId: string): string[] {
  const names = cg!.getIncomingEdges(nodeId)
    .filter((e) => e.kind === 'references')
    .map((e) => cg!.getNode(e.source)!)
    .map((n) => `${n.filePath.replace(/^src\//, '')}:${n.name}`);
  return [...new Set(names)].sort();
}

const MODE = `pub enum Mode {
    A,
    B,
    C(u8),
    D { x: u8 },
}

pub fn takes(_m: Mode) {}

pub fn current() -> Mode { Mode::B }
`;

describe('Rust enum variant paths reference their enum (#2328)', () => {
  it('the issue: a variant path in an expression and in match arms, through the module', async () => {
    await index({
      'mode.rs': MODE,
      'variant_use.rs': `use crate::mode;

pub fn code(flag: bool) -> u8 {
    let m = if flag { mode::Mode::A } else { mode::Mode::B };
    match m {
        mode::Mode::A => 1,
        mode::Mode::B => 2,
        _ => 3,
    }
}
`,
      'main.rs': `mod mode;
mod variant_use;

fn main() {
    mode::takes(mode::Mode::A);
    let _ = variant_use::code(true);
}
`,
    });
    expect(referencers(enumIn('mode.rs').id)).toEqual(['main.rs:main', 'mode.rs:current', 'mode.rs:takes', 'variant_use.rs:code']);
  });

  it('a bare `Mode::A` after `use crate::mode::Mode;`', async () => {
    await index({
      'lib.rs': 'pub mod mode;\npub mod bare;\n',
      'mode.rs': MODE,
      'bare.rs': `use crate::mode::{self, Mode};

pub fn pick() -> u8 {
    let _m = Mode::B;
    0
}

pub fn score() -> u8 {
    match mode::current() {
        Mode::A => 1,
        _ => 0,
    }
}
`,
    });
    expect(referencers(enumIn('mode.rs').id)).toEqual(['bare.rs:pick', 'bare.rs:score', 'mode.rs:current', 'mode.rs:takes']);
    const pick = cg!.getNodesByKind('function').find((n) => n.name === 'pick')!;
    const at = cg!.getOutgoingEdges(pick.id).filter((e) => e.kind === 'references').map((e) => `${e.line}:${e.column}`);
    expect(at).toEqual(['4:13']);
  });

  it('tuple and struct variant patterns, and a variant read as a value', async () => {
    await index({
      'lib.rs': 'pub mod mode;\npub mod pat;\n',
      'mode.rs': MODE,
      'pat.rs': `use crate::mode::{self, Mode};

pub fn tuple() -> u8 {
    match mode::current() {
        Mode::C(x) => x,
        _ => 0,
    }
}

pub fn structure() -> u8 {
    if let crate::mode::Mode::D { x } = mode::current() { x } else { 0 }
}

pub fn ctor_value(xs: Vec<u8>) -> usize {
    xs.into_iter().map(Mode::C).count()
}
`,
    });
    expect(referencers(enumIn('mode.rs').id)).toEqual([
      'mode.rs:current', 'mode.rs:takes', 'pat.rs:ctor_value', 'pat.rs:structure', 'pat.rs:tuple',
    ]);
  });

  it('constructing a tuple or struct variant stays linked to the variant itself', async () => {
    await index({
      'lib.rs': 'pub mod mode;\npub mod build;\n',
      'mode.rs': MODE,
      'build.rs': `use crate::mode::Mode;

pub fn build() {
    let _c = Mode::C(3);
    let _d = Mode::D { x: 2 };
}
`,
    });
    const build = cg!.getNodesByKind('function').find((n) => n.name === 'build')!;
    const out = cg!.getOutgoingEdges(build.id).map((e) => `${e.kind}:${cg!.getNode(e.target)!.qualifiedName}`).sort();
    expect(out).toEqual(['calls:Mode::C', 'instantiates:Mode::D']);
  });

  it('`Self::A` inside `impl Mode`, in the enum\'s file and in another one', async () => {
    await index({
      'lib.rs': 'pub mod mode;\npub mod ops;\n',
      'mode.rs': `${MODE}
impl Mode {
    pub fn flip(&self) -> u8 {
        match self {
            Self::A => 1,
            _ => 0,
        }
    }
}
`,
      'ops.rs': `use crate::mode::Mode;

impl Mode {
    pub fn is_b(&self) -> bool {
        if let Self::B = self { true } else { false }
    }
}
`,
    });
    expect(referencers(enumIn('mode.rs').id)).toEqual(['mode.rs:current', 'mode.rs:flip', 'mode.rs:takes', 'ops.rs:is_b']);
  });

  it('a variant imported by name and used bare has no path to read the enum from', async () => {
    await index({
      'lib.rs': 'pub mod mode;\npub mod other;\npub mod glob;\n',
      'mode.rs': MODE,
      'other.rs': 'pub enum Mode {\n    A,\n    Z,\n}\n',
      'glob.rs': `use crate::mode::Mode::*;

pub fn bare(m: u8) -> u8 {
    match m {
        0 => { let _ = A; 1 }
        _ => 0,
    }
}
`,
    });
    // Out of scope (#2328 is about paths): a bare name gives no receiver, and
    // it must never land on the other module's same-named enum either.
    expect(referencers(enumIn('mode.rs').id)).toEqual(['mode.rs:current', 'mode.rs:takes']);
    expect(referencers(enumIn('other.rs').id)).toEqual([]);
  });

  it('the path picks the type that declares the variant, never a same-named type without it', async () => {
    await index({
      'lib.rs': 'pub mod matching;\npub mod other;\npub mod user;\n',
      'matching.rs': 'pub enum Match {\n    None,\n    Ignore,\n}\n',
      'other.rs': 'pub struct Match;\n',
      'user.rs': `use crate::matching::Match;

pub enum ColorChoice {
    Auto,
    Ansi,
}

pub fn first() -> u8 {
    let _m = Match::None;
    0
}

pub fn color() -> u8 {
    let _c = termcolor::ColorChoice::AlwaysAnsi;
    0
}
`,
    });
    expect(referencers(enumIn('matching.rs', 'Match').id)).toEqual(['user.rs:first']);
    const struct = cg!.getNodesByKind('struct').find((n) => n.filePath === 'src/other.rs')!;
    expect(referencers(struct.id)).toEqual([]);
    // `termcolor`'s ColorChoice, not the file's own enum, which has no `AlwaysAnsi`.
    expect(referencers(enumIn('user.rs', 'ColorChoice').id)).toEqual([]);
  });

  it('an associated const or function read through a type is not a variant path', async () => {
    await index({
      'lib.rs': 'pub mod mode;\npub mod limits;\npub mod user;\n',
      'mode.rs': `${MODE}
impl Mode {
    pub const ALL: [u8; 2] = [0, 1];
    pub fn count() -> usize { Self::ALL.len() }
}
`,
      'limits.rs': 'pub struct Limits;\n\nimpl Limits {\n    pub const MAX: u8 = 3;\n    pub fn new() -> Self { Limits }\n}\n',
      'user.rs': `use crate::limits::Limits;
use crate::mode::Mode;

pub fn cap() -> u8 {
    Limits::MAX
}

pub fn all() -> usize {
    Mode::ALL.len()
}

pub fn make() {
    let _l = Limits::new();
    let _f = Limits::new;
}
`,
    });
    // Only variants: the enum's own `count` and every reader of `Mode::ALL` /
    // `Limits::MAX` stay off, and `Limits::new` links the function, not the type.
    expect(referencers(enumIn('mode.rs').id)).toEqual(['mode.rs:current', 'mode.rs:takes']);
    const limits = cg!.getNodesByKind('struct').find((n) => n.name === 'Limits')!;
    expect(referencers(limits.id)).toEqual([]);
    const make = cg!.getNodesByKind('function').find((n) => n.name === 'make')!;
    expect(cg!.getOutgoingEdges(make.id).map((e) => `${e.kind}:${cg!.getNode(e.target)!.qualifiedName}`)).toEqual(['calls:Limits::new']);
  });

  it('std and prelude enums never reach a same-named project enum', async () => {
    await index({
      'lib.rs': 'pub mod shapes;\npub mod user;\n',
      'shapes.rs': `pub enum Ordering {
    Less,
    Greater,
}

pub enum Option {
    Some,
    None,
}
`,
      'user.rs': `use std::cmp::{self, Ordering};

pub fn sorted(a: u8, b: u8) -> bool {
    a.cmp(&b) == Ordering::Less || b.cmp(&a) == cmp::Ordering::Greater || a.cmp(&b) != std::cmp::Ordering::Less
}

pub fn first(o: Option<u8>) -> u8 {
    match o {
        Option::Some(x) => x,
        Option::None => 0,
    }
}

pub fn bare(o: Option<u8>, r: Result<u8, ()>) -> u8 {
    match (o, r) {
        (Some(x), Ok(_)) => x,
        (None, Err(())) => 0,
        _ => 1,
    }
}
`,
    });
    expect(referencers(enumIn('shapes.rs', 'Ordering').id)).toEqual([]);
    expect(referencers(enumIn('shapes.rs', 'Option').id)).toEqual([]);
    for (const variant of cg!.getNodesByKind('enum_member')) {
      expect(cg!.getIncomingEdges(variant.id).filter((e) => e.kind !== 'contains'), variant.qualifiedName).toEqual([]);
    }
  });

  it('a module path, an associated function and a same-named enum elsewhere are not references to the enum', async () => {
    await index({
      'lib.rs': 'pub mod mode;\npub mod other;\npub mod util;\npub mod paths;\n',
      'mode.rs': `${MODE}
impl Mode {
    pub fn new() -> Mode { Mode::A }
}
`,
      'other.rs': 'pub enum Mode {\n    A,\n    Z,\n}\n',
      'util.rs': 'pub fn take(x: u8) -> u8 { x }\n',
      'paths.rs': `use crate::mode;
use crate::other;
use crate::util;

pub fn via_module() -> u8 {
    util::take(3)
}

pub fn via_ctor() {
    let _m = mode::Mode::new();
}

pub fn via_other() -> u8 {
    match other::Mode::A {
        other::Mode::Z => 1,
        _ => 0,
    }
}

pub fn via_mode() {
    let _m = mode::Mode::A;
}
`,
    });
    const viaModule = cg!.getNodesByKind('function').find((n) => n.name === 'via_module')!;
    expect(cg!.getOutgoingEdges(viaModule.id).filter((e) => e.kind === 'references')).toEqual([]);
    expect(referencers(enumIn('other.rs').id)).toEqual(['paths.rs:via_other']);
    // `new`'s own `Mode::A` and return type; `via_ctor` calls an associated
    // function, which links the function, not the enum.
    expect(referencers(enumIn('mode.rs').id)).toEqual(['mode.rs:current', 'mode.rs:new', 'mode.rs:takes', 'paths.rs:via_mode']);
  });
});
