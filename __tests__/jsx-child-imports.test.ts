import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { CodeGraph } from '../src';

/**
 * A JSX tag the file imports renders what that import resolves to — through
 * barrels, renames and the module's default export — not whichever component
 * happens to share the tag's name. The synthesizer used to pick by name and
 * consult the import only to break a tie, so a monorepo whose apps each import
 * `Button` from their own `@/components/ui/button` barrel rendered another
 * app's copy (the barrel declares no `Button` to break the tie with), a
 * default import named like an unrelated symbol bound that symbol, and a
 * function component default-imported under another name rendered nothing.
 *
 * Following the import is only as good as the default-export lookup behind
 * it, which guessed — the first exported function or component of the module
 * stood in for its default export — so these also pin that it reads the
 * module's `export default` statement instead.
 */
describe('JSX tags follow the file’s import of them', () => {
  let dir: string;
  let cg: any;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsx-import-'));
    fs.writeFileSync(path.join(dir, 'package.json'), '{"dependencies":{"react":"^18.0.0","mobx-react":"^9.0.0"}}');
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

  /** `file:name` of every node a jsx-render edge out of `parent` points at. */
  const rendersFrom = (db: any, parent: string): string[] =>
    db
      .prepare(
        `SELECT t.file_path || ':' || t.name AS r FROM edges e
           JOIN nodes s ON s.id = e.source
           JOIN nodes t ON t.id = e.target
          WHERE s.name = ? AND json_extract(e.metadata, '$.synthesizedBy') = 'jsx-render'
          ORDER BY r`
      )
      .all(parent)
      .map((r: any) => r.r);

  it('renders its own app’s component through a barrel when every app has one of that name', async () => {
    // Each app's `@/` is its own `src/`; the barrel only re-exports, so it
    // declares no `Button` for a name lookup to find. The decoy app sorts first.
    for (const app of ['a-admin', 'b-shop']) {
      write(`apps/${app}/tsconfig.json`, JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['./src/*'] } } }));
      write(`apps/${app}/src/components/ui/button/index.ts`, `export * from './button';\n`);
      write(
        `apps/${app}/src/components/ui/button/button.tsx`,
        `import * as React from 'react';
const Button = React.forwardRef<HTMLButtonElement, {}>((props, ref) => <button ref={ref} {...props} />);
Button.displayName = 'Button';
export { Button };
`
      );
    }
    write(
      'apps/b-shop/src/features/cart/checkout.tsx',
      `import { Button } from '@/components/ui/button';
export function Checkout() { return <form><Button>Pay</Button></form>; }
`
    );
    const db = await index();
    expect(rendersFrom(db, 'Checkout')).toEqual(['apps/b-shop/src/components/ui/button/button.tsx:Button']);
  });

  it('renders a module’s default export under any local name, never a same-named symbol elsewhere', async () => {
    write('a-decoy/settings.tsx', `export function Settings() { return <div>decoy</div>; }\n`);
    write('routes/app/settings.tsx', `export default function SettingsRoute() { return <div>settings</div>; }\n`);
    write('routes/app/profile.tsx', `export function ProfileRoute() { return <div>profile</div>; }\n`);
    write(
      'router.tsx',
      `import { default as Settings } from './routes/app/settings';
export function AliasedRouter() { return <Settings />; }
`
    );
    write(
      'router-default.tsx',
      `import Settings from './routes/app/settings';
export function DefaultRouter() { return <Settings />; }
`
    );
    write(
      'router-renamed.tsx',
      `import { ProfileRoute as Settings } from './routes/app/profile';
export function RenamedRouter() { return <Settings />; }
`
    );
    const db = await index();
    expect(rendersFrom(db, 'AliasedRouter')).toEqual(['routes/app/settings.tsx:SettingsRoute']);
    expect(rendersFrom(db, 'DefaultRouter')).toEqual(['routes/app/settings.tsx:SettingsRoute']);
    expect(rendersFrom(db, 'RenamedRouter')).toEqual(['routes/app/profile.tsx:ProfileRoute']);
  });

  it('renders a function component default-imported under another name', async () => {
    write('pages/settings.tsx', `export default function SettingsPage() { return <main />; }\n`);
    write(
      'app.tsx',
      `import Settings from './pages/settings';
export function App() { return <Settings />; }
`
    );
    const db = await index();
    expect(rendersFrom(db, 'App')).toEqual(['pages/settings.tsx:SettingsPage']);
  });

  it('reads the default export from its statement, past the functions exported above it', async () => {
    // A data router's route module: `loader` and `action` come first, and the
    // first exported function used to stand in for the default export.
    write(
      'pages/vans.tsx',
      `export async function loader() { return []; }
export function action() { return null; }
export default function Vans() { return <ul />; }
`
    );
    write(
      'pages/card.tsx',
      `import { observer } from 'mobx-react';
export function formatPrice(n: number) { return '$' + n; }
function Card() { return <div />; }
export default observer(Card);
`
    );
    write(
      'app.tsx',
      `import VansPage from './pages/vans';
import PriceCard from './pages/card';
export function App() { return <div><VansPage /><PriceCard /></div>; }
`
    );
    const db = await index();
    expect(rendersFrom(db, 'App')).toEqual(['pages/card.tsx:Card', 'pages/vans.tsx:Vans']);
  });

  it('renders nothing for a default export with no declaration of its own, not a same-named symbol elsewhere', async () => {
    write('app/header.tsx', `export function Header() { return <nav>app header</nav>; }\n`);
    write('emails/components/header.tsx', `export default () => <header>email header</header>;\n`);
    write(
      'emails/welcome.tsx',
      `import Header from './components/header';
export function Welcome() { return <div><Header /></div>; }
`
    );
    const db = await index();
    expect(rendersFrom(db, 'Welcome')).toEqual([]);
  });

  it('renders the component an anonymous default wraps when its own module declares it', async () => {
    // A React Router v6 shim around a class-era page: the default export renders `Search`.
    write('a-decoy/search.tsx', `export function Search() { return <div>decoy</div>; }\n`);
    write(
      'pages/search.tsx',
      `export function Search(props: any) { return <div>search</div>; }
export default (props: any) => <Search {...props} />;
`
    );
    write(
      'routes.tsx',
      `import Search from './pages/search';
export function Routes() { return <Search />; }
`
    );
    const db = await index();
    expect(rendersFrom(db, 'Routes')).toEqual(['pages/search.tsx:Search']);
  });

  it('renders the value a module declares under the name of its props type', async () => {
    write(
      'components/collapse-button.tsx',
      `export interface CollapseButton { label: string }
export const CollapseButton = ({ label }: CollapseButton) => <button>{label}</button>;
`
    );
    write(
      'sidebar.tsx',
      `import { CollapseButton } from './components/collapse-button';
export function Sidebar() { return <nav><CollapseButton label="x" /></nav>; }
`
    );
    const db = await index();
    expect(rendersFrom(db, 'Sidebar')).toEqual(['components/collapse-button.tsx:CollapseButton']);
  });

  it('renders a native component a spec module exports, directly or through a value', async () => {
    fs.writeFileSync(path.join(dir, 'package.json'), '{"dependencies":{"react":"^18.0.0","react-native":"^0.73"}}');
    write(
      'spec/MyViewNativeComponent.ts',
      `import { codegenNativeComponent } from 'react-native';
export interface NativeProps { color?: string }
export default codegenNativeComponent<NativeProps>('MyView');
`
    );
    write(
      'spec/OtherViewNativeComponent.ts',
      `import { codegenNativeComponent } from 'react-native';
export interface NativeProps { size?: number }
const OtherViewNativeComponent = codegenNativeComponent<NativeProps>('OtherView');
export default OtherViewNativeComponent;
`
    );
    write(
      'src/App.tsx',
      `import NativeView from '../spec/MyViewNativeComponent';
import OtherView from '../spec/OtherViewNativeComponent';
export function App() { return <NativeView><OtherView /></NativeView>; }
`
    );
    const db = await index();
    expect(rendersFrom(db, 'App')).toEqual([
      'spec/MyViewNativeComponent.ts:MyView',
      'spec/OtherViewNativeComponent.ts:OtherView',
    ]);
  });

  it('renders a class imported under another name only where the name is written as a tag', async () => {
    write(
      'editor/index.tsx',
      `import * as React from 'react';
export default class Editor extends React.Component { render() { return <div />; } }
`
    );
    write('models/import.ts', `export default class Import { id = ''; }\n`);
    write(
      'components/editor-host.tsx',
      `import * as React from 'react';
import SharedEditor from '../editor';
import ImportModel from '../models/import';
export function EditorHost() {
  const ref = React.useRef<SharedEditor>(null);
  const [current] = React.useState<ImportModel | null>(null);
  return <section>{current ? 'busy' : null}</section>;
}
export function EditorFrame() { return <SharedEditor />; }
`
    );
    const db = await index();
    expect(rendersFrom(db, 'EditorHost')).toEqual([]);
    expect(rendersFrom(db, 'EditorFrame')).toEqual(['editor/index.tsx:Editor']);
  });

  it('follows an index that forwards a default export, and a value that aliases a component', async () => {
    write('a-decoy/avatar.tsx', `export function Avatar() { return <img alt="decoy" />; }\n`);
    write('a-decoy/marker.tsx', `export function Marker() { return <i>decoy</i>; }\n`);
    write('components/Avatar/Avatar.tsx', `export default function Avatar() { return <img alt="real" />; }\n`);
    write('components/Avatar/index.ts', `import Avatar from './Avatar';\nexport default Avatar;\n`);
    write('components/Map/marker.tsx', `export default function Marker() { return <i />; }\n`);
    write('components/Map/index.ts', `import Marker from './marker';\nexport { Marker };\n`);
    write('components/Badge/BadgeWithTooltip.tsx', `export default function BadgeWithTooltip() { return <span />; }\n`);
    write(
      'components/Badge/index.ts',
      `import BadgeWithTooltip from './BadgeWithTooltip';
const Badge = BadgeWithTooltip;
export { Badge };
`
    );
    write(
      'profile.tsx',
      `import Avatar from './components/Avatar';
import { Badge } from './components/Badge';
import { Marker } from './components/Map';
export function Profile() { return <div><Avatar /><Badge /><Marker /></div>; }
`
    );
    const db = await index();
    expect(rendersFrom(db, 'Profile')).toEqual([
      'components/Avatar/Avatar.tsx:Avatar',
      'components/Badge/BadgeWithTooltip.tsx:BadgeWithTooltip',
      'components/Map/marker.tsx:Marker',
    ]);
  });
});

