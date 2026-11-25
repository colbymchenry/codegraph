/**
 * A Rust method call on a local or a parameter is a method of the type that
 * name is declared with where the call is: a parameter's type, a `let`'s
 * annotation or the value it is built from, a match arm's variant field. The
 * method is that type's own (inherent) one first, then one of a trait impl
 * the call's file has the trait of in scope, then a trait's provided one;
 * the type is the one the file's `use`s name. Through `&`, `Box`, `Rc`, `Arc`
 * a call reaches what they hold, and through `impl Trait` / `dyn Trait` the
 * trait's method. A type from outside the project has no project method. The
 * name strategies decide only where no declaration says what the name is:
 * dioxus's `Commands::Build(opts) => opts.build()` lost its link once the
 * build module's `BuildRequest::build` shared the method's name.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

let root = '';
let cg: CodeGraph;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-rust-typed-recv-'));
  const files: Record<string, string> = {
    'Cargo.toml': '[package]\nname = "app"\nversion = "0.1.0"\n\n[dependencies]\nnetlib = "1"\n',
    'src/main.rs': [
      'mod app;',
      'mod ast;',
      'mod canvas;',
      'mod cli;',
      'mod complete;',
      'mod disk;',
      'mod doc;',
      'mod doc_use;',
      'mod fallback;',
      'mod flags;',
      'mod form;',
      'mod http;',
      'mod io;',
      'mod layer;',
      'mod listener;',
      'mod net;',
      'mod once;',
      'mod overrides;',
      'mod paint;',
      'mod plan;',
      'mod render;',
      'mod report;',
      'mod request;',
      'mod runner;',
      'mod sched;',
      'mod serve;',
      'mod server;',
      'mod settings;',
      'mod shadow;',
      'mod start;',
      'mod store;',
      'mod sync;',
      'mod use_app;',
      'mod use_net;',
      'mod use_sync;',
      'mod widget;',
      'mod work;',
      '',
      'fn main() {}',
      '',
    ].join('\n'),
    'src/once.rs': [
      'use std::sync::Arc;',
      '',
      'pub struct SetOnce;',
      '',
      'impl SetOnce {',
      '    pub fn new() -> Self {',
      '        SetOnce',
      '    }',
      '',
      '    pub fn set(&self, v: u8) {}',
      '}',
      '',
      'pub fn fill() {',
      '    let once = Arc::new(SetOnce::new());',
      '    once.set(1);',
      '}',
      '',
    ].join('\n'),
    'src/form.rs': [
      'use std::rc::Rc;',
      '',
      'pub struct FormData;',
      'impl FormData {',
      '    pub fn downcast(&self) -> Option<&u8> {',
      '        None',
      '    }',
      '}',
      '',
      'pub fn get(data: Rc<FormData>) {',
      '    data.downcast();',
      '}',
      '',
    ].join('\n'),
    'src/sched.rs': [
      'use std::sync::Arc;',
      '',
      'pub trait Schedule {',
      '    fn schedule(&self, task: u32);',
      '}',
      '',
      'pub struct Handle;',
      '',
      'impl Handle {',
      '    pub fn spawn(&self) {}',
      '}',
      '',
      'impl Schedule for Arc<Handle> {',
      '    fn schedule(&self, task: u32) {}',
      '}',
      '',
      'pub fn run(handle: Arc<Handle>) {',
      '    handle.schedule(1);',
      '    handle.spawn();',
      '}',
      '',
    ].join('\n'),
    'src/flags.rs': [
      'pub struct ContextSeparator;',
      'impl ContextSeparator {',
      '    pub fn into_bytes(self) {}',
      '}',
      'pub struct FieldSeparator;',
      'impl FieldSeparator {',
      '    pub fn into_bytes(self) {}',
      '}',
      '',
      'pub fn context() {',
      '    use crate::flags::ContextSeparator as Separator;',
      '    let bytes = |sep: Separator| sep.into_bytes();',
      '}',
      '',
      'pub fn field() {',
      '    use crate::flags::FieldSeparator as Separator;',
      '    let bytes = |sep: Separator| sep.into_bytes();',
      '}',
      '',
    ].join('\n'),
    'src/doc.rs': [
      'pub trait Documentable {',
      '    fn to_doc(self) -> u8;',
      '}',
      '',
      'impl Documentable for netlib::EcoString {',
      '    fn to_doc(self) -> u8 {',
      '        0',
      '    }',
      '}',
      '',
      'impl Documentable for &netlib::EcoString {',
      '    fn to_doc(self) -> u8 {',
      '        1',
      '    }',
      '}',
      '',
    ].join('\n'),
    'src/doc_use.rs': [
      'use crate::doc::Documentable;',
      'use netlib::EcoString;',
      '',
      'pub fn by_ref(string: &EcoString) {',
      '    string.to_doc();',
      '}',
      '',
      'pub fn by_value(string: EcoString) {',
      '    string.to_doc();',
      '}',
      '',
    ].join('\n'),
    'src/runner.rs': [
      'pub enum Outcome {',
      '    Ignore { note: Option<String> },',
      '    Rebuild,',
      '}',
      '',
      'impl Outcome {',
      '    pub fn escalate(self, other: Outcome) -> Outcome {',
      '        other',
      '    }',
      '}',
      '',
      'pub fn decide() {',
      '    let mut result = Outcome::Ignore { note: None };',
      '    result = result.escalate(Outcome::Rebuild);',
      '}',
      '',
    ].join('\n'),
    'src/plan.rs': [
      'pub struct Plan;',
      '',
      'impl Plan {',
      '    pub fn escalate(&self) {}',
      '}',
      '',
    ].join('\n'),
    'src/ast.rs': [
      'pub struct Statement<T> {',
      '    pub value: T,',
      '}',
      '',
      'pub type TypedStatement = Statement<u32>;',
      'pub type UntypedStatement = Statement<String>;',
      '',
      'impl TypedStatement {',
      '    pub fn location(&self) {}',
      '}',
      '',
      'impl UntypedStatement {',
      '    pub fn location(&self) {}',
      '}',
      '',
      'pub fn visit(statement: &TypedStatement) {',
      '    statement.location();',
      '}',
      '',
      'impl TypedStatement {',
      '    pub fn type_(&self) {}',
      '}',
      '',
      'pub enum Node<T> {',
      '    Leaf(Statement<T>),',
      '}',
      '',
      'pub fn typed(node: &Node<u32>) {',
      '    match node {',
      '        Node::Leaf(statement) => statement.type_(),',
      '    }',
      '}',
      '',
    ].join('\n'),
    'src/io.rs': [
      'pub trait HttpClient {',
      '    fn send(&self);',
      '}',
      '',
    ].join('\n'),
    'src/http.rs': [
      'pub struct HttpClient;',
      '',
      'impl HttpClient {',
      '    pub fn new() -> Self {',
      '        HttpClient',
      '    }',
      '}',
      '',
      'impl crate::io::HttpClient for HttpClient {',
      '    fn send(&self) {}',
      '}',
      '',
      'pub fn fetch() {',
      '    let http = HttpClient::new();',
      '    http.send();',
      '}',
      '',
    ].join('\n'),
    'src/sync/mod.rs': 'pub mod batch;\npub mod semaphore;\n\npub use semaphore::Semaphore;\n',
    'src/sync/semaphore.rs': [
      'pub struct Semaphore;',
      '',
      'impl Semaphore {',
      '    pub fn new() -> Self {',
      '        Semaphore',
      '    }',
      '',
      '    pub fn try_acquire_owned(&self) {}',
      '}',
      '',
    ].join('\n'),
    'src/sync/batch.rs': [
      'pub struct Semaphore;',
      '',
      'impl Semaphore {',
      '    pub fn new() -> Self {',
      '        Semaphore',
      '    }',
      '}',
      '',
    ].join('\n'),
    'src/use_sync.rs': [
      'use std::sync::Arc;',
      '',
      'use crate::sync::Semaphore;',
      '',
      'pub fn take() {',
      '    let sem = Arc::new(Semaphore::new());',
      '    sem.try_acquire_owned();',
      '}',
      '',
    ].join('\n'),
    'src/listener.rs': [
      'pub trait Listener {',
      '    fn local_addr(&self) -> u16;',
      '}',
      '',
      'impl Listener for netlib::TcpListener {',
      '    fn local_addr(&self) -> u16 {',
      '        Self::local_addr(self)',
      '    }',
      '}',
      '',
    ].join('\n'),
    'src/serve.rs': [
      'use crate::listener::Listener;',
      'use netlib::TcpListener;',
      '',
      'pub fn addr(listener: TcpListener) {',
      '    listener.local_addr();',
      '}',
      '',
    ].join('\n'),
    'src/complete.rs': [
      'pub struct ScratchRuntime;',
      '',
      'impl netlib::Runtime for ScratchRuntime {',
      '    fn complete(&self) {}',
      '}',
      '',
      'pub fn load_runtime() -> Box<dyn netlib::Runtime> {',
      '    Box::new(ScratchRuntime)',
      '}',
      '',
      'pub fn check() {',
      '    let runtime = load_runtime();',
      '    runtime.complete();',
      '}',
      '',
    ].join('\n'),
    'src/cli.rs': [
      'use crate::overrides::Overrides;',
      '',
      'pub enum Commands {',
      '    Build(Overrides<BuildArgs>),',
      '    Tools(Tools),',
      '}',
      '',
      'pub enum Tools {',
      '    Assets(AssetsArgs),',
      '}',
      '',
      'pub struct BuildArgs;',
      '',
      'pub struct AssetsArgs;',
      '',
      'impl AssetsArgs {',
      '    pub fn run(self) {}',
      '}',
      '',
      'pub fn dispatch(args: Commands) {',
      '    match args {',
      '        Commands::Build(opts) => opts.build(),',
      '        Commands::Tools(Tools::Assets(opts)) => opts.run(),',
      '    }',
      '}',
      '',
    ].join('\n'),
    'src/overrides.rs': [
      'use crate::cli::BuildArgs;',
      '',
      'pub struct Overrides<T> {',
      '    pub inner: T,',
      '}',
      '',
      'impl Overrides<BuildArgs> {',
      '    pub fn build(self) {}',
      '}',
      '',
    ].join('\n'),
    'src/request.rs': [
      'pub struct BuildRequest;',
      '',
      'impl BuildRequest {',
      '    pub fn build(&self) {}',
      '}',
      '',
    ].join('\n'),
    'src/server.rs': [
      'pub struct Server;',
      '',
      'impl Server {',
      '    pub fn new() -> Self {',
      '        Server',
      '    }',
      '',
      '    pub fn run(&self) {}',
      '}',
      '',
    ].join('\n'),
    'src/work.rs': [
      'pub struct Worker;',
      '',
      'impl Worker {',
      '    pub fn run(&self) {}',
      '}',
      '',
    ].join('\n'),
    'src/start.rs': [
      'use std::rc::Rc;',
      'use std::sync::Arc;',
      '',
      'use crate::server::Server;',
      'use crate::work::Worker;',
      '',
      'pub fn shared(server: Arc<Server>) {',
      '    server.run();',
      '}',
      '',
      'pub fn boxed(worker: Box<Worker>) {',
      '    worker.run();',
      '}',
      '',
      'pub fn counted(worker: &mut Rc<Worker>) {',
      '    worker.run();',
      '}',
      '',
      "pub fn borrowed<'a>(srv: &'a Server) {",
      '    srv.run();',
      '}',
      '',
      'pub fn pathed(w: crate::work::Worker) {',
      '    w.run();',
      '}',
      '',
      'pub fn built() {',
      '    let srv = Arc::new(Server::new());',
      '    srv.run();',
      '}',
      '',
      'pub fn annotated() {',
      '    let srv: Rc<Server> = Rc::new(Server::new());',
      '    srv.run();',
      '}',
      '',
    ].join('\n'),
    'src/app/mod.rs': 'pub mod config;\n',
    'src/app/config.rs': [
      'pub struct Config;',
      '',
      'impl Config {',
      '    pub fn load(&self) {}',
      '}',
      '',
    ].join('\n'),
    'src/net/mod.rs': 'pub mod config;\n',
    'src/net/config.rs': [
      'pub struct Config;',
      '',
      'impl Config {',
      '    pub fn load(&self) {}',
      '}',
      '',
    ].join('\n'),
    'src/use_app.rs': [
      'use crate::app::config::Config;',
      '',
      'pub fn read(cfg: Config) {',
      '    cfg.load();',
      '}',
      '',
    ].join('\n'),
    'src/use_net.rs': [
      'use crate::net::config::Config;',
      '',
      'pub fn read(cfg: &Config) {',
      '    cfg.load();',
      '}',
      '',
    ].join('\n'),
    'src/render.rs': [
      'pub trait Render {',
      '    fn draw(&self);',
      '',
      '    fn describe(&self) -> String {',
      '        String::new()',
      '    }',
      '}',
      '',
    ].join('\n'),
    'src/paint.rs': [
      'pub trait Paint {',
      '    fn draw(&self);',
      '}',
      '',
    ].join('\n'),
    'src/widget.rs': [
      'use crate::paint::Paint;',
      'use crate::render::Render;',
      '',
      'pub struct Widget;',
      '',
      'impl Paint for Widget {',
      '    fn draw(&self) {}',
      '}',
      '',
      'impl Render for Widget {',
      '    fn draw(&self) {}',
      '}',
      '',
    ].join('\n'),
    'src/report.rs': [
      'pub struct Report;',
      '',
      'impl Report {',
      '    pub fn describe(&self) -> String {',
      '        String::new()',
      '    }',
      '}',
      '',
    ].join('\n'),
    'src/canvas.rs': [
      'use crate::render::Render;',
      'use crate::widget::Widget;',
      '',
      'pub fn show(widget: &Widget) {',
      '    widget.draw();',
      '    widget.describe();',
      '}',
      '',
      'pub fn paint_all(r: impl Render, d: &dyn Render, b: Box<dyn Render>) {',
      '    r.describe();',
      '    d.describe();',
      '    b.describe();',
      '}',
      '',
    ].join('\n'),
    'src/store.rs': [
      'pub struct Store;',
      '',
      'impl Store {',
      '    pub fn sync_all(&self) {}',
      '}',
      '',
    ].join('\n'),
    'src/disk.rs': [
      'pub fn persist(file: std::fs::File) {',
      '    file.sync_all();',
      '}',
      '',
    ].join('\n'),
    'src/shadow.rs': [
      'use crate::server::Server;',
      'use crate::work::Worker;',
      '',
      'fn spare() -> Option<Worker> {',
      '    None',
      '}',
      '',
      'pub fn shadowed(srv: Server) {',
      '    if let Some(srv) = spare() {',
      '        srv.run();',
      '    }',
      '}',
      '',
    ].join('\n'),
    'src/settings.rs': [
      'pub struct Settings;',
      '',
      'impl Settings {',
      '    pub fn combine(&self) {}',
      '',
      '    pub fn merge(&self, other: &Self) {',
      '        other.combine();',
      '    }',
      '}',
      '',
    ].join('\n'),
    'src/layer.rs': [
      'pub struct Layer;',
      '',
      'impl Layer {',
      '    pub fn combine(&self) {}',
      '}',
      '',
    ].join('\n'),
    'src/fallback.rs': [
      'pub struct Engine;',
      '',
      'impl Engine {',
      '    pub fn ignite(&self) {}',
      '}',
      '',
      'fn engine() -> Engine {',
      '    Engine',
      '}',
      '',
      'pub fn go() {',
      '    let e = engine();',
      '    e.ignite();',
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

describe('a Rust method call on a declared local or parameter', () => {
  it('is the method of the type a match arm\'s variant holds', () => {
    // `Commands::Build(opts)` holds an `Overrides<BuildArgs>`, whatever else
    // has a `build`; a nested variant's field the same way.
    expect(callsFrom('src/cli.rs', 'dispatch')).toEqual(['src/cli.rs@17', 'src/overrides.rs@8']);
  });

  it('reaches what `&`, `Box`, `Rc` and `Arc` hold', () => {
    expect(callsFrom('src/start.rs', 'shared')).toEqual(['src/server.rs@8']);
    expect(callsFrom('src/start.rs', 'boxed')).toEqual(['src/work.rs@4']);
    expect(callsFrom('src/start.rs', 'counted')).toEqual(['src/work.rs@4']);
    expect(callsFrom('src/start.rs', 'borrowed')).toEqual(['src/server.rs@8']);
  });

  it('reads a type written through a path, or the value a `let` is built from', () => {
    expect(callsFrom('src/start.rs', 'pathed')).toEqual(['src/work.rs@4']);
    expect(callsFrom('src/start.rs', 'built')).toEqual(['src/server.rs@4', 'src/server.rs@8']);
    expect(callsFrom('src/start.rs', 'annotated')).toEqual(['src/server.rs@4', 'src/server.rs@8']);
  });

  it('is the method of the type the file\'s `use` names, among types sharing its name', () => {
    expect(callsFrom('src/use_app.rs', 'read')).toEqual(['src/app/config.rs@4']);
    expect(callsFrom('src/use_net.rs', 'read')).toEqual(['src/net/config.rs@4']);
  });

  it('is the impl of the trait in scope, then the trait\'s provided method', () => {
    expect(callsFrom('src/canvas.rs', 'show')).toEqual(['src/render.rs@4', 'src/widget.rs@11']);
  });

  it('is the trait\'s method through `impl Trait`, `&dyn Trait` and `Box<dyn Trait>`', () => {
    expect(callsFrom('src/canvas.rs', 'paint_all')).toEqual(['src/render.rs@4']);
  });

  it('is the impl\'s own type\'s method through `Self`', () => {
    expect(callsFrom('src/settings.rs', 'merge')).toEqual(['src/settings.rs@4']);
  });

  it('is no project method for a type from outside the project', () => {
    expect(callsFrom('src/disk.rs', 'persist')).toEqual([]);
  });

  it('never takes the type of a declaration an inner binding shadows', () => {
    expect(callsFrom('src/shadow.rs', 'shadowed').filter((t) => t.startsWith('src/server.rs'))).toEqual([]);
  });

  it('is left to the name strategies where no declaration writes the type', () => {
    expect(callsFrom('src/fallback.rs', 'go')).toEqual(['src/fallback.rs@4', 'src/fallback.rs@7']);
    // Known only by a trait from outside the project, a value is any
    // implementation's, the project's among them.
    expect(callsFrom('src/complete.rs', 'check')).toEqual(['src/complete.rs@4', 'src/complete.rs@7']);
  });

  it('is the enum\'s method for a value a struct variant\'s literal builds', () => {
    expect(callsFrom('src/runner.rs', 'decide')).toEqual(['src/runner.rs@7']);
  });

  it('is the method an impl of a type alias declares, by the alias\'s name', () => {
    expect(callsFrom('src/ast.rs', 'visit')).toEqual(['src/ast.rs@9']);
    // A `Statement<T>` a generic enum's variant holds has the methods an
    // impl of its one alias with them declares.
    expect(callsFrom('src/ast.rs', 'typed')).toEqual(['src/ast.rs@21']);
  });

  it('is the impl\'s method, not the declaration of a trait sharing the type\'s name', () => {
    expect(callsFrom('src/http.rs', 'fetch')).toEqual(['src/http.rs@10', 'src/http.rs@4']);
  });

  it('is the method of the one type, among those the path may name, that has it', () => {
    expect(callsFrom('src/use_sync.rs', 'take')).toContain('src/sync/semaphore.rs@8');
  });

  it('is no project trait\'s method that hands the call on to the outside type\'s own', () => {
    expect(callsFrom('src/serve.rs', 'addr')).toEqual([]);
  });

  it('reaches through an `Arc` a method only `Pin` has of its own', () => {
    expect(callsFrom('src/once.rs', 'fill')).toEqual(['src/once.rs@10', 'src/once.rs@6']);
  });

  it('is a project impl on the `Arc` itself before what the `Arc` holds', () => {
    expect(callsFrom('src/sched.rs', 'run')).toEqual(['src/sched.rs@10', 'src/sched.rs@14']);
  });

  it('reaches the held type\'s `downcast` through an `Rc`, which only an `Rc<dyn Any>` has', () => {
    expect(callsFrom('src/form.rs', 'get')).toEqual(['src/form.rs@5']);
  });

  it('is the type a `use` in the calling block names', () => {
    expect(callsFrom('src/flags.rs', 'context')).toEqual(['src/flags.rs@3']);
    expect(callsFrom('src/flags.rs', 'field')).toEqual(['src/flags.rs@7']);
  });

  it('is the impl for a reference on a reference, for a value on a value', () => {
    expect(callsFrom('src/doc_use.rs', 'by_ref')).toEqual(['src/doc.rs@12']);
    expect(callsFrom('src/doc_use.rs', 'by_value')).toEqual(['src/doc.rs@6']);
  });
});
