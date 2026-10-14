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
 * The pass reads tag names off a parent's source with a pattern, and two
 * kinds of name it reads that way are no other file's component.
 *
 * - A type argument: `<PaginatedList<Document> …>` or `useState<User>()`
 *   writes a type's name right after another name. outline's document list
 *   rendered its `Document` model class, its settings tables the `User` and
 *   `Group` classes.
 * - A name the parent binds itself, as a `const` or a parameter, is that local
 *   wherever its tags sit. outline's menus pick a Radix part into `const
 *   Content = variant === 'dropdown' ? DropdownMenu.SubContent :
 *   ContextMenu.SubContent` and rendered the command bar's styled `Content`
 *   instead. A local is no node, so it renders nothing, unless the parent
 *   declares a component of that name inside itself.
 */
describe('JSX child: a name the parent writes only as a type, or binds itself', () => {
  let dir: string;
  let cg: any;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsx-local-'));
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

  /** `name file:line` of each node a jsx-render edge out of `parent` points at. */
  const renders = (parent: string): string[] =>
    cg.db.db
      .prepare(
        `SELECT t.name || ' ' || t.file_path || ':' || t.start_line AS r FROM edges e
           JOIN nodes s ON s.id = e.source
           JOIN nodes t ON t.id = e.target
          WHERE s.name = ? AND json_extract(e.metadata, '$.synthesizedBy') = 'jsx-render'
          ORDER BY r`
      )
      .all(parent)
      .map((row: any) => row.r);

  it('renders nothing for a name written only as a type argument or parameter', async () => {
    write('app/models/Document.ts', 'export default class Document {\n  title = "";\n}\n');
    write('app/models/User.ts', 'export default class User {\n  name = "";\n}\n');
    write(
      'app/components/PaginatedList.tsx',
      'export function PaginatedList<T>({ items }: { items: T[] }) {\n  return <ul>{items.length}</ul>;\n}\n'
    );
    write(
      'app/components/Badge.tsx',
      'import * as React from "react";\nexport class Badge extends React.Component {\n  render() {\n    return <b />;\n  }\n}\n'
    );
    write(
      'app/components/DocumentList.tsx',
      `import * as React from 'react';
import Document from '../models/Document';
import User from '../models/User';
import { Badge } from './Badge';
import { PaginatedList } from './PaginatedList';

export function DocumentList({ items }: { items: Document[] }) {
  const [owner] = React.useState<User | null>(null);
  const badge = React.useRef<Badge>(null);
  return (
    <div>
      <PaginatedList<Document> items={items} />
      <Badge ref={badge} />
    </div>
  );
}
`
    );
    // bulletproof-react's table: a generic arrow function's type parameter.
    write('app/profile/entry.tsx', 'export function Entry() {\n  return <div />;\n}\n');
    write(
      'app/components/Table.tsx',
      `type BaseEntity = { id: string };

export const Table = <Entry extends BaseEntity>({ data }: { data: Entry[] }) => {
  return <table>{data.length}</table>;
};
`
    );
    await index();
    // `Badge` is written as a type argument too, but a tag of it is enough.
    // `<PaginatedList<Document>` is a tag that passes a type argument: it
    // renders PaginatedList, and its `Document` stays a type.
    expect(renders('DocumentList')).toEqual([
      'Badge app/components/Badge.tsx:2',
      'PaginatedList app/components/PaginatedList.tsx:1',
    ]);
    expect(renders('Table')).toEqual([]);
  });

  it('renders nothing for a name the parent binds itself as a const or a parameter', async () => {
    write(
      'app/components/CommandBarItem.tsx',
      'export function Content() {\n  return <div />;\n}\n\nexport function Icon() {\n  return <svg />;\n}\n'
    );
    write('shared/editor/Widget.tsx', 'export function Widget() {\n  return <div />;\n}\n');
    write('app/components/Portal.tsx', 'export function Portal({ children }) {\n  return <div>{children}</div>;\n}\n');
    write(
      'app/components/Menu.tsx',
      `import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import * as ContextMenu from '@radix-ui/react-context-menu';

const Portal = DropdownMenu.Portal;

export function SubMenuContent({ variant, children }) {
  const Portal =
    variant === 'dropdown' ? DropdownMenu.Portal : ContextMenu.Portal;
  const Content =
    variant === 'dropdown'
      ? DropdownMenu.SubContent
      : ContextMenu.SubContent;
  return (
    <Portal>
      <Content collisionPadding={6}>{children}</Content>
    </Portal>
  );
}

export function SettingsLinks({ config }) {
  return (
    <ul>
      {config.map((item) => {
        const Icon = item.icon;
        return <li key={item.path}><Icon /></li>;
      })}
    </ul>
  );
}

