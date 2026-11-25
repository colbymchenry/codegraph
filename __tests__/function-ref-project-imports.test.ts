/**
 * A function passed as a value whose name the file imports from its own
 * project names what that import binds. When the import resolver binds it to
 * something that is not a function, the function-as-value matcher still fell
 * back to the one project function of that name elsewhere:
 * - outline's `import isCloudHosted from '~/utils/isCloudHosted'` (a boolean
 *   constant) landed on the server's `isCloudHosted()` policy helper, and its
 *   `Star` model class on the `<Star>` icon component;
 * - outline's `import * as Slack from '../slack'` (a module object) landed on
 *   the Slack plugin's settings component;
 * - topcoder's `import TCO21 from './themes/TCO21.scss'` landed on the TCO21
 *   community's routes, and cord-field's `.graphql` document on a component.
 *
 * A wrapper declared beside the function it wraps (`export default
 * styled(Disclosure)`) and a lazy loader (`lazy(() => import('../pages/Home'))`)
 * still lead to the namesake, as does an import the import resolver can't
 * follow at all (a barrel it doesn't read).
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-fnref-project-'));
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

const PACKAGE_JSON = JSON.stringify({ name: 'wiki', dependencies: { react: '^18.2.0', 'styled-components': '^6.1.0' } });
const TSCONFIG = JSON.stringify({ compilerOptions: { baseUrl: '.', jsx: 'react-jsx' } });

describe('a function value the file imports from its own project', () => {
  it('names the constant, class or module the import binds, not a function elsewhere', async () => {
    const cg = await indexProject({
      'package.json': PACKAGE_JSON,
      'tsconfig.json': TSCONFIG,
      // What the imports bind: a constant, a model class and a module.
      'app/utils/isCloudHosted.ts': `export const isCloudHosted = window.location.host.endsWith('.example.com');
`,
      'app/models/Star.ts': `export default class Star {
  id = '';
}
`,
      'plugins/slack/server/slack.ts': `export function post(text: string): string { return text; }
`,
      // The project's only functions of those names, somewhere else.
      'server/policies/utils.ts': `export function isCloudHosted(): boolean { return true; }
`,
      'app/components/Star.tsx': `export function Star() {
  return <svg />;
}
`,
      'plugins/slack/client/Settings.tsx': `export function Slack() {
  return <div />;
}
`,
      'app/scenes/Settings.ts': `import { isCloudHosted } from '../utils/isCloudHosted';
import Star from '../models/Star';

export function settings(register: (value: unknown) => void): void {
  register(isCloudHosted);
  register(Star);
}
`,
      'plugins/slack/server/hooks.test.ts': `import * as Slack from './slack';

export function spyOn(spy: (module: unknown) => void): void {
  spy(Slack);
}
`,
    });
    try {
      expect({
        settings: fnRefsFrom(cg, 'app/scenes/Settings.ts'),
        hooks: fnRefsFrom(cg, 'plugins/slack/server/hooks.test.ts'),
      }).toEqual({ settings: [], hooks: [] });
    } finally {
      cg.close();
    }
  }, 60_000);

  it('never names a function when it imports a stylesheet, an image or a GraphQL document', async () => {
    const cg = await indexProject({
      'package.json': PACKAGE_JSON,
      'tsconfig.json': TSCONFIG,
      'src/components/Countdown/themes/TCO21.scss': `.countdown { color: red; }
`,
      'src/assets/img-QA.png': '',
      'src/assets/visibility.svg': `<svg xmlns="http://www.w3.org/2000/svg"></svg>
`,
      'src/scenes/Story/Story.graphql': `mutation CreateStory { createStory { id } }
`,
      // The project's only functions of those names.
      'src/routes/TCO21/Routes.tsx': `export function TCO21() {
  return <div />;
}
`,
      'src/routes/QA/Routes.tsx': `export function QA() {
  return <div />;
}
`,
      'src/components/VisibilityIcon.tsx': `export function VisibilityIcon() {
  return <span />;
}
`,
      'src/scenes/Story/CreateStory.tsx': `export function CreateStory() {
  return <form />;
}
`,
      'src/components/Countdown/index.tsx': `import TCO21 from './themes/TCO21.scss';
import QA from '../../assets/img-QA.png';
import VisibilityIcon from '../../assets/visibility.svg?react';
import { CreateStoryDocument as CreateStory } from '../../scenes/Story/Story.graphql';

export function themes(pick: (value: unknown) => void): void {
  pick(TCO21);
  pick(QA);
  pick(VisibilityIcon);
  pick(CreateStory);
}
`,
    });
    try {
      expect(fnRefsFrom(cg, 'src/components/Countdown/index.tsx')).toEqual([]);
    } finally {
      cg.close();
    }
  }, 60_000);

  it('keeps a wrapper beside its function, a lazy loader, a barrel and a plain import', async () => {
    const cg = await indexProject({
      'package.json': PACKAGE_JSON,
      'tsconfig.json': TSCONFIG,
      // The default export wraps the function declared beside it.
      'app/components/Disclosure.tsx': `import styled from 'styled-components';

function Disclosure(props: { open: boolean }) {
  return <button aria-expanded={props.open} />;
}

const StyledDisclosure = styled(Disclosure)\`
  margin: 0;
\`;

export default StyledDisclosure;
`,
      // A lazy loader leads to the page it loads.
      'src/pages/Home.tsx': `export default function Home() {
  return <main />;
}
`,
      'src/AppRoutes/pageComponents.ts': `import { lazy } from 'react';

export const Home = lazy(() => import('../pages/Home'));
`,
      // A barrel whose re-export the import resolver may not follow.
      'server/presenters/apiKey.ts': `export default function presentApiKey(key: string): string { return key; }
`,
      'server/presenters/index.ts': `export { default as presentApiKey } from './apiKey';
`,
      'app/utils/format.ts': `export function formatDate(value: Date): string { return value.toISOString(); }
`,
      'app/components/SidebarLink.tsx': `import Disclosure from './Disclosure';
import { formatDate } from '../utils/format';

export function link(wrap: (component: unknown) => unknown): unknown {
  wrap(formatDate);
  return wrap(Disclosure);
}
`,
      'src/AppRoutes/routes.ts': `import { Home } from './pageComponents';

export function routes(add: (component: unknown) => void): void {
  add(Home);
}
`,
      'server/routes/apiKeys.ts': `import { presentApiKey } from '../presenters';

export function list(present: (fn: unknown) => void): void {
  present(presentApiKey);
}
`,
    });
    try {
      expect({
        sidebar: fnRefsFrom(cg, 'app/components/SidebarLink.tsx'),
        routes: fnRefsFrom(cg, 'src/AppRoutes/routes.ts'),
        apiKeys: fnRefsFrom(cg, 'server/routes/apiKeys.ts'),
      }).toEqual({
        sidebar: [
          'Disclosure -> app/components/Disclosure.tsx:Disclosure',
          'formatDate -> app/utils/format.ts:formatDate',
        ],
        routes: ['Home -> src/pages/Home.tsx:Home'],
        apiKeys: ['presentApiKey -> server/presenters/apiKey.ts:presentApiKey'],
      });
    } finally {
      cg.close();
    }
  }, 60_000);
});
