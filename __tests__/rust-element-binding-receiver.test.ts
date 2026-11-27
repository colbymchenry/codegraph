/**
 * Rust: a call on a closure's parameter, or on what `if let Some(x) = opt.as_mut()`
 * binds — a name whose type is not written beside it but follows from the
 * value it is taken from.
 *
 * When two types in the project share the method's name the call stayed
 * unlinked: with `rpc.as_mut().is_none_or(|r| r.stop().is_ok())` as the one
 * caller of `Rpc::stop`, `callers stop` did not list it once a `Control::stop`
 * also existed, so a change to `Rpc::stop` looked like it reached nothing.
 *
 * Every case here has `Rpc::stop`, `Control::stop` and `Failure::stop`, so a
 * pass means the receiver's type was read, not that a unique name was matched.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CodeGraph } from '../src';

const TYPES = `
pub struct Rpc { id: u32 }
impl Rpc {
    pub fn new() -> Self { Self { id: 1 } }
    pub fn stop(&mut self) -> Result<(), ()> { Ok(()) }
}
pub struct Control;
impl Control {
    pub fn stop(&self, reason: u32) -> Result<(), ()> { let _ = reason; Ok(()) }
}
pub struct Failure;
impl Failure {
    pub fn stop(&self) {}
}
`;

let root: string;
let cg: CodeGraph | undefined;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-rust-element-')); });
afterEach(() => { cg?.close(); cg = undefined; fs.rmSync(root, { recursive: true, force: true }); });

/** Index one crate whose `lib.rs` is the shared types followed by `body`. */
async function index(body: string) {
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'Cargo.toml'), '[package]\nname="elements"\nversion="0.1.0"\nedition="2021"\n');
  fs.writeFileSync(path.join(root, 'src', 'lib.rs'), TYPES + body);
  cg = await CodeGraph.init(root, { index: true });
  cg.resolveReferences();
}
/** The functions and methods that call `Owner::stop`, sorted. */
function callersOf(owner: string): string[] {
  const method = cg!.getNodesByKind('method').find((n) => n.qualifiedName === `${owner}::stop`);
  expect(method, `${owner}::stop is indexed`).toBeDefined();
  return cg!.getCallers(method!.id).map((c) => c.node.name).sort();
}

describe('a closure\'s only parameter is what the call it is handed to passes it', () => {
  it('links the reported shape: a call inside a closure on an Option', async () => {
    await index(`
pub fn run_turn() -> bool {
    let mut rpc: Option<Rpc> = Some(Rpc::new());
    let settled = rpc.as_mut().is_none_or(|r| r.stop().is_ok());
    settled
}
`);
    expect(callersOf('Rpc')).toEqual(['run_turn']);
    expect(callersOf('Control')).toEqual([]);
    expect(callersOf('Failure')).toEqual([]);
  });

  it('follows a chain broken over lines, a block body, and a closure that is not the first argument', async () => {
    await index(`
pub fn chained(rpc: &mut Option<Rpc>) -> bool {
    rpc
        .as_mut()
        .is_none_or(|r| r.stop().is_ok())
}
pub fn block(all: &mut Vec<Rpc>) {
    all.iter_mut().for_each(|r| {
        let _ = r.stop();
    });
}
pub fn second_argument(rpc: Option<Rpc>) -> bool {
    rpc.map_or(true, |mut r| r.stop().is_ok())
}
pub fn moved(all: Vec<Rpc>) {
    all.into_iter().for_each(move |mut r| { let _ = r.stop(); });
}
pub fn by_reference(all: &[Rpc]) -> usize {
    all.iter().filter(|&r| r.id > 0).count()
}
`);
    expect(callersOf('Rpc')).toEqual(['block', 'chained', 'moved', 'second_argument']);
    expect(callersOf('Control')).toEqual([]);
  });

  it('routes each call to the item type of its own receiver', async () => {
    await index(`
pub fn stop_rpcs(all: &mut Vec<Rpc>) {
    all.iter_mut().for_each(|r| { let _ = r.stop(); });
}
pub fn stop_controls(all: &Vec<Control>) {
    all.iter().for_each(|r| { let _ = r.stop(3); });
}
pub fn on_error(result: Result<Rpc, Failure>) {
    let _ = result.map_err(|r| r.stop());
}
pub fn on_success(result: Result<Rpc, Failure>) {
    let _ = result.map(|mut r| r.stop());
}
pub fn either(result: Result<Control, Failure>) {
    result.map_or_else(|e| e.stop(), |c| { let _ = c.stop(1); });
}
`);
    expect(callersOf('Rpc')).toEqual(['on_success', 'stop_rpcs']);
    expect(callersOf('Control')).toEqual(['either', 'stop_controls']);
    expect(callersOf('Failure')).toEqual(['either', 'on_error']);
  });

  it('reads a tuple pattern, a field of the enclosing type, and a function\'s return', async () => {
    await index(`
fn find() -> Option<Rpc> { None }
pub struct Pool { rpcs: Vec<Rpc>, current: Option<Box<Rpc>>, controls: Vec<Control> }
impl Pool {
    pub fn stop_all(&mut self) {
        self.rpcs.iter_mut().for_each(|r| { let _ = r.stop(); });
    }
    pub fn stop_current(&mut self) -> bool {
        self.current.as_mut().is_none_or(|r| r.stop().is_ok())
    }
    pub fn stop_controls(&self) {
        self.controls.iter().for_each(|c| { let _ = c.stop(1); });
    }
}
pub fn numbered(all: &mut Vec<Rpc>) {
    all.iter_mut().enumerate().for_each(|(i, r)| { let _ = (i, r.stop()); });
}
pub fn returned() {
    find().map(|mut r| r.stop());
}
pub fn returned_then_borrowed() {
    let mut rpc = find();
    rpc.as_mut().map(|r| r.stop());
}
`);
    expect(callersOf('Rpc')).toEqual(['numbered', 'returned', 'returned_then_borrowed', 'stop_all', 'stop_current']);
    expect(callersOf('Control')).toEqual(['stop_controls']);
  });
});

