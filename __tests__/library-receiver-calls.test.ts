/**
 * Calls on a library's own types and modules stay the library's, not a
 * same-named project method's:
 *
 * - Rust `Vec::new()` / `task::spawn(…)`: a type the project doesn't declare,
 *   and a module path (tokio's `task::spawn` went to TaskTracker's `spawn`
 *   300 times, `Vec::new` to a VecWithInitialized);
 * - a link further down a multi-line Rust chain is named after the chain's
 *   head: `bat()\n.stdout(…)` is assert_cmd's, `Arg::new("x")\n.value_hint(…)`
 *   the project's Arg;
 * - Go's `w.Header().Get(…)` is net/http's Header, not gin's `Context.Get`;
 * - R's bare `range(x)` is base R's, not a ggproto object's `range` method;
 * - JS `response.text()` is fetch's Response, not a project class's `text`.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

let root = '';
let cg: CodeGraph;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-library-receivers-'));
  const files: Record<string, string> = {
    'src/lib.rs': `pub struct VecWithInitialized;
impl VecWithInitialized {
    pub fn new() -> Self { VecWithInitialized }
}

pub struct TaskTracker;
impl TaskTracker {
    pub fn spawn(&self) {}
}

pub struct OutputType;
impl OutputType {
    pub fn stdout(&self) {}
}

pub struct Arg;
impl Arg {
    pub fn new(name: &str) -> Arg { Arg }
    pub fn value_hint(self, hint: u8) -> Arg { self }
}

pub fn run() {
    let v: Vec<u8> = Vec::new();
    task::spawn(async {});
    bat()
        .assert()
        .stdout("x");
    let a = Arg::new("cmd")
        .value_hint(1);
}
`,
    'context.go': `package gin

type Context struct{}

func (c *Context) Get(key string) (any, bool) { return nil, false }

func handler(w Writer) string {
	return w.Header().Get("Content-Type")
}
`,
    'R/coord.R': `Coord <- ggproto("Coord",
  range = function(panel_params) {
    list(x = panel_params$x$dimension())
  }
)

scale_limits <- function(x) {
  range(x)
}
`,
    'src/file.js': `export class LazyFile {
  text() { return ''; }
}

export async function load(response) {
  return await response.text();
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

/** `Owner::member` of every call edge out of a file. */
function callsFrom(file: string): string[] {
  const ids = cg.getNodesInFile(file).map((n) => n.id);
  return cg
    .getOutgoingEdgesFrom(ids)
    .filter((e) => e.kind === 'calls')
    .map((e) => cg.getNode(e.target)!.qualifiedName)
    .sort();
}

describe('calls on a library’s types and modules', () => {
  it('Rust: outside types, module paths and multi-line chains', () => {
    const calls = callsFrom('src/lib.rs');
    expect(calls).not.toContain('VecWithInitialized::new');
    expect(calls).not.toContain('TaskTracker::spawn');
    expect(calls).not.toContain('OutputType::stdout');
    expect(calls).toContain('Arg::value_hint');
  });

  it('Go: net/http Header methods', () => {
    expect(callsFrom('context.go')).not.toContain('Context::Get');
  });

  it('R: a bare call is a function, not an object’s method', () => {
    expect(callsFrom('R/coord.R').filter((q) => q.endsWith('range'))).toEqual([]);
  });

  it('JS: fetch Response bodies', () => {
    expect(callsFrom('src/file.js')).not.toContain('LazyFile::text');
  });
});
