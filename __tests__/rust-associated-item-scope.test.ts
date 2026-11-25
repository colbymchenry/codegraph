/**
 * A Rust associated item — a `type` or `const` written inside an `impl` (or a
 * trait) — belongs to the type, not to the module: Rust reaches it only
 * through a path (`Self::Err`, `<T as FromStr>::Err`, `T::Err`), never by its
 * name alone, and no module path names it. clap's and gleam's `Err(…)` calls
 * went to the `type Err` of a `FromStr` impl in the same file, and axum's
 * `routing/` tests' `Response`s to the `type Response` of the `Service` impl
 * in `routing/mod.rs`, whose private items the modules inside it can see.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

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

describe('a Rust associated item', () => {
  let root = '';
  let cg: CodeGraph;

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-rust-assoc-'));
    const files: Record<string, string> = {
      'Cargo.toml': '[package]\nname = "web"\nversion = "0.1.0"\n',
      'src/lib.rs': 'pub mod de;\npub mod error;\npub mod parts;\npub mod response;\npub mod routing;\npub mod value;\npub mod value_hint;\n',
      // serde declares `de::Error` in a macro, which the index doesn't read:
      // the one `Error` it holds for `de/mod.rs` is an impl's.
      'src/de/mod.rs': [
        'macro_rules! declare_error_trait {',
        '    () => {',
        '        pub trait Error: Sized {}',
        '    };',
        '}',
        '',
        'declare_error_trait!();',
        '',
        'pub trait SeqAccess {',
        '    type Error;',
        '}',
        '',
        'pub struct Access;',
        '',
        'impl SeqAccess for Access {',
        '    type Error = String;',
        '}',
        '',
      ].join('\n'),
      'src/value.rs': 'use crate::de::Error;\n\npub struct ValueError;\n\nimpl crate::de::Error for ValueError {}\n',
      'src/response.rs': 'pub struct Body;\n\npub type Response<T = Body> = http::Response<T>;\n',
      // The crate's own `Error`, which `parts.rs`'s `std::error::Error` is not either.
      'src/error.rs': 'pub struct Error;\n',
      'src/routing/mod.rs': [
        'mod route;',
        '#[cfg(test)]',
        'mod tests;',
        '',
        'use crate::response::Response;',
        'use std::convert::Infallible;',
        '',
        'pub struct Router;',
        '',
        'impl<B> tower::Service<http::Request<B>> for Router {',
        '    type Response = Response;',
        '    type Error = Infallible;',
        '',
        '    fn call(&mut self, req: http::Request<B>) -> Result<Self::Response, Self::Error> {',
        '        todo!()',
        '    }',
        '}',
        '',
      ].join('\n'),
      // A module inside `routing` sees its private items, but never an impl's.
      'src/routing/tests.rs': 'use crate::response::Response;\n\nfn handler() -> Response {\n    todo!()\n}\n',
      'src/routing/route.rs': [
        'use crate::response::Response;',
        '',
        'pub struct Route;',
        '',
        'impl<B> tower::Service<http::Request<B>> for Route {',
        '    type Response = Response;',
        '',
        '    fn call(&mut self, req: http::Request<B>) -> Self::Response {',
        '        todo!()',
        '    }',
        '}',
        '',
        'pub struct RouteFuture;',
        '',
        'impl RouteFuture {',
        '    pub fn new(response: Response) -> Self {',
        '        RouteFuture',
        '    }',
        '}',
        '',
      ].join('\n'),
      'src/value_hint.rs': [
        'use std::str::FromStr;',
        '',
        'pub enum ValueHint {',
        '    Unknown,',
        '    Other,',
        '}',
        '',
        'impl FromStr for ValueHint {',
        '    type Err = String;',
        '',
        '    fn from_str(s: &str) -> Result<Self, Self::Err> {',
        '        match s {',
        '            "other" => Ok(ValueHint::Other),',
        '            _ => Err(format!("unknown hint: {s}")),',
        '        }',
        '    }',
        '}',
        '',
        'pub fn parse(s: &str) -> Result<ValueHint, String> {',
        '    if s.is_empty() {',
        '        return Err(String::from("empty"));',
        '    }',
        '    s.parse()',
        '}',
        '',
      ].join('\n'),
      'src/parts.rs': [
        'use std::convert::Infallible;',
        '',
        'pub trait IntoParts {',
        '    type Error;',
        '}',
        '',
        'pub struct Extensions;',
        '',
        'impl IntoParts for Extensions {',
        '    type Error = Infallible;',
        '}',
        '',
        '#[derive(Debug)]',
        'pub struct HeaderError;',
        '',
        'impl std::error::Error for HeaderError {',
        '    fn source(&self) -> Option<&(dyn std::error::Error + \'static)> {',
        '        None',
        '    }',
        '}',
        '',
        'pub struct Jar;',
        '',
        'pub struct JarIter;',
        '',
        'impl Jar {',
        '    pub fn iter(&self) -> impl Iterator<Item = String> + \'_ {',
        '        JarIter',
        '    }',
        '}',
        '',
        'impl Iterator for JarIter {',
        '    type Item = String;',
        '',
        '    fn next(&mut self) -> Option<Self::Item> {',
        '        None',
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

  it('is not what a bare call names: `Err(…)` is the prelude\'s, not a `FromStr` impl\'s `type Err`', () => {
    expect(targetsOf(cg, 'src/value_hint.rs', 'Err', ['calls'])).toEqual([]);
  });

  it('is not what a bare type names, in its own file or a module inside its own', () => {
    expect(targetsOf(cg, 'src/routing/tests.rs', 'Response', ['references'])).toEqual(['src/response.rs@3']);
    const own = cg.getNodesInFile('src/routing/route.rs').find((n) => n.name === 'new')!;
    const targets = cg.getOutgoingEdges(own.id).filter((e) => e.kind === 'references').map((e) => cg.getNode(e.target)!)
      .filter((t) => t.name === 'Response').map((t) => `${t.filePath}@${t.startLine}`);
    expect(targets).toEqual(['src/response.rs@3']);
  });

  it('is not what a module path names: `std::error::Error` is no impl\'s `type Error`', () => {
    const source = cg.getNodesInFile('src/parts.rs').find((n) => n.name === 'source')!;
    const targets = cg.getOutgoingEdges(source.id).map((e) => cg.getNode(e.target)!).filter((t) => t.name === 'Error');
    expect(targets.map((t) => `${t.kind} ${t.filePath}@${t.startLine}`)).toEqual([]);
  });

  it('is not what a `use` or a path to its module names', () => {
    const value = cg.getNodesInFile('src/value.rs');
    const targets = value.flatMap((n) => cg.getOutgoingEdges(n.id)).map((e) => cg.getNode(e.target)!)
      .filter((t) => t.name === 'Error').map((t) => `${t.kind} ${t.filePath}@${t.startLine}`);
    expect(targets).toEqual([]);
  });

  it('is not the `Item` an `Iterator<Item = …>` bound names', () => {
    const iter = cg.getNodesInFile('src/parts.rs').find((n) => n.name === 'iter')!;
    const targets = cg.getOutgoingEdges(iter.id).map((e) => cg.getNode(e.target)!).filter((t) => t.name === 'Item');
    expect(targets).toEqual([]);
  });

  it('is still what `Self::` names inside its impl', () => {
    expect(targetsOf(cg, 'src/value_hint.rs', 'Err', ['references'])).toEqual(['src/value_hint.rs@9']);
    const call = cg.getNodesInFile('src/routing/mod.rs').find((n) => n.name === 'call')!;
    const targets = cg.getOutgoingEdges(call.id).filter((e) => e.kind === 'references').map((e) => cg.getNode(e.target)!)
      .map((t) => `${t.name} ${t.filePath}@${t.startLine}`).sort();
    expect(targets).toEqual(['Error src/routing/mod.rs@12', 'Response src/routing/mod.rs@11']);
    expect(targetsOf(cg, 'src/parts.rs', 'Item', ['references'])).toEqual(['src/parts.rs@33']);
  });
});
