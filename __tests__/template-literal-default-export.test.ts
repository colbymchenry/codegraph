/**
 * A template literal containing the text `export default NAME` must not be read
 * as the file's default export (issue #2968). The template is only text; a
 * real `export default` elsewhere in the file owns the default.
 *
 * A template whose `${…}` interpolation holds a nested template (`\`a${\`b\`}c\``)
 * puts the comment-stripping masker out of step, so the `export default NAME`
 * text inside it survives and is scanned as a candidate statement. It names a
 * node of the file, so it used to win the scan and hide the real default. The
 * fix ignores a candidate written inside a function or a value — where a
 * literal, never a real module-scope statement, sits.
 *
 * A plain string literal writes the same text with no masker desync, so it is
 * already safe; `(c)` pins that.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

let root = '';
let cg: CodeGraph;

const files: Record<string, string> = {
  // (a) template inside a function, before a real export default class.
  'src/in-function.ts':
    'export const helper = () => 1\n' +
    '\n' +
    'function makeDoc() {\n' +
    '  return `intro ${`nested`} tail\n' +
    'export default helper\n' +
    '`\n' +
    '}\n' +
    '\n' +
    'export default class InFunction {\n' +
    '  run() {\n' +
    '    return helper()\n' +
    '  }\n' +
    '}\n',
  // (b) template at top level inside a const, before a real export default class.
  'src/in-const.ts':
    'export const helper = () => 1\n' +
    '\n' +
    'const doc = `intro ${`nested`} tail\n' +
    'export default helper\n' +
    '`\n' +
    '\n' +
    'export default class InConst {\n' +
    '  run() {\n' +
    '    return helper()\n' +
    '  }\n' +
    '}\n',
  // (c) plain string literal (double-quoted) containing "export default helper".
  'src/plain-string.ts':
    'export const helper = () => 1\n' +
    '\n' +
    'const note = "introduced by: export default helper"\n' +
    '\n' +
    'export default class PlainString {\n' +
    '  run() {\n' +
    '    return helper()\n' +
    '  }\n' +
    '}\n',
  'src/use.ts':
    'import Thing1 from "./in-function"\n' +
    'import Thing2 from "./in-const"\n' +
    'import Thing3 from "./plain-string"\n' +
    '\n' +
    'export function consume() {\n' +
    '  new Thing1().run()\n' +
    '  new Thing2().run()\n' +
    '  new Thing3().run()\n' +
    '}\n',
};

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-template-default-'));
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

function instantiatesFrom(file: string): string[] {
  const consume = cg.getNodesInFile(file).find((n) => n.name === 'consume')!;
  return cg
    .getOutgoingEdges(consume.id)
    .filter((e) => e.kind === 'instantiates')
    .map((e) => cg.getNode(e.target)!)
    .map((n) => `${n.filePath}:${n.name}`);
}

describe('a template literal that mentions `export default NAME`', () => {
  it('(a) template inside a function is not taken as default; real class later is', () => {
    const t = instantiatesFrom('src/use.ts');
    expect(t).toContain('src/in-function.ts:InFunction');
    expect(t).not.toContain('src/in-function.ts:helper');
  });
  it('(b) template at top level inside a const is not taken as default', () => {
    const t = instantiatesFrom('src/use.ts');
    expect(t).toContain('src/in-const.ts:InConst');
    expect(t).not.toContain('src/in-const.ts:helper');
  });
  it('(c) plain string literal is not taken as default (expected: unaffected)', () => {
    const t = instantiatesFrom('src/use.ts');
    expect(t).toContain('src/plain-string.ts:PlainString');
    expect(t).not.toContain('src/plain-string.ts:helper');
  });
});
