import { describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import * as path from 'path';
import { getKernel } from '../src/extraction/kernel';
import type { ExtractionResult, Language } from '../src/types';

const dist = path.resolve(__dirname, '../dist');
const kernel = getKernel();

// Bound synchronous regressions in a child: a synchronous parse cannot honor Vitest's timer.
function extractWithBackend(backend: 'native' | 'wasm', source: string, language: Language = 'python'): ExtractionResult {
  const script = `
    const fs = require('fs'), path = require('path');
    const dist = process.argv[1], language = process.argv[2];
    (async () => {
      const source = fs.readFileSync(0, 'utf8');
      let result;
      if (process.argv[3] === 'wasm') {
        process.env.CODEGRAPH_KERNEL = '0';
        const { initGrammars, loadGrammarsForLanguages } = require(path.join(dist, 'extraction/grammars'));
        await initGrammars();
        await loadGrammarsForLanguages([language]);
        result = require(path.join(dist, 'extraction/tree-sitter')).extractFromSource('comments', source, language);
      } else {
        const kernel = require(path.join(dist, 'extraction/kernel')).getKernel();
        if (!kernel) throw Error('native kernel missing');
        const { decodeExtractBuffers } = require(path.join(dist, 'extraction/kernel/decode'));
        result = decodeExtractBuffers(kernel.extractFile('comments', source, language), 'comments', language);
      }
      console.log(JSON.stringify(result));
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `;
  return JSON.parse(execFileSync(process.execPath, ['--liftoff-only', '-e', script, dist, language, backend], {
    input: source, encoding: 'utf8', timeout: 10_000, killSignal: 'SIGKILL', maxBuffer: 4 * 1024 * 1024,
  }));
}

for (const backend of ['native', 'wasm'] as const) {
  describe.skipIf(backend === 'native' && !kernel)(`${backend} wide comment runs`, () => {
    const extract = (source: string, language: Language = 'python') => extractWithBackend(backend, source, language);
    it.each([31, 32, 33, 70_000])('keeps all %i preceding comments in source order', count => {
      const docs = Array.from({ length: count }, (_, i) => `doc ${i}`);
      const result = extract(docs.map(d => `# ${d}\n`).join('') + '@decorator\ndef included():\n    return helper()\n');
      const fn = result.nodes.find(n => n.name === 'included')!;
      expect(result.errors).toEqual([]);
      expect(fn.docstring).toBe(docs.join('\n'));
      expect(fn.startLine).toBe(count + 2);
      expect(result.unresolvedReferences.some(r => r.referenceName === 'decorator' && r.referenceKind === 'decorates')).toBe(true);
      expect(result.unresolvedReferences.some(r => r.referenceName === 'helper')).toBe(true);
    });

    it.each([31, 32, 33])('keeps JavaScript wrapper comments at the %i-comment boundary', count => {
      const docs = Array.from({ length: count }, (_, i) => `doc ${i}`);
      const result = extract(docs.map(d => `// ${d}\n`).join('') + 'export function included() {}\n', 'javascript');
      expect(result.nodes.find(n => n.name === 'included')!.docstring).toBe(docs.join('\n'));
    });

    it('keeps Dart annotations transparent across a long documentation run', () => {
      const docs = Array.from({ length: 33 }, (_, i) => `doc ${i}`);
      const result = extract('class Box {\n  /// before\n  @override\n'
        + docs.map(d => `  /// ${d}\n`).join('') + '  String toString() => "box";\n}\n', 'dart');
      expect(result.nodes.find(n => n.name === 'toString')!.docstring).toBe(['before', ...docs].join('\n'));
    });

    it.each([31, 32, 33])('stops %i preceding comments at the previous declaration', count => {
      const docs = '# included docs\n'.repeat(count);
      const result = extract('# unrelated docs\ndef previous():\n    pass\n' + docs + 'def included():\n    pass\n');
      expect(result.nodes.find(n => n.name === 'included')!.docstring).toBe('included docs\n'.repeat(count).trimEnd());
      expect(result.nodes.find(n => n.name === 'previous')!.docstring).toBe('unrelated docs');
    });

    it.each(['function', 'class', 'class prefix', 'value references'])('walks wide %s bodies without losing symbols or documentation', shape => {
      const comments = '# padding\n'.repeat(70_000);
      const indented = '    # padding\n'.repeat(70_000);
      const source = shape === 'function'
        ? 'def included():\n' + indented + '    """body docs"""\n    return helper()\n'
        : shape === 'class'
          ? 'class Container(Base):\n    """class docs"""\n' + indented + '    def included(self):\n        return helper()\n'
          : shape === 'class prefix'
            ? 'class Container(Base):\n' + indented + '    def included(self):\n        return helper()\n'
            : 'VALUE = 42\n' + comments + 'def included():\n    return VALUE\n';
      const result = extract(source);
      const fn = result.nodes.find(n => n.name === 'included')!;
      expect(result.errors).toEqual([]);
      expect(fn).toBeDefined();
      if (shape === 'function') expect(fn.docstring).toBe('body docs');
      if (shape.startsWith('class')) expect(result.unresolvedReferences.some(r => r.referenceName === 'Base' && r.referenceKind === 'extends')).toBe(true);
      if (shape === 'class') expect(fn.docstring).toBe('padding\n'.repeat(70_000).trimEnd());
      if (shape === 'value references') {
        const value = result.nodes.find(n => n.name === 'VALUE')!;
        expect(result.edges.some(e => e.source === fn.id && e.target === value.id && e.kind === 'references')).toBe(true);
      } else {
        expect(result.unresolvedReferences.some(r => r.referenceName === 'helper')).toBe(true);
      }
    });
  });
}
