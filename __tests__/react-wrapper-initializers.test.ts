import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { CodeGraph } from '../src';
import { ToolHandler } from '../src/mcp/tools';
import { resetKernelForTests } from '../src/extraction/kernel';

/**
 * A React component declared through a wrapper with no render function of its
 * own — `styled.div\`…\``, outline's `styled(ActionButton).attrs(…)<Props>\`…\``,
 * MUI's `styled(Box)(({ theme }) => …)`, `memo(Button)` — is a `component` node
 * (#841, #2429) that nothing walked: the calls in its template's
 * interpolations went nowhere, where a plain `const X = …` attributes them to X
 * (#693), and nothing linked it to the component it wraps, so a render flow
 * Page → NudeButton → ActionButton stopped at NudeButton.
 *
 * Now the initializer is walked under the component, minus the wrapper's own
 * chain (`styled`, `styled.div`, `.attrs`, `memo`: the library, which no project
 * code answers), and the wrapped component is what the wrapper renders: a
 * `jsx-render` hop bound as a tag of that name in the file would be, so a
 * package's `styled(Link)` renders no project `Link`. Both engines.
 */

const KERNEL_PATH = path.join(
  __dirname,
  '..',
  'codegraph-kernel',
  'prebuilds',
  `${process.platform}-${process.arch}`,
  'codegraph-kernel.node'
);
const kernelBuilt = fs.existsSync(KERNEL_PATH) || process.env.CODEGRAPH_KERNEL_EXPECT === '1';
const ENGINES = [
  { engine: 'wasm', kernel: '0' as string | undefined },
  ...(kernelBuilt ? [{ engine: 'kernel', kernel: undefined as string | undefined }] : []),
];

const FILES: Record<string, string> = {
  'package.json': JSON.stringify({
    dependencies: { react: '^18.0.0', 'styled-components': '^6.0.0', 'react-router-dom': '^6.0.0', antd: '^5.0.0' },
  }),
  'theme.ts': `export function s(key: string) { return key; }
export function breakpoint(size: string) { return (strings: TemplateStringsArray) => size + strings.join(''); }
export function labelFor(props: unknown) { return String(props); }
export function areEqual(a: unknown, b: unknown) { return a === b; }
export function pickColor(theme: unknown) { return String(theme); }
`,
  'ActionButton.tsx': `export default function ActionButton(props: { title?: string }) {
  return <button>{props.title}</button>;
}
`,
  // A project namesake of react-router's Link: what styled(Link) must not render.
  'Link.tsx': `export function Link(props: { to: string }) {
  return <a href={props.to} />;
}
`,
  // Namesakes a guess would take for names the wrappers below don't bind to them.
  'other.tsx': `import styled from 'styled-components';
export const Icon = styled.i\`\`;
export const Text = styled.span\`\`;
`,
  // A base imported through a path nothing resolves (a Meteor app's
  // `/imports/…`), and one the file destructures from a library.
  'unbound.tsx': `import styled from 'styled-components';
import Icon from '/imports/ui/components/icon/component';
import { Typography } from 'antd';
const { Text } = Typography;
export const BigIcon = styled(Icon)\`\`;
export const StyledText = styled(Text)\`\`;
`,
  'ui.tsx': `import styled, { css } from 'styled-components';
import { Link } from 'react-router-dom';
import { memo } from 'react';
import ActionButton from './ActionButton';
import { s, breakpoint, labelFor, areEqual, pickColor } from './theme';

type Props = { active: boolean };
const BASE_CSS = css\`color: red;\`;

export const Plain = styled.div\`
  color: \${(p) => s('accent')};
  \${BASE_CSS}
  \${breakpoint('tablet')\`padding: 0;\`}
\`;
export const NudeButton = styled(ActionButton).attrs((props: Props) => ({ title: labelFor(props) }))<Props>\`
  width: \${(props) => s('width')};
\`;
export const Root = styled(ActionButton)(({ theme }) => ({ color: pickColor(theme) }));
export const Memoized = memo(ActionButton, areEqual);
const Box = styled.div\`\`;
export const Card = styled(Box)\`\`;
export const StyledLink = styled(Link)\`\`;
`,
  // A styles file: TypeScript, no markup of its own.
  'styles.ts': `import styled from 'styled-components';
import ActionButton from './ActionButton';
export const Panel = styled(ActionButton)\`margin: 0;\`;
`,
  // A wrapper of an element only, in a file no synthesis pass reads yet.
  'bare.ts': `import styled from 'styled-components';
import ActionButton from './ActionButton';
export const Bare = styled.div\`margin: 0;\`;
`,
  'Page.tsx': `import { NudeButton } from './ui';
export function Page() {
  return <NudeButton active />;
}
`,
};

