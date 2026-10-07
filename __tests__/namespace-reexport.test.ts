/**
 * `export * as core from './core'` exports `core` — not every member of
 * `./core` as if it were `export *`. Read as a wildcard, zod's
 * `z.number()` walked into core and on into `export * as regexes`, landing
 * on the `number` regex constant (262 `z.string()` calls did the same); the
 * schema function it means sits in a LATER `export * from './schemas'`.
 * `z.core.safeParse()` continues into the namespaced module, and a member a
 * barrel forwards by name (`export { safeParse } from '../core'`) is found
 * for `import * as m` too.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

let root = '';
let cg: CodeGraph;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-ns-reexport-'));
  const files: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'schema', private: true }),
    'src/core/regexes.ts': `export const number = /^-?\\d+$/;
`,
    'src/core/parse.ts': `export function safeParse(value: unknown) {
  return { success: true, data: value };
}
`,
    'src/core/api.ts': `export function _lt(limit: number) {
  return limit;
}
`,
    'src/core/index.ts': `export * as regexes from "./regexes.js";
export * from "./parse.js";
export * from "./api.js";
`,
    'src/classic/schemas.ts': `export function number() {
  return { kind: "number" };
}
`,
    'src/classic/external.ts': `export * as core from "../core/index.js";
export * from "./schemas.js";
export { _lt as lt } from "../core/index.js";
`,
    'src/mini/parse.ts': `export { safeParse } from "../core/index.js";
`,
    'src/mini/external.ts': `export * as core from "../core/index.js";
export * from "./parse.js";
`,
    'src/tests/classic.test.ts': `import * as z from "../classic/external.js";

export function classic() {
  z.number();
  z.lt(10);
  z.core.safeParse(1);
}
`,
    'src/tests/mini.test.ts': `import * as m from "../mini/external.js";

export function mini() {
  m.safeParse(1);
}
`,
  };
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  cg = await CodeGraph.init(root, { index: true });
});

afterAll(() => {
  cg?.close();
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

/** `file: qualified name` of every call edge out of a file. */
function callsFrom(file: string): string[] {
  const ids = cg.getNodesInFile(file).map((n) => n.id);
  return cg
    .getOutgoingEdgesFrom(ids)
    .filter((e) => e.kind === 'calls')
    .map((e) => {
      const t = cg.getNode(e.target)!;
      return `${t.filePath}: ${t.qualifiedName}`;
    })
    .sort();
}

describe('`export * as ns` re-exports', () => {
  it('export the namespace only, so a later `export *` supplies the member', () => {
    expect(callsFrom('src/tests/classic.test.ts')).toEqual([
      'src/classic/schemas.ts: number',
      'src/core/api.ts: _lt',
      'src/core/parse.ts: safeParse',
    ]);
  });

  it('find a member a barrel forwards by name for a namespace import', () => {
    expect(callsFrom('src/tests/mini.test.ts')).toEqual(['src/core/parse.ts: safeParse']);
  });
});
