/**
 * TS/JS class-field kind classification (#808).
 *
 * `public_field_definition` (TS) / `field_definition` (JS) previously
 * extracted as method-kind nodes unconditionally, so a plain annotated field
 * (`public fonts: Fonts;`) was reported as a method — misrepresenting class
 * shape and defeating kind-based filtering (#756 had to work around it).
 *
 * Now classification follows the VALUE: arrow-function / function-expression
 * fields (and HOF-wrapped ones, mirroring resolveBody) stay methods; every
 * other field is a property. Parity requirements: the property keeps its
 * type-annotation `references` edge, visibility, and static-ness; method
 * fields keep walking their bodies (calls still attributed).
 */

import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { CodeGraph } from '../src';
import { initGrammars, loadAllGrammars } from '../src/extraction/grammars';

beforeAll(async () => {
  await initGrammars();
  await loadAllGrammars();
});

describe('TS/JS class field classification (#808)', () => {
  let tmpDir: string | undefined;
  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  });

  it('TS: plain fields are properties; function-valued fields are methods', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-808-ts-'));
    fs.writeFileSync(
      path.join(tmpDir, 'app.ts'),
      [
        'declare function throttle(f: unknown, ms: number): unknown;',
        'class Fonts {}',
        'class History {}',
        'class App {',
        '  public fonts: Fonts;', // plain annotated → property
        '  private history: History = new History();', // annotated + initializer → property
        '  interactiveCanvas: HTMLCanvasElement | null = null;', // union type → property
        '  count = 0;', // plain value → property
        '  static defaults = { a: 1 };', // object value → property
        '  onClick = () => { this.run(); };', // arrow field → method
        '  onScroll = throttle((e: Event) => { this.run(); }, 100);', // HOF-wrapped → method
        '  handler = function namedFn() {};', // function expression → method
        '  handleClick(): void {}', // real method
        '  get value(): number { return 1; }', // getter stays method
        '  run(): void {}',
        '}',
      ].join('\n')
    );

    const cg = CodeGraph.initSync(tmpDir);
    try {
      await cg.indexAll();

      const kindOf = (name: string) =>
        cg.getNodesByName(name).map((n) => n.kind).sort().join(',');

      expect(kindOf('fonts')).toBe('property');
      expect(kindOf('history')).toBe('property');
      expect(kindOf('interactiveCanvas')).toBe('property');
      expect(kindOf('count')).toBe('property');
      expect(kindOf('defaults')).toBe('property');
      expect(kindOf('onClick')).toBe('method');
      expect(kindOf('onScroll')).toBe('method');
      expect(kindOf('handler')).toBe('method');
      expect(kindOf('handleClick')).toBe('method');
      expect(kindOf('value')).toBe('method');

      // Parity: the property keeps its type-annotation reference edge.
      const fontsProp = cg.getNodesByName('fonts').find((n) => n.kind === 'property')!;
      const fontsRefs = cg
        .getOutgoingEdges(fontsProp.id)
        .filter((e) => e.kind === 'references')
        .map((e) => cg.getNode(e.target)?.name);
      expect(fontsRefs).toContain('Fonts');

      // Parity: visibility survives the property path.
      expect(fontsProp.visibility).toBe('public');
      const historyProp = cg.getNodesByName('history').find((n) => n.kind === 'property')!;
      expect(historyProp.visibility).toBe('private');

      // Parity: arrow-field bodies still walk — onClick calls run.
      const onClick = cg.getNodesByName('onClick')[0]!;
      const calls = cg
        .getOutgoingEdges(onClick.id)
        .filter((e) => e.kind === 'calls')
        .map((e) => cg.getNode(e.target)?.name);
      expect(calls).toContain('run');

      // Signature carries the declared type, C#-style "Type name".
      expect(fontsProp.signature).toBe('Fonts fonts');
    } finally {
      cg.destroy();
      tmpDir = undefined;
    }
  });

  it('JS: field_definition classifies the same way', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-808-js-'));
    fs.writeFileSync(
      path.join(tmpDir, 'app.js'),
      [
        'class App {',
        '  count = 0;',
        '  config = { retries: 3 };',
        '  onClick = () => { this.run(); };',
        '  run() {}',
        '}',
        'module.exports = App;',
      ].join('\n')
    );

    const cg = CodeGraph.initSync(tmpDir);
    try {
      await cg.indexAll();
      expect(cg.getNodesByName('count')[0]?.kind).toBe('property');
      expect(cg.getNodesByName('config')[0]?.kind).toBe('property');
      expect(cg.getNodesByName('onClick')[0]?.kind).toBe('method');
    } finally {
      cg.destroy();
      tmpDir = undefined;
    }
  });

  it('field initializers still register callbacks (fn-ref scan)', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-808-fnref-'));
    fs.writeFileSync(
      path.join(tmpDir, 'main.ts'),
      [
        'function onSave(): void {}',
        'function onLoad(): void {}',
        'export class Registry {',
        '  static handlers = { save: onSave, load: onLoad };',
        '}',
      ].join('\n')
    );

    const cg = CodeGraph.initSync(tmpDir);
    try {
      await cg.indexAll();
      const onSave = cg.getNodesByName('onSave')[0]!;
      const fnRefs = cg
        .getIncomingEdges(onSave.id)
        .filter((e) => e.metadata?.fnRef === true);
      expect(fnRefs.length).toBeGreaterThan(0);
    } finally {
      cg.destroy();
      tmpDir = undefined;
    }
  });
});
