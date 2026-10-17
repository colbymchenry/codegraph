/**
 * A Python src-layout package imported ABSOLUTELY (`from app import db`, or
 * `import app.db as store`) whose member name collides with a built-in method
 * (`db.get`, `store.write`) must still resolve to the project function — while
 * the same name on a local collection (`d.get()`, `xs.append()`) must not.
 */
import { afterEach, beforeEach, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CodeGraph } from '../src';

let root: string;
let cg: CodeGraph | undefined;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-py-module-member-')); });
afterEach(() => { cg?.close(); cg = undefined; fs.rmSync(root, { recursive: true, force: true }); });

async function index(files: Record<string, string>) {
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  }
  cg = await CodeGraph.init(root, { index: true });
}

/** `file:qualifiedName` of everything with a `calls` edge into the named symbol. */
function callers(file: string, qualifiedName: string): string[] {
  const target = cg!.getNodesInFile(file).find((n) => n.qualifiedName === qualifiedName);
  expect(target, `${file}:${qualifiedName}`).toBeDefined();
  return cg!.getIncomingEdges(target!.id)
    .filter((e) => e.kind === 'calls')
    .map((e) => {
      const src = cg!.getNode(e.source)!;
      return `${src.filePath}:${src.qualifiedName}`;
    })
    .sort();
}

const FIXTURE = {
  'pyproject.toml': '[project]\nname = "app"\n',
  'src/app/__init__.py': '',
  'src/app/db.py': 'def get(key):\n    return key\n\n\ndef fetch(key):\n    return key\n\n\ndef write(x):\n    pass\n',
  'src/app/main.py': 'from app import db\nimport app.db as store\n\n\ndef use():\n    a = db.get("x")\n    b = db.fetch("y")\n\n\ndef use_alias():\n    store.write("z")\n',
  'src/app/sub/__init__.py': '',
  'src/app/sub/mod.py': 'from .. import db\n\n\ndef use_relative():\n    return db.get("z")\n',
};

it('resolves a builtin-method member through an absolute `from pkg import mod`', async () => {
  await index(FIXTURE);
  expect(callers('src/app/db.py', 'get')).toEqual([
    'src/app/main.py:use',
    'src/app/sub/mod.py:use_relative',
  ]);
});

it('resolves a non-builtin member through the same absolute import', async () => {
  await index(FIXTURE);
  expect(callers('src/app/db.py', 'fetch')).toEqual(['src/app/main.py:use']);
});

it('resolves an alias of an absolute dotted module import (`import app.db as store`)', async () => {
  await index(FIXTURE);
  expect(callers('src/app/db.py', 'write')).toEqual(['src/app/main.py:use_alias']);
});

it('does not bind a builtin-method name on a local collection to a project function', async () => {
  await index({
    ...FIXTURE,
    'src/app/local.py': 'def use_collections():\n    d = {}\n    xs = []\n    d.get("k")\n    xs.append(1)\n',
  });
  const targetNames = new Set<string>();
  for (const node of cg!.getNodesInFile('src/app/local.py')) {
    for (const edge of cg!.getOutgoingEdges(node.id)) {
      if (edge.kind !== 'calls') continue;
      const target = cg!.getNode(edge.target);
      if (target) targetNames.add(target.qualifiedName);
    }
  }
  expect(targetNames.has('get')).toBe(false);
  expect(targetNames.has('append')).toBe(false);
});

const SHADOW = {
  'pyproject.toml': '[project]\nname = "pkg"\n',
  'src/pkg/__init__.py': '',
  'src/pkg/other.py': 'def write(x):\n    return x\n\n\ndef update(x):\n    return x\n',
  'tests/shadow.py': `from pkg import other


def real():
    other.update({"b": 2})


def by_param(other):
    other.update({"a": 1})


def by_with(path):
    with open(path, "w") as other:
        other.write("x")


def by_assign():
    other = {}
    other.update({"c": 3})


def by_for(items):
    for other in items:
        other.update(1)


def by_except():
    try:
        pass
    except OSError as other:
        other.write("e")


def by_lambda():
    return lambda other: other.update(1)
`,
};

it('does not bind a builtin-method name to a module whose alias the enclosing function rebinds', async () => {
  await index(SHADOW);
  // Only the genuine module-scope receiver reaches the module's functions.
  expect(callers('src/pkg/other.py', 'update')).toEqual(['tests/shadow.py:real']);
  expect(callers('src/pkg/other.py', 'write')).toEqual([]);
});

