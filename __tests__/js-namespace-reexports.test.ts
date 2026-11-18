/**
 * JS/TS module namespaces handed on by name, and `export *` barrels:
 * - a name a module exports as a module namespace — `export * as ns3 from
 *   './schemas'`, or zod's `import * as z from './external'; export { z }` —
 *   is that module where another file imports it by name, so `z.ipv4()`
 *   after `import { z } from './index'` is the module's `ipv4`, as after
 *   `import * as z` (#2951);
 * - through a barrel of several `export *` lines, a module's own export of a
 *   name answers before a member of an object another module exports, in
 *   whichever order the lines come (#3233).
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';

let tempDir: string;
let cg: CodeGraph | null = null;

async function index(files: Record<string, string>): Promise<void> {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-ns-reexport-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(tempDir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  cg = await CodeGraph.init(tempDir, { index: true });
}

/** The calls made by the function with this name, as `kind qualifiedName (file:line)`. */
function callsFrom(name: string): string[] {
  const from = cg!.getNodesByKind('function').find((n) => n.name === name);
  expect(from, `${name} should be indexed`).toBeDefined();
  return cg!.getOutgoingEdges(from!.id).filter((e) => e.kind === 'calls')
    .map((e) => { const t = cg!.getNode(e.target)!; return `${t.kind} ${t.qualifiedName} (${t.filePath}:${t.startLine})`; })
    .sort();
}

afterEach(() => {
  cg?.close();
  cg = null;
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
});

const SCHEMAS = {
  'schemas.ts':
    'export interface ZodString { ipv4(): this; nope(): this; }\n' +
    'export function ipv4(): ZodString { return null as any; }\n',
  'external.ts': 'export * from "./schemas.js";\n',
  'index.ts': 'import * as z from "./external.js";\nexport { z };\n',
  'index2.ts': 'import * as ns from "./schemas.js";\nexport { ns };\n',
  'index3.ts': 'export * as ns3 from "./schemas.js";\n',
  'outer.ts': 'export { z } from "./index.js";\n',
};

describe('a module namespace imported by name (#2951)', () => {
  it('is the module, as a namespace import of it is', async () => {
    await index({
      ...SCHEMAS,
      'b.ts': 'import * as z from "./external.js";\nexport function fb() { z.ipv4(); }\n',
      'a.ts': 'import { z } from "./index.js";\nexport function fa() { z.ipv4(); }\n',
      'c.ts': 'import { ns } from "./index2.js";\nexport function fc() { ns.ipv4(); }\n',
      'd.ts': 'import { ns3 } from "./index3.js";\nexport function fd() { ns3.ipv4(); }\n',
      'e.ts': 'import { z } from "./outer.js";\nexport function fe() { z.ipv4(); }\n',
    });
    for (const fn of ['fb', 'fa', 'fc', 'fd', 'fe']) {
      expect(callsFrom(fn), fn).toEqual(['function ipv4 (schemas.ts:2)']);
    }
  });

  it('links no method of another type to a member the module does not export', async () => {
    await index({
      ...SCHEMAS,
      'a.ts': 'import { z } from "./index.js";\nexport function fa() { z.nope(); }\n',
    });
    expect(callsFrom('fa')).toEqual([]);
  });
});

const FX = {
  'fx/deaf.ts': 'export const DEAF = {\n  log: async () => undefined,\n  mark: async () => undefined,\n}\n',
  'fx/mark.ts': 'export const mark = (entry: unknown): string => String(entry)\n',
};

describe('an export * barrel (#3233)', () => {
  it('answers with a module\'s own export before an object\'s same-named method', async () => {
    await index({
      ...FX,
      'fx/index.ts': "export * from './deaf.js'\nexport * from './mark.js'\n",
      'c.ts': "import { mark } from './fx'\nexport function useNamed() { return mark(1) }\n",
      'd.ts': "import * as NS from './fx'\nexport function useNs() { return NS.mark(1) }\n",
    });
    expect(callsFrom('useNamed')).toEqual(['function mark (fx/mark.ts:1)']);
    expect(callsFrom('useNs')).toEqual(['function mark (fx/mark.ts:1)']);
  });

  it('does so through `export * as default from` a barrel of itself', async () => {
    await index({
      ...FX,
      'fx/index.ts': "export * from './deaf.js'\nexport * from './mark.js'\nexport * as default from '.'\n",
      'e.ts': "import Fixtures from './fx'\nexport function useDefault() { return Fixtures.mark(1) }\n",
    });
    expect(callsFrom('useDefault')).toEqual(['function mark (fx/mark.ts:1)']);
  });

  it('still answers with a member when no module exports the name itself', async () => {
    await index({
      'fx/deaf.ts': 'export const DEAF = {\n  mark: async () => undefined,\n}\nexport const { mark } = DEAF\n',
      'fx/log.ts': 'export const log = (s: string): void => {}\n',
      'fx/index.ts': "export * from './log.js'\nexport * from './deaf.js'\n",
      'c.ts': "import { mark } from './fx'\nexport function useNamed() { return mark(1) }\n",
    });
    expect(callsFrom('useNamed')).toEqual(['function DEAF::mark (fx/deaf.ts:2)']);
  });
});
