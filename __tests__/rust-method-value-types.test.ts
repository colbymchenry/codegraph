/**
 * A Rust local bound to a method call's value — `let server = b.port(80)
 * .build()`, `let s = cfg.load()?`, `let conn = c.connect().await` — has the
 * type the method it reaches returns, read from that method's signature, so
 * a call on the local reaches that type's method. `.await` hands out an
 * `async fn`'s return type, or an `impl Future`'s `Output`; an `async fn`'s
 * value not awaited is a future, whose type the signature doesn't write.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

let root = '';
let cg: CodeGraph;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-rust-method-value-'));
  const files: Record<string, string> = {
    'Cargo.toml': '[package]\nname = "app"\nversion = "0.1.0"\n',
    'src/main.rs': [
      'mod app;',
      'mod codec;',
      'mod ext;',
      'mod net;',
      'mod other;',
      'mod printer;',
      'mod widget;',
      '',
      'fn main() {}',
      '',
    ].join('\n'),
    'src/ext.rs': [
      'pub trait Extension {}',
      '',
      'pub struct Completer;',
      '',
      'impl Extension for Completer {}',
      '',
      'impl Completer {',
      '    pub fn complete_at(&self) {}',
      '}',
      '',
      'pub struct Arg;',
      '',
      'impl Arg {',
      '    pub fn get<T: Extension>(&self) -> Option<&T> {',
      '        None',
      '    }',
      '}',
      '',
    ].join('\n'),
    'src/codec.rs': [
      'pub trait Encoder<Item> {',
      '    fn encode(&mut self, item: Item);',
      '}',
      '',
      'pub struct Codec;',
      'pub struct Frame;',
      '',
      'impl Encoder<Frame> for Codec {',
      '    fn encode(&mut self, item: Frame) {}',
      '}',
      '',
      'impl Encoder<String> for Codec {',
      '    fn encode(&mut self, item: String) {}',
      '}',
      '',
    ].join('\n'),
    'src/printer.rs': [
      'pub trait WriteColor {}',
      '',
      'pub struct Standard<W> {',
      '    wtr: W,',
      '}',
      '',
      'impl<W: WriteColor> Standard<W> {',
      '    pub fn sink(&self) {}',
      '}',
      '',
      'pub struct StandardBuilder;',
      '',
      'impl StandardBuilder {',
      '    pub fn build<W: WriteColor>(&self, wtr: W) -> Standard<W> {',
      '        Standard { wtr }',
      '    }',
      '}',
      '',
      'pub struct NoColor;',
      '',
      'impl WriteColor for NoColor {}',
      '',
    ].join('\n'),
    'src/widget.rs': [
      'pub trait Configure {',
      '    fn configured(self) -> Self',
      '    where',
      '        Self: Sized,',
      '    {',
      '        self',
      '    }',
      '}',
      '',
      'pub struct Widget;',
      '',
      'impl Configure for Widget {}',
      '',
      'impl Widget {',
      '    pub fn draw(&self) {}',
      '}',
      '',
    ].join('\n'),
    'src/net.rs': [
      'pub struct Builder {',
      '    port: u16,',
      '}',
      '',
      'impl Builder {',
      '    pub fn new() -> Self {',
      '        Builder { port: 0 }',
      '    }',
      '    pub fn port(self, port: u16) -> Self {',
      '        Builder { port }',
      '    }',
      '    pub fn build(self) -> Server {',
      '        Server',
      '    }',
      '}',
      '',
      'pub struct Server;',
      '',
      'impl Server {',
      '    pub fn run(&self) {}',
      '    fn state(&self) -> State {',
      '        State',
      '    }',
      '    pub fn tick(&self) {',
      '        let st = self.state();',
      '        st.advance();',
      '    }',
      '}',
      '',
      'pub struct State;',
      '',
      'impl State {',
      '    pub fn advance(&self) {}',
      '}',
      '',
      'pub struct Config;',
      '',
      'impl Config {',
      '    pub fn load(&self) -> Result<Settings, String> {',
      '        Ok(Settings)',
      '    }',
      '}',
      '',
      'pub struct Settings;',
      '',
      'impl Settings {',
      '    pub fn apply(&self) {}',
      '}',
      '',
      'pub struct Client;',
      '',
      'impl Client {',
      '    pub async fn connect(&self) -> Conn {',
      '        Conn',
      '    }',
      '    pub fn fetch(&self) -> impl std::future::Future<Output = Conn> {',
      '        async { Conn }',
      '    }',
      '}',
      '',
      'pub struct Conn;',
      '',
      'impl Conn {',
      '    pub fn send(&self) {}',
      '}',
      '',
    ].join('\n'),
    'src/other.rs': [
      'pub struct Other;',
      '',
      'impl Other {',
      '    pub fn run(&self) {}',
      '    pub fn advance(&self) {}',
      '    pub fn apply(&self) {}',
      '    pub fn send(&self) {}',
      '    pub fn build(&self) -> Other {',
      '        Other',
      '    }',
      '    pub async fn connect(&self) -> Other {',
      '        Other',
      '    }',
      '    pub fn fetch(&self) -> Other {',
      '        Other',
      '    }',
      '}',
      '',
    ].join('\n'),
    'src/app.rs': [
      'use crate::net::{Builder, Client, Config};',
      '',
      'pub fn start() {',
      '    let b = Builder::new();',
      '    let server = b.port(80).build();',
      '    server.run();',
      '}',
      '',
      'pub fn setup(cfg: Config) -> Result<(), String> {',
      '    let s = cfg.load()?;',
      '    s.apply();',
      '    Ok(())',
      '}',
      '',
      'pub async fn talk(c: Client) {',
      '    let conn = c.connect().await;',
      '    conn.send();',
      '}',
      '',
      'pub async fn fetched(c: Client) {',
      '    let conn = c.fetch().await;',
      '    conn.send();',
      '}',
      '',
      '// Same-file namesakes, which a guess by name alone prefers.',
      'pub struct Decoy;',
      '',
      'impl Decoy {',
      '    pub fn run(&self) {}',
      '    pub fn apply(&self) {}',
      '    pub fn send(&self) {}',
      '    pub fn complete_at(&self) {}',
      '    pub fn draw(&self) {}',
      '    pub fn sink(&self) {}',
      '}',
      '',
      'pub fn print(b: crate::printer::StandardBuilder) {',
      '    let printer = b.build(crate::printer::NoColor);',
      '    printer.sink();',
      '}',
      '',
      'pub fn complete(arg: crate::ext::Arg) {',
      '    if let Some(completer) = arg.get::<crate::ext::Completer>() {',
      '        completer.complete_at();',
      '    }',
      '}',
      '',
      'pub fn encode_frame(mut codec: crate::codec::Codec) {',
      '    use crate::codec::Encoder;',
      '    codec.encode(crate::codec::Frame);',
      '    codec.encode(String::new());',
      '}',
      '',
      'pub fn show(w: crate::widget::Widget) {',
      '    use crate::widget::Configure;',
      '    let w2 = w.configured();',
      '    w2.draw();',
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

/** What the `calls` edges out of `fn`, declared in `file`, reach, as `file@line`, sorted. */
const callsFrom = (file: string, fn: string): string[] => {
  const out: string[] = [];
  for (const node of cg.getNodesInFile(file).filter((n) => n.name === fn)) {
    for (const edge of cg.getOutgoingEdges(node.id)) {
      if (edge.kind !== 'calls') continue;
      const target = cg.getNode(edge.target)!;
      out.push(`${target.filePath}@${target.startLine}`);
    }
  }
  return [...new Set(out)].sort();
};

