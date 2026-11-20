/**
 * A bare Python function-as-value reference (`function_ref`) of a name bound
 * locally in the enclosing function(s) — a parameter, assignment, loop/with/except
 * target, comprehension variable, lambda parameter, or nested def — reads that
 * local binding rather than a same-named function or class imported by the file
 * (#3430). A `global` declaration, an unshadowed function, a function-local
 * import, and a pytest fixture in reach keep linking as before.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';

let tempDir: string | undefined;
let cg: CodeGraph | null = null;

async function index(files: Record<string, string>): Promise<void> {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-py-fnref-'));
  for (const [rel, source] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(tempDir, rel)), { recursive: true });
    fs.writeFileSync(path.join(tempDir, rel), source);
  }
  cg = await CodeGraph.init(tempDir, { index: true });
}

afterEach(() => {
  cg?.close();
  cg = null;
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

function edgesFrom(qualified: string, kinds: readonly string[] = ['references', 'calls']): string[] {
  const from = [...cg!.getNodesByKind('function'), ...cg!.getNodesByKind('method')].filter(
    (n) => n.qualifiedName === qualified
  );
  expect(from.length, `${qualified} should be indexed`).toBe(1);
  return cg!
    .getOutgoingEdges(from[0]!.id)
    .filter((e) => kinds.includes(e.kind))
    .map((e) => {
      const target = cg!.getNode(e.target);
      return target ? `${e.kind}:${target.qualifiedName}@${target.filePath}` : null;
    })
    .filter((s): s is string => s !== null)
    .sort();
}

describe('a Python local binding shadows an imported function read as a value (#3430)', () => {
  it("reproduces the issue's Option.__init__ parameter case while keeping the real call", async () => {
    await index({
      'pkg/__init__.py': '',
      'pkg/termui.py': [
        'def prompt(text):',
        '    return input(text)',
        '',
      ].join('\n'),
      'pkg/core.py': [
        'from .termui import prompt',
        '',
        '',
        'class Option:',
        '    def __init__(self, prompt=False):',
        '        if prompt is True:',
        '            prompt_text = "Value"',
        '        else:',
        '            prompt_text = prompt',
        '        self.prompt = prompt_text',
        '',
        '    def prompt_for_value(self):',
        '        assert self.prompt is not None',
        '        return prompt(self.prompt)',
        '',
      ].join('\n'),
    });

    expect(edgesFrom('Option::__init__')).toEqual([]);
    expect(edgesFrom('Option::prompt_for_value')).toEqual(['calls:prompt@pkg/termui.py']);
  });

  it('blocks local assignments, enclosing parameters, comprehensions and lambdas, but keeps unshadowed, global, and nested defs', async () => {
    await index({
      'pkg/__init__.py': '',
      'pkg/termui.py': [
        'def prompt(text):',
        '    return input(text)',
        '',
      ].join('\n'),
      'pkg/use.py': [
        'from .termui import prompt',
        '',
        '',
        'def local_assign(flag):',
        '    prompt = "default" if flag else "other"',
        '    saved = prompt',
        '    return saved',
        '',
        '',
        'def outer_param(prompt):',
        '    def inner():',
        '        saved = prompt',
        '        return saved',
        '    return inner',
        '',
        '',
        'def comp_shadow(items):',
        '    return [prompt for prompt in items]',
        '',
        '',
        'def lambda_shadow():',
        '    return lambda prompt: prompt',
        '',
        '',
        'def with_global():',
        '    global prompt',
        '    saved = prompt',
        '    return saved',
        '',
        '',
        'def control():',
        '    saved = prompt',
        '    return saved',
        '',
        '',
        'def nested_def():',
        '    def prompt(text):',
        '        return text',
        '    saved = prompt',
        '    return saved',
        '',
      ].join('\n'),
    });

    expect(edgesFrom('local_assign')).toEqual([]);
    expect(edgesFrom('outer_param::inner')).toEqual([]);
    expect(edgesFrom('comp_shadow')).toEqual([]);
    expect(edgesFrom('lambda_shadow')).toEqual([]);
    expect(edgesFrom('with_global')).toEqual(['references:prompt@pkg/termui.py']);
    expect(edgesFrom('control')).toEqual(['references:prompt@pkg/termui.py']);
    expect(edgesFrom('nested_def')).toEqual(['references:nested_def::prompt@pkg/use.py']);
  });

  it('keeps an imported pytest fixture when a test takes it as a parameter', async () => {
    await index({
      'tests/conftest.py': [
        'import pytest',
        '',
        '@pytest.fixture',
        'def sample_fixture():',
        '    return "ok"',
        '',
      ].join('\n'),
      'tests/test_use.py': [
        'from .conftest import sample_fixture',
        '',
        'def test_reads_fixture(sample_fixture):',
        '    val = sample_fixture',
        '    return val',
        '',
      ].join('\n'),
    });

    expect(edgesFrom('test_reads_fixture')).toEqual(['references:sample_fixture@tests/conftest.py']);
  });

  it('handles imported classes, function-local imports, and an inner parameter shadowing an outer nested def', async () => {
    await index({
      'pkg/__init__.py': '',
      'pkg/models.py': [
        'class Widget:',
        '    pass',
        '',
      ].join('\n'),
      'pkg/termui.py': [
        'def prompt(text):',
        '    return input(text)',
        '',
      ].join('\n'),
      'pkg/other.py': [
        'def prompt(text):',
        '    return text',
        '',
      ].join('\n'),
      'pkg/cases.py': [
        'from .models import Widget',
        'from .termui import prompt',
        '',
        '',
        'def takes_widget(Widget):',
        '    saved = Widget',
        '    return saved',
        '',
        '',
        'def uses_widget():',
        '    saved = Widget',
        '    return saved',
        '',
        '',
        'def local_import():',
        '    from .other import prompt',
        '    saved = prompt',
        '    return saved',
        '',
        '',
        'def outer_nested():',
        '    def prompt(text):',
        '        return text',
        '',
        '    def inner(prompt):',
        '        saved = prompt',
        '        return saved',
        '    return inner',
        '',
      ].join('\n'),
    });

    expect(edgesFrom('takes_widget')).toEqual([]);
    expect(edgesFrom('uses_widget')).toEqual(['references:Widget@pkg/models.py']);
    expect(edgesFrom('local_import')).toEqual(['references:prompt@pkg/other.py']);
    expect(edgesFrom('outer_nested::inner')).toEqual([]);
  });
});
