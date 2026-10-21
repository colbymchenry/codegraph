/**
 * A sync redraws a JSX tag when a module its import is read through changes.
 *
 * A tag imported from a module of the project renders what that module
 * exports under the name, through an `index` that forwards it — outline's
 * `Sidebar/index.ts` is `import Sidebar from './App'; export default
 * Sidebar` — and past a wrapper around it (`export default
 * observer(AppSidebar)`). So the tag's edge depends on files that hold no
 * markup and no synthesized edge of their own: rewiring the index, or the
 * default export behind it, must redraw the tag, as a fresh index would draw
 * it, though the file that renders the tag is untouched.
 *
 * Every case compares the synced graph with a fresh index of the same files in
 * a folder of its own: indexing again over an existing index skips its
 * unchanged files, so it is no stand-in for one.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';

type Files = Record<string, string | null>;

const pkg = JSON.stringify({ name: 'app', dependencies: { react: '^18', 'mobx-react': '^9' } });

/** Two pages that render `<Sidebar>` through the same forwarding index. */
const BASE: Files = {
  'package.json': pkg,
  'src/components/Sidebar/Aside.tsx': 'export function Sidebar() {\n  return <aside />;\n}\n',
  'src/components/Sidebar/App.tsx':
    "import { observer } from 'mobx-react';\n\nfunction AppSidebar() {\n  return <nav />;\n}\n\nexport default observer(AppSidebar);\n",
  'src/components/Sidebar/Shared.tsx':
    "import { observer } from 'mobx-react';\n\nfunction SharedSidebar() {\n  return <nav />;\n}\n\nexport default observer(SharedSidebar);\n",
  'src/components/Sidebar/index.ts': "import Sidebar from './App';\n\nexport default Sidebar;\n",
  'src/scenes/Home.tsx': "import Sidebar from '../components/Sidebar';\n\nexport function Home() {\n  return <main><Sidebar /></main>;\n}\n",
  'src/scenes/Settings.tsx':
    "import Sidebar from '../components/Sidebar';\n\nexport function Settings() {\n  return <main><Sidebar /></main>;\n}\n",
};

let root: string | undefined;
let cg: CodeGraph | undefined;

afterEach(() => {
  cg?.close();
  cg = undefined;
  if (root) fs.rmSync(root, { recursive: true, force: true });
  root = undefined;
});

function write(dir: string, files: Files): void {
  for (const [file, text] of Object.entries(files)) {
    const full = path.join(dir, file);
    if (text === null) {
      fs.rmSync(full, { force: true });
      continue;
    }
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, text);
  }
}

/** Every node and edge by natural key, edge metadata included, so two indexes of the same files compare directly. */
function graphOf(graph: CodeGraph): string[] {
  const keys = new Map(
    graph.getFiles()
      .flatMap((file) => graph.getNodesInFile(file.path))
      .map((n) => [n.id, `${n.kind} ${n.filePath}:${n.qualifiedName}:${n.startLine}`] as const)
  );
  const edges = graph.getOutgoingEdgesFrom([...keys.keys()]).map((e) =>
    `${keys.get(e.source)} -${e.kind}-> ${keys.get(e.target) ?? e.target} ${JSON.stringify(e.metadata ?? null)} @${e.line ?? ''}:${e.column ?? ''}`);
  return [...[...keys.values()].map((k) => `node ${k}`), ...edges].sort();
}

/** `<parent> -> <child file>::<child>` for every JSX render edge. */
function renders(graph: CodeGraph): string[] {
  const out: string[] = [];
  for (const file of graph.getFiles()) {
    for (const node of graph.getNodesInFile(file.path)) {
      for (const e of graph.getOutgoingEdges(node.id)) {
        if (e.metadata?.synthesizedBy !== 'jsx-render') continue;
        const child = graph.getNode(e.target);
        out.push(`${node.name} -> ${child?.filePath}::${child?.name}`);
      }
    }
  }
  return out.sort();
}

/** The graph of a fresh index of `files`, in a folder of its own. */
async function freshGraph(files: Files): Promise<string[]> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-jsx-forward-fresh-'));
  try {
    write(dir, Object.fromEntries(Object.entries(files).filter(([, text]) => text !== null)));
    const fresh = await CodeGraph.init(dir, { index: true });
    try {
      return graphOf(fresh);
    } finally {
      fresh.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Index `initial`, then write each step and sync after it — with `scoped`, a
 * sync of only the step's files, as the file watcher runs it. Returns the
 * final files.
 */
async function indexThenSync(opts: { scoped: boolean }, initial: Files, ...steps: Files[]): Promise<Files> {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-jsx-forward-'));
  write(root, initial);
  cg = await CodeGraph.init(root, { index: true });
  const files = { ...initial };
  for (const step of steps) {
    write(root, step);
    Object.assign(files, step);
    await cg.sync(opts.scoped ? { paths: Object.keys(step) } : {});
  }
  return files;
}

describe('sync redraws a tag imported through a module that forwards it', () => {
  it('renders the forwarded component on a fresh index', async () => {
    await indexThenSync({ scoped: false }, BASE);
    expect(renders(cg!)).toEqual([
      'Home -> src/components/Sidebar/App.tsx::AppSidebar',
      'Settings -> src/components/Sidebar/App.tsx::AppSidebar',
    ]);
  }, 60_000);

  it.each([false, true])('when only the index changes which module it forwards (scoped=%s)', async (scoped) => {
    const files = await indexThenSync(
      { scoped },
      BASE,
      // Neither page changes, and the index has no markup of its own.
      { 'src/components/Sidebar/index.ts': "import Sidebar from './Shared';\n\nexport default Sidebar;\n" }
    );
    expect(renders(cg!)).toEqual([
      'Home -> src/components/Sidebar/Shared.tsx::SharedSidebar',
      'Settings -> src/components/Sidebar/Shared.tsx::SharedSidebar',
    ]);
    expect(graphOf(cg!)).toEqual(await freshGraph(files));
  }, 60_000);

  it('when the index starts holding the other module’s component in a value', async () => {
    const files = await indexThenSync(
      { scoped: true },
      BASE,
      // outline's `Avatar/index.ts` shape: `const Avatar = AvatarWithHoverCard; export { Avatar }`.
      { 'src/components/Sidebar/index.ts': "import Shared from './Shared';\n\nconst Sidebar = Shared;\n\nexport default Sidebar;\n" }
    );
    expect(renders(cg!)).toEqual([
      'Home -> src/components/Sidebar/Shared.tsx::SharedSidebar',
      'Settings -> src/components/Sidebar/Shared.tsx::SharedSidebar',
    ]);
    expect(graphOf(cg!)).toEqual(await freshGraph(files));
  }, 60_000);

  it('when the module behind the index wraps another component', async () => {
    const files = await indexThenSync(
      { scoped: false },
      BASE,
      {
        'src/components/Sidebar/App.tsx':
          "import { observer } from 'mobx-react';\n\nfunction AppSidebar() {\n  return <nav />;\n}\n\nfunction CompactSidebar() {\n  return <nav />;\n}\n\nexport default observer(CompactSidebar);\n",
      }
    );
    expect(renders(cg!)).toEqual([
      'Home -> src/components/Sidebar/App.tsx::CompactSidebar',
      'Settings -> src/components/Sidebar/App.tsx::CompactSidebar',
    ]);
    expect(graphOf(cg!)).toEqual(await freshGraph(files));
  }, 60_000);
});