export function Widgets({ widgets }) {
  return <div>{Object.values(widgets).map((Widget, index) => <Widget key={index} />)}</div>;
}
`
    );
    await index();
    // The file's own `Portal` is shadowed too: the tag means the local.
    expect(renders('SubMenuContent')).toEqual([]);
    expect(renders('SettingsLinks')).toEqual([]);
    expect(renders('Widgets')).toEqual([]);
  });

  it('renders a component the parent declares inside itself, and the outer one for a tag above the local', async () => {
    write('a-decoy/row.tsx', 'export function Row() {\n  return <tr />;\n}\n');
    write('app/icon.tsx', 'export function Icon() {\n  return <svg />;\n}\n');
    write(
      'app/table.tsx',
      `import { Icon } from './icon';

function Row() {
  return <tr className="outer" />;
}

export function Table({ rows }) {
  const Row = ({ row }) => <tr>{row.name}</tr>;
  return <table>{rows.map((row) => <Row key={row.id} row={row} />)}</table>;
}

export function Toolbar({ actions }) {
  return (
    <div>
      <Icon />
      {actions.map((action) => {
        const Icon = action.icon;
        return <Icon key={action.id} />;
      })}
    </div>
  );
}
`
    );
    await index();
    expect(renders('Table')).toEqual(['Row app/table.tsx:8']);
    expect(renders('Toolbar')).toEqual(['Icon app/icon.tsx:1']);
  });

  it('keeps a destructured name on the same-named component, as a destructured call does', async () => {
    // excalidraw's example app: `const { Sidebar, Footer, … } = excalidrawLib`.
    // Destructuring is not the parent's own binding here, as it is not for a
    // bare call (`const { t } = useI18n()`), so the name links by name.
    write(
      'packages/excalidraw/components/WelcomeScreen.tsx',
      'export default function WelcomeScreen() {\n  return <div />;\n}\n'
    );
    write(
      'examples/app/ExampleApp.tsx',
      `export default function ExampleApp({ excalidrawLib }) {
  const { WelcomeScreen, exportToSvg } = excalidrawLib;
  return <div><WelcomeScreen /></div>;
}
`
    );
    await index();
    expect(renders('ExampleApp')).toEqual(['WelcomeScreen packages/excalidraw/components/WelcomeScreen.tsx:1']);
  });
});

/**
 * A generic component's tag passes its type arguments right after its name:
 * outline's lists render `<PaginatedList<Document> items={…} />`, excalidraw's
 * property panels `<RadioSelection<TextAlign | false> …>`. The pass read a
 * tag's name only where whitespace, `/` or `>` ended it, so a tag that `<`
 * ends was never read, and the parent had no edge to the component it renders.
 * The type arguments stay types.
 */
describe('JSX child: a tag that passes type arguments', () => {
  let dir: string;
  let cg: any;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsx-generic-'));
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

  /** `name file:line` of each node a jsx-render edge out of `parent` points at. */
  const renders = (parent: string): string[] =>
    cg.db.db
      .prepare(
        `SELECT t.name || ' ' || t.file_path || ':' || t.start_line AS r FROM edges e
           JOIN nodes s ON s.id = e.source
           JOIN nodes t ON t.id = e.target
          WHERE s.name = ? AND json_extract(e.metadata, '$.synthesizedBy') = 'jsx-render'
          ORDER BY r`
      )
      .all(parent)
      .map((row: any) => row.r);

  it('renders the component a generic tag names, however its type arguments are written', async () => {
    write('app/models/Document.ts', 'export default class Document {\n  title = "";\n}\n');
    write('app/models/Mode.ts', 'export class Mode {\n  name = "";\n}\n');
    write(
      'app/components/PaginatedList.tsx',
      `type PaginatedItem = { id: string };

const PaginatedList = <T extends PaginatedItem>({ items }: { items: T[] }) => {
  return <ul>{items.length}</ul>;
};

export default PaginatedList;
`
    );
    write(
      'app/components/RadioSelection.tsx',
      'export const RadioSelection = <T extends Object>({ value }: { value: T }) => {\n  return <div>{String(value)}</div>;\n};\n'
    );
    write(
      'app/components/DataTable.tsx',
      'export function DataTable<Row, Column>({ children }: { rows: Row[]; columns: Column[]; children?: unknown }) {\n  return <table>{children}</table>;\n}\n'
    );
    write(
      'app/components/DocumentList.tsx',
      `import PaginatedList from './PaginatedList';
import { RadioSelection } from './RadioSelection';
import { DataTable } from './DataTable';
import Document from '../models/Document';
import { Mode } from '../models/Mode';

