/**
 * A full index hands the resolver pool's workers the frameworks the main thread
 * detected, so they don't each read the project again. What a worker gets from
 * those names has to be what detecting would have given it.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { ReferenceResolver } from '../src/resolution';

describe('ReferenceResolver.initialize with detected frameworks', () => {
  let root: string;
  let cg: CodeGraph;
  const queries = (): ConstructorParameters<typeof ReferenceResolver>[1] => (cg as unknown as { queries: ConstructorParameters<typeof ReferenceResolver>[1] }).queries;

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-shared-frameworks-'));
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ dependencies: { express: '^4.0.0', react: '^18.0.0' } }));
    fs.mkdirSync(path.join(root, 'src'));
    fs.writeFileSync(path.join(root, 'src/app.ts'), "import express from 'express';\nexport const app = express();\n");
    fs.writeFileSync(path.join(root, 'src/Widget.java'), '@RestController\nclass Widget {}\n');
    cg = await CodeGraph.init(root, { index: true });
  });

  afterEach(() => {
    cg.destroy();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('gives a worker what detection gives it, in the same order', () => {
    const detected = new ReferenceResolver(root, queries());
    detected.initialize();
    const names = detected.getDetectedFrameworks();
    expect(names).toEqual(expect.arrayContaining(['express', 'spring']));

    const worker = new ReferenceResolver(root, queries());
    worker.initialize([...names].reverse());
    expect(worker.getDetectedFrameworks()).toEqual(names);
  });

  it('takes an empty list as none, rather than detecting', () => {
    const worker = new ReferenceResolver(root, queries());
    worker.initialize([]);
    expect(worker.getDetectedFrameworks()).toEqual([]);
  });
});
