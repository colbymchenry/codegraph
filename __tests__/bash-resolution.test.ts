/**
 * What a Bash script's `source` / `.` / `bash x` / Bats `load` reaches, and
 * which functions its commands call (#1203, #1217).
 *
 * A literal `./lib.sh` is relative to the directory the script is run from, so
 * it links only when the script's own directory and the project root don't
 * disagree; a path anchored to the script's directory (`$(dirname "$0")`, a
 * canonical `SCRIPT_DIR`, Bats' `$BATS_TEST_DIRNAME`) is exact. A shell adds no
 * extension, and a command name that is a program on PATH must not bind to a
 * same-named function in another language.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { extractFromSource } from '../src/extraction';
import { initGrammars, loadGrammarsForLanguages } from '../src/extraction/grammars';
import { resolveImportPath } from '../src/resolution/import-resolver';
import type { ResolutionContext } from '../src/resolution';

beforeAll(async () => {
  await initGrammars();
  await loadGrammarsForLanguages(['bash', 'python']);
});

let dir: string | undefined;
let cg: CodeGraph | undefined;

afterEach(() => {
  cg?.destroy();
  cg = undefined;
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

async function index(files: Record<string, string>): Promise<CodeGraph> {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-bash-resolution-'));
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  }
  cg = await CodeGraph.init(dir, { index: true });
  return cg;
}

/** The files a file's `imports` edges reach. */
function importsOf(graph: CodeGraph, file: string): string[] {
  const ids = new Set(graph.getNodesInFile(file).map((n) => n.id));
  const targets: string[] = [];
  for (const id of ids) {
    for (const edge of graph.getOutgoingEdges(id)) {
      if (edge.kind !== 'imports') continue;
      const target = graph.getNode(edge.target);
      if (target) targets.push(target.filePath);
    }
  }
  return targets.sort();
}

function callees(graph: CodeGraph, name: string, file?: string): string[] {
  const fn = graph.getNodesByName(name).find((n) => n.kind === 'function' && (!file || n.filePath === file))!;
  expect(fn, `function ${name}`).toBeDefined();
  return graph.getCallees(fn.id).map((c) => `${c.node.filePath}::${c.node.name}`).sort();
}

function shellContext(files: string[]): ResolutionContext {
  return {
    getNodesInFile: () => [],
    getNodesByName: () => [],
    getNodesByQualifiedName: () => [],
    getNodesByKind: () => [],
    fileExists: (p) => files.includes(p),
    readFile: () => null,
    getProjectRoot: () => '',
    getAllFiles: () => files,
  };
}

describe('literal source paths', () => {
  it('links `./x` from a script at the root, where its directory is the root', async () => {
    const graph = await index({
      'main.sh': '#!/usr/bin/env bash\nsource ./lib/helpers.sh\nbash ./tasks/build.sh\n./tasks/test.sh\n',
      'lib/helpers.sh': 'helper() { :; }\n',
      'tasks/build.sh': 'build() { :; }\n',
      'tasks/test.sh': 'run_tests() { :; }\n',
    });
    expect(importsOf(graph, 'main.sh')).toEqual(['lib/helpers.sh', 'tasks/build.sh', 'tasks/test.sh']);
  });

  it('links a nested script\'s `./x` only when its directory and the root do not both hold one', () => {
    expect(resolveImportPath('./lib.sh', 'scripts/main.sh', 'bash', shellContext(['scripts/lib.sh']))).toBe('scripts/lib.sh');
    expect(resolveImportPath('./lib.sh', 'scripts/main.sh', 'bash', shellContext(['lib.sh']))).toBe('lib.sh');
    expect(resolveImportPath('./lib.sh', 'scripts/main.sh', 'bash', shellContext(['lib.sh', 'scripts/lib.sh']))).toBeNull();
    expect(resolveImportPath('../lib.sh', 'main.sh', 'bash', shellContext(['lib.sh']))).toBeNull();
  });

  it('keeps a dynamic source path out of the graph', () => {
    const result = extractFromSource('main.sh', 'source "./lib.sh"\nsource "$PLUGIN"\nsource "$HOME/x.sh"\n');
    expect(result.unresolvedReferences.filter((r) => r.referenceKind === 'imports').map((r) => r.referenceName)).toEqual(['./lib.sh']);
  });
});

