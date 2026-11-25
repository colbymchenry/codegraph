/**
 * A Rust call on what `.as_mut()` or `.as_ref()` hands back, which the
 * extractor records by its bare name, is a call on the receiver's declared
 * type as `as_mut` passes it on: a `Pin<P>` re-pins what it points at, a
 * `Box<T>` lends its `T`, an `Option<T>` stays an `Option`, whose methods are
 * std's. By the name alone, tokio's `self.delay.as_mut().reset(now)` on a
 * `Pin<Box<Sleep>>` field went to the calling `Interval::reset`, its
 * `this.timer.as_mut().as_pin_mut()` on an `Option` to a stream's
 * `as_pin_mut`, `reader.as_mut().poll_read(…)` on a generic `R` to
 * `BufReader::poll_read`, and dioxus's `self.child.as_mut().map(…)` to a
 * `GenerationalRefMut::map` that shared the word `mut`.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

let root = '';
let cg: CodeGraph;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-rust-as-mut-'));
  const files: Record<string, string> = {
    'Cargo.toml': '[package]\nname = "rt"\nversion = "0.1.0"\n',
    'src/main.rs': 'mod copy;\nmod decoys;\nmod holder;\nmod interval;\nmod projected;\nmod pump;\nmod sleep;\n\nfn main() {}\n',
    'src/sleep.rs': [
      'use std::pin::Pin;',
      '',
      'pub struct Sleep {',
      '    deadline: u64,',
      '}',
      '',
      'impl Sleep {',
      '    pub fn reset(self: Pin<&mut Self>, deadline: u64) {}',
      '',
      '    pub fn deadline(&self) -> u64 {',
      '        self.deadline',
      '    }',
      '}',
      '',
    ].join('\n'),
    // Methods by the names the calls below use, on types the calls never reach.
    'src/decoys.rs': [
      'use std::pin::Pin;',
      '',
      'pub struct Writer;',
      '',
      'impl Writer {',
      '    pub fn start_seek(self: Pin<&mut Self>, pos: u64) {}',
      '}',
      '',
      'pub struct GuardMut;',
      '',
      'impl GuardMut {',
      '    pub fn map(self, f: u8) -> u8 {',
      '        f',
      '    }',
      '}',
      '',
      'pub struct Lines;',
      '',
      'impl Lines {',
      '    pub fn as_pin_mut(self: Pin<&mut Self>) {}',
      '}',
      '',
    ].join('\n'),
    // Fields declared `Pin<Box<T>>` and `Option<T>`.
    'src/interval.rs': [
      'use std::pin::Pin;',
      '',
      'use crate::sleep::Sleep;',
      '',
      'pub struct Interval {',
      '    delay: Pin<Box<Sleep>>,',
      '    timer: Option<Sleep>,',
      '}',
      '',
      'impl Interval {',
      '    pub fn reset(&mut self, at: u64) {',
      '        self.delay.as_mut().reset(at);',
      '    }',
      '',
      '    pub fn peek(&mut self) -> u64 {',
      '        self.delay.as_ref().deadline()',
      '    }',
      '',
      '    pub fn stop(&mut self) {',
      '        self.timer.as_mut().map(|_| ());',
      '    }',
      '}',
      '',
    ].join('\n'),
    // Fields declared `Box<T>` and `NonNull<T>` lend the `T`; `?` takes an `Option`'s back out.
    'src/holder.rs': [
      'use std::ptr::NonNull;',
      '',
      'use crate::sleep::Sleep;',
      '',
      'pub struct Holder {',
      '    inner: Box<Sleep>,',
      '}',
      '',
      'impl Holder {',
      '    pub fn check(&mut self) -> u64 {',
      '        self.inner.as_mut().deadline()',
      '    }',
      '}',
      '',
      'pub struct Shared {',
      '    entry: NonNull<Sleep>,',
      '    next: Option<Sleep>,',
      '}',
      '',
      'impl Shared {',
      '    pub unsafe fn when(&self) -> u64 {',
      '        unsafe { self.entry.as_ref().deadline() }',
      '    }',
      '',
      '    pub fn upcoming(&mut self) -> Option<u64> {',
      '        Some(self.next.as_mut()?.deadline())',
      '    }',
      '}',
      '',
    ].join('\n'),
    // pin-project: a `#[pin]` field projects to `Pin<&mut T>`, another to `&mut T`.
    'src/projected.rs': [
      'use std::pin::Pin;',
      '',
      'use crate::sleep::Sleep;',
      '',
      'pin_project_lite::pin_project! {',
      '    pub struct Timeout<W> {',
      '        #[pin]',
      '        inner: W,',
      '        #[pin]',
      '        delay: Sleep,',
      '        timer: Option<Sleep>,',
      '    }',
      '}',
      '',
      'impl<W> Timeout<W> {',
      '    pub fn poll_seek(self: Pin<&mut Self>, pos: u64) {',
      '        let mut me = self.project();',
      '        me.inner.as_mut().start_seek(pos);',
      '        me.delay.as_mut().reset(pos);',
      '        me.timer.as_mut().as_pin_mut();',
      '    }',
      '}',
      '',
    ].join('\n'),
    // Values declared `Pin<&mut …>`.
    'src/copy.rs': [
      'use std::pin::Pin;',
      '',
      'use crate::sleep::Sleep;',
      '',
      'pub fn read_some<R: Unpin>(mut reader: Pin<&mut R>, deadline: Pin<&mut Sleep>) -> u64 {',
      '    reader.as_mut().start_seek(0);',
      '    deadline.as_ref().deadline()',
      '}',
      '',
    ].join('\n'),
    // `self: Pin<&mut Self>`: `self.as_mut()` is that same `Pin`.
    'src/pump.rs': [
      'use std::pin::Pin;',
      '',
      'pub struct Pump;',
      '',
      'impl Pump {',
      '    fn step(self: Pin<&mut Self>) {}',
      '',
      '    fn get_mut(&mut self) -> u8 {',
      '        0',
      '    }',
      '',
      '    pub fn run(mut self: Pin<&mut Self>) {',
      '        self.as_mut().step();',
      '        self.as_mut().get_mut();',
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

/** What the calls on `line` of `file` link to, as `qualifiedName@file:line`, sorted. */
const callsAt = (file: string, line: number): string[] => {
  const out: string[] = [];
  for (const node of cg.getNodesInFile(file)) {
    for (const edge of cg.getOutgoingEdges(node.id)) {
      if (edge.kind !== 'calls' || edge.line !== line) continue;
      const target = cg.getNode(edge.target)!;
      out.push(`${target.qualifiedName}@${target.filePath}:${target.startLine}`);
    }
  }
  return [...new Set(out)].sort();
};

