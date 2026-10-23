/**
 * A function passed as a value (`styled(Link)`, `createContext({ onClose:
 * noop })`, `register(debounce)`) whose name the file imports from a package
 * is that package's function. The function-as-value matcher still bound it to
 * the one project function of that name whenever there was exactly one:
 * outline's `styled(Link)`, with `Link` from react-router-dom, landed on an
 * email template's `Footer.tsx:Link`, and cord-field's lodash `noop` on a
 * test file's local `const noop = () => {}`.
 *
 * The import says which `Link` it is. A name the file imports from a package
 * its package.json declares (or a Node built-in) names nothing in the
 * repository; a project import still resolves through its import, a
 * specifier nothing declares may be an alias the resolver doesn't know, and a
 * declaration in the same file still wins.
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-fnref-package-'));
  roots.push(root);
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  return CodeGraph.init(root, { index: true });
}

/** `<value name> -> <target file>:<target qualified name>` for each function-as-value edge leaving `file`. */
function fnRefsFrom(cg: CodeGraph, file: string): string[] {
  const ids = cg.getNodesInFile(file).map((n) => n.id);
  return [...new Set(cg
    .getOutgoingEdgesFrom(ids)
    .filter((e) => e.metadata?.fnRef === true)
    .map((e) => {
      const target = cg.getNode(e.target);
      return `${String(e.metadata?.refName)} -> ${target?.filePath}:${target?.qualifiedName}`;
    }))]
    .sort();
}

describe('a function value the file imports from a package', () => {
  it('never lands on a project function of the same name', async () => {
    const cg = await indexProject({
      'package.json': JSON.stringify({
        name: 'wiki',
        dependencies: { react: '^18.2.0', 'react-router-dom': '^6.22.0', 'styled-components': '^6.1.0', lodash: '^4.17.21' },
      }),
      'tsconfig.json': JSON.stringify({ compilerOptions: { baseUrl: '.', jsx: 'react-jsx', paths: { '~/*': ['./app/*'] } } }),
      // The project's only `Link`, `noop`, `debounce` and `format` functions.
      'server/emails/Footer.tsx': `export function Link(props: { href: string; children?: string }) {
  return <a href={props.href}>{props.children}</a>;
}
`,
      'app/utils/noop.ts': `export function noop(): void {}
`,
      'app/utils/debounce.ts': `export function debounce(fn: () => void): () => void { return fn; }
`,
      'app/utils/format.ts': `export function format(value: number): string { return String(value); }
`,
      // outline's Breadcrumb: react-router-dom's `Link`, wrapped by styled-components.
      'app/components/Breadcrumb.tsx': `import { Link } from 'react-router-dom';
import styled from 'styled-components';

const Item = styled(Link)\`
  display: flex;
\`;

export function Crumb() {
  return <Item to="/">home</Item>;
}
`,
      // A named import, a default import of a package path, and a Node built-in.
      'app/hooks/useDeferred.ts': `import { noop } from 'lodash';
import debounce from 'lodash/debounce';
import { format } from 'node:util';

export const defaults = { onClose: noop };

export function useDeferred(register: (cb: unknown) => void): void {
  register(debounce);
  register(format);
}
`,
    });
    try {
      expect({
        breadcrumb: fnRefsFrom(cg, 'app/components/Breadcrumb.tsx'),
        deferred: fnRefsFrom(cg, 'app/hooks/useDeferred.ts'),
      }).toEqual({ breadcrumb: [], deferred: [] });
    } finally {
      cg.close();
    }
  }, 60_000);

  it('never lands on one under a catch-all path alias either', async () => {
    const cg = await indexProject({
      'package.json': JSON.stringify({ name: 'cord', dependencies: { react: '^18.2.0', lodash: '^4.17.21' } }),
      // cord-field's shape: `~/…` for the project's own files, `*` for local
      // type declarations of untyped packages.
      'tsconfig.json': JSON.stringify({
        compilerOptions: { baseUrl: 'src', jsx: 'react-jsx', paths: { '~/*': ['./*'], '*': ['./typings/*'] } },
      }),
      'src/scenes/Users/UserForm.test.tsx': `const noop = () => {
  // a stub
};

export function renderForm(onSubmit: () => void) {
  return onSubmit;
}

renderForm(noop);
`,
      'src/components/form/AllowClose.ts': `import { noop } from 'lodash';
import { createContext } from 'react';

export const AllowFormCloseContext = createContext({ allow: noop });
`,
    });
    try {
      expect(fnRefsFrom(cg, 'src/components/form/AllowClose.ts')).toEqual([]);
      // The test's own `noop` is still what the test passes.
      expect(fnRefsFrom(cg, 'src/scenes/Users/UserForm.test.tsx')).toEqual([
        'noop -> src/scenes/Users/UserForm.test.tsx:noop',
      ]);
    } finally {
      cg.close();
    }
  }, 60_000);

  it('keeps a project import, an undeclared specifier and a same-file declaration resolving', async () => {
    const cg = await indexProject({
      'package.json': JSON.stringify({ name: 'kit', dependencies: { react: '^18.2.0', lodash: '^4.17.21' } }),
      'tsconfig.json': JSON.stringify({ compilerOptions: { baseUrl: '.', jsx: 'react-jsx' } }),
      'src/emails/Footer.tsx': `export function Link(props: { href: string }) {
  return <a href={props.href} />;
}
`,
      'src/lib/handlers.ts': `export function onSave(): void {}
`,
      // A project import resolves through the import.
      'src/menus/Menu.tsx': `import { Link } from '../emails/Footer';

export function menuItems(wrap: (c: unknown) => unknown) {
  return wrap(Link);
}
`,
      // SvelteKit's \`$lib\`: no package.json declares it, so it may be the
      // project's own folder under an alias this resolver doesn't read.
      'src/routes/page.ts': `import { onSave } from '$lib/handlers';

export function bind(register: (cb: () => void) => void): void {
  register(onSave);
}
`,
      // A declaration in the file shadows the package's \`noop\` where it is in scope.
      'src/hooks/stub.ts': `import { noop } from 'lodash';

export function setup(register: (cb: () => void) => void): void {
  function noop(): void {}
  register(noop);
}
`,
    });
    try {
      expect(fnRefsFrom(cg, 'src/menus/Menu.tsx')).toEqual(['Link -> src/emails/Footer.tsx:Link']);
      expect(fnRefsFrom(cg, 'src/routes/page.ts')).toEqual(['onSave -> src/lib/handlers.ts:onSave']);
      expect(fnRefsFrom(cg, 'src/hooks/stub.ts')).toEqual(['noop -> src/hooks/stub.ts:setup::noop']);
    } finally {
      cg.close();
    }
  }, 60_000);
});
