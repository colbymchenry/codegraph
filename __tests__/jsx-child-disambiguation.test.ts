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
