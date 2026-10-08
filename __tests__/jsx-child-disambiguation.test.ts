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
    // A generic tag's own name is not read at all: no tag ends after
    // `<PaginatedList` (its type arguments follow).
    expect(renders('DocumentList')).toEqual(['Badge app/components/Badge.tsx:2']);
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