describe('a pattern over a borrowed or taken Option binds what the Option holds', () => {
  it('links `if let`, `while let` and `let … else`', async () => {
    await index(`
pub fn if_let() {
    let mut rpc: Option<Rpc> = Some(Rpc::new());
    if let Some(r) = rpc.as_mut() {
        let _ = r.stop();
    }
}
pub fn while_let(mut queue: Vec<Rpc>) {
    let mut next: Option<Rpc> = queue.pop();
    while let Some(mut r) = next.take() {
        let _ = r.stop();
    }
}
pub fn let_else(rpc: &mut Option<Rpc>) {
    let Some(r) = rpc.as_mut() else { return; };
    let _ = r.stop();
}
pub fn if_ok(result: &Result<Rpc, Failure>) {
    if let Err(r) = result.as_ref() {
        r.stop();
    }
}
pub fn unwrapped(rpc: &mut Option<Rpc>) {
    let r = rpc.as_mut().unwrap();
    let _ = r.stop();
}
`);
    expect(callersOf('Rpc')).toEqual(['if_let', 'let_else', 'unwrapped', 'while_let']);
    expect(callersOf('Failure')).toEqual(['if_ok']);
    expect(callersOf('Control')).toEqual([]);
  });
});

describe('nothing is guessed where the type is not written down', () => {
  it('leaves the call unlinked rather than pick one of the three methods', async () => {
    await index(`
pub struct Wrapper { inner: Rpc }
impl Wrapper {
    pub fn map<F: FnOnce(u32) -> u32>(&self, f: F) -> u32 { f(1) }
}
fn apply<F: Fn(u32)>(f: F) { f(1) }
pub fn two_parameters(all: &Vec<Rpc>) -> u32 {
    all.iter().fold(0, |sum, r| sum + r.stop())
}
pub fn mapped_to_something_else(all: &Vec<Rpc>) {
    all.iter().map(|x| x.id).for_each(|r| { let _ = r.stop(); });
}
pub fn primitive_items(items: &[u32]) {
    items.iter().for_each(|r| { let _ = r.stop(); });
}
pub fn nested_container(all: &Vec<Option<Rpc>>) {
    all.iter().for_each(|r| { let _ = r.stop(); });
}
pub fn bound_to_a_name() {
    let f = |r| r.stop();
    let _ = f;
}
pub fn handed_to_a_function() {
    apply(|r| { let _ = r.stop(); });
}
pub fn project_method_of_the_same_name(wrapper: &Wrapper) {
    wrapper.map(|r| r.stop());
}
pub fn from_outside(all: outside::Things) {
    all.iter().for_each(|r| { let _ = r.stop(); });
}
pub fn first_argument_is_a_value(rpc: Option<Rpc>, other: Option<Control>) {
    rpc.map_or(other.map(|c| c.stop(0).is_ok()).unwrap_or(false), |_| true);
}
`);
    expect(callersOf('Rpc')).toEqual([]);
    // The one typed call in there is still read: `other.map(|c| …)` is on an Option<Control>.
    expect(callersOf('Control')).toEqual(['first_argument_is_a_value']);
    expect(callersOf('Failure')).toEqual([]);
  });

  it('does not link a method the item type does not have', async () => {
    await index(`
pub struct Plain;
impl Plain { pub fn id(&self) -> u32 { 1 } }
pub fn no_such_method(all: &Vec<Plain>) {
    all.iter().for_each(|r| { let _ = r.stop(); });
}
`);
    expect(callersOf('Rpc')).toEqual([]);
    expect(callersOf('Control')).toEqual([]);
    expect(callersOf('Failure')).toEqual([]);
  });

  it('a type written on the parameter still decides', async () => {
    await index(`
pub fn typed(all: &Vec<Control>) {
    all.iter().for_each(|r: &Control| { let _ = r.stop(2); });
}
`);
    expect(callersOf('Control')).toEqual(['typed']);
    expect(callersOf('Rpc')).toEqual([]);
  });
});