describe.each(ENGINES)('a wrapper component walks its initializer and renders what it wraps ($engine)', ({ kernel }) => {
  let dir: string;
  let cg: any;
  let saved: string | undefined;

  beforeEach(() => {
    saved = process.env.CODEGRAPH_KERNEL;
    if (kernel === undefined) delete process.env.CODEGRAPH_KERNEL;
    else process.env.CODEGRAPH_KERNEL = kernel;
    resetKernelForTests();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'react-wrap-'));
    for (const [file, text] of Object.entries(FILES)) fs.writeFileSync(path.join(dir, file), text);
  });

  afterEach(() => {
    cg?.close?.();
    cg = undefined;
    if (saved === undefined) delete process.env.CODEGRAPH_KERNEL;
    else process.env.CODEGRAPH_KERNEL = saved;
    resetKernelForTests();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  async function index() {
    cg = await CodeGraph.init(dir, { silent: true });
    await cg.indexAll();
    return (cg as any).db.db;
  }

  /** `kind` edges from a component to a node, as `Source>target`. */
  const edgesFrom = (db: any, kind: string, where = '1=1'): string[] =>
    db
      .prepare(
        `SELECT s.name src, t.name dst FROM edges e
         JOIN nodes s ON s.id = e.source JOIN nodes t ON t.id = e.target
         WHERE e.kind = ? AND s.kind = 'component' AND ${where}
         ORDER BY s.name, t.name`
      )
      .all(kind)
      .map((r: any) => `${r.src}>${r.dst}`);

  it('attributes the calls and values in its template, attrs and style function to the component', async () => {
    const db = await index();
    const calls = new Set(edgesFrom(db, 'calls', "json_extract(e.metadata, '$.synthesizedBy') IS NULL"));
    for (const edge of ['Plain>s', 'Plain>breakpoint', 'NudeButton>labelFor', 'NudeButton>s', 'Root>pickColor']) {
      expect(calls, edge).toContain(edge);
    }
    // The style function MUI hands the wrapper is the component's code, not a
    // function of its own named for the declarator.
    expect(db.prepare("SELECT kind FROM nodes WHERE name = 'Root'").all().map((r: any) => r.kind)).toEqual(['component']);
    // A file-scope value the template reads, and a memo comparator passed by name.
    expect(edgesFrom(db, 'references', "json_extract(e.metadata, '$.valueRef') = 1")).toContain('Plain>BASE_CSS');
    expect(edgesFrom(db, 'references', "json_extract(e.metadata, '$.fnRef') = 1")).toEqual(['Memoized>areEqual']);
  });

  it('records none of the wrapper machinery, and no function-as-value reference to the wrapped component', async () => {
    const db = await index();
    const fromComponents = db
      .prepare(
        `SELECT r.reference_name name FROM unresolved_refs r JOIN nodes n ON n.id = r.from_node_id
         WHERE n.kind = 'component'`
      )
      .all()
      .map((r: any) => r.name as string);
    for (const machinery of ['styled', 'styled.div', 'styled().attrs', 'memo', 'React.memo']) {
      expect(fromComponents, machinery).not.toContain(machinery);
    }
    expect(fromComponents.filter((n) => n.startsWith('styled('))).toEqual([]);
    // The wrapped component is rendered, not passed as a value: no fn-ref from the
    // component or from the file, resolved or not.
    const fnRefs = db
      .prepare(
        `SELECT r.reference_name name FROM unresolved_refs r WHERE r.reference_kind = 'function_ref'
         UNION ALL
         SELECT t.name FROM edges e JOIN nodes t ON t.id = e.target WHERE json_extract(e.metadata, '$.fnRef') = 1`
      )
      .all()
      .map((r: any) => r.name as string);
    for (const wrapped of ['ActionButton', 'Box', 'Link']) expect(fnRefs, wrapped).not.toContain(wrapped);
  });

  it('renders the component it wraps, bound as a tag of that name in its file', async () => {
    const db = await index();
    const rows = db
      .prepare(
        `SELECT s.name src, t.name dst, t.file_path file, e.metadata meta FROM edges e
         JOIN nodes s ON s.id = e.source JOIN nodes t ON t.id = e.target
         WHERE json_extract(e.metadata, '$.wrapped') = 1 ORDER BY s.name, t.name`
      )
      .all();
    expect(rows.map((r: any) => `${r.src}>${r.dst}@${r.file}`)).toEqual([
      'Card>Box@ui.tsx',
      'Memoized>ActionButton@ActionButton.tsx',
      'NudeButton>ActionButton@ActionButton.tsx',
      'Panel>ActionButton@ActionButton.tsx',
      'Root>ActionButton@ActionButton.tsx',
    ]);
    for (const r of rows) {
      expect(JSON.parse(r.meta)).toMatchObject({ synthesizedBy: 'jsx-render', via: r.dst, wrapped: true });
    }
    // react-router's Link renders no project namesake, nor does a name the file
    // imports from a module the index can't follow, or destructures itself.
    for (const wrapper of ['StyledLink', 'BigIcon', 'StyledText']) {
      expect(edgesFrom(db, 'calls').filter((e) => e.startsWith(`${wrapper}>`)), wrapper).toEqual([]);
    }
  });

  it('lets explore follow a render flow through the wrapper to the component it wraps', async () => {
    await index();
    const res = await new ToolHandler(cg).execute('codegraph_explore', { query: 'Page NudeButton ActionButton' });
    const text: string = res.content?.[0]?.text ?? '';
    const flow = text.slice(text.indexOf('**Flow'));
    expect(text).toContain('**Flow');
    const steps = [...flow.matchAll(/^(\d+)\. (\w+) \(/gm)].map((m) => `${m[1]}. ${m[2]}`);
    expect(steps.slice(0, 3)).toEqual(['1. Page', '2. NudeButton', '3. ActionButton']);
  });

  it('draws the render link when a sync turns a wrapper in a file with no markup onto a component', async () => {
    const db = await index();
    const wrapped = () =>
      db
        .prepare(
          `SELECT s.name src, t.name dst FROM edges e JOIN nodes s ON s.id = e.source JOIN nodes t ON t.id = e.target
           WHERE json_extract(e.metadata, '$.wrapped') = 1 AND s.name = 'Bare'`
        )
        .all()
        .map((r: any) => `${r.src}>${r.dst}`);
    expect(wrapped()).toEqual([]);
    // No markup, no synthesized edge and the same component names before and
    // after: only the wrapper itself says the JSX edges need redrawing.
    fs.writeFileSync(path.join(dir, 'bare.ts'), FILES['bare.ts']!.replace('styled.div`', 'styled(ActionButton)`'));
    await cg.sync();
    expect(wrapped()).toEqual(['Bare>ActionButton']);
  });
});