export function DocumentList({ documents, mode }: { documents: Document[]; mode: Mode }) {
  return (
    <section>
      <PaginatedList<Document>
        items={documents}
      />
      <RadioSelection<Exclude<Mode, "auto"> | false> value={mode} />
      <DataTable<Document, string> rows={documents} columns={[]}>
        <p>{documents.length}</p>
      </DataTable>
    </section>
  );
}
`
    );
    await index();
    // `Document` and `Mode` are classes the tags pass as types, not children.
    expect(renders('DocumentList')).toEqual([
      'DataTable app/components/DataTable.tsx:1',
      'PaginatedList app/components/PaginatedList.tsx:3',
      'RadioSelection app/components/RadioSelection.tsx:1',
    ]);
  });

  it('still renders nothing for a generic type written as a type argument', async () => {
    write(
      'app/components/Grid.tsx',
      `import * as React from 'react';

export class Grid<Row> extends React.Component<{ rows: Row[] }> {
  render() {
    return <table>{this.props.rows.length}</table>;
  }
}
`
    );
    write(
      'app/components/Report.tsx',
      `import * as React from 'react';
import { Grid } from './Grid';

export function Report({ rows }: { rows: string[] }) {
  const grid = React.useRef<Grid<string>>(null);
  const [grids] = React.useState<Array<Grid<string>>>([]);
  return <section>{rows.length + grids.length}</section>;
}
`
    );
    await index();
    expect(renders('Report')).toEqual([]);
  });

  it('renders nothing for a generic tag the file imports from a package', async () => {
    // refine's examples: react95's `<Select<number>>` and antd's
    // `<Table<IPost>>` are the packages' own components, not another app's
    // Select or Table that shares the name.
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      '{"dependencies":{"react":"^18.0.0","react95":"^4.0.0","antd":"^5.0.0"}}'
    );
    write('apps/shadcn/components/ui/select.tsx', 'export function Select() {\n  return <select />;\n}\n');
    write('apps/shadcn/components/ui/table.tsx', 'export function Table() {\n  return <table />;\n}\n');
    write(
      'apps/win95/pages/posts.tsx',
      `import { Select } from 'react95';
import { Table } from 'antd';

type IPost = { id: number };

export function PostList({ posts }: { posts: IPost[] }) {
  return (
    <div>
      <Select<number> options={[]} />
      <Table<IPost> dataSource={posts} />
    </div>
  );
}
`
    );
    await index();
    expect(renders('PostList')).toEqual([]);
  });
});

/**
 * A tag the file declares itself as a VALUE — a lazily loaded page, a
 * wrapped component, an alias — is that declaration, whatever else in the
 * repository shares its name. A value is no component node, so the lookup by
 * kind used to skip it and take a lone same-named function anywhere: on
 * codedthemes' mantis (a vite app and a Next.js app in one repository) the
 * vite app's `RegisterPage` went to the Next.js app's page, and excalidraw's
 * Next.js example rendered the docs site's `Excalidraw`. Component resolution
 * keeps the same rule for every other reference to such a name (the last case).
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

  it('renders the branch of a conditional that loads lazily, and a wrapper typed past its call or given options', async () => {
    // SigNoz loads its devtools in development only and memoizes a table body
    // with a comparator; mastodon types its `forwardRef` with an object type
    // that keeps the generics.
    write('a-decoy/AuthZDevModal.tsx', 'export function AuthZDevModal() {\n  return <div />;\n}\n');
    write('a-decoy/Combobox.tsx', 'export function Combobox() {\n  return <div />;\n}\n');
    write('a-decoy/MemoizedRows.tsx', 'export function MemoizedRows() {\n  return <div />;\n}\n');
    write('src/lib/devtools/AuthZDevModal.tsx', 'export function AuthZDevModal() {\n  return <dialog />;\n}\n');
    write(
      'src/palette.tsx',
      `import React, { forwardRef } from 'react';

const IS_DEV = process.env.NODE_ENV === 'development';

const AuthZDevModal = IS_DEV
  ? React.lazy(() =>
      import('./lib/devtools/AuthZDevModal').then((m) => ({
        default: m.AuthZDevModal,
      })),
    )
  : null;

const ComboboxWithRef = <Item extends { id: string }>(
  props: { items: Item[] },
  ref: React.ForwardedRef<HTMLInputElement>,
) => {
  return <input ref={ref} />;
};

export const Combobox = forwardRef(ComboboxWithRef) as {
  <Item extends { id: string }>(props: { items: Item[] }): ReturnType<typeof ComboboxWithRef>;
  displayName: string;
};

function Rows({ rows }: { rows: string[] }) {
  return <ul>{rows.map((row) => <li key={row}>{row}</li>)}</ul>;
}

const MemoizedRows = React.memo(
  Rows,
  (prev, next) => prev.rows === next.rows,
) as typeof Rows;

export function Palette() {
  return <div>{AuthZDevModal && <AuthZDevModal />}<Combobox items={[]} /><MemoizedRows rows={[]} /></div>;
}
`
    );
    await index();
    expect(renders('Palette')).toEqual([
      'function AuthZDevModal src/lib/devtools/AuthZDevModal.tsx',
      'function ComboboxWithRef src/palette.tsx',
      'function Rows src/palette.tsx',
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
