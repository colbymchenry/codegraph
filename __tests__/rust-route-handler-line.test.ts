/**
 * A Rust route's handler reference sits on the line its handler is written
 * on (#2326). rustfmt wraps a long `.route(` call, putting the handler on a
 * line below `.route(`; the Rust scope gate reads the reference's line to see
 * how the name is written (`handlers::f` names the `handlers` module), so a
 * reference left on the `.route(` line never found the name there and the
 * edge was dropped. A call inside a closure handler's body is not a method
 * router: `cache.get(keys::session_key)` is not a `GET` route handled by
 * `session_key`. Nor is an Actix resource's chain longer than the call it is
 * an argument of: the App-level `.route(..)` after it is not its method.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { rustResolver } from '../src/resolution/frameworks/rust';

const MAIN_RS = `mod actix_app;
mod handlers;
mod keys;
use axum::{routing::{get, post}, Router};
use crate::handlers::used_handler;

pub fn app() -> Router {
    Router::new()
        .route("/single", get(handlers::single_line_handler))
        .route(
            "/multi",
            get(handlers::multi_line_handler),
        )
        .route(
            "/deep",
            get(
                handlers::deep_line_handler,
            ),
        )
        .route(
            "/items",
            get(handlers::list_items)
                .post(handlers::create_item)
                .delete(handlers::delete_item),
        )
        .route(
            "/used",
            post(used_handler),
        )
        .route(
            "/other",
            get(metrics::render_handler),
        )
        .route("/closure-inline", get(|| async { cache().get(keys::session_key) }))
        .route(
            "/closure",
            get(|| async move {
                cache().get(keys::session_key)
            }),
        )
}
`;

const ACTIX_RS = `use actix_web::{web, App};
use crate::handlers;

pub fn actix() {
    App::new()
        .service(
            web::resource("/index/with/a/rather/long/path/{id}")
                .to(handlers::actix_index),
        )
        .service(
            web::resource("/user/{id}")
                .route(
                    web::get()
                        .to(handlers::actix_get_user),
                ),
        )
        .route(
            "/hey",
            web::get().to(handlers::actix_hello),
        );
}
`;

let root = '';
let cg: CodeGraph;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-rust-route-line-'));
  const files: Record<string, string> = {
    'Cargo.toml': '[package]\nname = "repro"\nversion = "0.1.0"\nedition = "2021"\n\n[dependencies]\naxum = "0.7"\nactix-web = "4"\nmetrics = "0.23"\n',
    'src/main.rs': MAIN_RS,
    'src/actix_app.rs': ACTIX_RS,
    'src/handlers/mod.rs': `pub async fn single_line_handler() {}
pub async fn multi_line_handler() {}
pub async fn deep_line_handler() {}
pub async fn list_items() {}
pub async fn create_item() {}
pub async fn delete_item() {}
pub async fn used_handler() {}
pub async fn render_handler() {}
pub async fn actix_index() {}
pub async fn actix_get_user() {}
pub async fn actix_hello() {}
`,
    'src/keys.rs': 'pub fn session_key() -> &\'static str { "s" }\n',
  };
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  cg = await CodeGraph.init(root, { index: true });
});

afterAll(() => {
  cg?.close();
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

/** `METHOD /path -> file:handler` for every route -> function `references` edge out of a file's routes. */
const routeEdges = (file: string): string[] => {
  const routes = cg.getNodesInFile(file).filter((n) => n.kind === 'route');
  return cg.getOutgoingEdgesFrom(routes.map((r) => r.id), ['references'])
    .map((e) => `${cg.getNode(e.source)!.name} -> ${cg.getNode(e.target)!.filePath}:${cg.getNode(e.target)!.name}`)
    .sort();
};

describe('Axum: a handler written below `.route(` is linked to its route (#2326)', () => {
  it('links a single-line route, as before', () => {
    expect(routeEdges('src/main.rs')).toContain('GET /single -> src/handlers/mod.rs:single_line_handler');
  });

  it('links a rustfmt-wrapped route', () => {
    expect(routeEdges('src/main.rs')).toContain('GET /multi -> src/handlers/mod.rs:multi_line_handler');
  });

  it('links a handler wrapped below its method router too', () => {
    expect(routeEdges('src/main.rs')).toContain('GET /deep -> src/handlers/mod.rs:deep_line_handler');
  });

  it('links every method of a chain wrapped over several lines', () => {
    expect(routeEdges('src/main.rs')).toEqual(expect.arrayContaining([
      'GET /items -> src/handlers/mod.rs:list_items',
      'POST /items -> src/handlers/mod.rs:create_item',
      'DELETE /items -> src/handlers/mod.rs:delete_item',
    ]));
  });

  it('links a wrapped handler named through a `use`', () => {
    expect(routeEdges('src/main.rs')).toContain('POST /used -> src/handlers/mod.rs:used_handler');
  });

  it('does not link a wrapped handler another module names to a same-named one', () => {
    expect(routeEdges('src/main.rs').filter((e) => e.includes('render_handler'))).toEqual([]);
  });

  it('never reads a call inside a closure handler as a route', () => {
    expect(routeEdges('src/main.rs').filter((e) => e.includes('closure'))).toEqual([]);
    const routes = cg.getNodesInFile('src/main.rs').filter((n) => n.kind === 'route').map((n) => n.name);
    expect(routes.filter((n) => n.includes('closure'))).toEqual([]);
  });

  it('keeps the route on the `.route(` line and puts the reference on the handler', () => {
    const { nodes, references } = rustResolver.extract!('src/main.rs', MAIN_RS);
    const lines = MAIN_RS.split('\n');
    const lineOf = (text: string) => lines.findIndex((l) => l.includes(text)) + 1;
    const multi = nodes.find((n) => n.name === 'GET /multi')!;
    expect(multi.startLine).toBe(lineOf('"/multi"') - 1);
    const ref = references.find((r) => r.referenceName === 'multi_line_handler')!;
    expect(ref.line).toBe(lineOf('handlers::multi_line_handler'));
    expect(lines[ref.line - 1]!.startsWith('multi_line_handler', ref.column)).toBe(true);
    const single = references.find((r) => r.referenceName === 'single_line_handler')!;
    expect(single.line).toBe(nodes.find((n) => n.name === 'GET /single')!.startLine);
  });
});

describe('Actix: a handler written below its route is linked to it (#2326)', () => {
  it('links a wrapped `web::resource(..).to(handler)`', () => {
    expect(routeEdges('src/actix_app.rs')).toContain('ANY /index/with/a/rather/long/path/{id} -> src/handlers/mod.rs:actix_index');
  });

  it('links a wrapped `web::get().to(handler)` inside `.route(`', () => {
    expect(routeEdges('src/actix_app.rs')).toContain('GET /user/{id} -> src/handlers/mod.rs:actix_get_user');
  });

  it('links a wrapped App-level `.route("/path", web::get().to(handler))`', () => {
    expect(routeEdges('src/actix_app.rs')).toContain('GET /hey -> src/handlers/mod.rs:actix_hello');
  });

  it('does not read the App-level route after a `.service(..)` into its resource', () => {
    expect(routeEdges('src/actix_app.rs').filter((e) => e.startsWith('GET /user/{id}')))
      .toEqual(['GET /user/{id} -> src/handlers/mod.rs:actix_get_user']);
  });
});