describe('paths anchored to the script directory', () => {
  const importRefs = (file: string, source: string) =>
    extractFromSource(file, source).unresolvedReferences.filter((r) => r.referenceKind === 'imports').map((r) => r.referenceName);

  it('follows a canonical script-directory variable assigned at the top level', () => {
    const refs = importRefs('scripts/phases/s6_wire_local.sh', [
      '#!/usr/bin/env bash',
      'S6_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)',
      'source "$S6_DIR/../lib/atomic-write.sh"',
      'ROOT="$( cd -- "$( dirname -- "${BASH_SOURCE[0]}" )/../.." &> /dev/null && pwd )"',
      '. "${ROOT}/env.sh"',
      'readonly HERE="$(cd "${BASH_SOURCE%/*}" && pwd -P)"',
      '"$HERE/build.sh" --release',
      '',
    ].join('\n'));
    expect(refs).toEqual(['scripts/lib/atomic-write.sh', 'env.sh', 'scripts/phases/build.sh']);
  });

  it('follows the inline script-directory forms', () => {
    const refs = importRefs('bin/tool.sh', [
      'source "$(dirname "$0")/lib.sh"',
      '. "${BASH_SOURCE%/*}/../share/common.sh"',
      'source "$(dirname "$(readlink -f "$0")")/real.sh"',
      '',
    ].join('\n'));
    expect(refs).toEqual(['bin/lib.sh', 'share/common.sh', 'bin/real.sh']);
  });

  it('assumes nothing about a variable whose value depends on what ran', () => {
    const refs = importRefs('scripts/run.sh', [
      'DYNAMIC_DIR="$HOME"',
      'source "$DYNAMIC_DIR/unsafe.sh"',
      'shadow() {',
      '  SHADOW_DIR=$(cd "$(dirname "$0")" && pwd)',
      '}',
      'source "$SHADOW_DIR/function-body.sh"',
      "cat <<'EOF'",
      'HEREDOC_DIR=$(cd "$(dirname "$0")" && pwd)',
      'EOF',
      'source "$HEREDOC_DIR/heredoc.sh"',
      'REASSIGNED_DIR=$(cd "$(dirname "$0")" && pwd)',
      'export REASSIGNED_DIR="$HOME"',
      'source "$REASSIGNED_DIR/reassigned.sh"',
      'if true; then BRANCH_DIR=$(cd "$(dirname "$0")" && pwd); fi',
      'source "$BRANCH_DIR/branch.sh"',
      'source "$(dirname "$0")/../../outside.sh"',
      '',
    ].join('\n'));
    expect(refs).toEqual([]);
  });

  it('resolves an anchored path exactly, even where a literal `./x` would be ambiguous', async () => {
    const graph = await index({
      'scripts/main.sh': 'source "$(dirname "$0")/lib.sh"\nsource ./lib.sh\n',
      'scripts/lib.sh': 'nested_lib() { :; }\n',
      'lib.sh': 'root_lib() { :; }\n',
    });
    expect(importsOf(graph, 'scripts/main.sh')).toEqual(['scripts/lib.sh']);
  });
});

describe('Bats test files', () => {
  it('makes each @test a function named for its description, owning what it calls', async () => {
    const graph = await index({
      'test/deploy.bats': [
        'load test_helper',
        '',
        'setup() {',
        '  prepare_env',
        '}',
        '',
        '@test "deploy succeeds" {',
        '  run deploy app',
        '  assert_success',
        '}',
        '',
        "@test 'rollback restores the release' {",
        '  rollback app',
        '}',
        '',
      ].join('\n'),
      'test/test_helper.bash': 'assert_success() { :; }\nprepare_env() { :; }\n',
      'lib/deploy.sh': 'deploy() { :; }\nrollback() { :; }\n',
    });
    const tests = graph.getNodesInFile('test/deploy.bats').filter((n) => n.kind === 'function');
    expect(tests.map((n) => [n.name, n.startLine, n.endLine])).toEqual([
      ['setup', 3, 5],
      ['deploy succeeds', 7, 10],
      ['rollback restores the release', 12, 14],
    ]);
    expect(callees(graph, 'deploy succeeds')).toEqual(['test/test_helper.bash::assert_success']);
    expect(callees(graph, 'rollback restores the release')).toEqual(['lib/deploy.sh::rollback']);
    expect(importsOf(graph, 'test/deploy.bats')).toEqual(['test/test_helper.bash']);
  });

  it('reads `load` as the test directory\'s `.bash` file', () => {
    const refs = extractFromSource('test/unit/a.bats', [
      'load test_helper',
      "load '../../shared/coordination'",
      'load ../vendor/bash-preexec.sh',
      'load "$BATS_TEST_DIRNAME/fixtures/setup"',
      'load "${LIB}/dynamic"',
      '',
    ].join('\n')).unresolvedReferences.filter((r) => r.referenceKind === 'imports').map((r) => r.referenceName);
    expect(refs).toEqual(['test/unit/test_helper.bash', 'shared/coordination.bash', 'test/vendor/bash-preexec.sh', 'test/unit/fixtures/setup.bash']);
  });
});

describe('call resolution', () => {
  it('links a command to a shell function, never to a same-named function in another language', async () => {
    const graph = await index({
      'deploy.sh': 'source ./lib.sh\nmain() {\n  build\n  install\n}\n',
      'lib.sh': 'build() { :; }\n',
      'setup.py': 'def build():\n    pass\n\ndef install():\n    pass\n',
    });
    expect(callees(graph, 'main')).toEqual(['lib.sh::build']);
  });

  it('reaches a function defined inside another one, which Bash makes global', async () => {
    const graph = await index({
      'main.sh': 'init() {\n  helper() { :; }\n}\nlater() {\n  helper\n}\n',
    });
    expect(callees(graph, 'later')).toEqual(['main.sh::helper']);
  });
});
