import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { CodeGraph } from '../src';

/**
 * A JSX tag names ONE component, and the file it is written in says which:
 * the one that file declares, or the one it imports. The synthesizer used to
 * take the first node of that name in the whole graph, which is a coin flip as
 * soon as a name repeats — and repeated component names are the norm, not the
 * exception (`Section`, `Picker`, `FrameCard`, one per feature folder).
 *
 * Getting it wrong costs twice: the parent gains an edge to a component it
 * never renders, and the component it DOES render is left with no caller, so
 * every walk back from that subtree — Screens' navigation attribution,
 * `getCallers`, an impact radius — dead-ends there. On an Expo app that showed
 * up as a navigation standing alone on the Screens tab with no screen behind
 * it, while the edge pointed at an unrelated card in another sheet.
 *
 * Each decoy here is deliberately named to sort BEFORE the right answer, so a
 * first-match resolver picks it and the test fails.
 */
describe('JSX child disambiguation among same-named components', () => {
  let dir: string;
  let cg: any;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsx-child-'));
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

  async function index() {
    cg = await CodeGraph.init(dir, { silent: true });
    await cg.indexAll();
    return (cg as any).db.db;
  }

  /** The files a jsx-render edge out of `parent` points into. */
  const rendersFrom = (db: any, parent: string): string[] =>
    db
      .prepare(
        `SELECT t.file_path AS f FROM edges e
           JOIN nodes s ON s.id = e.source
           JOIN nodes t ON t.id = e.target
          WHERE s.name = ? AND json_extract(e.metadata, '$.synthesizedBy') = 'jsx-render'
          ORDER BY f`
      )
      .all(parent)
      .map((r: any) => r.f);

  it('follows the import when the same name is declared in another file', async () => {
    write('a-decoy/card.tsx', `export function Card() { return <div>decoy</div>; }\n`);
    write('real/card.tsx', `export function Card() { return <div>real</div>; }\n`);
    write(
      'grid.tsx',
      `import { Card } from './real/card';
export function Grid() { return <div><Card /></div>; }
`
    );
    const db = await index();
    expect(rendersFrom(db, 'Grid')).toEqual(['real/card.tsx']);
  });

  it('follows a tsconfig path alias the same way a relative import is followed', async () => {
    fs.writeFileSync(
      path.join(dir, 'tsconfig.json'),
      JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['src/*'] } } })
    );
    write('src/a-decoy/row.tsx', `export function Row() { return <li>decoy</li>; }\n`);
    write('src/real/row.tsx', `export function Row() { return <li>real</li>; }\n`);
    write(
      'src/list.tsx',
      `import { Row } from '@/real/row';
export function List() { return <ul><Row /></ul>; }
`
    );
    const db = await index();
    expect(rendersFrom(db, 'List')).toEqual(['src/real/row.tsx']);
  });

  it('prefers a component declared in the same file over a same-named import elsewhere', async () => {
    write('a-decoy/pill.tsx', `export function Pill() { return <span>decoy</span>; }\n`);
    write(
      'toolbar.tsx',
      `function Pill() { return <span>local</span>; }
export function Toolbar() { return <div><Pill /></div>; }
`
    );
    const db = await index();
    expect(rendersFrom(db, 'Toolbar')).toEqual(['toolbar.tsx']);
  });

  it('prefers a JS component over a same-named class in the app’s native half', async () => {
    // A React Native app: `<CaptureSettings/>` is the TS component the screen
    // imports, never the Swift type that happens to share its name.
    write('a-ios/CaptureSettings.swift', `class CaptureSettings {\n  func sync() {}\n}\n`);
    write('ui/capture-settings.tsx', `export function CaptureSettings() { return <div />; }\n`);
    write(
      'ui/overlay.tsx',
      `import { CaptureSettings } from './capture-settings';
export function Overlay() { return <div><CaptureSettings /></div>; }
`
    );
    const db = await index();
    expect(rendersFrom(db, 'Overlay')).toEqual(['ui/capture-settings.tsx']);
  });

  it('still links a name that appears exactly once', async () => {
    write('only/badge.tsx', `export function Badge() { return <b>1</b>; }\n`);
    write(
      'header.tsx',
      `import { Badge } from './only/badge';
export function Header() { return <h1><Badge /></h1>; }
`
    );
    const db = await index();
    expect(rendersFrom(db, 'Header')).toEqual(['only/badge.tsx']);
  });
});