describe('a Rust local bound to a method call\'s value', () => {
  it('has the type a builder chain\'s last method returns', () => {
    // `server.run()` is `Server::run`, whatever the chain's `.build()`, a bare
    // call by its name, links to.
    const calls = callsFrom('src/app.rs', 'start');
    expect(calls).toContain('src/net.rs@20');
    expect(calls).not.toContain('src/app.rs@29');
    expect(calls).not.toContain('src/other.rs@4');
  });

  it('has the type `?` takes out of a returned `Result`', () => {
    expect(callsFrom('src/app.rs', 'setup')).toEqual(['src/net.rs@39', 'src/net.rs@47']);
  });

  it('has the type an awaited `async fn` returns', () => {
    expect(callsFrom('src/app.rs', 'talk')).toEqual(['src/net.rs@53', 'src/net.rs@64']);
  });

  it('has the `Output` of an awaited `impl Future`', () => {
    expect(callsFrom('src/app.rs', 'fetched')).toEqual(['src/net.rs@56', 'src/net.rs@64']);
  });

  it('has the type a `self` method returns', () => {
    expect(callsFrom('src/net.rs', 'tick')).toEqual(['src/net.rs@21', 'src/net.rs@33']);
  });

  it('has the type the call\'s turbofish gives the method\'s own type parameter', () => {
    // `completer.complete_at()` is `Completer`'s. (The extractor names the
    // turbofish call itself `arg.get::<crate::ext::Completer>`, which no
    // strategy reads yet.)
    const calls = callsFrom('src/app.rs', 'complete');
    expect(calls).toContain('src/ext.rs@8');
    expect(calls).not.toContain('src/app.rs@32');
  });

  it('has the type the return type\'s head names, whatever generic it carries', () => {
    // `build<W: WriteColor>(…) -> Standard<W>`: a `Standard`, whatever `W` is.
    expect(callsFrom('src/app.rs', 'print')).toEqual(['src/printer.rs@14', 'src/printer.rs@8']);
  });

  it('has the receiver\'s own type where a trait\'s provided method returns `Self`', () => {
    expect(callsFrom('src/app.rs', 'show')).toEqual(['src/widget.rs@15', 'src/widget.rs@2']);
  });
});

describe('a Rust call on a type with two impls of one trait', () => {
  it('is the impl whose trait argument is the call\'s argument\'s type', () => {
    expect(callsFrom('src/app.rs', 'encode_frame')).toEqual(['src/codec.rs@13', 'src/codec.rs@9']);
  });
});
