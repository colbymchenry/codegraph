/**
 * A default import is the declaration the module's `export default` statement
 * names, wherever it sits in the file — not the first exported function.
 *
 * A React Router 6.4+ data-router page exports its loader or action above the
 * page component (`export function loader() {…}` then `export default function
 * Vans() {…}`), and `import Vans, { loader as vansLoader } from './Vans'` bound
 * `Vans` to `loader`: the route `/vans` rendered the loader, and every call
 * through the default import went there too. A component file that exports a
 * styled or memo component lost its default function or binding to that
 * component, and an anonymous default (`export default function () {…}`,
 * `export default () => …`) took whatever exported function came first — even
 * one nested inside the default itself.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

let root = '';
let cg: CodeGraph;

const files: Record<string, string> = {
  'package.json': JSON.stringify({ name: 'vanlife', private: true, dependencies: { react: '^18', 'react-router-dom': '^6.4' } }),
  'src/index.jsx': `import { RouterProvider, createBrowserRouter, createRoutesFromElements, Route } from "react-router-dom"
import Vans, { loader as vansLoader } from "./pages/Vans/Vans"
import HostVans, { loader as hostVansLoader } from "./pages/Host/HostVans"
import Login, { action as loginAction } from "./pages/Login"

const router = createBrowserRouter(createRoutesFromElements(
  <Route path="/">
    <Route path="login" element={<Login />} action={loginAction} />
    <Route path="vans" element={<Vans />} loader={vansLoader} />
    <Route path="host/vans" element={<HostVans />} loader={hostVansLoader} />
  </Route>
))

export default function App() {
  return <RouterProvider router={router} />
}
`,
  'src/api.js': `export function getVans() {
  return fetch("/api/vans")
}
`,
  'src/pages/Vans/Vans.jsx': `import { useLoaderData, defer } from "react-router-dom"
import { getVans } from "../../api"

export function loader() {
  return defer({ vans: getVans() })
}

export default function Vans() {
  const dataPromise = useLoaderData()
  function renderVanElements(vans) {
    return vans.map((van) => <h3 key={van.id}>{van.name}</h3>)
  }
  return <div>{renderVanElements(dataPromise.vans)}</div>
}
`,
  'src/pages/Host/HostVans.jsx': `import { useLoaderData } from "react-router-dom"
import { getVans } from "../../api"

export const loader = async () => getVans()

export default function HostVans() {
  return <ul>{useLoaderData().length}</ul>
}
`,
  'src/pages/Login.jsx': `import { useActionData } from "react-router-dom"

export async function action({ request }) {
  return request.formData()
}

export default function Login() {
  const data = useActionData()
  return <form>{data}</form>
}
`,
  // A Next.js API route: a helper exported above the default handler.
  'src/api/vans.ts': `export function listVans() {
  return []
}

export default async function handler(req: unknown, res: { json(v: unknown): void }) {
  res.json(listVans())
}
`,
  'src/store.ts': `export function createStore() {
  return {}
}

export default class Store {
  read() {
    return 1
  }
}
`,
  // A regex with a backtick inside a template literal's interpolation
  // (outline's headingToSlug): a string masker loses step there and blanked
  // the statement below it.
  'src/slug.ts': `export function escapeHtml(text: string) {
  return text
}

function safeSlugify(text: string) {
  return \`h-\${escapeHtml(text).replace(/[\`]/g, "")}\`
}

export default function headingToSlug(text: string, index = 0) {
  return index === 0 ? safeSlugify(text) : \`\${safeSlugify(text)}-\${index}\`
}
`,
  // A line break between the statement and the declaration it writes.
  'src/stream.js': `export function emit() {
  return 1
}

export default
function* stream() {
  yield emit()
}
`,
  // An exported styled component above the default function, or the binding.
  'src/components/Title.tsx': `import styled from "styled-components"

export const Heading = styled.h1\`
  font-size: 2rem;
\`

export default function Title() {
  return <Heading>Vans</Heading>
}
`,
  'src/components/Banner.tsx': `import styled from "styled-components"

export const Strip = styled.div\`
  display: flex;
\`

const Banner = () => <Strip />

export default Banner
`,
  // Anonymous defaults name no declaration of their own.
  'src/anonymous.js': `export function helper() {
  return 1
}

export default function () {
  function inner() {
    return helper()
  }
  return inner()
}
`,
  'src/arrow.jsx': `export function useThing() {
  return 1
}

export default () => {
  const handle = () => useThing()
  return <button onClick={handle} />
}
`,
  // An expression default keeps the class it instantiates.
  'src/service.ts': `export class Service {
  run() {
    return 1
  }
}

export default new Service()
`,
  'src/use.tsx': `import handler from "./api/vans"
import Store from "./store"
import headingToSlug from "./slug"
import stream from "./stream"
import Title from "./components/Title"
import Banner from "./components/Banner"
import runAnonymous from "./anonymous"
import Arrow from "./arrow"
import service from "./service"

export function consume() {
  handler({}, { json() {} })
  new Store().read()
  headingToSlug("Vans")
  stream()
  Title()
  Banner()
  runAnonymous()
  Arrow()
  service.run()
}
`,
};

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-default-export-'));
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

/** `file:name` of every node `consume` calls or instantiates. */
function consumed(): string[] {
  const consume = cg.getNodesInFile('src/use.tsx').find((n) => n.name === 'consume')!;
  return cg
    .getOutgoingEdges(consume.id)
    .filter((e) => e.kind === 'calls' || e.kind === 'instantiates')
    .map((e) => cg.getNode(e.target)!)
    .map((n) => `${n.filePath}:${n.name}`)
    .sort();
}

