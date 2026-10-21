/**
 * A tsconfig `paths` entry keyed `"*"` matches every specifier, so treating
 * "an alias pattern matches" as "the import is the project's" made every
 * package import in such a project look local. The out-of-repo guard never
 * fired there: on cord-field (`"baseUrl": "src"`, `"*": ["./typings/*"]`),
 * 169 imports of `Typography` from `@mui/material` landed on a project
 * `Typography`, and `Form` from `react-final-form` on the project's form.
 *
 * An alias counts only when it maps the specifier to a project file. A
 * package the importing file's package.json declares, which no alias maps to
 * a file, is outside the repository, catch-all or not. A catch-all that does
 * find a file (a local `.d.ts` for an untyped package, or `"*": ["src/*"]`
 * for the project's own folders) still makes that import the project's.
 */
import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

const roots: string[] = [];
afterAll(() => {
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
});

async function indexProject(files: Record<string, string>): Promise<CodeGraph> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-catch-all-alias-'));
  roots.push(root);
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  return CodeGraph.init(root, { index: true });
}

/**
 * `<kind> <target file>:<target qualified name>` for every edge leaving
 * `file`'s nodes. JSX tags are left out: a separate pass links `<Button>` by
 * name without reading the file's imports, alias or not.
 */
function edgesFrom(cg: CodeGraph, file: string): string[] {
  const ids = cg.getNodesInFile(file).map((n) => n.id);
  return cg
    .getOutgoingEdgesFrom(ids)
    .filter((e) => e.metadata?.synthesizedBy !== 'jsx-render')
    .map((e) => {
      const target = cg.getNode(e.target);
      return `${e.kind} ${target?.filePath}:${target?.qualifiedName}`;
    })
    .sort();
}

describe('a catch-all tsconfig path alias', () => {
  it('leaves a declared package outside the repository when it names no project file', async () => {
    const cg = await indexProject({
      'package.json': JSON.stringify({
        name: 'portal',
        dependencies: {
          '@mui/material': '^5.15.0',
          'react-final-form': '^6.5.9',
          luxon: '^3.4.3',
          'legacy-widgets': '^1.0.0',
          react: '^18.2.0',
        },
      }),
      // cord-field's shape: `~/…` for the project's own files, `*` for local
      // type declarations of untyped packages.
      'tsconfig.json': JSON.stringify({
        compilerOptions: { baseUrl: 'src', jsx: 'react-jsx', paths: { '~/*': ['./*'], '*': ['./typings/*'] } },
      }),
      'src/components/Button.tsx': `export interface ButtonProps { label: string }
export function Button(props: ButtonProps) { return <button>{props.label}</button>; }
`,
      'src/components/Card.tsx': `export function Card(props: { children?: unknown }) { return <div>{String(props.children)}</div>; }
`,
      'src/components/form/Form.tsx': `export function Form() { return <form />; }
export function useForm() { return { valid: true }; }
`,
      'src/common/DateTime.ts': `export class DateTime {
  static now(): DateTime { return new DateTime(); }
}
`,
      // The catch-all does answer this package: its types live in the project.
      'src/typings/legacy-widgets.d.ts': `export interface WidgetOptions { name: string }
export declare class Widget {
  constructor(options: WidgetOptions);
  render(): void;
}
`,
      'src/scenes/Page.tsx': `import { Button, type ButtonProps } from '@mui/material';
import { Form, useForm } from 'react-final-form';
import { DateTime } from 'luxon';
import { Widget, type WidgetOptions } from 'legacy-widgets';
import { Card } from '~/components/Card';

const options: WidgetOptions = { name: 'page' };

export function Page(props: ButtonProps) {
  const form = useForm();
  const when = DateTime.now();
  new Widget(options).render();
  return <Card><Button>{props.label}{String(form.valid)}{String(when)}</Button><Form /></Card>;
}
`,
    });
    try {
      const fromPage = edgesFrom(cg, 'src/scenes/Page.tsx');
      // No name the page imports from a package lands on a project namesake.
      expect(fromPage.filter((e) => /src\/components\/(?:Button|form\/Form)\.tsx|src\/common\/DateTime\.ts/.test(e))).toEqual([]);
      // `~/…` still reaches the project, and so does a package whose types the
      // catch-all finds in the project.
      expect(fromPage).toContain('imports src/components/Card.tsx:Card');
      expect(fromPage).toContain('imports src/typings/legacy-widgets.d.ts:Widget');
      expect(fromPage).toContain('imports src/typings/legacy-widgets.d.ts:WidgetOptions');
    } finally {
      cg.close();
    }
  });

  it('still makes an import the project’s when it maps the import to a project file', async () => {
    const cg = await indexProject({
      'package.json': JSON.stringify({ name: 'shop', dependencies: { '@mui/material': '^5.15.0', react: '^18.2.0' } }),
      'tsconfig.json': JSON.stringify({ compilerOptions: { baseUrl: '.', jsx: 'react-jsx', paths: { '*': ['src/*'] } } }),
      'src/components/Button.tsx': `export function Button() { return <button />; }
`,
      'src/pages/Home.tsx': `import { Button } from 'components/Button';
export function Home() { return <Button />; }
`,
      'src/pages/Checkout.tsx': `import { Button } from '@mui/material';
export function Checkout() { return <Button />; }
`,
    });
    try {
      expect(edgesFrom(cg, 'src/pages/Home.tsx')).toContain('imports src/components/Button.tsx:Button');
      expect(edgesFrom(cg, 'src/pages/Checkout.tsx').filter((e) => e.includes('src/components/Button.tsx'))).toEqual([]);
    } finally {
      cg.close();
    }
  });

  it('leaves a declared package outside the repository when its alias lands outside the index', async () => {
    const cg = await indexProject({
      'package.json': JSON.stringify({ name: 'panel', dependencies: { lit: '^3.0.0', 'date-fns': '^3.0.0', config: '^3.3.0' } }),
      // home-assistant pins lit's entry points to files in node_modules, and
      // topcoder's catch-all ends in `node_modules/*`.
      'tsconfig.json': JSON.stringify({
        compilerOptions: {
          baseUrl: '.',
          experimentalDecorators: true,
          paths: { 'lit/decorators': ['./node_modules/lit/decorators.js'], '*': ['src/*', 'node_modules/*'] },
        },
      }),
      // Installed packages: on disk, never indexed.
      'node_modules/lit/decorators.js': `export function property() { return () => {}; }
`,
      'node_modules/date-fns/index.js': `export function format(value) { return String(value); }
`,
      'src/data/zwave.ts': `export interface ConfigParam {
  property: string;
}
`,
      'src/format.ts': `export function format(value: number) { return value.toFixed(2); }
`,
      // The `config` package reads this folder at run time.
      'config/default.js': `const config = { port: 3000 };
module.exports = config;
`,
      'src/panel.ts': `import { property } from 'lit/decorators';
import { format } from 'date-fns';
import config from 'config';

export class Panel {
  @property() label = '';
  render() { return format(config.port); }
}
`,
    });
    try {
      expect(edgesFrom(cg, 'src/panel.ts').filter((e) => /src\/data\/zwave\.ts|src\/format\.ts|config\/default\.js/.test(e))).toEqual([]);
    } finally {
      cg.close();
    }
  });
});