/**
 * A tag the file declares itself as a VALUE — a lazily loaded page, a
 * wrapped component, an alias — is that declaration, whatever else in the
 * repository shares its name. A value is no component node, so the lookup by
 * kind used to skip it and take a lone same-named function anywhere: on
 * codedthemes' mantis (a vite app and a Next.js app in one repository) the
 * vite app's `RegisterPage` went to the Next.js app's page, and excalidraw's
 * Next.js example rendered the docs site's `Excalidraw`.
 */
describe('JSX child: a value the file declares itself', () => {
  let dir: string;
  let cg: any;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsx-own-'));
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

  async function index(): Promise<void> {
    cg = await CodeGraph.init(dir, { silent: true });
    await cg.indexAll();
  }

  /** `kind name file` of each node a jsx-render edge out of `parent` points at. */
  const renders = (parent: string): string[] =>
    cg.db.db
      .prepare(
        `SELECT t.kind || ' ' || t.name || ' ' || t.file_path AS r FROM edges e
           JOIN nodes s ON s.id = e.source
           JOIN nodes t ON t.id = e.target
          WHERE s.name = ? AND json_extract(e.metadata, '$.synthesizedBy') = 'jsx-render'
          ORDER BY r`
      )
      .all(parent)
      .map((row: any) => row.r);

  const LOADABLE = 'export default function Loadable(Component) {\n  return (props) => <Component {...props} />;\n}\n';

  it('renders the module a lazy value loads, never another app’s same-named page', async () => {
    write('next/src/app/(auth)/register/page.jsx', 'export default function RegisterPage() {\n  return <div />;\n}\n');
    write('vite/src/pages/auth/Register.jsx', 'export default function Register() {\n  return <div />;\n}\n');
    write('vite/src/components/Loadable.jsx', LOADABLE);
    write(
      'vite/src/layout/AuthShell.jsx',
      `import { lazy } from 'react';
import Loadable from '../components/Loadable';

const RegisterPage = Loadable(lazy(() => import('../pages/auth/Register')));

export function AuthShell() {
  return <main><RegisterPage /></main>;
}
`
    );
    await index();
    expect(renders('AuthShell')).toEqual(['function Register vite/src/pages/auth/Register.jsx']);
  });

  it('renders the declaration itself when the module it loads is out of reach', async () => {
    write('next/src/app/(auth)/login/page.jsx', 'export default function LoginPage() {\n  return <div />;\n}\n');
    write('vite/src/components/Loadable.jsx', LOADABLE);
    write(
      'vite/src/layout/AuthShell.jsx',
      `import { lazy } from 'react';
import Loadable from '../components/Loadable';

// An import only the app's own build resolves (\`baseUrl\`).
const LoginPage = Loadable(lazy(() => import('pages/auth/Login')));

export function AuthShell() {
  return <main>Sign in <LoginPage /></main>;
}
`
    );
    await index();
    expect(renders('AuthShell')).toEqual(['constant LoginPage vite/src/layout/AuthShell.jsx']);
  });

  it('reads next/dynamic’s `(await import(…)).default` and a `.then` that picks a named export', async () => {
    // excalidraw's docs site has a component of the same name.
    write('dev-docs/src/theme/ReactLiveScope/index.js', 'const Excalidraw = React.forwardRef((props, ref) => <div ref={ref} />);\nexport default { Excalidraw };\n');
    write('examples/with-nextjs/src/excalidrawWrapper.tsx', 'const ExcalidrawWrapper = () => {\n  return <div />;\n};\nexport default ExcalidrawWrapper;\n');
    write(
      'examples/with-nextjs/src/pages/excalidraw-in-pages.tsx',
      `import dynamic from 'next/dynamic';

const Excalidraw = dynamic(
  async () => (await import('../excalidrawWrapper')).default,
  {
    ssr: false,
  },
);

export default function Page() {
  return <Excalidraw />;
}
`
    );
    write('a-decoy/line-chart.tsx', 'export function LineChart() {\n  return <svg />;\n}\n');
    write('charts/line-chart.tsx', 'export function LineChart() {\n  return <svg />;\n}\n');
    write('charts/index.ts', "export default function Fallback() {\n  return null;\n}\nexport * from './line-chart';\n");
    write(
      'dashboard.tsx',
      `import { lazy } from 'react';
const LineChart = lazy(() => import('./charts').then((m) => ({ default: m.LineChart })));
export function Dashboard() {
  return <LineChart />;
}
`
    );
    await index();
    expect(renders('Page')).toEqual(['function ExcalidrawWrapper examples/with-nextjs/src/excalidrawWrapper.tsx']);
    expect(renders('Dashboard')).toEqual(['function LineChart charts/line-chart.tsx']);
  });

  it('follows a module that forwards its default export to the component it wraps', async () => {
    // outline: `scenes/Login/index.ts` forwards `Login.tsx`'s `observer(Login)`.
    write('a-decoy/Login.tsx', 'export function Login() {\n  return <form />;\n}\n');
    write(
      'app/scenes/Login/Login.tsx',
      "import { observer } from 'mobx-react';\nfunction Login() {\n  return <form />;\n}\n\nexport default observer(Login);\n"
    );
    write('app/scenes/Login/index.ts', 'import Login from "./Login";\n\nexport default Login;\n');
    write(
      'app/scenes/Shared/index.tsx',
      `import { lazy } from 'react';
const Login = lazy(() => import('../Login'));
export function SharedScene() {
  return <Login />;
}
`
    );
    await index();
    expect(renders('SharedScene')).toEqual(['function Login app/scenes/Login/Login.tsx']);
  });

  it('renders the function a value wraps, and an alias value itself', async () => {
    write('a-decoy/portal.tsx', 'export function DialogPortal() {\n  return <div />;\n}\n');
    write(
      'app/settings.tsx',
      `import { observer } from 'mobx-react';
import * as DialogPrimitive from '@radix-ui/react-dialog';

const DialogPortal = DialogPrimitive.Portal;

const Application = observer(function Application() {
  return <div />;
});

function TableViewInner() {
  return <table />;
}

const TableView = observer(TableViewInner) as typeof TableViewInner;

export function Settings() {
  return <DialogPortal><Application /><TableView /></DialogPortal>;
}
`
    );
    write('a-decoy/table-view.tsx', 'export class TableView {}\n');
    await index();
    expect(renders('Settings')).toEqual([
      'constant DialogPortal app/settings.tsx',
      'function Application app/settings.tsx',
      'function TableViewInner app/settings.tsx',
    ]);
  });

  it('renders nothing for a type argument naming the value, nor for an import inside a function it wraps', async () => {
    write('a-decoy/schema.tsx', 'export function Schema() {\n  return <div />;\n}\n');
    write('heavy.tsx', 'export default function Heavy() {\n  return <div />;\n}\n');
    write(
      'form.tsx',
      `import { z } from 'zod';
import { useForm } from 'react-hook-form';
import { withFallback } from './fallback';

const Schema = z.object({ name: z.string() });
type Schema = z.infer<typeof Schema>;

const Dialog = withFallback('Dialog', (props) => {
  const load = () => import('./heavy');
  return <div onClick={load} />;
});

export function Form() {
  const form = useForm<Schema>();
  return <form><Dialog /></form>;
}
`
    );
    write('fallback.tsx', 'export function withFallback(name, render) {\n  return render;\n}\n');
    await index();
    expect(renders('Form')).toEqual(['constant Dialog form.tsx']);
  });

  it('binds a TSX type named like a value the file declares to that file, never another app’s component', async () => {
    // Component resolution saw the name as a component's and took the only
    // one in the repository, in another app.
    write('admin/src/components/User.tsx', 'export function User() {\n  return <div />;\n}\n');
    write(
      'web/src/forms/profile-form.tsx',
      `import { z } from 'zod';

const User = z.object({ name: z.string() });
type User = z.infer<typeof User>;

export function ProfileForm({ user }: { user: User }) {
  return <form>{user.name}</form>;
}
`
    );
    await index();
    const referenced = cg.db.db
      .prepare(
        `SELECT DISTINCT t.file_path AS f FROM edges e
           JOIN nodes s ON s.id = e.source
           JOIN nodes t ON t.id = e.target
          WHERE s.name = 'ProfileForm' AND e.kind = 'references'`
      )
      .all()
      .map((row: any) => row.f);
    expect(referenced).toEqual(['web/src/forms/profile-form.tsx']);
  });
});
