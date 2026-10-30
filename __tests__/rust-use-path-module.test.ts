/**
 * A name a Rust `use` binds is the item its path names: the item of that name
 * in the module the path walks to. tokio's `signal/mod.rs` writes `use
 * crate::sync::watch::Receiver;` and tokio-stream `use
 * tokio::sync::watch::Receiver;`, and both linked their `Receiver<()>` to the
 * `Receiver` of `net/unix/pipe.rs`: every `Receiver` in the crate read as in
 * scope, because the file imports a `Receiver`, and the first one won. The
 * path's module now decides — its own items, then what it re-exports (`pub
 * use mutex::{Mutex, …}`, macro-wrapped as tokio's `cfg_sync! { … }` are),
 * and the modules declared inline (`pub mod futures { … }`). Name matching
 * still answers when the path's module has no file to read.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

/** Writes `files` into a fresh temp dir and indexes it. */
async function indexProject(prefix: string, files: Record<string, string>): Promise<{ root: string; cg: CodeGraph }> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  return { root, cg: await CodeGraph.init(root, { index: true }) };
}

/** What `name`, written in `file`, links to, as `file@line` of each target, sorted. */
const targetsOf = (cg: CodeGraph, file: string, name: string, kinds: string[]): string[] => {
  const out: string[] = [];
  for (const node of cg.getNodesInFile(file)) {
    for (const edge of cg.getOutgoingEdges(node.id)) {
      if (!kinds.includes(edge.kind)) continue;
      const target = cg.getNode(edge.target)!;
      if (target.name === name) out.push(`${target.filePath}@${target.startLine}`);
    }
  }
  return [...new Set(out)].sort();
};

