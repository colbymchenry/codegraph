/**
 * The Rust resolver's struct/handler/service name heuristics never reach an
 * item declared inside a function body — axum's examples' `Uri` (imported
 * from `http`) went to a `struct Uri` a routing test declares inside itself —
 * and a file's own item comes first: ripgrep's `Ok(Glob { … })` in
 * globset's glob.rs is its own `Glob`, not the CLI flags' `Glob`.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

let root = '';
let cg: CodeGraph;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-rust-fw-'));
  const files: Record<string, string> = {
    'Cargo.toml': '[workspace]\nmembers = ["crates/core", "crates/globset", "crates/web", "examples/tls"]\n',
    'crates/core/Cargo.toml': '[package]\nname = "rg-core"\n',
    'crates/web/Cargo.toml': '[package]\nname = "web"\n',
    'crates/web/src/lib.rs': 'pub mod http;\n',
    'crates/web/src/http.rs': 'pub use ::http::Uri;\n',
    'crates/web/src/routing/tests.rs': `fn outer_middleware_still_see_whole_url() {
    struct Uri;
    let _ = Uri;
}
`,
    'examples/tls/Cargo.toml': '[package]\nname = "example-tls"\n\n[dependencies]\nweb = { path = "../../crates/web" }\n',
    'examples/tls/src/main.rs': `use web::http::Uri;

fn make_https(uri: Uri, port: u16) -> Uri {
    uri
}
`,
    'crates/core/src/flags/defs.rs': `pub struct Glob;

pub fn glob_flag() -> Glob {
    Glob
}
`,
    'crates/globset/Cargo.toml': '[package]\nname = "globset"\n',
    'crates/globset/src/glob.rs': `pub struct Glob {
    glob: String,
}

impl Glob {
    pub fn new(glob: &str) -> Result<Glob, ()> {
        Ok(Glob { glob: glob.to_string() })
    }
}
`,
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

const targetsFrom = (file: string) => {
  const ids = cg.getNodesInFile(file).map((n) => n.id);
  return cg.getOutgoingEdgesFrom(ids).filter((e) => e.kind !== 'contains')
    .map((e) => cg.getNode(e.target)!).map((t) => `${t.filePath}:${t.qualifiedName}`);
};

describe('Rust framework name heuristics', () => {
  it('never reach an item declared inside a function body', () => {
    expect(targetsFrom('examples/tls/src/main.rs').filter((t) => t.includes('outer_middleware'))).toEqual([]);
  });

  it('take the file’s own item first', () => {
    const globs = targetsFrom('crates/globset/src/glob.rs').filter((t) => t.endsWith(':Glob'));
    expect(globs.length).toBeGreaterThan(0);
    expect(new Set(globs)).toEqual(new Set(['crates/globset/src/glob.rs:Glob']));
  });
});
