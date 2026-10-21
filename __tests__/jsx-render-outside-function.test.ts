import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { CodeGraph } from '../src';

/**
 * JSX written outside a named function, method or component (#2587): in an
 * entry file's `createRoot(el).render(<App />)`, a top-level
 * `const ICONS = { a: <Icon /> }`, or a test's `it('…', () => render(<Card />))`.
 * A plain call in those places is attributed to the file node or the `const`;
 * a tag is attributed the same way.
 */
describe('JSX outside a named function (#2587)', () => {
  let dir: string;
  let cg: any;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsx-outside-'));
    fs.writeFileSync(path.join(dir, 'package.json'), '{"dependencies":{"react":"^18.0.0"}}');
  });

  afterEach(() => {
    cg?.close?.();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const write = (rel: string, body: string) => {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
  };

  /** Every jsx-render edge, as `source kind:name@file -> target name@file`. */
  async function renders(): Promise<string[]> {
    cg = await CodeGraph.init(dir, { silent: true });
    await cg.indexAll();
    const db = (cg as any).db.db;
    return db
      .prepare(
        `SELECT s.kind || ':' || s.name || '@' || s.file_path || ' -> ' || t.name || '@' || t.file_path AS e
           FROM edges e JOIN nodes s ON s.id = e.source JOIN nodes t ON t.id = e.target
          WHERE json_extract(e.metadata, '$.synthesizedBy') = 'jsx-render' ORDER BY e`
      )
      .all()
      .map((r: any) => r.e);
  }

  const CARD = [
    'export function Card() { return <div>card</div>; }',
    'export function Icon() { return <svg />; }',
    'export function Cell() { return <td />; }',
    '',
  ].join('\n');

  it('links a tag at module scope from the file', async () => {
    write('src/Card.tsx', CARD);
    write('src/main.tsx', [
      'import { createRoot } from "react-dom/client";',
      'import { Card } from "./Card";',
      'createRoot(document.getElementById("root")!).render(<Card />);',
      '',
    ].join('\n'));
    expect(await renders()).toEqual(['file:main.tsx@src/main.tsx -> Card@src/Card.tsx']);
  });

  it('links a tag in a top-level const from the const', async () => {
    write('src/Card.tsx', CARD);
    write('src/icons.tsx', [
      'import { Icon } from "./Card";',
      'export const ICONS = {',
      '  a: <Icon />,',
      '};',
      '',
    ].join('\n'));
    const out = await renders();
    expect(out).toHaveLength(1);
    expect(out[0]).toMatch(/^(constant|variable):ICONS@src\/icons\.tsx -> Icon@src\/Card\.tsx$/);
  });

  it('links a tag in a test callback from the file', async () => {
    write('src/Card.tsx', CARD);
    write('src/Card.test.tsx', [
      'import { it } from "vitest";',
      'import { render } from "@testing-library/react";',
      'import { Card } from "./Card";',
      'it("renders", () => {',
      '  render(<Card />);',
      '});',
      '',
    ].join('\n'));
    expect(await renders()).toEqual(['file:Card.test.tsx@src/Card.test.tsx -> Card@src/Card.tsx']);
  });

  it('keeps a tag inside a function on that function only', async () => {
    write('src/Card.tsx', CARD);
    write('src/Table.tsx', [
      'import { Cell, Card } from "./Card";',
      'export const Row = () => <Cell />;',
      'export function Table() {',
      '  return <Card />;',
      '}',
      'export const ROWS = [1].map(() => <Row />);',
      '',
    ].join('\n'));
    const out = await renders();
    expect(out).toContain('function:Table@src/Table.tsx -> Card@src/Card.tsx');
    expect(out.filter((e) => e.startsWith('file:'))).toEqual([]);
    expect(out.filter((e) => e.endsWith('-> Cell@src/Card.tsx'))).toHaveLength(1);
    expect(out.filter((e) => e.endsWith('-> Card@src/Card.tsx'))).toHaveLength(1);
  });

  it('links an entry whose tags share lines with router routes', async () => {
    write('src/Card.tsx', CARD);
    write('src/main.tsx', [
      'import { createRoot } from "react-dom/client";',
      'import { BrowserRouter, Routes, Route } from "react-router-dom";',
      'import { Card, Icon } from "./Card";',
      'createRoot(document.getElementById("root")!).render(',
      '  <BrowserRouter>',
      '    <Routes>',
      '      <Route path="/" element={<Card />} />',
      '      <Route path="/icon" element={<Icon />} />',
      '    </Routes>',
      '  </BrowserRouter>',
      ');',
      '',
    ].join('\n'));
    expect(await renders()).toEqual([
      'file:main.tsx@src/main.tsx -> Card@src/Card.tsx',
      'file:main.tsx@src/main.tsx -> Icon@src/Card.tsx',
    ]);
  });

  it('is not shadowed by a parameter of another function, or by its own import', async () => {
    write('src/Card.tsx', CARD);
    write('src/Card.test.tsx', [
      'import { it } from "vitest";',
      'import { render } from "@testing-library/react";',
      'import { Icon, Card, Cell } from "./Card";',
      'function wrap(Card: any) { return Card; }',
      'it("renders", () => {',
      '  render(<Card />);',
      '});',
      '',
    ].join('\n'));
    expect((await renders()).filter((e) => e.startsWith('file:'))).toEqual([
      'file:Card.test.tsx@src/Card.test.tsx -> Card@src/Card.tsx',
    ]);
  });

  it('does not link a name a test callback binds itself', async () => {
    write('src/Card.tsx', CARD);
    write('src/Card.test.tsx', [
      'import { it, vi } from "vitest";',
      'import { render } from "@testing-library/react";',
      'it("renders a stub", () => {',
      '  const Card = vi.fn(() => null);',
      '  render(<Card />);',
      '});',
      '',
    ].join('\n'));
    expect(await renders()).toEqual([]);
  });

  it('gives a line two top-level values share to neither', async () => {
    write('src/Card.tsx', CARD);
    write('src/icons.tsx', [
      'import { Icon, Cell } from "./Card";',
      'export const a = <Icon />, b = <Cell />;',
      '',
    ].join('\n'));
    expect(await renders()).toEqual([]);
  });

  it('does not credit a value with a statement written after it on its line', async () => {
    write('src/Card.tsx', CARD);
    write('src/main.tsx', [
      'import { createRoot } from "react-dom/client";',
      'import { Card } from "./Card";',
      'const root = createRoot(document.body); root.render(<Card />);',
      '',
    ].join('\n'));
    expect((await renders()).filter((e) => e.includes(':root@'))).toEqual([]);
  });

  it('links every entry of an icon map keyed by component name', async () => {
    write('src/Card.tsx', CARD);
    write('src/icons.tsx', [
      'import { Icon, Cell } from "./Card";',
      'export const ICONS = {',
      '  Icon: <Icon />,',
      '  Cell: <Cell />,',
      '};',
      '',
    ].join('\n'));
    expect((await renders()).map((e) => e.replace(/^\w+:/, ''))).toEqual([
      'ICONS@src/icons.tsx -> Cell@src/Card.tsx',
      'ICONS@src/icons.tsx -> Icon@src/Card.tsx',
    ]);
  });

  it('links a component a test also passes as a value', async () => {
    write('src/Card.tsx', CARD);
    write('src/Card.test.tsx', [
      'import { it, expect } from "vitest";',
      'import { render } from "@testing-library/react";',
      'import { Card } from "./Card";',
      'expect(Card).toBeDefined();',
      'it("renders", () => render(<Card />));',
      '',
    ].join('\n'));
    expect(await renders()).toEqual(['file:Card.test.tsx@src/Card.test.tsx -> Card@src/Card.tsx']);
  });

  it.each([
    ['a block comment before it', '/* note */ export const A = <Icon />;\n'],
    ['a block comment after it', 'export const A = <Icon />; /* x */\n'],
    ['a line comment and CRLF', 'export const A = <Icon />; // the icon\r\n'],
  ])('keeps a value its own line with %s', async (_label, line) => {
    write('src/Card.tsx', CARD);
    write('src/a.tsx', `import { Icon } from "./Card";\n${line}`);
    expect((await renders()).map((e) => e.replace(/^\w+:/, ''))).toEqual(['A@src/a.tsx -> Icon@src/Card.tsx']);
  });

  it('does not attribute a class field tag to the file', async () => {
    write('src/Card.tsx', CARD);
    write('src/Panel.tsx', [
      'import { Icon } from "./Card";',
      'export class Panel {',
      '  static icon = <Icon />;',
      '}',
      '',
    ].join('\n'));
    expect((await renders()).filter((e) => e.startsWith('file:'))).toEqual([]);
  });
});