describe('a default import of a module that exports something above its default', () => {
  it('binds each data-router route to the page component, not its loader or action', () => {
    const bindings = cg
      .getNodesByKind('route')
      .flatMap((r) =>
        cg
          .getOutgoingEdges(r.id)
          .filter((e) => e.kind === 'references')
          .map((e) => `${r.name} -> ${cg.getNode(e.target)!.filePath}:${cg.getNode(e.target)!.name}`)
      )
      .sort();
    expect(bindings).toEqual([
      '/host/vans -> src/pages/Host/HostVans.jsx:HostVans',
      '/login -> src/pages/Login.jsx:Login',
      '/vans -> src/pages/Vans/Vans.jsx:Vans',
    ]);
  });

  it('calls the default-exported function or class the statement declares', () => {
    const targets = consumed();
    expect(targets).toContain('src/api/vans.ts:handler');
    expect(targets).toContain('src/store.ts:Store');
    expect(targets).toContain('src/slug.ts:headingToSlug');
    expect(targets).toContain('src/stream.js:stream');
    expect(targets).not.toContain('src/api/vans.ts:listVans');
    expect(targets).not.toContain('src/store.ts:createStore');
    expect(targets).not.toContain('src/slug.ts:escapeHtml');
    expect(targets).not.toContain('src/stream.js:emit');
  });

  it('prefers what the statement exports to an exported component above it', () => {
    const targets = consumed();
    expect(targets).toContain('src/components/Title.tsx:Title');
    expect(targets).toContain('src/components/Banner.tsx:Banner');
    expect(targets).not.toContain('src/components/Title.tsx:Heading');
    expect(targets).not.toContain('src/components/Banner.tsx:Strip');
  });

  it('binds an anonymous default to nothing, not to an exported function beside or inside it', () => {
    const targets = consumed();
    for (const wrong of ['src/anonymous.js:helper', 'src/anonymous.js:inner', 'src/arrow.jsx:useThing', 'src/arrow.jsx:handle']) {
      expect(targets).not.toContain(wrong);
    }
  });

  it('still finds the class behind an expression default', () => {
    expect(consumed()).toContain('src/service.ts:run');
  });
});
