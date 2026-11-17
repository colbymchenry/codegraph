/**
 * `$0` is the script the shell was started with: in a file that is sourced,
 * `$(dirname "$0")` is the sourcing script's directory, not the file's own
 * (`BASH_SOURCE` is the file's own). And a one-line Bats test,
 * `@test "x" { run foo; }`, is a test like any other.
 */
import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

let dir: string | undefined;
let cg: CodeGraph | undefined;

afterEach(() => {
  cg?.destroy();
  cg = undefined;
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

async function index(files: Record<string, string>): Promise<CodeGraph> {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-bash-zero-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, { mode: 0o755 });
  }
  cg = await CodeGraph.init(dir, { index: true });
  return cg;
}

/** Every bash `calls` / `imports` edge as `from-file:from-name -> to-file:to-name (kind)`. */
function edges(graph: CodeGraph, kind: 'calls' | 'imports'): string[] {
  const out: string[] = [];
  for (const file of graph.getFiles()) {
    for (const n of graph.getNodesInFile(file.path)) {
      for (const e of graph.getOutgoingEdgesFrom([n.id], [kind] as any)) {
        const t = graph.getNode(e.target);
        if (t?.language === 'bash') out.push(`${n.filePath}:${n.name} -> ${t.filePath}:${t.name} (${t.kind})`);
      }
    }
  }
  return out.sort();
}

const from = (list: string[], file: string): string[] => list.filter((e) => e.startsWith(`${file}:`));

describe('Bash $0 in a sourced file', () => {
  it('places $(dirname "$0") in a sourced file at the sourcing script\'s directory', async () => {
    const graph = await index({
      'bin/main': '#!/bin/bash\nsource "$(dirname "$0")/../lib/a.sh"\nhelper\n',
      'bin/b.sh': 'helper() { echo bin; }\n',
      'lib/a.sh': 'source "$(dirname "$0")/b.sh"\n',
      'lib/b.sh': 'helper() { echo lib; }\n',
    });
    expect(from(edges(graph, 'imports'), 'lib/a.sh')).toEqual(['lib/a.sh:a.sh -> bin/b.sh:b.sh (file)']);
    expect(from(edges(graph, 'calls'), 'bin/main')).toEqual(['bin/main:main -> bin/b.sh:helper (function)']);
  });

  it('still places BASH_SOURCE in a sourced file at the file\'s own directory', async () => {
    const graph = await index({
      'bin/main': '#!/bin/bash\nsource "$(dirname "$0")/../lib/a.sh"\nhelper\n',
      'bin/b.sh': 'helper() { echo bin; }\n',
      'lib/a.sh': 'source "$(dirname "${BASH_SOURCE[0]}")/b.sh"\n',
      'lib/b.sh': 'helper() { echo lib; }\n',
    });
    expect(from(edges(graph, 'imports'), 'lib/a.sh')).toEqual(['lib/a.sh:a.sh -> lib/b.sh:b.sh (file)']);
    expect(from(edges(graph, 'calls'), 'bin/main')).toEqual(['bin/main:main -> lib/b.sh:helper (function)']);
  });

  it('places $0 in a script nothing sources at the script\'s own directory', async () => {
    const graph = await index({
      'bin/main': '#!/bin/bash\nsource "$(dirname "$0")/b.sh"\nhelper\n',
      'bin/b.sh': 'helper() { :; }\n',
    });
    expect(from(edges(graph, 'calls'), 'bin/main')).toEqual(['bin/main:main -> bin/b.sh:helper (function)']);
  });

  it('follows $0 through a SCRIPT_DIR variable in a sourced file', async () => {
    const graph = await index({
      'bin/main': '#!/bin/bash\nsource "$(dirname "$0")/../lib/a.sh"\n',
      'bin/b.sh': ':\n',
      'lib/a.sh': 'DIR="$(cd "$(dirname "$0")" && pwd)"\nsource "$DIR/b.sh"\n',
      'lib/b.sh': ':\n',
    });
    expect(from(edges(graph, 'imports'), 'lib/a.sh')).toEqual(['lib/a.sh:a.sh -> bin/b.sh:b.sh (file)']);
  });

  it('links nothing when the scripts sourcing a file place a $0 path differently', async () => {
    const graph = await index({
      'one/main': '#!/bin/bash\nsource "$(dirname "$0")/../lib/a.sh"\n',
      'two/main': '#!/bin/bash\nsource "$(dirname "$0")/../lib/a.sh"\n',
      'one/b.sh': ':\n',
      'two/b.sh': ':\n',
      'lib/a.sh': 'source "$(dirname "$0")/b.sh"\n',
    });
    expect(from(edges(graph, 'imports'), 'lib/a.sh')).toEqual([]);
  });

  it('links when every script sourcing a file places a $0 path at the same file', async () => {
    const graph = await index({
      'bin/one': '#!/bin/bash\nsource "$(dirname "$0")/../lib/a.sh"\n',
      'bin/two': '#!/bin/bash\nsource "$(dirname "$0")/../lib/a.sh"\n',
      'bin/b.sh': ':\n',
      'lib/a.sh': 'source "$(dirname "$0")/b.sh"\n',
    });
    expect(from(edges(graph, 'imports'), 'lib/a.sh')).toEqual(['lib/a.sh:a.sh -> bin/b.sh:b.sh (file)']);
  });

  it('follows $0 up a chain of sourced files to the script that started it', async () => {
    const graph = await index({
      'bin/main': '#!/bin/bash\nsource "$(dirname "$0")/../lib/a.sh"\n',
      'lib/a.sh': 'source "${BASH_SOURCE%/*}/inner/c.sh"\n',
      'lib/inner/c.sh': 'source "$(dirname "$0")/b.sh"\n',
      'bin/b.sh': ':\n',
      'lib/inner/b.sh': ':\n',
    });
    expect(from(edges(graph, 'imports'), 'lib/inner/c.sh')).toEqual(['lib/inner/c.sh:c.sh -> bin/b.sh:b.sh (file)']);
  });

  it('leaves a $0 path unresolved in a file Bats loads ($0 is Bats\' runner)', async () => {
    const graph = await index({
      'test/x.bats': 'load helper\n@test "t" {\n  run true\n}\n',
      'test/helper.bash': 'source "$(dirname "$0")/b.sh"\n',
      'test/b.sh': ':\n',
    });
    expect(from(edges(graph, 'imports'), 'test/helper.bash')).toEqual([]);
  });

  it('leaves a $0 path unresolved when the sourcing chain loops with no starting script', async () => {
    const graph = await index({
      'a.sh': 'source "${BASH_SOURCE%/*}/b.sh"\n',
      'b.sh': 'source "${BASH_SOURCE%/*}/a.sh"\nsource "$(dirname "$0")/c.sh"\n',
      'c.sh': ':\n',
    });
    expect(from(edges(graph, 'imports'), 'b.sh').filter((e) => e.includes('c.sh'))).toEqual([]);
  });
});

