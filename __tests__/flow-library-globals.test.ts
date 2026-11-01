/**
 * A Flow library definition declares globals. `flow-typed/environments/streams.js`
 * is a `.js` script of `declare class ReadableStream { … }` lines, and the `[libs]`
 * of a flowconfig are the same, so `stream: ReadableStream` in a file Flow checks
 * names that class though no import does. #2736 kept such a name to declaration
 * files and `declare global` blocks, which a `.js` file isn't, and react lost
 * every type reference into its Flow libraries.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

let root = '';
let cg: CodeGraph;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-flow-libs-'));
  const files: Record<string, string> = {
    'flow-typed/environments/streams.js': `declare class ReadableStream {
  locked: boolean;
}
declare module 'fsx' {
  declare module.exports: { read(): void };
}
`,
    'scripts/flow/environment.js': `/* @flow */
declare interface ConsoleTask {
  run<T>(f: () => T): T;
}
`,
    'src/other.js': 'export function other(a: any) { return a; }\n',
    'src/client.js': `// @flow
import {other} from './other';
export function start(stream: ReadableStream, task: ConsoleTask): void {
  other(stream);
  other(task);
}
`,
    'ts/client.ts': `import { other } from '../src/other';
export function typed(stream: ReadableStream): void {
  other(stream);
}
`,
    // No `declare` anywhere: a sample's script, global to its own program.
    'src/sample.js': 'class Sample {}\n',
    'src/uses-sample.js': `import {other} from './other';
export function sampled(x: Sample) { return other(x); }
`,
  };
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  cg = await CodeGraph.init(root, { index: true });
});

afterAll(() => {
  cg.close();
  fs.rmSync(root, { recursive: true, force: true });
});

const typeRefs = (name: string): string[] => cg.getOutgoingEdges(cg.getNodesByName(name)[0]!.id)
  .filter((e) => e.kind === 'references')
  .map((e) => `${cg.getNode(e.target)!.filePath}:${cg.getNode(e.target)!.name}`)
  .sort();

describe('a Flow library definition', () => {
  it('declares the types a Flow file names without importing them', () => {
    expect(typeRefs('start')).toEqual([
      'flow-typed/environments/streams.js:ReadableStream',
      'scripts/flow/environment.js:ConsoleTask',
    ]);
  });

  it('is no global of a TypeScript file', () => {
    expect(typeRefs('typed')).toEqual([]);
  });

  it('is told from a script that declares nothing', () => {
    expect(typeRefs('sampled')).toEqual([]);
  });
});
