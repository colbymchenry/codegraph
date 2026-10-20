/**
 * A Rust method call reaches what Rust's method lookup picks:
 * - through a wrapper — `self: Pin<&mut Self>`, `self: Rc<Self>`, `read:
 *   Pin<&mut R>` — the wrapped type's own method taking `self` through it
 *   first (`fn poll_flush(self: Pin<&mut Self>, …)`), then the wrapper's own
 *   (`Pin::get_mut`, `Rc`'s `clone`, an impl on `Pin<P>` taking `&self`), then
 *   the wrapped type's other methods. tokio's `self.poll_flush(cx)` in `impl
 *   AsyncWrite for File` went to its blanket `impl AsyncWrite for Pin<P>`,
 *   whose `poll_flush` would need a `Pin<&mut Pin<…>>`;
 * - a type's inherent method before a trait's of the same name: tokio's
 *   `Arc::from_raw(ptr)` is std's own, not its `impl Link for Arc<…>`'s, and
 *   a trait impl's `fn wake(self) { self.wake() }` hands the call on to the
 *   type's own `wake`, never back to itself;
 * - `(self.into_route)(state)` calls what a field holds, no method;
 * - a tuple's method is no named type's: serde's `(self.ip(),
 *   self.port()).serialize(s)` went to the `impl Serialize for Path` below it.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

let root = '';
let cg: CodeGraph;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-rust-wrapped-self-'));
  const files: Record<string, string> = {
    'Cargo.toml': '[package]\nname = "rt"\nversion = "0.1.0"\n',
    'src/main.rs': 'mod copy;\nmod cursor;\nmod erased;\nmod file;\nmod grid;\nmod io;\nmod link;\nmod measure;\nmod net;\nmod runtime;\nmod ser;\nmod shape;\nmod sleep;\nmod tester;\nmod wake;\nmod waker;\n\nfn main() {}\n',
    // A field holding a function, called through `self: Box<Self>`, beside a method of its name.
    'src/erased.rs': [
      'pub struct MakeErased {',
      '    into_route: fn(u8) -> u8,',
      '}',
      '',
      'impl MakeErased {',
      '    fn into_route(self: Box<Self>, state: u8) -> u8 {',
      '        (self.into_route)(state)',
      '    }',
      '',
      '    fn call(self: Box<Self>, state: u8) -> u8 {',
      '        self.into_route(state)',
      '    }',
      '}',
      '',
    ].join('\n'),
    // A trait impl handing a call on to the type's own method of its name.
    'src/waker.rs': [
      'use std::task::Waker;',
      '',
      'trait WakerRef {',
      '    fn wake(self);',
      '}',
      '',
      'impl WakerRef for Waker {',
      '    fn wake(self) {',
      '        self.wake();',
      '    }',
      '}',
      '',
      'impl WakerRef for &Waker {',
      '    fn wake(self) {',
      '        self.wake_by_ref();',
      '    }',
      '}',
      '',
    ].join('\n'),
    'src/measure.rs': [
      'use crate::grid::Grid;',
      '',
      'pub trait Measure {',
      '    fn len(&self) -> usize;',
      '}',
      '',
      'impl Measure for Grid {',
      '    fn len(&self) -> usize {',
      '        self.len()',
      '    }',
      '}',
      '',
    ].join('\n'),
    'src/tester.rs': [
      'use std::future::Future;',
      'use std::pin::Pin;',
      'use std::task::{Context, Poll};',
      '',
      'pub struct Tester {',
      '    done: bool,',
      '}',
      '',
      'impl Future for Tester {',
      '    type Output = ();',
      '',
      '    fn poll(mut self: Pin<&mut Self>, cx: &mut Context<\'_>) -> Poll<()> {',
      '        if self.done {',
      '            return Poll::Ready(());',
      '        }',
      '        self.done = true;',
      '        self.poll(cx)',
      '    }',
      '}',
      '',
    ].join('\n'),
    'src/io.rs': [
      'use std::pin::Pin;',
      'use std::task::{Context, Poll};',
      '',
      'pub trait AsyncWrite {',
      '    fn poll_write(self: Pin<&mut Self>, cx: &mut Context<\'_>, buf: &[u8]) -> Poll<usize>;',
      '    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<\'_>) -> Poll<()>;',
      '    fn poll_write_vectored(self: Pin<&mut Self>, cx: &mut Context<\'_>, buf: &[u8]) -> Poll<usize> {',
      '        self.poll_write(cx, buf)',
      '    }',
      '    fn is_write_vectored(&self) -> bool {',
      '        false',
      '    }',
      '}',
      '',
      'pub trait AsyncRead {',
      '    fn poll_read(self: Pin<&mut Self>, cx: &mut Context<\'_>, buf: &mut [u8]) -> Poll<usize>;',
      '}',
      '',
      'impl<P> AsyncWrite for Pin<P>',
      'where',
      '    P: std::ops::DerefMut,',
      '    P::Target: AsyncWrite,',
      '{',
      '    fn poll_write(self: Pin<&mut Self>, cx: &mut Context<\'_>, buf: &[u8]) -> Poll<usize> {',
      '        Poll::Ready(buf.len())',
      '    }',
      '',
      '    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<\'_>) -> Poll<()> {',
      '        Poll::Ready(())',
      '    }',
      '',
      '    fn is_write_vectored(&self) -> bool {',
      '        true',
      '    }',
      '}',
      '',
      'impl<P> AsyncRead for Pin<P>',
      'where',
      '    P: std::ops::DerefMut,',
      '    P::Target: AsyncRead,',
      '{',
      '    fn poll_read(self: Pin<&mut Self>, cx: &mut Context<\'_>, buf: &mut [u8]) -> Poll<usize> {',
      '        Poll::Ready(0)',
      '    }',
      '}',
      '',
    ].join('\n'),
    'src/file.rs': [
      'use std::pin::Pin;',
      'use std::task::{Context, Poll};',
      '',
      'use crate::io::AsyncWrite;',
      '',
      'pub struct File {',
      '    pending: usize,',
      '}',
      '',
      'impl File {',
      '    pub fn get_mut(&mut self) -> &mut usize {',
      '        &mut self.pending',
      '    }',
      '',
      '    fn complete(&mut self) -> usize {',
      '        self.pending',
      '    }',
      '}',
      '',
      'impl AsyncWrite for File {',
      '    fn poll_write(self: Pin<&mut Self>, cx: &mut Context<\'_>, buf: &[u8]) -> Poll<usize> {',
      '        Poll::Ready(buf.len())',
      '    }',
      '',
      '    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<\'_>) -> Poll<()> {',
      '        let _ = self.complete();',
      '        let me = self.get_mut();',
      '        Poll::Ready(())',
      '    }',
      '',
      '    fn poll_write_vectored(self: Pin<&mut Self>, cx: &mut Context<\'_>, buf: &[u8]) -> Poll<usize> {',
      '        self.poll_flush(cx);',
      '        Poll::Ready(0)',
      '    }',
      '}',
      '',
    ].join('\n'),
    // Two impls of one trait for one outside type: each `self.poll_flush` is its own block's.
    'src/cursor.rs': [
      'use std::io::Cursor;',
      'use std::pin::Pin;',
      'use std::task::{Context, Poll};',
      '',
      'use crate::io::AsyncWrite;',
      '',
      'impl AsyncWrite for Cursor<Vec<u8>> {',
      '    fn poll_write(self: Pin<&mut Self>, cx: &mut Context<\'_>, buf: &[u8]) -> Poll<usize> {',
      '        self.poll_flush(cx);',
      '        Poll::Ready(0)',
      '    }',
      '',
      '    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<\'_>) -> Poll<()> {',
      '        Poll::Ready(())',
      '    }',
      '}',
      '',
      'impl AsyncWrite for Cursor<Box<[u8]>> {',
      '    fn poll_write(self: Pin<&mut Self>, cx: &mut Context<\'_>, buf: &[u8]) -> Poll<usize> {',
      '        self.poll_flush(cx);',
      '        Poll::Ready(0)',
      '    }',
      '',
      '    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<\'_>) -> Poll<()> {',
      '        Poll::Ready(())',
      '    }',
      '}',
      '',
    ].join('\n'),
    // Through a parameter declared `Pin<&mut …>`.
    'src/copy.rs': [
      'use std::pin::Pin;',
      'use std::task::{Context, Poll};',
      '',
      'use crate::file::File;',
      'use crate::io::{AsyncRead, AsyncWrite};',
      '',
      'pub fn read_some<R: AsyncRead + ?Sized>(read: Pin<&mut R>, cx: &mut Context<\'_>, buf: &mut [u8]) -> Poll<usize> {',
      '    read.poll_read(cx, buf)',
      '}',
      '',
      'pub fn vectored<T: AsyncWrite + ?Sized>(io: Pin<&mut T>) -> bool {',
      '    io.is_write_vectored()',
      '}',
      '',
      'pub fn flush_file(file: Pin<&mut File>, cx: &mut Context<\'_>) -> Poll<()> {',
      '    file.poll_flush(cx)',
      '}',
      '',
    ].join('\n'),
    'src/sleep.rs': [
      'use std::pin::Pin;',
      '',
      'pub struct Sleep;',
      '',
      'impl Sleep {',
      '    pub fn reset(self: Pin<&mut Self>) {}',
      '',
      '    pub fn deadline(&self) -> u64 {',
      '        0',
      '    }',
      '}',
      '',
      'pub fn rearm(sleep: Pin<&mut Sleep>) -> u64 {',
      '    let at = sleep.deadline();',
      '    sleep.reset();',
      '    at',
      '}',
      '',
    ].join('\n'),
    'src/runtime.rs': [
      'use std::rc::Rc;',
      '',
      '#[derive(Debug)]',
      'pub struct Runtime;',
      '',
      'impl Clone for Runtime {',
      '    fn clone(&self) -> Self {',
      '        Runtime',
      '    }',
      '}',
      '',
      'impl Runtime {',
      '    fn in_scope(&self) {}',
      '',
      '    pub fn handle_event(self: Rc<Self>) {',
      '        let me = self.clone();',
      '        self.in_scope();',
      '    }',
      '}',
      '',
      'pub struct Route;',
      '',
      'impl Route {',
      '    fn into_route(self: Box<Self>) -> Route {',
      '        *self',
      '    }',
      '',
      '    fn call(self: Box<Self>) -> Route {',
      '        self.into_route()',
      '    }',
      '}',
      '',
    ].join('\n'),
    'src/link.rs': [
      'use std::ptr::NonNull;',
      '',
      'pub unsafe trait Link {',
      '    type Target;',
      '    unsafe fn from_raw(ptr: NonNull<Self::Target>) -> Self;',
      '}',
      '',
    ].join('\n'),
    'src/net.rs': [
      'use std::ptr::NonNull;',
      'use std::sync::Arc;',
      '',
      'use crate::link::Link;',
      '',
      'pub struct ScheduledIo;',
      '',
      'unsafe impl Link for Arc<ScheduledIo> {',
      '    type Target = ScheduledIo;',
      '',
      '    unsafe fn from_raw(ptr: NonNull<ScheduledIo>) -> Arc<ScheduledIo> {',
      '        unsafe { Arc::from_raw(ptr.as_ptr() as *const _) }',
      '    }',
      '}',
      '',
    ].join('\n'),
    'src/wake.rs': [
      'use std::ptr::NonNull;',
      'use std::sync::Arc;',
      '',
      'use crate::link::Link;',
      'use crate::net::ScheduledIo;',
      '',
      'pub unsafe fn wake(ptr: NonNull<ScheduledIo>) -> Arc<ScheduledIo> {',
      '    unsafe { Arc::from_raw(ptr.as_ptr()) }',
      '}',
      '',
    ].join('\n'),
    // An inherent method and a trait's of one name: the inherent is the one called.
    'src/grid.rs': [
      'pub struct Grid {',
      '    cells: Vec<u8>,',
      '}',
      '',
      'impl Grid {',
      '    pub fn len(&self) -> usize {',
      '        self.cells.len()',
      '    }',
      '}',
      '',
    ].join('\n'),
    'src/shape.rs': [
      'use crate::grid::Grid;',
      '',
      'pub trait Shape {',
      '    fn len(&self) -> usize;',
      '    fn area(&self) -> usize;',
      '}',
      '',
      'impl Shape for Grid {',
      '    fn len(&self) -> usize {',
      '        0',
      '    }',
      '',
      '    fn area(&self) -> usize {',
      '        self.len()',
      '    }',
      '}',
      '',
      'pub fn count(grid: &Grid) -> usize {',
      '    grid.len()',
      '}',
      '',
    ].join('\n'),
    // A tuple's `serialize` is no named type's.
    'src/ser.rs': [
      'pub trait Serialize {',
      '    fn serialize(&self, out: &mut String);',
      '}',
      '',
      'pub struct SocketAddr {',
      '    ip: u32,',
      '    port: u16,',
      '}',
      '',
      'impl Serialize for SocketAddr {',
      '    fn serialize(&self, out: &mut String)',
      '    where',
      '        Self: Sized,',
      '    {',
      '        if out.is_empty() {',
      '            out.push(\'[\');',
      '        } else {',
      '            (self.ip, self.port).serialize(out)',
      '        }',
      '    }',
      '}',
      '',
      'impl Serialize for Path {',
      '    fn serialize(&self, out: &mut String) {}',
      '}',
      '',
      'pub struct Path;',
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

describe('a Rust call through `self: Pin<&mut Self>`', () => {
  it('is the type\'s own method taking `self` that way, not a blanket impl on `Pin<P>`', () => {
    expect(callsAt('src/file.rs', 32)).toEqual(['File::poll_flush@src/file.rs:25']);
  });

  it('in a trait\'s own body is the trait\'s method', () => {
    expect(callsAt('src/io.rs', 8)).toEqual(['AsyncWrite::poll_write@src/io.rs:5']);
  });

  it('is the impl block\'s own method when one outside type has several impls', () => {
    expect(callsAt('src/cursor.rs', 9)).toEqual(['Cursor::poll_flush@src/cursor.rs:13']);
    expect(callsAt('src/cursor.rs', 20)).toEqual(['Cursor::poll_flush@src/cursor.rs:24']);
  });

  it('is `Pin`\'s own method before the type\'s namesake', () => {
    expect(callsAt('src/file.rs', 27)).toEqual([]);
  });

  it('reaches the type\'s other methods through it', () => {
    expect(callsAt('src/file.rs', 26)).toEqual(['File::complete@src/file.rs:15']);
  });
});

describe('a Rust call on a value declared `Pin<&mut T>`', () => {
  it('is the bound\'s method, never a blanket impl\'s taking `self: Pin<&mut Self>`', () => {
    expect(callsAt('src/copy.rs', 8)).toEqual(['AsyncRead::poll_read@src/io.rs:16']);
  });

  it('keeps a blanket impl\'s `&self` method, which `Pin` answers first', () => {
    expect(callsAt('src/copy.rs', 12)).toEqual(['Pin::is_write_vectored@src/io.rs:32']);
  });

  it('is the pinned type\'s own method', () => {
    expect(callsAt('src/copy.rs', 16)).toEqual(['File::poll_flush@src/file.rs:25']);
    expect(callsAt('src/sleep.rs', 14)).toEqual(['Sleep::deadline@src/sleep.rs:8']);
    expect(callsAt('src/sleep.rs', 15)).toEqual(['Sleep::reset@src/sleep.rs:6']);
  });
});

describe('a Rust call through `self: Rc<Self>` / `self: Box<Self>`', () => {
  it('is the type\'s own method', () => {
    expect(callsAt('src/runtime.rs', 17)).toEqual(['Runtime::in_scope@src/runtime.rs:13']);
    expect(callsAt('src/runtime.rs', 29)).toEqual(['Route::into_route@src/runtime.rs:24']);
  });

  it('is the wrapper\'s own `clone`, not the type\'s', () => {
    expect(callsAt('src/runtime.rs', 16)).toEqual([]);
  });

  it('is no method when it calls what a field holds, `(self.into_route)(state)`', () => {
    expect(callsAt('src/erased.rs', 7)).toEqual([]);
    expect(callsAt('src/erased.rs', 11)).toEqual(['MakeErased::into_route@src/erased.rs:6']);
  });
});

describe('a Rust trait impl calling `self.<its own name>()`', () => {
  it('hands the call on to the type\'s inherent method', () => {
    expect(callsAt('src/measure.rs', 9)).toEqual(['Grid::len@src/grid.rs:6']);
  });

  it('links nothing for a type from outside the project, whose own method the index doesn\'t hold', () => {
    expect(callsAt('src/waker.rs', 9)).toEqual([]);
  });

  it('calls itself again where the project\'s type has no such method', () => {
    expect(callsAt('src/tester.rs', 17)).toEqual(['Tester::poll@src/tester.rs:12']);
  });
});

describe('a Rust type\'s inherent method comes before a trait\'s of the same name', () => {
  it('leaves std\'s inherent `Arc::from_raw` to std, with a project trait\'s in scope', () => {
    expect(callsAt('src/net.rs', 12)).toEqual([]);
    expect(callsAt('src/wake.rs', 8)).toEqual([]);
  });

  it('takes a project type\'s inherent method over its trait impl\'s', () => {
    expect(callsAt('src/shape.rs', 14)).toEqual(['Grid::len@src/grid.rs:6']);
    expect(callsAt('src/shape.rs', 19)).toEqual(['Grid::len@src/grid.rs:6']);
  });
});

describe('a Rust method called on a tuple', () => {
  it('is no named type\'s', () => {
    expect(callsAt('src/ser.rs', 18)).toEqual([]);
  });
});
