/**
 * A Rust method call on a value of an outside crate's type, or on what that
 * value's own methods return, can't mean a same-named inherent method of a
 * project type (#3483): `resp.status().is_success()` on a
 * `reqwest::blocking::Response` is `StatusCode::is_success`, not the
 * project's `LocalResp::is_success`. A sibling crate stands in for reqwest,
 * and only `app` is indexed, so `ext` stays outside the project. Calls whose
 * receiver can be the project's type keep their edges.
 */
import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CodeGraph } from '../src';

let root = '';
let cg: CodeGraph | undefined;

afterEach(() => {
  cg?.close();
  cg = undefined;
  if (root) fs.rmSync(root, { recursive: true, force: true });
  root = '';
});

const EXT = `pub mod blocking {
    pub struct Response { code: u16 }
    impl Response {
        pub fn status(&self) -> super::StatusCode { super::StatusCode(self.code) }
    }
}
pub struct StatusCode(pub u16);
impl StatusCode {
    pub fn is_success(&self) -> bool { self.0 < 300 }
}
`;

const APP = `use ext::blocking::Response;

pub struct LocalResp;

impl LocalResp {
    pub fn is_success(&self) -> bool {
        true
    }
}

pub trait Wrap {
    fn local(&self) -> LocalResp;
}

impl Wrap for Response {
    fn local(&self) -> LocalResp {
        LocalResp
    }
}

fn check(resp: ext::blocking::Response) -> bool {
    resp.status().is_success()
}

fn check_ref(resp: &Response) -> bool {
    resp.status().is_success()
}

fn check_typed_local(code: u16) -> bool {
    let resp: ext::blocking::Response = make(code);
    let status: ext::StatusCode = resp.status();
    status.is_success()
}

fn make(_code: u16) -> Response {
    unimplemented!()
}

fn local_check(resp: &LocalResp) -> bool {
    resp.is_success()
}

fn wrapped(resp: &Response) -> bool {
    resp.local().is_success()
}

fn optional(o: Option<LocalResp>) -> bool {
    o.unwrap().is_success()
}

pub struct Parsed;

impl Parsed {
    pub fn parsed_ok(&self) -> bool {
        true
    }
}

impl std::str::FromStr for Parsed {
    type Err = ();
    fn from_str(_s: &str) -> Result<Self, ()> {
        Ok(Parsed)
    }
}

fn take(_p: &Parsed) {}

fn inferred(s: String) -> bool {
    let v = s.parse().unwrap();
    take(&v);
    v.parsed_ok()
}
`;

// Crates inside the indexed directory that the root's manifest names by
// `path`: one that is no workspace member, and a member under another key.
const LOCAL_CRATES: Record<string, string> = {
  'app/Cargo.toml': '[package]\nname = "app"\nversion = "0.1.0"\nedition = "2021"\n\n[workspace]\nmembers = ["core"]\n\n[dependencies]\nshared = { path = "shared" }\ncore2 = { package = "mycore", path = "core" }\n',
  'app/src/lib.rs': `fn shared_chain(r: shared::Resp) -> bool {
    r.status().code_ok()
}

fn renamed_chain(r: core2::CResp) -> bool {
    r.kid().kid_ok()
}
`,
  'app/shared/Cargo.toml': '[package]\nname = "shared"\nversion = "0.1.0"\nedition = "2021"\n',
  'app/shared/src/lib.rs': `pub struct Resp;
pub struct Code;
impl Resp {
    pub fn status(&self) -> Code { Code }
}
impl Code {
    pub fn code_ok(&self) -> bool { true }
}
`,
  'app/core/Cargo.toml': '[package]\nname = "mycore"\nversion = "0.1.0"\nedition = "2021"\n',
  'app/core/src/lib.rs': `pub struct CResp;
pub struct Kid;
impl CResp {
    pub fn kid(&self) -> Kid { Kid }
}
impl Kid {
    pub fn kid_ok(&self) -> bool { true }
}
`,
};

async function index(layout: 'ext' | 'local' = 'ext'): Promise<CodeGraph> {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-rust-outside-recv-'));
  const files: Record<string, string> = layout === 'local' ? LOCAL_CRATES : {
    'ext/Cargo.toml': '[package]\nname = "ext"\nversion = "0.1.0"\nedition = "2021"\n',
    'ext/src/lib.rs': EXT,
    'app/Cargo.toml': '[package]\nname = "app"\nversion = "0.1.0"\nedition = "2021"\n\n[dependencies]\next = { path = "../ext" }\n',
    'app/src/lib.rs': APP,
  };
  for (const [rel, text] of Object.entries(files)) {
    const dest = path.join(root, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, text);
  }
  cg = await CodeGraph.init(path.join(root, 'app'), { index: true });
  return cg;
}

/** The project functions and methods `fn` calls, by qualified name, sorted. */
function callsOf(graph: CodeGraph, fn: string): string[] {
  const node = graph.getNodesByName(fn).find((n) => n.kind === 'function' || n.kind === 'method');
  expect(node, fn).toBeDefined();
  return graph.getOutgoingEdges(node!.id)
    .filter((e) => e.kind === 'calls')
    .map((e) => graph.getNode(e.target)!.qualifiedName)
    .sort();
}

describe('Rust: a call on an outside crate\'s value (#3483)', () => {
  it('does not link a method of what an outside type returns to a project namesake', async () => {
    const graph = await index();
    expect(callsOf(graph, 'check')).toEqual([]);
    expect(callsOf(graph, 'check_ref')).toEqual([]);
    expect(callsOf(graph, 'check_typed_local').filter((n) => n.startsWith('LocalResp::'))).toEqual([]);
  });

  it('keeps calls whose receiver can be the project type', async () => {
    const graph = await index();
    expect(callsOf(graph, 'local_check')).toEqual(['LocalResp::is_success']);
    expect(callsOf(graph, 'wrapped')).toEqual(['LocalResp::is_success', 'Response::local']);
    expect(callsOf(graph, 'optional')).toEqual(['LocalResp::is_success']);
    // A generic return a later use fixes: `v` is a `Parsed` by `take(&v)`.
    expect(callsOf(graph, 'inferred')).toEqual(['Parsed::parsed_ok', 'take']);
  });

  it('keeps chains through a crate the manifest names by path', async () => {
    const graph = await index('local');
    expect(callsOf(graph, 'shared_chain')).toEqual(['Code::code_ok']);
    expect(callsOf(graph, 'renamed_chain')).toEqual(['Kid::kid_ok']);
  });
});
