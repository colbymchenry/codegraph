/**
 * A bare Python function-as-value reference (`function_ref`) of a name bound
 * locally in the enclosing function(s) — a parameter, assignment, loop/with/except
 * target, walrus target, comprehension variable, lambda parameter, function-local
 * `import ... as name`, or nested `def`/`class` — reads that local binding rather
 * than a same-named function or class imported by the file (#3430). A `global`
 * declaration, an unshadowed function, a function-local `from ... import`, an
 * unshadowed nested `def`, and a pytest fixture in reach keep linking as before.
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

  it('blocks local assignments, enclosing parameters, comprehensions, lambdas, and local module imports while keeping positive controls', async () => {
    await index({
      'pkg/__init__.py': '',
      'pkg/termui.py': [
        'def prompt(text):',
        '    return input(text)',
        '',
      ].join('\n'),
      'pkg/other.py': [
        'def helper():',
        '    return "other"',
        '',
      ].join('\n'),
      'pkg/use.py': [
        'from .termui import prompt',
        '',
        '',
        'def wrap(fn):',
        '    return fn',
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
        '    return [wrap(prompt) for prompt in items]',
        '',
        '',
        'def comp_control(items):',
        '    return [wrap(prompt) for item in items]',
        '',
        '',
        'def lambda_shadow():',
        '    return lambda prompt: wrap(prompt)',
        '',
        '',
        'def lambda_control():',
        '    return lambda item: wrap(prompt)',
        '',
        '',
        'def with_global():',
        '    global prompt',
        '    saved = prompt',
        '    return saved',
        '',
        '',
        'def with_global_and_assign(replacement):',
        '    global prompt',
        '    saved = prompt',
        '    prompt = replacement',
        '    return saved',
        '',
        '',
        'def outer_with_nested_assign():',
        '    def helper():',
        '        prompt = "local"',
        '        return prompt',
        '    saved = prompt',
        '    return saved',
        '',
        '',
        'def local_module_alias():',
        '    import pkg.other as prompt',
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
        '',
        'def nested_def_closure():',
        '    def prompt(text):',
        '        return text',
        '',
        '    def inner():',
        '        saved = prompt',
        '        return saved',
        '    return inner',
        '',
      ].join('\n'),
    });

    expect(edgesFrom('local_assign')).toEqual([]);
    expect(edgesFrom('outer_param::inner')).toEqual([]);
    expect(edgesFrom('comp_shadow')).toEqual(['calls:wrap@pkg/use.py']);
    expect(edgesFrom('comp_control')).toEqual(['calls:wrap@pkg/use.py', 'references:prompt@pkg/termui.py']);
    expect(edgesFrom('lambda_shadow')).toEqual(['calls:wrap@pkg/use.py']);
    expect(edgesFrom('lambda_control')).toEqual(['calls:wrap@pkg/use.py', 'references:prompt@pkg/termui.py']);
    expect(edgesFrom('with_global')).toEqual(['references:prompt@pkg/termui.py']);
    expect(edgesFrom('with_global_and_assign')).toEqual(['references:prompt@pkg/termui.py']);
    expect(edgesFrom('outer_with_nested_assign')).toEqual(['references:prompt@pkg/termui.py']);
    expect(edgesFrom('local_module_alias')).toEqual([]);
    expect(edgesFrom('control')).toEqual(['references:prompt@pkg/termui.py']);
    expect(edgesFrom('nested_def')).toEqual(['references:nested_def::prompt@pkg/use.py']);
    expect(edgesFrom('nested_def_closure::inner')).toEqual(['references:nested_def_closure::prompt@pkg/use.py']);
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

  it('resolves exact innermost binding scope so shadowed nested defs and nested classes never leak false edges', async () => {
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
        'class Outer:',
        '    class Widget:',
        '        pass',
        '',
        '',
        'def wrap(fn):',
        '    return fn',
        '',
        '',
        'def takes_widget(Widget):',
        '    saved = Widget',
        '    return saved',
        '',
        '',
        'def enclosing_param_widget(Widget):',
        '    def inner():',
        '        saved = Widget',
        '        return saved',
        '    return inner',
        '',
        '',
        'def comp_widget(items):',
        '    return [wrap(Widget) for Widget in items]',
        '',
        '',
        'def lambda_widget():',
        '    return lambda Widget: wrap(Widget)',
        '',
        '',
        'def walrus_widget(get_val):',
        '    if (Widget := get_val()):',
        '        saved = Widget',
        '        return saved',
        '    return None',
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
        'def outer_nested_param():',
        '    def prompt(text):',
        '        return text',
        '',
        '    def inner(prompt):',
        '        saved = prompt',
        '        return saved',
        '    return inner',
        '',
        '',
        'def outer_nested_enclosing_param():',
        '    def prompt(text):',
        '        return text',
        '',
        '    def middle(prompt):',
        '        def inner():',
        '            saved = prompt',
        '            return saved',
        '        return inner',
        '    return middle',
        '',
        '',
        'def outer_nested_comp(items):',
        '    def prompt(text):',
        '        return text',
        '    return [wrap(prompt) for prompt in items]',
        '',
        '',
        'def outer_nested_lambda():',
        '    def prompt(text):',
        '        return text',
        '    return lambda prompt: wrap(prompt)',
        '',
        '',
        'def outer_nested_walrus(get_val):',
        '    def prompt(text):',
        '        return text',
        '',
        '    def inner():',
        '        if (prompt := get_val()):',
        '            saved = prompt',
        '            return saved',
        '        return None',
        '    return inner',
        '',
      ].join('\n'),
    });

    expect(edgesFrom('takes_widget')).toEqual([]);
    expect(edgesFrom('enclosing_param_widget::inner')).toEqual([]);
    expect(edgesFrom('comp_widget')).toEqual(['calls:wrap@pkg/cases.py']);
    expect(edgesFrom('lambda_widget')).toEqual(['calls:wrap@pkg/cases.py']);
    expect(edgesFrom('walrus_widget')).toEqual([]);
    expect(edgesFrom('uses_widget')).toEqual(['references:Widget@pkg/models.py']);
    expect(edgesFrom('local_import')).toEqual(['references:prompt@pkg/other.py']);
    expect(edgesFrom('outer_nested_param::inner')).toEqual([]);
    expect(edgesFrom('outer_nested_enclosing_param::middle::inner')).toEqual([]);
    expect(edgesFrom('outer_nested_comp')).toEqual(['calls:wrap@pkg/cases.py']);
    expect(edgesFrom('outer_nested_lambda')).toEqual(['calls:wrap@pkg/cases.py']);
    expect(edgesFrom('outer_nested_walrus::inner')).toEqual([]);
  });
});
