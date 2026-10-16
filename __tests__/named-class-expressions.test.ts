import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { extractFromSource } from '../src/extraction';
import { initGrammars, loadGrammarsForLanguages } from '../src/extraction/grammars';
import type { Language } from '../src/types';

beforeAll(async () => {
  await initGrammars();
  await loadGrammarsForLanguages(['javascript', 'jsx', 'typescript', 'tsx']);
});

describe.each(['javascript', 'jsx', 'typescript', 'tsx'] as Language[])('named class expressions (%s)', language => {
  it.each([
    'register(class Widget extends ElementBase { connectedCallback() { return helper(); } });',
    'customElements.define("x-widget", class Widget extends ElementBase { connectedCallback() { return helper(); } });',
    'export const Registered = class Widget extends ElementBase { connectedCallback() { return helper(); } };',
    'function make() { return class Widget extends ElementBase { connectedCallback() { return helper(); } }; }',
  ])('indexes the class, method, body and inheritance: %s', expression => {
    const result = extractFromSource('example.' + (language === 'typescript' ? 'ts' : language === 'javascript' ? 'js' : language),
      'class ElementBase {}\nfunction helper() { return 1; }\n' + expression, language);
    const cls = result.nodes.find(n => n.kind === 'class' && n.name === 'Widget');
    expect(cls).toBeDefined();
    expect(cls!.isExported).toBe(false);
    expect(cls!.signature).toBe('class Widget extends ElementBase');
    const method = result.nodes.find(n => n.kind === 'method' && n.name === 'connectedCallback');
    expect(method).toBeDefined();
    expect(result.edges).toContainEqual(expect.objectContaining({ source: cls!.id, target: method!.id, kind: 'contains' }));
    expect(result.unresolvedReferences).toContainEqual(expect.objectContaining({ fromNodeId: cls!.id, referenceName: 'ElementBase', referenceKind: 'extends' }));
    expect(result.unresolvedReferences).toContainEqual(expect.objectContaining({ fromNodeId: method!.id, referenceName: 'helper', referenceKind: 'calls' }));
  });

  it('keeps anonymous expressions anonymous and walks their body', () => {
    const result = extractFromSource('example.js', 'function helper() {} register(class { run() { helper(); } });', language);
    expect(result.nodes.filter(n => n.kind === 'class')).toHaveLength(0);
    expect(result.unresolvedReferences.some(r => r.referenceName === 'helper' && r.referenceKind === 'calls')).toBe(true);
  });

  it('keeps repeated expression names distinct with Unicode and CRLF', () => {
    const result = extractFromSource('example.js', '/* é😀 */ register(class Widget { run() {} }); register(class Widget { run() {} });\r\n', language);
    expect(result.nodes.filter(n => n.kind === 'class' && n.name === 'Widget')).toHaveLength(2);
    expect(new Set(result.nodes.map(n => n.id)).size).toBe(result.nodes.length);
  });
});

describe('class expression scope after persistence', () => {
  let root: string | undefined;
  let graph: CodeGraph | undefined;
  afterEach(() => {
    graph?.close();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it('resolves body calls and inheritance without exposing the inner name outside', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-class-expression-'));
    fs.writeFileSync(path.join(root, 'widget.js'), `
export class ElementBase { connectedCallback() { return 1; } }
export function helper() { return 2; }
function register(Type) { return Type; }
export const Registered = register(class Widget extends ElementBase {
  connectedCallback() { return helper(); }
  clone() { return new Widget(); }
});
export function outside() { return new Widget(); }
export function outsideMethod() { return Widget.connectedCallback(); }
`);
    fs.writeFileSync(path.join(root, 'other.js'), `import { Widget } from './widget.js'; export function elsewhere() { return new Widget(); }`);
    graph = await CodeGraph.init(root, { index: true });
    const cls = graph.getNodesByKind('class').find(n => n.name === 'Widget')!;
    expect(cls).toBeDefined();
    expect(graph.getOutgoingEdges(cls.id)).toContainEqual(expect.objectContaining({ kind: 'extends', target: graph.getNodesByKind('class').find(n => n.name === 'ElementBase')!.id }));
    const method = graph.getNodesByKind('method').find(n => n.name === 'connectedCallback' && n.startLine === 6)!;
    expect(graph.getCallees(method.id).map(c => c.node.name)).toContain('helper');
    const clone = graph.getNodesByKind('method').find(n => n.name === 'clone')!;
    expect(graph.getOutgoingEdges(clone.id)).toContainEqual(expect.objectContaining({ kind: 'instantiates', target: cls.id }));
    for (const name of ['outside', 'outsideMethod', 'elsewhere']) {
      const caller = graph.getNodesByKind('function').find(n => n.name === name)!;
      expect(graph.getOutgoingEdges(caller.id).filter(e => e.target === cls.id || e.target === method.id)).toEqual([]);
    }
    expect(cls.isExported).toBe(false);
  });
});
