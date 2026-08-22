import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { CodeGraph } from '../src';

/**
 * #841 — React components declared via an HOC wrapper
 * (`const Button = forwardRef(...)`, `memo(...)`, `styled.x\`…\``) were indexed
 * as plain `constant` nodes, so their JSX usages (`<Button/>`) got no render
 * edge and `getCallers` / `getImpactRadius` returned empty — a dangerous silent
 * false negative for every shadcn/ui-style design system. They must now be
 * `component` nodes that receive jsx-render edges like function components do.
 */
describe('React HOC-wrapped component recognition (#841)', () => {
  let dir: string;
  let cg: any;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'react-hoc-'));
    fs.writeFileSync(path.join(dir, 'package.json'), '{"dependencies":{"react":"^18.0.0"}}');
  });

  afterEach(() => {
    cg?.close?.();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  async function index() {
    cg = await CodeGraph.init(dir, { silent: true });
    await cg.indexAll();
    return (cg as any).db.db;
  }

  const kindsOf = (db: any, name: string): string[] =>
    db
      .prepare('SELECT kind FROM nodes WHERE name=? ORDER BY kind')
      .all(name)
      .map((r: any) => r.kind);

  it('classifies forwardRef / memo / styled consts as component nodes (not constant)', async () => {
    fs.writeFileSync(
      path.join(dir, 'ui.tsx'),
      `import * as React from 'react';
import styled from 'styled-components';
export const Button = React.forwardRef<HTMLButtonElement, {}>((props, ref) => <button ref={ref} {...props} />);
export const Bare = forwardRef((props, ref) => <span ref={ref} />);
export const Card = memo((props: { t: string }) => <div>{props.t}</div>);
export const Named = memo(function Named(props: { t: string }) { return <div>{props.t}</div>; });
export const Boxed = styled.div\`color: red;\`;
export const Wrapped = styled(Button)\`padding: 4px;\`;
export const Rewrapped = memo(Button);
`
    );
    const db = await index();
    for (const name of ['Button', 'Bare', 'Card', 'Named', 'Boxed', 'Wrapped', 'Rewrapped']) {
      expect(kindsOf(db, name), `${name} should be a component`).toContain('component');
      // The bug was that these stayed plain constants.
      expect(kindsOf(db, name), `${name} should not remain a constant`).not.toContain('constant');
    }
  });

  it('emits jsx-render edges so getCallers/getImpactRadius resolve a forwardRef component', async () => {
    fs.writeFileSync(
      path.join(dir, 'button.tsx'),
      `import * as React from 'react';
export const Button = React.forwardRef<HTMLButtonElement, {}>((props, ref) => <button ref={ref} {...props} />);
`
    );
    fs.writeFileSync(
      path.join(dir, 'page.tsx'),
      `import { Button } from './button';
export function Page() {
  return <Button>Click</Button>;
}
`
    );
    const db = await index();

    // The render edge exists and is the synthesized jsx-render kind.
    const edgeRows = db
      .prepare(
        `SELECT s.name caller FROM edges e
         JOIN nodes s ON s.id = e.source
         JOIN nodes t ON t.id = e.target
         WHERE json_extract(e.metadata, '$.synthesizedBy') = 'jsx-render'
           AND t.kind = 'component' AND t.name = 'Button'`
      )
      .all();
    expect(edgeRows.map((r: any) => r.caller)).toContain('Page');

    // ...and it surfaces through the public callers API (the issue's symptom:
    // "No callers found" before the fix).
    const buttonId = db
      .prepare("SELECT id FROM nodes WHERE name='Button' AND kind='component'")
      .get().id as string;
    const callers = cg.getCallers(buttonId).map((c: any) => c.node.name);
    expect(callers).toContain('Page');
  });

  it('captures the inner render-fn body callees under the component', async () => {
    fs.writeFileSync(
      path.join(dir, 'widget.tsx'),
      `import * as React from 'react';
function useThing() { return 1; }
export const Widget = React.forwardRef((props, ref) => {
  const v = useThing();
  return <div ref={ref}>{v}</div>;
});
`
    );
    const db = await index();
    const rows = db
      .prepare(
        `SELECT t.name FROM edges e
         JOIN nodes s ON s.id = e.source
         JOIN nodes t ON t.id = e.target
         WHERE s.name = 'Widget' AND s.kind = 'component'
           AND e.kind = 'calls' AND t.name = 'useThing'`
      )
      .all();
    expect(rows.length).toBeGreaterThanOrEqual(1);
  });

  it('does not misclassify non-component PascalCase consts (precision)', async () => {
    fs.writeFileSync(
      path.join(dir, 'controls.tsx'),
      `import * as React from 'react';
const cache = memo(expensiveFn);
export const Config = loadConfig();
export const Client = new ApiClient();
export const Styles = styledHelper();
export const Total = [1, 2].reduce((a, b) => a + b, 0);
export const Theme = { color: 'red' };
`
    );
    const db = await index();
    for (const name of ['Config', 'Client', 'Styles', 'Total', 'Theme']) {
      expect(kindsOf(db, name), `${name} must stay a constant`).toContain('constant');
      expect(kindsOf(db, name), `${name} must not be a component`).not.toContain('component');
    }
    // A lowercase-named memo() result is a memoization util, not a component.
    expect(kindsOf(db, 'cache')).not.toContain('component');
  });
});