describe('a Rust call on `.as_mut()` / `.as_ref()` of a field', () => {
  it('declared `Pin<Box<T>>` is `T`\'s method', () => {
    expect(callsAt('src/interval.rs', 12)).toEqual(['Sleep::reset@src/sleep.rs:8']);
    expect(callsAt('src/interval.rs', 16)).toEqual(['Sleep::deadline@src/sleep.rs:10']);
  });

  it('declared `Option<T>` is the `Option`\'s own, no project method', () => {
    expect(callsAt('src/interval.rs', 20)).toEqual([]);
  });

  it('declared `Box<T>` or `NonNull<T>` is `T`\'s method', () => {
    expect(callsAt('src/holder.rs', 11)).toEqual(['Sleep::deadline@src/sleep.rs:10']);
    expect(callsAt('src/holder.rs', 22)).toEqual(['Sleep::deadline@src/sleep.rs:10']);
  });

  it('declared `Option<T>`, through `?`, is `T`\'s method', () => {
    expect(callsAt('src/holder.rs', 26)).toEqual(['Sleep::deadline@src/sleep.rs:10']);
  });

  it('projected by pin-project is the field\'s type, pinned or not', () => {
    expect(callsAt('src/projected.rs', 18)).toEqual([]);
    expect(callsAt('src/projected.rs', 19)).toEqual(['Sleep::reset@src/sleep.rs:8']);
    expect(callsAt('src/projected.rs', 20)).toEqual([]);
  });
});

describe('a Rust call on `.as_mut()` / `.as_ref()` of a value declared `Pin<&mut T>`', () => {
  it('is `T`\'s method, and nothing for a type parameter', () => {
    expect(callsAt('src/copy.rs', 6)).toEqual([]);
    expect(callsAt('src/copy.rs', 7)).toEqual(['Sleep::deadline@src/sleep.rs:10']);
  });
});

describe('a Rust call on `self.as_mut()` through `self: Pin<&mut Self>`', () => {
  it('is the type\'s own method, or `Pin`\'s', () => {
    expect(callsAt('src/pump.rs', 13)).toEqual(['Pump::step@src/pump.rs:6']);
    expect(callsAt('src/pump.rs', 14)).toEqual([]);
  });
});