// Rebinding is scoped to the call's own function: these look like a rebinding
// of `helpers` to a text scan, but none of them binds it where the call is.
const SCOPED = {
  'pyproject.toml': '[project]\nname = "pkg"\n',
  'src/pkg/__init__.py': '',
  'src/pkg/helpers.py': 'def build():\n    return 1\n\n\ndef items():\n    return []\n\n\ndef run():\n    return 1\n\n\ndef update(x=None):\n    return x\n\n\ndef get(key=None):\n    return key\n',
  'tests/scoped.py': `from pkg import helpers


def kwarg_line():
    return dict(
        helpers=helpers,
    ) and helpers.build()


def comprehension(seen):
    return [y for y in helpers.items() if y in seen]


def outer():
    def inner(helpers):
        return helpers
    return helpers.run()


def commented():  # shared by outreach, helpers, and others
    return helpers.update()


def local_import_alias():
    from pkg import helpers as h
    return h.get("k")


def lambda_elsewhere():
    pick = sorted([3, 1], key=lambda helpers: helpers)
    helpers.update(pick)
`,
};

it('keeps resolving a module member when the receiver text only looks rebound', async () => {
  await index(SCOPED);
  expect(callers('src/pkg/helpers.py', 'build')).toEqual(['tests/scoped.py:kwarg_line']);
  expect(callers('src/pkg/helpers.py', 'items')).toEqual(['tests/scoped.py:comprehension']);
  expect(callers('src/pkg/helpers.py', 'run')).toEqual(['tests/scoped.py:outer']);
  expect(callers('src/pkg/helpers.py', 'update')).toEqual(['tests/scoped.py:commented', 'tests/scoped.py:lambda_elsewhere']);
  expect(callers('src/pkg/helpers.py', 'get')).toEqual(['tests/scoped.py:local_import_alias']);
});

it('still treats a rebinding in the call\'s own function, or a nested one around it, as a local', async () => {
  await index({
    ...SCOPED,
    'tests/own.py': `from pkg import helpers


def comp_target(rows):
    return [helpers.update(helpers) for helpers in rows]


def nested_call(helpers):
    def inner():
        return helpers.run()
    return inner


def annotated():
    helpers: dict = {}
    return helpers.get("k")


def augmented(helpers):
    helpers += [1]
    return helpers.items()
`,
  });
  expect(callers('src/pkg/helpers.py', 'update')).toEqual(['tests/scoped.py:commented', 'tests/scoped.py:lambda_elsewhere']);
  expect(callers('src/pkg/helpers.py', 'run')).toEqual(['tests/scoped.py:outer']);
  expect(callers('src/pkg/helpers.py', 'get')).toEqual(['tests/scoped.py:local_import_alias']);
  expect(callers('src/pkg/helpers.py', 'items')).toEqual(['tests/scoped.py:comprehension']);
});

// A function-local import binds the name to whatever module it names, and a
// `match` capture pattern binds it too: neither is the file-level module.
const LOCAL_REBIND = {
  'pyproject.toml': '[project]\nname = "pkg"\n',
  'src/pkg/__init__.py': '',
  'src/pkg/other.py': 'def get(key=None):\n    return key\n\n\ndef update(x=None):\n    return x\n',
  'src/pkg/third.py': 'def get(key=None):\n    return key\n',
  // Separate files: the file-level mappings of one file list every import in it, local or not.
  'tests/local_same.py': `from pkg import other


def top():
    return other.get(0)


def same_module():
    from pkg import other
    return other.get(1)
`,
  'tests/local_from.py': `from pkg import other


def other_module_from():
    from pkg import third as other
    return other.get(2)
`,
  'tests/local_import.py': `from pkg import other


def other_module_import():
    import pkg.third as other
    return other.get(3)
`,
  'tests/local_match.py': `from pkg import other


def match_capture(v):
    match v:
        case other:
            return other.get(5)


def match_sequence(v):
    match v:
        case [other, *_]:
            return other.update(6)


def match_class(v):
    match v:
        case Point(x=other) if other:
            return other.get(7)


def match_mapping(v):
    match v:
        case {"k": other}:
            return other.update(8)


def match_not_a_capture(v):
    match v:
        case Point(other=1):
            return other.get(9)
        case mod.other:
            return other.update(10)


def case_is_a_name():
    case = 1
    return other.get(case)
`,
};

it('treats a function-local import of a different module, or a match capture, as a rebinding', async () => {
  await index(LOCAL_REBIND);
  expect(callers('src/pkg/other.py', 'get')).toEqual([
    'tests/local_match.py:case_is_a_name',
    'tests/local_match.py:match_not_a_capture',
    'tests/local_same.py:same_module',
    'tests/local_same.py:top',
  ]);
  expect(callers('src/pkg/other.py', 'update')).toEqual(['tests/local_match.py:match_not_a_capture']);
});
