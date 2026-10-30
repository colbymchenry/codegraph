/**
 * A Python call through a name the file imports as a module reads that module
 * only where nothing nearer binds the name:
 *
 *   from pkg import other
 *
 *   def real():
 *       other.update({})          # pkg/other.py's update
 *
 *   def by_param(other):
 *       other.update({})          # dict.update, or whatever the caller passed
 *
 * The import resolver read the file's imports alone, so a parameter, a local,
 * a `with … as` / `except … as` / loop target, a walrus, a `case` capture or a
 * lambda or comprehension variable named like the module still linked the
 * call to the module's function. A function-local `from pkg import third as
 * other` linked to `pkg.other` too, and so did, from every other function of
 * the file, though it binds the name only where it is written.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';

const FILES: Record<string, string> = {
  'pyproject.toml': '[project]\nname = "pkg"\n',
  'src/pkg/__init__.py': '',
  'src/pkg/other.py': [
    'def update(x=None):',
    '    return x',
    '',
    '',
    'def persist(x=None):',
    '    return x',
    '',
    '',
    'def get(key=None):',
    '    return key',
    '',
  ].join('\n'),
  'src/pkg/third.py': ['def get(key=None):', '    return key', ''].join('\n'),
  'tests/shadow.py': [
    'from pkg import other',
    '',
    '',
    'def real():',
    '    other.update({"b": 2})',
    '    return other.persist(1)',
    '',
    '',
    'def by_param(other):',
    '    other.update({"a": 1})',
    '    return other.persist(2)',
    '',
    '',
    'def by_with(path):',
    '    with open(path, "w") as other:',
    '        return other.persist(3)',
    '',
    '',
    'def by_assign():',
    '    other = {}',
    '    other.update({"c": 3})',
    '',
    '',
    'def by_for(items):',
    '    for other in items:',
    '        other.persist(4)',
    '',
    '',
    'def by_except():',
    '    try:',
    '        pass',
    '    except OSError as other:',
    '        return other.persist(5)',
    '',
    '',
    'def by_lambda():',
    '    return lambda other: other.persist(6)',
    '',
    '',
    'def by_comprehension(items):',
    '    return [other.persist(7) for other in items]',
    '',
    '',
    'def by_walrus(load):',
    '    if (other := load()):',
    '        return other.persist(8)',
    '',
    '',
    'def by_closure(other):',
    '    def inner():',
    '        return other.persist(9)',
    '    return inner',
    '',
    '',
    'def by_capture(v):',
    '    match v:',
    '        case other:',
    '            return other.persist(10)',
    '',
    '',
    'def by_local_import():',
    '    from pkg import third as other',
    '    return other.get(11)',
    '',
    '',
    // Each of these reads the module the file imports.
    'def keyword_argument(run):',
    '    run(',
    '        other=1,',
    '    )',
    '    return other.persist(12)',
    '',
    '',
    'def in_a_string():',
    '    print("with x as other", "other = 1")  # other = 2',
    '    return other.persist(13)',
    '',
    '',
    'def comprehension_of_others(items):',
    '    return [x for x in other.persist(items)]',
    '',
    '',
    'def lambda_beside(run):',
    '    return run(lambda other: 1, other.persist(14))',
    '',
    '',
    'def declared_global():',
    '    global other',
    '    return other.persist(15)',
    '',
    '',
    'def keyword_pattern(v):',
    '    match v:',
    '        case Point(other=1):',
    '            return other.persist(16)',
    '',
    '',
    'def same_module_again():',
    '    from pkg import other',
    '    return other.get(17)',
    '',
  ].join('\n'),
  // The module binds `other` with a plain import, which the file's mappings
  // list after every from-import, the function-local one included.
  'tests/leak.py': [
    'import pkg.other as other',
    '',
    '',
    'def local_third():',
    '    from pkg import third as other',
    '    return other.get(1)',
    '',
    '',
    'def untouched():',
    '    return other.get(2)',
    '',
  ].join('\n'),
};

describe.each([
  ['default', 'LF'],
  ['wasm', 'LF'],
  ['default', 'CRLF'],
  ['wasm', 'CRLF'],
])('a Python receiver the function binds itself is not the module the file imports (%s, %s)', (backend, eol) => {
  let root = '';
  let cg: CodeGraph | undefined;
  let kernel: string | undefined;

  beforeAll(async () => {
    kernel = process.env.CODEGRAPH_KERNEL;
    if (backend === 'wasm') process.env.CODEGRAPH_KERNEL = '0';
    else delete process.env.CODEGRAPH_KERNEL;
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-py-rebind-'));
    for (const [rel, content] of Object.entries(FILES)) {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), eol === 'CRLF' ? content.replace(/\n/g, '\r\n') : content);
    }
    cg = await CodeGraph.init(root, { index: true });
  }, 60_000);

  afterAll(() => {
    cg?.destroy();
    if (root) fs.rmSync(root, { recursive: true, force: true });
    if (kernel === undefined) delete process.env.CODEGRAPH_KERNEL;
    else process.env.CODEGRAPH_KERNEL = kernel;
  });

  /** `file:name` of each project function `name` in `file` calls, sorted. */
  const callsFrom = (file: string, name: string): string[] => {
    const from = cg!.getNodesInFile(file).filter((n) => n.name === name && (n.kind === 'function' || n.kind === 'method'));
    expect(from, `${name} in ${file}`).toHaveLength(1);
    return cg!.getOutgoingEdgesFrom([from[0]!.id])
      .filter((e) => e.kind === 'calls')
      .map((e) => cg!.getNode(e.target)!)
      .filter((t) => t.filePath.startsWith('src/'))
      .map((t) => `${t.filePath}:${t.name}`)
      .sort();
  };

  it('a call where nothing nearer binds the name reaches the module', () => {
    expect(callsFrom('tests/shadow.py', 'real')).toEqual(['src/pkg/other.py:persist', 'src/pkg/other.py:update']);
  });

  it.each([
    'by_param', 'by_with', 'by_assign', 'by_for', 'by_except', 'by_lambda',
    'by_comprehension', 'by_walrus', 'inner', 'by_capture',
  ])('%s: a name the code around the call binds links no module function', (fn) => {
    expect(callsFrom('tests/shadow.py', fn)).toEqual([]);
  });

  it('a function-local `from pkg import third as other` is that module', () => {
    expect(callsFrom('tests/shadow.py', 'by_local_import')).toEqual(['src/pkg/third.py:get']);
    expect(callsFrom('tests/leak.py', 'local_third')).toEqual(['src/pkg/third.py:get']);
  });

  it('a function-local import binds the name in that function only', () => {
    expect(callsFrom('tests/leak.py', 'untouched')).toEqual(['src/pkg/other.py:get']);
  });

  it.each([
    ['keyword_argument', 'src/pkg/other.py:persist'],
    ['in_a_string', 'src/pkg/other.py:persist'],
    ['comprehension_of_others', 'src/pkg/other.py:persist'],
    ['lambda_beside', 'src/pkg/other.py:persist'],
    ['declared_global', 'src/pkg/other.py:persist'],
    ['keyword_pattern', 'src/pkg/other.py:persist'],
    ['same_module_again', 'src/pkg/other.py:get'],
  ])('%s binds nothing of that name: the call reaches the module', (fn, target) => {
    expect(callsFrom('tests/shadow.py', fn)).toEqual([target]);
  });
});
