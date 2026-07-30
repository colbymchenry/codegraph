/**
 * `.js` specifiers naming an on-disk `.ts` source.
 *
 * `"moduleResolution": "NodeNext"` REQUIRES the emitted extension on relative
 * imports (`./impl.js`), while the file on disk is `./impl.ts`.
 * EXTENSION_RESOLUTION only ever APPENDS a suffix, so such a specifier was tried
 * as `impl.js.ts`, `impl.js.tsx`, … then bare `impl.js` — never `impl.ts`.
 * Import resolution returned null for EVERY relative import in the project and
 * the resolver fell through to the name-matcher, which cannot cross a rename,
 * so an aliased or default import reported a false 0 callers.
 *
 * Each fixture below imports under a DIFFERENT local name than the declaration,
 * so the name-matcher cannot rescue the edge — the assertion isolates
 * import-based resolution.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import CodeGraph from '../src/index';

describe('.js specifiers resolve to their TS source', () => {
  let cg: CodeGraph;
  let dir: string;

  afterEach(() => {
    if (cg) cg.destroy();
    if (dir && fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  });

  const callersOf = (name: string): string[] => {
    const target = cg.getNodesByKind('function').find((n) => n.name === name);
    expect(target, `fixture symbol ${name} was not indexed`).toBeDefined();
    return cg.getCallers(target!.id).map((c) => c.node.name);
  };

  it('resolves a default import through a `.js` specifier', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-jsspec-'));
    fs.writeFileSync(
      path.join(dir, 'impl.ts'),
      'export default function realImpl(): number { return 1; }\n'
    );
    fs.writeFileSync(
      path.join(dir, 'consumer.ts'),
      "import renamedLocally from './impl.js';\n" +
        'export function consumerFn(): number { return renamedLocally(); }\n'
    );

    cg = CodeGraph.initSync(dir, { config: { include: ['**/*.ts'], exclude: [] } });
    await cg.indexAll();

    expect(callersOf('realImpl')).toContain('consumerFn');
  });

  it('resolves `.mjs` and `.cjs` specifiers to `.mts` and `.cts`', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-jsspec-esm-'));
    fs.writeFileSync(
      path.join(dir, 'esm.mts'),
      'export default function esmImpl(): number { return 1; }\n'
    );
    fs.writeFileSync(
      path.join(dir, 'cjs.cts'),
      'export default function cjsImpl(): number { return 2; }\n'
    );
    fs.writeFileSync(
      path.join(dir, 'consumer.ts'),
      "import esmRenamed from './esm.mjs';\n" +
        "import cjsRenamed from './cjs.cjs';\n" +
        'export function consumerFn(): number { return esmRenamed() + cjsRenamed(); }\n'
    );

    cg = CodeGraph.initSync(dir, {
      config: { include: ['**/*.ts', '**/*.mts', '**/*.cts'], exclude: [] },
    });
    await cg.indexAll();

    expect(callersOf('esmImpl')).toContain('consumerFn');
    expect(callersOf('cjsImpl')).toContain('consumerFn');
  });

  it('prefers a real emitted `.js` on disk over the rewritten `.ts`', async () => {
    // Committed build output beside its source: `./emitted.js` names the JS
    // file, which exists, so the rewrite must NOT steal the edge.
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-jsspec-literal-'));
    fs.writeFileSync(
      path.join(dir, 'emitted.js'),
      'export default function fromJs() { return 1; }\n'
    );
    fs.writeFileSync(
      path.join(dir, 'emitted.ts'),
      'export default function fromTs(): number { return 1; }\n'
    );
    fs.writeFileSync(
      path.join(dir, 'consumer.ts'),
      "import renamedLocally from './emitted.js';\n" +
        'export function consumerFn(): number { return renamedLocally(); }\n'
    );

    cg = CodeGraph.initSync(dir, {
      config: { include: ['**/*.ts', '**/*.js'], exclude: [] },
    });
    await cg.indexAll();

    expect(callersOf('fromJs')).toContain('consumerFn');
    expect(callersOf('fromTs')).not.toContain('consumerFn');
  });
});
