/**
 * A Python call on an element of a collection, like `stats[i].write_timeline()`,
 * links to the project's one method of the name, in a module the file has in
 * hand, unless a list or a dict has that method too. The receiver's text kept
 * the subscript, so no strategy could read it, and these calls linked to nothing.
 *
 * The collection's name says nothing of the element's class: netbox's
 * `context['object'].get_absolute_url()` is no `ConfigContext`.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';

describe('a Python call on an element of a collection', () => {
  let root = '';
  let cg: CodeGraph | undefined;

  afterEach(() => {
    cg?.destroy();
    cg = undefined;
    if (root) fs.rmSync(root, { recursive: true, force: true });
    root = '';
  });

  /** Index one module and return the qualified names a function's call lines reach, by line. */
  async function calls(source: string, fn: string): Promise<Array<[number, string]>> {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-py-subscript-'));
    fs.writeFileSync(path.join(root, 'a.py'), source);
    const graph = (cg = await CodeGraph.init(root, { index: true }));
    const node = graph.getNodesByName(fn).find((n) => n.kind === 'function' || n.kind === 'method')!;
    return graph
      .getOutgoingEdges(node.id)
      .filter((e) => e.kind === 'calls')
      .map((e): [number, string] => [e.line ?? 0, graph.getNode(e.target)!.qualifiedName])
      .sort((a, b) => a[0] - b[0]);
  }

  const classes = [
    'class Log:',
    '    def get_message(self):',
    '        return 1',
    '    def pop(self):',
    '        return 1',
    '    def search(self):',
    '        return 1',
    '',
    'class Timeline:',
    '    def replay(self):',
    '        return 1',
    '',
    'class Other:',
    '    def replay(self):',
    '        return 1',
    '',
  ];
  const at = (offset: number): number => classes.length + 1 + offset;

  it('links the one method of the name, through any subscript', async () => {
    const reached = await calls([
      ...classes,
      'def f(trigger, stats, key):',
      '    trigger["a"][0].get_message()',
      '    stats[key].get_message()',
      '    stats[key["k"]].get_message()',
      '    stats["a]b"].get_message()',
      '',
    ].join('\n'), 'f');
    expect(reached).toEqual([
      [at(1), 'Log::get_message'],
      [at(2), 'Log::get_message'],
      [at(3), 'Log::get_message'],
      [at(4), 'Log::get_message'],
    ]);
  });

  it('never takes a method a list or a dict has, or one of several', async () => {
    const reached = await calls([
      ...classes,
      'def f(trigger):',
      '    trigger["a"].pop(1)',
      '    trigger["a"].search()',
      '    trigger["a"].replay()',
      '',
    ].join('\n'), 'f');
    expect(reached).toEqual([]);
  });

  it('stops at an attribute after the subscript: nothing says what it holds', async () => {
    // django's `connections[db].settings_dict.get(…)` is a dict's, whatever its name says.
    const reached = await calls([
      ...classes,
      'def f(caches):',
      '    caches["opt"].timeline.replay()',
      '    caches["opt"].anything.get_message()',
      '',
    ].join('\n'), 'f');
    expect(reached).toEqual([]);
  });

  it('never goes by the name of the collection, or by a dunder a container answers', async () => {
    const reached = await calls([
      'class ConfigContext:',
      '    def url(self):',
      '        return 1',
      '',
      'class Other:',
      '    def url(self):',
      '        return 1',
      '',
      'class Registry:',
      '    def __setitem__(self, k, v):',
      '        pass',
      '',
      'def f(context, registry, a):',
      '    context["object"].url()',
      '    registry["a"].__setitem__(1, a)',
      '',
    ].join('\n'), 'f');
    expect(reached).toEqual([]);
  });

  it('reads an element of what a call returns the same way', async () => {
    const reached = await calls([
      ...classes,
      'def g():',
      '    return []',
      'def f(x):',
      '    g()[0].get_message()',
      '',
    ].join('\n'), 'f');
    expect(reached.map(([, name]) => name).sort()).toEqual(['Log::get_message', 'g']);
  });

  it('wants the method in a module the file has in hand', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-py-subscript-'));
    const files: Record<string, string> = {
      'lookups.py': 'class CollatedMixin:\n    def process_rhs(self):\n        return 1\n',
      'models.py': 'class Log:\n    def get_message(self):\n        return 1\n',
      'use.py': [
        'from models import Log',
        'def f(children, logs):',
        '    children[0].process_rhs()',
        '    logs[0].get_message()',
        '',
      ].join('\n'),
    };
    for (const [rel, content] of Object.entries(files)) fs.writeFileSync(path.join(root, rel), content);
    const graph = (cg = await CodeGraph.init(root, { index: true }));
    const f = graph.getNodesByName('f').find((n) => n.kind === 'function')!;
    expect(graph.getOutgoingEdges(f.id).filter((e) => e.kind === 'calls').map((e) => graph.getNode(e.target)!.qualifiedName))
      .toEqual(['Log::get_message']);
  });
});