describe('a call through a default import', () => {
  let dir: string;
  let cg: any;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'default-call-'));
  });

  afterEach(() => {
    cg?.close?.();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('reaches the function the module exports as its default, not the first one it exports', async () => {
    fs.writeFileSync(
      path.join(dir, 'app.ts'),
      `export function helper() { return 1; }
export default function createApp() { return helper() + 1; }
`
    );
    fs.writeFileSync(
      path.join(dir, 'main.ts'),
      `import makeApp from './app';
export function start() { return makeApp(); }
`
    );
    cg = await CodeGraph.init(dir, { silent: true });
    await cg.indexAll();
    const callees = (cg as any).db.db
      .prepare(
        `SELECT t.name AS n FROM edges e
           JOIN nodes s ON s.id = e.source
           JOIN nodes t ON t.id = e.target
          WHERE s.name = 'start' AND e.kind = 'calls'`
      )
      .all()
      .map((r: any) => r.n);
    expect(callees).toEqual(['createApp']);
  });

  it('reaches the function a wrapper call hands on, and the methods of an exported instance', async () => {
    fs.writeFileSync(
      path.join(dir, 'tracing.ts'),
      `export function traceFunction(opts: object) { return <T>(fn: T) => fn; }\n`
    );
    fs.writeFileSync(
      path.join(dir, 'provisioner.ts'),
      `import { traceFunction } from './tracing';
export type Result = { ok: boolean };
async function accountProvisioner() { return { ok: true }; }
export default traceFunction({ spanName: 'accountProvisioner' })(accountProvisioner);
`
    );
    fs.writeFileSync(
      path.join(dir, 'storage.ts'),
      `export function storageKey(k: string) { return 'app:' + k; }
export class Storage {
  get(key: string) { return localStorage.getItem(storageKey(key)); }
}
export default new Storage();
`
    );
    fs.writeFileSync(
      path.join(dir, 'main.ts'),
      `import provision from './provisioner';
import Storage from './storage';
export async function signIn() { await provision(); return Storage.get('user'); }
`
    );
    cg = await CodeGraph.init(dir, { silent: true });
    await cg.indexAll();
    const callees = (cg as any).db.db
      .prepare(
        `SELECT t.kind || ' ' || t.name AS n FROM edges e
           JOIN nodes s ON s.id = e.source
           JOIN nodes t ON t.id = e.target
          WHERE s.name = 'signIn' AND e.kind = 'calls'
          ORDER BY n`
      )
      .all()
      .map((r: any) => r.n);
    expect(callees).toEqual(['function accountProvisioner', 'method get']);
  });
});