describe('One-line Bats tests', () => {
  it('reads @test "x" { run foo; } as a test whose body calls run', async () => {
    const graph = await index({
      'test/x.bats': 'load helper\n@test "one line" { run foo; }\n@test "two" {\n  run bar\n}\n',
      'test/helper.bash': 'run() { :; }\n',
    });
    const tests = graph.getNodesInFile('test/x.bats').filter((n) => n.kind === 'function');
    expect(tests.map((n) => [n.name, n.decorators])).toEqual([
      ['one line', ['@test']],
      ['two', ['@test']],
    ]);
    expect(from(edges(graph, 'calls'), 'test/x.bats')).toEqual([
      'test/x.bats:one line -> test/helper.bash:run (function)',
      'test/x.bats:two -> test/helper.bash:run (function)',
    ]);
  });

  it('reads a one-line test whose body runs on past the header line', async () => {
    const graph = await index({
      'test/x.bats': 'load helper\n@test "t" { run foo; check; }\nafter\n',
      'test/helper.bash': 'run() { :; }\ncheck() { :; }\nafter() { :; }\n',
    });
    const test = graph.getNodesInFile('test/x.bats').find((n) => n.name === 't')!;
    expect(test.endLine).toBe(2);
    expect(from(edges(graph, 'calls'), 'test/x.bats')).toEqual([
      'test/x.bats:t -> test/helper.bash:check (function)',
      'test/x.bats:t -> test/helper.bash:run (function)',
      'test/x.bats:x.bats -> test/helper.bash:after (function)',
    ]);
  });

  it('reads @test "x" { foo } with the brace closing on the header', async () => {
    const graph = await index({
      'test/x.bats': 'load helper\n@test "closed" { foo }\nafter\n',
      'test/helper.bash': 'foo() { :; }\nafter() { :; }\n',
    });
    const test = graph.getNodesInFile('test/x.bats').find((n) => n.name === 'closed')!;
    expect(test.decorators).toEqual(['@test']);
    expect(from(edges(graph, 'calls'), 'test/x.bats')).toEqual([
      'test/x.bats:closed -> test/helper.bash:foo (function)',
      'test/x.bats:x.bats -> test/helper.bash:after (function)',
    ]);
  });
});
