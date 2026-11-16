/**
 * A Bash call reaches only what the shell would run: a function the calling
 * file defines, or one defined in a file it sources (directly or through other
 * sourced files), the last definition read winning. Never a same-named script
 * file, a variable, or a function in a script that isn't sourced; and a
 * sourced path is the exact file or nothing.
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
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-bash-scope-'));
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

describe('Bash call scope', () => {
  it('does not link a call into a script that is not sourced', async () => {
    const graph = await index({
      'a.sh': 'build() { echo a; }\nls() { :; }\n',
      'b.sh': 'build() { echo b; }\n',
      'c.sh': 'build\nls -la\n',
    });
    expect(edges(graph, 'calls').filter((e) => e.startsWith('c.sh'))).toEqual([]);
  });

  it('links a call to the function the calling file defines', async () => {
    const graph = await index({
      'a.sh': 'build() { echo a; }\n',
      'c.sh': 'build() { echo c; }\nbuild\n',
    });
    expect(edges(graph, 'calls').filter((e) => e.startsWith('c.sh'))).toEqual(['c.sh:c.sh -> c.sh:build (function)']);
  });

  it('links a call to a sourced file, the last-sourced definition winning', async () => {
    const graph = await index({
      'bin/main.sh': '#!/bin/bash\nsource "$(dirname "$0")/../lib/base.sh"\nsource "$(dirname "$0")/../lib/override.sh"\ngreet\n',
      'lib/base.sh': 'greet() { echo base; }\n',
      'lib/override.sh': 'greet() { echo override; }\n',
    });
    expect(edges(graph, 'calls').filter((e) => e.startsWith('bin/main.sh'))).toEqual([
      'bin/main.sh:main.sh -> lib/override.sh:greet (function)',
    ]);
  });

  it('follows a file the sourced file sources', async () => {
    const graph = await index({
      'bin/main.sh': '#!/bin/bash\nsource "$(dirname "$0")/../lib/all.sh"\nlog_info hi\n',
      'lib/all.sh': 'source "${BASH_SOURCE%/*}/log.sh"\n',
      'lib/log.sh': 'log_info() { echo "$@"; }\n',
      'other/log.sh': 'log_info() { echo other; }\n',
    });
    expect(edges(graph, 'calls').filter((e) => e.startsWith('bin/main.sh'))).toEqual([
      'bin/main.sh:main.sh -> lib/log.sh:log_info (function)',
    ]);
  });

  it('never links a command to an extensionless script of the same name', async () => {
    const graph = await index({
      'bin/set': '#!/bin/bash\necho set\n',
      'bin/test': '#!/bin/bash\necho test\n',
      'plugins/x/build.sh': 'set -eo pipefail\ntest -f x\n',
    });
    expect(edges(graph, 'calls').filter((e) => e.startsWith('plugins/'))).toEqual([]);
  });

  it('never links a command to a variable of the same name', async () => {
    const graph = await index({
      't/helper.sh': 'command="$1"\n',
      'run.sh': 'source ./t/helper.sh\ncommand -v git\n',
    });
    expect(edges(graph, 'calls').filter((e) => e.startsWith('run.sh'))).toEqual([]);
  });

  it('links `source ./x` only to that exact file, never a same-named file elsewhere', async () => {
    const graph = await index({
      'scripts/main.sh': '#!/bin/bash\nsource ./lib.sh\nhelper\n',
      'other/deep/lib.sh': 'helper() { echo x; }\n',
    });
    expect(edges(graph, 'imports')).toEqual([]);
    expect(edges(graph, 'calls').filter((e) => e.startsWith('scripts/'))).toEqual([]);
  });

  it('a script run by path is an import, not a call', async () => {
    const graph = await index({
      'run.sh': './build.sh --x\n',
      'build.sh': 'echo build\n',
    });
    expect(edges(graph, 'imports')).toEqual(['run.sh:run.sh -> build.sh:build.sh (file)']);
    expect(edges(graph, 'calls').filter((e) => e.startsWith('run.sh'))).toEqual([]);
  });

  it('a command-scoped assignment makes no variable, but calls in its value still count', async () => {
    const graph = await index({
      'm.sh': 'stamp() { date; }\nFOO=1 make\nBAR="$(stamp)" make\n',
    });
    const vars = graph.getNodesInFile('m.sh').filter((n) => n.kind === 'variable').map((n) => n.name);
    expect(vars).toEqual([]);
    expect(edges(graph, 'calls')).toContain('m.sh:m.sh -> m.sh:stamp (function)');
  });

  it('running a script is not sourcing it', async () => {
    const graph = await index({
      'lib/deep.sh': 'f() { :; }\n',
      'exe.sh': 'bash ./lib/deep.sh\nf\n',
      'exe2.sh': 'exec ./lib/deep.sh\nf\n',
      'exe3.sh': './lib/deep.sh\nf\n',
    });
    expect(edges(graph, 'calls').filter((e) => e.startsWith('exe'))).toEqual([]);
  });

  it('a sourced file that redefines after its own source wins', async () => {
    const graph = await index({
      'lib/deep.sh': 'f() { echo deep; }\n',
      'lib/mid.sh': 'source "${BASH_SOURCE%/*}/deep.sh"\nf() { echo mid; }\n',
      'main.sh': 'source ./lib/mid.sh\nf\n',
    });
    expect(edges(graph, 'calls').filter((e) => e.startsWith('main.sh'))).toEqual(['main.sh:main.sh -> lib/mid.sh:f (function)']);
  });

  it('top-level calls see what was read before their line', async () => {
    const graph = await index({
      'lib.sh': 'f() { echo lib; }\n',
      'lib2.sh': 'f() { echo lib2; }\n',
      // line 1: before any f; line 3: own f; line 5: lib2's f (sourced on line 4)
      'main.sh': 'f\nf() { echo own; }\nf\nsource ./lib2.sh\nf\n',
    });
    const got = edges(graph, 'calls').filter((e) => e.startsWith('main.sh')).sort();
    expect(got).toEqual(['main.sh:main.sh -> lib2.sh:f (function)', 'main.sh:main.sh -> main.sh:f (function)']);
  });

  it('a library function does not reach a sibling library only its entry script sources (known limit: no edge)', async () => {
    const graph = await index({
      'lib/a.sh': 'log() { echo "$@"; }\n',
      'lib/b.sh': 'run_b() { log x; }\n',
      'main.sh': 'source "$(dirname "$0")/lib/a.sh"\nsource "$(dirname "$0")/lib/b.sh"\nrun_b\n',
    });
    expect(edges(graph, 'calls').filter((e) => e.startsWith('lib/b.sh'))).toEqual([]);
    expect(edges(graph, 'calls')).toContain('main.sh:main.sh -> lib/b.sh:run_b (function)');
  });

  it('a Bats test name is not a function a command can call', async () => {
    const graph = await index({
      't.bats': '@test "help" {\n  help\n}\n\n@test "second" {\n  help\n}\n',
    });
    expect(edges(graph, 'calls')).toEqual([]);
  });

  it('`load` in a plain .bash library is a call to its own function, not a Bats load', async () => {
    const graph = await index({
      'lib/app.bash': 'load() { echo "$1"; }\nmain() { load plugins; }\n',
      'lib/plugins.bash': 'plug() { :; }\n',
    });
    expect(edges(graph, 'imports')).toEqual([]);
    expect(edges(graph, 'calls')).toEqual(['lib/app.bash:main -> lib/app.bash:load (function)']);
  });

  it('an env-prefixed source and a source on the call\'s own line both count; the last source on a line wins', async () => {
    const graph = await index({
      'a.sh': 'f() { echo a; }\n',
      'b.sh': 'f() { echo b; }\n',
      'm1.sh': 'LC_ALL=C source ./a.sh\nf\n',
      'm2.sh': 'source ./a.sh && f\n',
      'm3.sh': 'source ./a.sh; source ./b.sh\nf\n',
    });
    const got = edges(graph, 'calls').filter((e) => e.startsWith('m'));
    expect(got).toEqual([
      'm1.sh:m1.sh -> a.sh:f (function)',
      'm2.sh:m2.sh -> a.sh:f (function)',
      'm3.sh:m3.sh -> b.sh:f (function)',
    ]);
  });

  it('libraries that source each other behind include guards index quickly', async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 9; i++) {
      const others = Array.from({ length: 9 }, (_, j) => j).filter((j) => j !== i).map((j) => `source "\${BASH_SOURCE%/*}/l${j}.sh"`).join('\n');
      files[`lib/l${i}.sh`] = `[[ -n "\$L${i}" ]] && return\nL${i}=1\n${others}\ng${i}() { :; }\n`;
    }
    files['main.sh'] = 'source "$(dirname "$0")/lib/l0.sh"\ng5\n';
    const t0 = Date.now();
    const graph = await index(files);
    expect(Date.now() - t0).toBeLessThan(10_000);
    expect(edges(graph, 'calls')).toContain('main.sh:main.sh -> lib/l5.sh:g5 (function)');
  }, 30_000);

  it('sync re-resolves a call when a file it sources through stops sourcing', async () => {
    const graph = await index({
      'b.sh': 'f() { :; }\n',
      'a.sh': 'source ./b.sh\n',
      'main.sh': 'source ./a.sh\nf\n',
    });
    expect(edges(graph, 'calls')).toContain('main.sh:main.sh -> b.sh:f (function)');
    fs.writeFileSync(path.join(dir!, 'a.sh'), '# no longer sources b\n');
    await graph.sync();
    expect(edges(graph, 'calls').filter((e) => e.startsWith('main.sh'))).toEqual([]);
    fs.writeFileSync(path.join(dir!, 'a.sh'), 'source ./b.sh\n');
    await graph.sync();
    expect(edges(graph, 'calls')).toContain('main.sh:main.sh -> b.sh:f (function)');
  });

  it('a sourcing cycle gives the same answer whatever the files are called', async () => {
    for (const name of ['z', 'a']) {
      const graph = await index({
        [`${name}.sh`]: '[[ -n $A ]] && return; A=1\nsource ./d.sh\nsource ./b.sh\nh() { g; }\n',
        'd.sh': 'g() { echo d; }\n',
        'b.sh': `[[ -n $B ]] && return; B=1\nsource ./${name}.sh\ng() { echo b; }\nk() { g; }\n`,
      });
      expect(edges(graph, 'calls')).toContain(`${name}.sh:h -> b.sh:g (function)`);
      cg?.destroy();
      cg = undefined;
      fs.rmSync(dir!, { recursive: true, force: true });
      dir = undefined;
    }
  });

  it('sync drops a call when the middle file of a chain is removed, and links it when one is added', async () => {
    const graph = await index({
      'main.sh': 'source ./mid.sh\nleafFn\n',
      'mid.sh': 'source ./leaf.sh\n',
      'leaf.sh': 'leafFn() { :; }\n',
    });
    expect(edges(graph, 'calls')).toContain('main.sh:main.sh -> leaf.sh:leafFn (function)');
    fs.rmSync(path.join(dir!, 'mid.sh'));
    await graph.sync();
    expect(edges(graph, 'calls').filter((e) => e.startsWith('main.sh'))).toEqual([]);
    fs.writeFileSync(path.join(dir!, 'mid.sh'), 'source ./leaf.sh\n');
    await graph.sync();
    expect(edges(graph, 'calls')).toContain('main.sh:main.sh -> leaf.sh:leafFn (function)');
  });

  it('a call on the line a function ends is top-level code', async () => {
    const graph = await index({ 'a.sh': 'f() { :; }; g\ng() { :; }\n' });
    expect(edges(graph, 'calls')).toEqual([]);
  });
});
