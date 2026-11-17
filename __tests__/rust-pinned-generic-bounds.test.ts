/**
 * A Rust call through a `Pin` onto a type parameter — `reader.as_mut()
 * .poll_read(…)` on a `Pin<&mut R>`, pin-project's `me.inner.as_mut()
 * .start_seek(…)` on a `#[pin] inner: W` — is to the method the parameter's
 * bounds declare, as a call on the parameter's own path is: tokio's
 * `BufWriter` under `impl<W: AsyncWrite + AsyncSeek>` calls
 * `AsyncSeek::start_seek`. It linked nothing; 1.6.2 took `BufWriter`'s own
 * `start_seek` by its name, which is right only when `W` is a `BufWriter`.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

let root = '';
let cg: CodeGraph;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-rust-pinned-bounds-'));
  const files: Record<string, string> = {
    'Cargo.toml': '[package]\nname = "rt"\nversion = "0.1.0"\n',
    'src/lib.rs': 'pub mod buf_writer;\npub mod copy;\npub mod seek;\npub mod write;\n',
    'src/seek.rs': [
      'use std::ops::DerefMut;',
      'use std::pin::Pin;',
      '',
      'pub trait AsyncSeek {',
      '    fn start_seek(self: Pin<&mut Self>, pos: u64) -> u8;',
      '    fn poll_complete(self: Pin<&mut Self>) -> u64;',
      '}',
      '',
      'impl<P> AsyncSeek for Pin<P>',
      'where',
      '    P: DerefMut + Unpin,',
      '    P::Target: AsyncSeek,',
      '{',
      '    fn start_seek(self: Pin<&mut Self>, pos: u64) -> u8 {',
      '        0',
      '    }',
      '',
      '    fn poll_complete(self: Pin<&mut Self>) -> u64 {',
      '        0',
      '    }',
      '}',
      '',
    ].join('\n'),
    'src/write.rs': [
      'use std::pin::Pin;',
      '',
      'pub trait AsyncWrite {',
      '    fn poll_flush(self: Pin<&mut Self>) -> u8;',
      '}',
      '',
      'pub trait Flush {',
      '    fn poll_flush(self: Pin<&mut Self>) -> u8;',
      '}',
      '',
      'pub struct Sink;',
      '',
      'impl AsyncWrite for Sink {',
      '    fn poll_flush(self: Pin<&mut Self>) -> u8 {',
      '        1',
      '    }',
      '}',
      '',
    ].join('\n'),
    'src/buf_writer.rs': [
      'use std::pin::Pin;',
      '',
      'use crate::seek::AsyncSeek;',
      'use crate::write::AsyncWrite;',
      '',
      'pin_project_lite::pin_project! {',
      '    pub struct BufWriter<W> {',
      '        #[pin]',
      '        inner: W,',
      '        buf: Vec<u8>,',
      '    }',
      '}',
      '',
      'impl<W: AsyncWrite + AsyncSeek> AsyncSeek for BufWriter<W> {',
      '    fn start_seek(self: Pin<&mut Self>, pos: u64) -> u8 {',
      '        0',
      '    }',
      '',
      '    fn poll_complete(self: Pin<&mut Self>) -> u64 {',
      '        let mut me = self.project();',
      '        me.inner.as_mut().start_seek(1);',
      '        me.inner.as_mut().poll_complete()',
      '    }',
      '}',
      '',
    ].join('\n'),
    'src/copy.rs': [
      'use std::pin::Pin;',
      '',
      'use crate::write::{AsyncWrite, Flush};',
      '',
      'pub fn flush_all<W: AsyncWrite + ?Sized>(mut writer: Pin<&mut W>) -> u8 {',
      '    writer.as_mut().poll_flush()',
      '}',
      '',
      'pub fn flush_where<W>(mut writer: Pin<&mut W>) -> u8',
      'where',
      '    W: AsyncWrite + Unpin,',
      '{',
      '    writer.as_mut().poll_flush()',
      '}',
      '',
      'pub fn unbounded<W>(mut writer: Pin<&mut W>) -> u8 {',
      '    writer.as_mut().poll_flush()',
      '}',
      '',
      'pub fn ambiguous<W: AsyncWrite + Flush>(mut writer: Pin<&mut W>) -> u8 {',
      '    writer.as_mut().poll_flush()',
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

describe('a Rust call through a Pin onto a type parameter', () => {
  it('is the method the bound of the impl around it declares, not a namesake of the type being implemented', () => {
    expect(callsAt('src/buf_writer.rs', 21)).toEqual(['AsyncSeek::start_seek@src/seek.rs:5']);
    expect(callsAt('src/buf_writer.rs', 22)).toEqual(['AsyncSeek::poll_complete@src/seek.rs:6']);
  });

  it('is the method its function\'s bound declares, inline or in a where clause', () => {
    expect(callsAt('src/copy.rs', 6)).toEqual(['AsyncWrite::poll_flush@src/write.rs:4']);
    expect(callsAt('src/copy.rs', 13)).toEqual(['AsyncWrite::poll_flush@src/write.rs:4']);
  });

  it('is nothing with no bound declaring it, or two that both do', () => {
    expect(callsAt('src/copy.rs', 17)).toEqual([]);
    expect(callsAt('src/copy.rs', 21)).toEqual([]);
  });
});
