/**
 * React Router links written through a route-config object (bulletproof-react's
 * `config/paths.ts`): `<Link to={paths.app.discussion.getHref(id)}>` and
 * `navigate(paths.auth.login.getHref())` read the href the helper returns —
 * a template's whole-segment `${id}` stays a parameter, a hole glued onto a
 * segment (`?redirectTo=…`) is dropped. An arrow-function attribute before
 * `to` (`onMouseEnter={() => …}`) no longer ends the tag early.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

let root = '';
let cg: CodeGraph;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-rr-config-href-'));
  const files: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'web', dependencies: { react: '^18', 'react-router': '^7' } }),
    'tsconfig.json': JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['./src/*'] } } }),
    'src/config/paths.ts': `export const paths = {
  auth: {
    login: {
      path: '/auth/login',
      getHref: (redirectTo?: string | null | undefined) =>
        \`/auth/login\${redirectTo ? \`?redirectTo=\${encodeURIComponent(redirectTo)}\` : ''}\`,
    },
  },
  app: {
    root: { path: '/app', getHref: () => '/app' },
    discussions: { path: 'discussions', getHref: () => '/app/discussions' },
    discussion: {
      path: 'discussions/:discussionId',
      getHref: (id: string) => \`/app/discussions/\${id}\`,
    },
  },
} as const;
`,
    'src/app/router.tsx': `import { createBrowserRouter } from 'react-router';
import { paths } from '@/config/paths';

export const router = createBrowserRouter([
  { path: paths.auth.login.path, lazy: () => import('./routes/auth/login') },
  {
    path: paths.app.root.path,
    lazy: () => import('./routes/app/root'),
    children: [
      { path: paths.app.discussions.path, lazy: () => import('./routes/app/discussions') },
      { path: paths.app.discussion.path, lazy: () => import('./routes/app/discussion') },
    ],
  },
]);
`,
    'src/app/routes/auth/login.tsx': `export default function LoginRoute() { return null; }
`,
    'src/app/routes/app/root.tsx': `export default function AppRoot() { return null; }
`,
    'src/app/routes/app/discussions.tsx': `export default function DiscussionsRoute() { return null; }
`,
    'src/app/routes/app/discussion.tsx': `export default function DiscussionRoute() { return null; }
`,
    'src/features/discussions/discussions-list.tsx': `import { Link } from 'react-router';
import { paths } from '@/config/paths';

export function DiscussionsList({ items, prefetch }: { items: { id: string }[]; prefetch: (id: string) => void }) {
  return items.map((d) => (
    <Link onMouseEnter={() => prefetch(d.id)} to={paths.app.discussion.getHref(d.id)}>
      open
    </Link>
  ));
}
`,
    'src/lib/auth.tsx': `import { useNavigate } from 'react-router';
import { paths } from '@/config/paths';

export function Logout() {
  const navigate = useNavigate();
  return <button onClick={() => navigate(paths.auth.login.getHref(location.pathname))}>out</button>;
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

/** `route name` of every navigates edge out of a file. */
function navigatesFrom(file: string): string[] {
  const ids = cg.getNodesInFile(file).map((n) => n.id);
  return cg
    .getOutgoingEdgesFrom(ids)
    .filter((e) => e.kind === 'navigates')
    .map((e) => cg.getNode(e.target)!.name)
    .sort();
}

describe('React Router links through a route-config object', () => {
  it('reads a Link’s `to={paths.x.getHref(id)}`, past an arrow attribute before it', () => {
    expect(navigatesFrom('src/features/discussions/discussions-list.tsx')).toEqual(['/app/discussions/:discussionId']);
  });

  it('reads `navigate(paths.x.getHref(…))`, dropping a query suffix glued onto the path', () => {
    expect(navigatesFrom('src/lib/auth.tsx')).toEqual(['/auth/login']);
  });
});