describe('a name a Rust `use` binds, by the module its path walks', () => {
  let root = '';
  let cg: CodeGraph;

  beforeAll(async () => {
    ({ root, cg } = await indexProject('cg-rust-use-path-', {
      'Cargo.toml': '[workspace]\nmembers = ["tokio", "tokio-stream"]\n',
      'tokio/Cargo.toml': '[package]\nname = "tokio"\nversion = "0.1.0"\n',
      'tokio/src/lib.rs': 'pub mod fs;\npub mod net;\npub mod signal;\npub mod sync;\nmod loom;\n',
      // Namesakes in modules that sort ahead of `sync`.
      'tokio/src/fs/mod.rs': 'pub struct Ready;\n\npub struct Notified;\n',
      'tokio/src/loom/mod.rs': 'pub(crate) struct Mutex<T>(T);\n',
      'tokio/src/net/mod.rs': 'pub mod unix;\n',
      'tokio/src/net/unix/mod.rs': 'pub mod pipe;\n',
      'tokio/src/net/unix/pipe.rs': [
        'pub struct Receiver {',
        '    fd: i32,',
        '}',
        '',
        'pub struct Sender {',
        '    fd: i32,',
        '}',
        '',
        'pub fn channel() -> Receiver {',
        '    Receiver { fd: 0 }',
        '}',
        '',
      ].join('\n'),
      'tokio/src/sync/mod.rs': [
        'macro_rules! cfg_sync {',
        '    ($($item:item)*) => { $( $item )* }',
        '}',
        '',
        'cfg_sync! {',
        '    mod mutex;',
        '    pub use mutex::{Mutex, MutexGuard};',
        '',
        '    pub(crate) mod notify;',
        '',
        '    pub mod broadcast;',
        '    pub mod watch;',
        '}',
        '',
        'pub mod futures {',
        '    pub use super::notify::Notified;',
        '',
        '    pub struct Ready;',
        '}',
        '',
      ].join('\n'),
      'tokio/src/sync/mutex.rs': 'pub struct Mutex<T> {\n    value: T,\n}\n\npub struct MutexGuard;\n',
      'tokio/src/sync/notify.rs': 'pub struct Notified;\n',
      'tokio/src/sync/broadcast.rs': 'use super::Mutex;\n\npub fn tail(lock: Mutex<u64>) {}\n',
      'tokio/src/sync/watch.rs': [
        'macro_rules! sender {',
        '    () => { pub struct Sender; }',
        '}',
        '',
        'sender!();',
        '',
        'pub struct Receiver<T> {',
        '    shared: T,',
        '}',
        '',
        'pub fn channel<T>(init: T) -> Receiver<T> {',
        '    Receiver { shared: init }',
        '}',
        '',
      ].join('\n'),
      'tokio/src/signal/mod.rs': [
        'use crate::sync::futures::{Notified, Ready};',
        'use crate::sync::watch::{channel, Receiver, Sender};',
        'use crate::sync::Mutex;',
        'use crate::gen::Thing;',
        '',
        'pub fn make(lock: Mutex<u8>) -> Receiver<()> {',
        '    channel(())',
        '}',
        '',
        'pub fn send(tx: Sender) {}',
        '',
        'pub fn wait(n: Notified, r: Ready, t: Thing) {}',
        '',
      ].join('\n'),
      // Generated at build time: the path's module has no file to read.
      'tokio/src/signal/thing.rs': 'pub struct Thing;\n',
      'tokio/tests/sync_watch.rs': 'use tokio::sync::watch::Receiver;\n\nfn rx(r: Receiver<u8>) -> Receiver<u8> {\n    r\n}\n',
      'tokio-stream/Cargo.toml': '[package]\nname = "tokio-stream"\nversion = "0.1.0"\n\n[dependencies]\ntokio = { path = "../tokio" }\n',
      'tokio-stream/src/lib.rs': 'pub mod wrappers;\n',
      'tokio-stream/src/wrappers/mod.rs': 'mod watch;\npub use watch::stream;\n',
      'tokio-stream/src/wrappers/watch.rs': 'use tokio::sync::watch::Receiver;\n\npub fn stream<T>(rx: Receiver<T>) -> Receiver<T> {\n    rx\n}\n',
    }));
  }, 60_000);

  afterAll(() => {
    cg?.close();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it('`use crate::sync::watch::Receiver` is watch.rs\'s Receiver, not a namesake elsewhere in the crate', () => {
    expect(targetsOf(cg, 'tokio/src/signal/mod.rs', 'Receiver', ['references'])).toEqual(['tokio/src/sync/watch.rs@7']);
  });

  it('so is `use tokio::sync::watch::Receiver`, from tokio\'s own tests and from a crate that depends on it', () => {
    expect(targetsOf(cg, 'tokio/tests/sync_watch.rs', 'Receiver', ['references'])).toEqual(['tokio/src/sync/watch.rs@7']);
    expect(targetsOf(cg, 'tokio-stream/src/wrappers/watch.rs', 'Receiver', ['references'])).toEqual(['tokio/src/sync/watch.rs@7']);
  });

  it('follows what the module re-exports, inside a macro too', () => {
    expect(targetsOf(cg, 'tokio/src/signal/mod.rs', 'Mutex', ['references'])).toEqual(['tokio/src/sync/mutex.rs@1']);
  });

  it('`use super::Mutex` starts from the parent module', () => {
    expect(targetsOf(cg, 'tokio/src/sync/broadcast.rs', 'Mutex', ['references'])).toEqual(['tokio/src/sync/mutex.rs@1']);
  });

  it('reaches into a module declared inline, and what it re-exports', () => {
    expect(targetsOf(cg, 'tokio/src/signal/mod.rs', 'Ready', ['references'])).toEqual(['tokio/src/sync/mod.rs@18']);
    expect(targetsOf(cg, 'tokio/src/signal/mod.rs', 'Notified', ['references'])).toEqual(['tokio/src/sync/notify.rs@1']);
  });

  it('links a call the same way', () => {
    expect(targetsOf(cg, 'tokio/src/signal/mod.rs', 'channel', ['calls'])).toEqual(['tokio/src/sync/watch.rs@11']);
  });

  it('links nothing when the module holds no such item the index knows', () => {
    // watch.rs's `Sender` is a macro's: no node, and pipe.rs's is not it.
    expect(targetsOf(cg, 'tokio/src/signal/mod.rs', 'Sender', ['references'])).toEqual([]);
  });

  it('falls back to name matching when the path\'s module has no file', () => {
    expect(targetsOf(cg, 'tokio/src/signal/mod.rs', 'Thing', ['references'])).toEqual(['tokio/src/signal/thing.rs@1']);
  });

  it('reads an edited `use` afresh on sync', async () => {
    fs.writeFileSync(path.join(root, 'tokio/src/sync/broadcast.rs'), 'use crate::loom::Mutex;\n\npub fn tail(lock: Mutex<u64>) {}\n');
    await cg.sync();
    expect(targetsOf(cg, 'tokio/src/sync/broadcast.rs', 'Mutex', ['references'])).toEqual(['tokio/src/loom/mod.rs@1']);
  });
});

describe('what a Rust module re-exports, when its names have more than one meaning', () => {
  let root = '';
  let cg: CodeGraph;

  beforeAll(async () => {
    ({ root, cg } = await indexProject('cg-rust-use-ns-', {
      'Cargo.toml': '[workspace]\nmembers = ["app", "clap", "clap_builder", "clap_derive"]\n',
      // clap re-exports its derive macros by name and its traits by a glob:
      // `ValueEnum` is both, a macro and a trait.
      'clap/Cargo.toml': '[package]\nname = "clap"\nversion = "0.1.0"\n\n[dependencies]\nclap_builder = { path = "../clap_builder" }\nclap_derive = { path = "../clap_derive" }\n',
      'clap/src/lib.rs': 'pub use clap_builder::*;\n\n#[cfg(feature = "derive")]\npub use clap_derive::{Parser, ValueEnum};\n',
      'clap_builder/Cargo.toml': '[package]\nname = "clap_builder"\nversion = "0.1.0"\n',
      'clap_builder/src/lib.rs': 'mod derive;\n\npub use crate::derive::{Parser, ValueEnum};\n',
      'clap_builder/src/derive.rs': 'pub trait Parser {}\n\npub trait ValueEnum {}\n',
      'clap_derive/Cargo.toml': '[package]\nname = "clap_derive"\nversion = "0.1.0"\n\n[lib]\nproc-macro = true\n',
      'clap_derive/src/lib.rs': 'use proc_macro::TokenStream;\n\n#[proc_macro_derive(ValueEnum)]\npub fn value_enum(input: TokenStream) -> TokenStream {\n    input\n}\n',
      'app/Cargo.toml': '[package]\nname = "app"\nversion = "0.1.0"\n\n[dependencies]\nclap = { path = "../clap" }\nglobal-hotkey = "0.6"\n',
      'app/src/lib.rs': 'mod desktop;\nmod mobile_shortcut;\nmod shell;\nmod shortcut;\nmod sys;\nmod user;\n',
      'app/src/shell.rs': 'use clap::ValueEnum;\n\npub enum Shell {\n    Bash,\n}\n\nimpl ValueEnum for Shell {}\n',
      // One cfg re-exports another crate's type, the other the project's.
      'app/src/shortcut.rs': '#[cfg(not(target_os = "ios"))]\npub use global_hotkey::HotKey;\n\n#[cfg(target_os = "ios")]\npub use crate::mobile_shortcut::*;\n',
      'app/src/mobile_shortcut.rs': 'pub struct HotKey;\n',
      'app/src/desktop.rs': 'use crate::shortcut::HotKey;\n\npub fn register(key: HotKey) {}\n',
      // A module a `#[path]` puts in another file on one target.
      'app/src/sys/mod.rs': '#[cfg(target_os = "ios")]\n#[path = "ios.rs"]\nmod imp;\n\n#[cfg(not(target_os = "ios"))]\nmod imp;\n\npub use imp::Handle;\n',
      'app/src/sys/imp.rs': 'pub use std::fs::File as Handle;\n',
      'app/src/sys/ios.rs': 'pub struct Handle;\n',
      'app/src/user.rs': 'use crate::sys::Handle;\n\npub fn open(handle: Handle) {}\n',
    }));
  }, 60_000);

  afterAll(() => {
    cg?.close();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it('a name `use`d as a macro still comes in as a trait through a glob', () => {
    expect(targetsOf(cg, 'app/src/shell.rs', 'ValueEnum', ['implements'])).toEqual(['clap_builder/src/derive.rs@3']);
  });

  it('a re-export of another crate\'s type leaves the project\'s, another cfg\'s, in scope', () => {
    expect(targetsOf(cg, 'app/src/desktop.rs', 'HotKey', ['references'])).toEqual(['app/src/mobile_shortcut.rs@1']);
  });

  it('a module whose file a `#[path]` names says nothing about its items', () => {
    expect(targetsOf(cg, 'app/src/user.rs', 'Handle', ['references'])).toEqual(['app/src/sys/ios.rs@1']);
  });
});
