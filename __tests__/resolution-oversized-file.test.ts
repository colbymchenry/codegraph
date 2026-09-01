/**
 * Resolution-side oversized-file guard.
 *
 * Pins the contract that reference resolution treats files larger than
 * extraction's MAX_FILE_SIZE exactly like extraction does: invisible.
 * Asset imports (`import video from "./intro.mp4"`, aliased or relative)
 * hand the resolver a verbatim path to a file extraction never parsed —
 * it can't contain resolvable symbols, but the import/re-export chase
 * used to `readFileSync` it whole, decode it as UTF-8, and regex-scan
 * it. On a real project a single ~240 MB video import OOM'd an 8 GB heap
 * at "Resolving refs" ~65%, killing every `codegraph init`.
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

describe('resolution skips oversized import targets', () => {
  let tmpDir: string | undefined;
  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  });

  it('does not chase re-exports through a barrel extraction skipped for size', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-bigbarrel-'));
    fs.mkdirSync(path.join(tmpDir, 'src'));

    fs.writeFileSync(
      path.join(tmpDir, 'src/real.ts'),
      'export function play(): number {\n  return 1;\n}\n'
    );

    // A syntactically valid barrel pushed over MAX_FILE_SIZE by padding.
    // Extraction skips it (too big), so resolution must not read it either
    // — chasing its re-export would resolve through a file the graph
    // doesn't contain, and reading arbitrarily large targets is the OOM.
    const padding = `// ${'x'.repeat(120)}\n`.repeat(9000); // ~1.1 MB
    fs.writeFileSync(
      path.join(tmpDir, 'src/barrel.ts'),
      `export { play as video } from "./real";\n${padding}`
    );

    fs.writeFileSync(
      path.join(tmpDir, 'src/app.ts'),
      'import { video } from "./barrel";\n' +
        'export function run(): number {\n' +
        '  return video();\n' +
        '}\n'
    );

    const cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();

    // Sanity: the small files are in the graph, the oversized barrel is not.
    const fns = cg.getNodesByKind('function');
    const play = fns.find((n) => n.name === 'play');
    const run = fns.find((n) => n.name === 'run');
    expect(play).toBeDefined();
    expect(run).toBeDefined();
    expect(cg.getNodesInFile('src/barrel.ts')).toHaveLength(0);

    // The chase must stop at the oversized barrel: no call edge may reach
    // play() — resolving run()'s `video()` there requires reading
    // barrel.ts's content. (The structural `contains` edge from real.ts
    // itself is expected.)
    const playCalls = cg.getIncomingEdges(play!.id).filter((e) => e.kind === 'calls');
    expect(playCalls).toHaveLength(0);
  });

  it('indexes a project importing a >1MB binary asset without dying', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-bigasset-'));
    fs.mkdirSync(path.join(tmpDir, 'src'));

    // Pseudo-binary garbage over MAX_FILE_SIZE. (The real-world trigger
    // was a 240 MB .mp4; the guard threshold is what matters, not scale.)
    fs.writeFileSync(path.join(tmpDir, 'src/intro.mp4'), Buffer.alloc(2 * 1024 * 1024, 0xfe));

    fs.writeFileSync(
      path.join(tmpDir, 'src/app.ts'),
      'import video from "./intro.mp4";\n' +
        'export function play(): string {\n' +
        '  return video;\n' +
        '}\n'
    );

    const cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();

    const fns = cg.getNodesByKind('function');
    expect(fns.find((n) => n.name === 'play')).toBeDefined();
  });
});
