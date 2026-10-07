/**
 * A sync binds a navigation call to a route that appears after the call was
 * indexed, for every router, as a full index binds it.
 *
 * `history.push('/login')`, `navigate('/login')`, `router.push('/x')`,
 * `goto('/x')`: a navigation call names its route by path and its reference
 * by the router's method. While the route did not exist, the call was parked
 * as failed, and sync's retry — a failed ref's name tail against the names
 * the synced files define — never found it, because no file that adds
 * `/login` defines anything named `push`. The synced index kept a failure a
 * fresh index of the same files does not have (CG-33).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';
import { QueryBuilder } from '../src/db/queries';
import { referenceNameTail } from '../src/db/reference-tail';
import { getAllFrameworkResolvers } from '../src/resolution/frameworks';
import { changedRoutes, type ReferenceResolver } from '../src/resolution';
import type { Node } from '../src/types';

interface Case {
  name: string;
  /** The project as it ends up. */
  files: Record<string, string>;
  /** The file the route comes from, and what it holds while the route does not exist (null: no such file yet). */
  route: { file: string; before: string | null };
  /** The file whose navigation call waits for the route. */
  from: string;
  /** Where that call goes once the route exists: `<href> → <route>`. */
  expected: string;
}

const angularComponent = (name: string, body = '', template = '<p>x</p>') => `import { Component } from '@angular/core';
import { Router } from '@angular/router';
@Component({ selector: 'app-x', template: '${template}' })
export class ${name} {
  constructor(private readonly router: Router) {}
${body}
}
`;

const CASES: Case[] = [
  {
    name: 'React Router (a <Route> in the markup)',
    files: {
      'package.json': JSON.stringify({ name: 'shop', dependencies: { react: '18', 'react-router-dom': '5' } }),
      'src/App.js':
        "import { BrowserRouter as Router, Route } from 'react-router-dom'\n" +
        "import LoginScreen from './screens/LoginScreen'\n" +
        "import CartScreen from './screens/CartScreen'\n" +
        'const App = () => (\n' +
        '  <Router>\n' +
        "    <Route path='/login' component={LoginScreen} />\n" +
        "    <Route path='/cart' component={CartScreen} />\n" +
        '  </Router>\n' +
        ')\n' +
        'export default App\n',
      'src/screens/LoginScreen.js': 'const LoginScreen = () => <div>Login</div>\nexport default LoginScreen\n',
      'src/screens/CartScreen.js':
        'const CartScreen = ({ history }) => {\n' +
        '  const checkout = () => {\n' +
        "    history.push('/login?redirect=shipping')\n" +
        '  }\n' +
        '  return <button onClick={checkout}>Checkout</button>\n' +
        '}\n' +
        'export default CartScreen\n',
    },
    route: {
      file: 'src/App.js',
      before:
        "import { BrowserRouter as Router, Route } from 'react-router-dom'\n" +
        "import LoginScreen from './screens/LoginScreen'\n" +
        "import CartScreen from './screens/CartScreen'\n" +
        'const App = () => (\n' +
        '  <Router>\n' +
        "    <Route path='/cart' component={CartScreen} />\n" +
        '  </Router>\n' +
        ')\n' +
        'export default App\n',
    },
    from: 'src/screens/CartScreen.js',
    expected: '/login?redirect=shipping → /login',
  },
  {
    name: 'React Router (a path built from a constant another file holds)',
    files: {
      'package.json': JSON.stringify({ name: 'web', dependencies: { react: '18', 'react-router': '7' } }),
      'src/config/paths.ts': "export const paths = {\n  auth: { login: { path: '/auth/login' } },\n} as const;\n",
      'src/app/router.tsx':
        "import { createBrowserRouter } from 'react-router';\n" +
        "import { paths } from '../config/paths';\n" +
        "import { LoginRoute } from './routes/login';\n" +
        'export const router = createBrowserRouter([\n' +
        '  { path: paths.auth.login.path, element: <LoginRoute /> },\n' +
        ']);\n',
      'src/app/routes/login.tsx': 'export function LoginRoute() { return null; }\n',
      'src/lib/auth.tsx':
        "import { useNavigate } from 'react-router';\n" +
        'export function Logout() {\n' +
        '  const navigate = useNavigate();\n' +
        "  return <button onClick={() => navigate('/auth/login')}>out</button>;\n" +
        '}\n',
    },
    // The route's own file never changes: the constant it reads does.
    route: { file: 'src/config/paths.ts', before: "export const paths = {\n  auth: { login: { path: '/auth/sign-in' } },\n} as const;\n" },
    from: 'src/lib/auth.tsx',
    expected: '/auth/login → /auth/login',
  },
  {
    // The routes live in a file that never changes: they exist only while
    // another file hands that table to the router.
    name: 'React Router (a table another file hands the router)',
    files: {
      'package.json': JSON.stringify({ name: 'app', dependencies: { react: '18', 'react-router-dom': '6' } }),
      'src/AppRoutes.js':
        "import { Home } from './Home';\n" +
        "import { Counter } from './Counter';\n" +
        'const AppRoutes = [\n' +
        '  { index: true, element: <Home /> },\n' +
        "  { path: '/counter', element: <Counter /> },\n" +
        '];\n' +
        'export default AppRoutes;\n',
      'src/App.js':
        "import { Route, Routes } from 'react-router-dom';\n" +
        "import AppRoutes from './AppRoutes';\n" +
        'export default function App() {\n' +
        '  return <Routes>{AppRoutes.map(({ element, ...rest }, index) => <Route key={index} {...rest} element={element} />)}</Routes>;\n' +
        '}\n',
      'src/Home.js': 'export function Home() { return null; }\n',
      'src/Counter.js': 'export function Counter() { return null; }\n',
      'src/NavMenu.js':
        "import { Link, useNavigate } from 'react-router-dom';\n" +
        'export function NavMenu() {\n' +
        '  const navigate = useNavigate();\n' +
        "  const goHome = () => navigate('/');\n" +
        '  return <nav><button onClick={goHome}>Home</button><Link to="/counter">Counter</Link></nav>;\n' +
        '}\n',
    },
    route: {
      file: 'src/App.js',
      before:
        "import { Route, Routes } from 'react-router-dom';\n" +
        "import { Counter } from './Counter';\n" +
        'export default function App() {\n' +
        '  return <Routes><Route path="/static" element={<Counter />} /></Routes>;\n' +
        '}\n',
    },
    from: 'src/NavMenu.js',
    expected: '/ → /',
  },
  {
    name: 'React Router (one arm of a conditional destination)',
    files: {
      'package.json': JSON.stringify({ name: 'shop', dependencies: { react: '18', 'react-router-dom': '5' } }),
      'src/App.js':
        "import { BrowserRouter as Router, Route } from 'react-router-dom'\n" +
        "import LoginScreen from './screens/LoginScreen'\n" +
        "import CartScreen from './screens/CartScreen'\n" +
        'const App = () => (\n' +
        '  <Router>\n' +
        "    <Route path='/login' component={LoginScreen} />\n" +
        "    <Route path='/cart' component={CartScreen} />\n" +
        '  </Router>\n' +
        ')\n' +
        'export default App\n',
      'src/screens/LoginScreen.js': 'const LoginScreen = () => <div>Login</div>\nexport default LoginScreen\n',
      // While `/login` is missing the call still resolves, through its other
      // arm: it is not parked as failed, it lost a destination.
      'src/screens/CartScreen.js':
        'const CartScreen = ({ history, user }) => {\n' +
        '  const checkout = () => {\n' +
        "    history.push(user ? '/cart' : '/login')\n" +
        '  }\n' +
        '  return <button onClick={checkout}>Checkout</button>\n' +
        '}\n' +
        'export default CartScreen\n',
    },
    route: {
      file: 'src/App.js',
      before:
        "import { BrowserRouter as Router, Route } from 'react-router-dom'\n" +
        "import CartScreen from './screens/CartScreen'\n" +
        'const App = () => (\n' +
        '  <Router>\n' +
        "    <Route path='/cart' component={CartScreen} />\n" +
        '  </Router>\n' +
        ')\n' +
        'export default App\n',
    },
    from: 'src/screens/CartScreen.js',
    expected: '/login → /login',
  },
  {
    name: 'React Router (a parameter route that took the call meanwhile)',
    files: {
      'package.json': JSON.stringify({ name: 'admin', dependencies: { react: '18', 'react-router-dom': '6' } }),
      'src/App.jsx':
        "import { Routes, Route } from 'react-router-dom'\n" +
        "import { User, NewUser } from './User'\n" +
        'export const App = () => (\n' +
        '  <Routes>\n' +
        '    <Route path="/users/new" element={<NewUser />} />\n' +
        '    <Route path="/users/:id" element={<User />} />\n' +
        '  </Routes>\n' +
        ')\n',
      'src/User.jsx': 'export const User = () => <div>User</div>\nexport const NewUser = () => <div>New</div>\n',
      'src/Admin.jsx':
        "import { useNavigate } from 'react-router-dom'\n" +
        'export const Admin = () => {\n' +
        '  const navigate = useNavigate()\n' +
        "  const add = () => navigate('/users/new')\n" +
        '  return <button onClick={add}>Add</button>\n' +
        '}\n',
    },
    route: {
      file: 'src/App.jsx',
      before:
        "import { Routes, Route } from 'react-router-dom'\n" +
        "import { User } from './User'\n" +
        'export const App = () => (\n' +
        '  <Routes>\n' +
        '    <Route path="/users/:id" element={<User />} />\n' +
        '  </Routes>\n' +
        ')\n',
    },
    from: 'src/Admin.jsx',
    expected: '/users/new → /users/new',
  },
  {
    name: 'Next.js',
    files: {
      'package.json': JSON.stringify({ name: 'site', dependencies: { next: '15', react: '19' } }),
      'app/page.tsx': 'export default function Home() {\n  return null\n}\n',
      'app/login/page.tsx': 'export default function LoginPage() {\n  return null\n}\n',
      'components/logout-button.tsx':
        "'use client'\n" +
        "import { useRouter } from 'next/navigation'\n" +
        'export function LogoutButton() {\n' +
        '  const router = useRouter()\n' +
        "  const out = () => router.push('/login')\n" +
        '  return <button onClick={out}>Log out</button>\n' +
        '}\n',
    },
    route: { file: 'app/login/page.tsx', before: null },
    from: 'components/logout-button.tsx',
    expected: '/login → /login',
  },
  {
    name: 'Expo Router',
    files: {
      'package.json': JSON.stringify({ name: 'app', dependencies: { expo: '52', 'expo-router': '4', react: '18' } }),
      'src/app/_layout.tsx': 'export default function Layout() { return null }\n',
      'src/app/index.tsx': 'export default function Home() { return null }\n',
      'src/app/settings.tsx': 'export default function Settings() { return null }\n',
      'src/services/nav.ts': "import { router } from 'expo-router'\nexport function openSettings() {\n  router.push('/settings')\n}\n",
    },
    route: { file: 'src/app/settings.tsx', before: null },
    from: 'src/services/nav.ts',
    expected: '/settings → /settings',
  },
  {
    name: 'Expo Router (a catch-all screen that took the call meanwhile)',
    files: {
      'package.json': JSON.stringify({ name: 'app', dependencies: { expo: '52', 'expo-router': '4', react: '18' } }),
      'src/app/_layout.tsx': 'export default function Layout() { return null }\n',
      'src/app/index.tsx': 'export default function Home() { return null }\n',
      'src/app/[...missing].tsx': 'export default function NotFound() { return null }\n',
      'src/app/login.tsx': 'export default function Login() { return null }\n',
      'src/services/session.ts': "import { router } from 'expo-router'\nexport function signOut() {\n  router.replace('/login')\n}\n",
    },
    route: { file: 'src/app/login.tsx', before: null },
    from: 'src/services/session.ts',
    expected: '/login → /login',
  },
  {
    name: 'Vue Router',
    files: {
      'package.json': JSON.stringify({ name: 'conduit', dependencies: { vue: '3', 'vue-router': '4' } }),
      'src/router/index.js':
        'import { createRouter, createWebHistory } from "vue-router"\n' +
        'const router = createRouter({\n' +
        '  history: createWebHistory(),\n' +
        '  routes: [\n' +
        '    { name: "home", path: "/", component: () => import("@/views/Home") },\n' +
        '    { name: "login", path: "/login", component: () => import("@/views/Login") },\n' +
        '  ]\n' +
        '})\n' +
        'export default router\n',
      'src/views/Home.vue':
        '<template>\n  <button @click="signIn">Sign in</button>\n</template>\n' +
        '<script setup>\n' +
        'import { useRouter } from "vue-router"\n' +
        'const router = useRouter()\n' +
        'function signIn() {\n' +
        '  router.push("/login")\n' +
        '}\n' +
        '</script>\n',
      'src/views/Login.vue': '<template>\n  <div>Login</div>\n</template>\n<script setup>\nconst x = 1\n</script>\n',
    },
    route: {
      file: 'src/router/index.js',
      before:
        'import { createRouter, createWebHistory } from "vue-router"\n' +
        'const router = createRouter({\n' +
        '  history: createWebHistory(),\n' +
        '  routes: [\n' +
        '    { name: "home", path: "/", component: () => import("@/views/Home") },\n' +
        '  ]\n' +
        '})\n' +
        'export default router\n',
    },
    from: 'src/views/Home.vue',
    expected: '/login → /login',
  },
  {
    name: 'Angular',
    files: {
      'package.json': JSON.stringify({ dependencies: { '@angular/core': '19', '@angular/router': '19' } }),
      'src/app/app.routes.ts':
        "import { Routes } from '@angular/router';\n" +
        "import { HomeComponent } from './home.component';\n" +
        "import { LoginComponent } from './login.component';\n" +
        'export const routes: Routes = [\n' +
        "  { path: 'home', component: HomeComponent },\n" +
        "  { path: 'login', component: LoginComponent },\n" +
        '];\n',
      'src/app/home.component.ts': angularComponent('HomeComponent', "  signIn() { this.router.navigate(['/login']); }"),
      'src/app/login.component.ts': angularComponent('LoginComponent'),
    },
    route: {
      file: 'src/app/app.routes.ts',
      before:
        "import { Routes } from '@angular/router';\n" +
        "import { HomeComponent } from './home.component';\n" +
        'export const routes: Routes = [\n' +
        "  { path: 'home', component: HomeComponent },\n" +
        '];\n',
    },
    from: 'src/app/home.component.ts',
    expected: '/login → /login',
  },
  {
    // A link in a template is a synthesizer's edge, and a routes file holds
    // nothing that sends a sync to the synthesizers on its own.
    name: 'Angular (a routerLink, the routes file added later)',
    files: {
      'package.json': JSON.stringify({ dependencies: { '@angular/core': '19', '@angular/router': '19' } }),
      'src/app/app.routes.ts':
        "import { Routes } from '@angular/router';\n" +
        "import { HomeComponent } from './home.component';\n" +
        "import { LoginComponent } from './login.component';\n" +
        'export const routes: Routes = [\n' +
        "  { path: 'home', component: HomeComponent },\n" +
        "  { path: 'login', component: LoginComponent },\n" +
        '];\n',
      'src/app/home.component.ts': angularComponent('HomeComponent', '', '<a routerLink="/login">Sign in</a>'),
      'src/app/login.component.ts': angularComponent('LoginComponent'),
    },
    route: { file: 'src/app/app.routes.ts', before: null },
    from: 'src/app/home.component.ts',
    expected: '/login → /login',
  },
  {
    name: 'TanStack Router',
    files: {
      'package.json': JSON.stringify({ name: 'app', dependencies: { react: '19', '@tanstack/react-router': '1' } }),
      'src/routes/index.tsx':
        "import { createFileRoute, useNavigate } from '@tanstack/react-router'\n" +
        "export const Route = createFileRoute('/')({ component: IndexComponent })\n" +
        'function IndexComponent() {\n' +
        '  const navigate = useNavigate()\n' +
        "  const signIn = () => navigate({ to: '/login' })\n" +
        '  return <button onClick={signIn}>Sign in</button>\n' +
        '}\n',
      'src/routes/login.tsx':
        "import { createFileRoute } from '@tanstack/react-router'\n" +
        "export const Route = createFileRoute('/login')({ component: LoginComponent })\n" +
        'function LoginComponent() {\n  return <div>Login</div>\n}\n',
    },
    route: { file: 'src/routes/login.tsx', before: null },
    from: 'src/routes/index.tsx',
    expected: '/login → /login',
  },
  {
    name: 'SvelteKit',
    files: {
      'package.json': JSON.stringify({ name: 'conduit', devDependencies: { '@sveltejs/kit': '2', svelte: '5' } }),
      'src/routes/+page.svelte': '<h1>Home</h1>\n',
      'src/routes/settings/+page.svelte': '<h1>Settings</h1>\n',
      'src/routes/settings/+page.server.js':
        "import { redirect } from '@sveltejs/kit'\n" +
        'export function load({ locals }) {\n' +
        "  if (!locals.user) redirect(302, '/login')\n" +
        '}\n',
      'src/routes/login/+page.svelte': '<h1>Sign in</h1>\n',
    },
    route: { file: 'src/routes/login/+page.svelte', before: null },
    from: 'src/routes/settings/+page.server.js',
    expected: '/login → /login',
  },
];

const roots: string[] = [];
const graphs: CodeGraph[] = [];

afterEach(() => {
  for (const graph of graphs.splice(0)) graph.close();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-sync-nav-'));
  roots.push(root);
  return root;
}

function write(root: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
}

/** Set a file's content, or remove the file for null. */
function put(root: string, rel: string, content: string | null): void {
  if (content === null) fs.rmSync(path.join(root, rel));
  else write(root, { [rel]: content });
}

async function index(root: string): Promise<CodeGraph> {
  const graph = await CodeGraph.init(root, { index: true });
  graphs.push(graph);
  return graph;
}

/** `<href> → <route>` for every navigation out of `file`. */
function navigations(graph: CodeGraph, file: string): string[] {
  const ids = graph.getNodesInFile(file).map((n) => n.id);
  return graph
    .getOutgoingEdgesFrom(ids, ['navigates'])
    .map((edge) => `${String(edge.metadata?.href)} → ${graph.getNode(edge.target)?.name}`)
    .sort();
}

/** The same files, indexed from scratch in a folder of their own. */
async function freshNavigations(files: Record<string, string>, file: string): Promise<string[]> {
  const root = tempRoot();
  write(root, files);
  return navigations(await index(root), file);
}

function internals(graph: CodeGraph): { queries: QueryBuilder; resolver: ReferenceResolver } {
  return graph as unknown as { queries: QueryBuilder; resolver: ReferenceResolver };
}

describe('sync binds a navigation call to a route that appears later', () => {
  it.each(CASES)('$name', async (c) => {
    const root = tempRoot();
    const without = { ...c.files };
    if (c.route.before === null) delete without[c.route.file];
    else without[c.route.file] = c.route.before;
    write(root, without);
    const graph = await index(root);
    const missing = navigations(graph, c.from);
    expect(missing).not.toContain(c.expected);
    const fresh = await freshNavigations(c.files, c.from);
    expect(fresh).toContain(c.expected);

    // The route appears; the file with the call does not change.
    put(root, c.route.file, c.files[c.route.file]!);
    await graph.sync();
    expect(navigations(graph, c.from)).toEqual(fresh);
    expect(graph.getPendingReferenceCount()).toBe(0);

    // Gone again, and back: the call parks while the route is missing and
    // binds again when it returns, as a full index of each state has it.
    put(root, c.route.file, c.route.before);
    await graph.sync();
    expect(navigations(graph, c.from)).toEqual(missing);
    put(root, c.route.file, c.files[c.route.file]!);
    await graph.sync();
    expect(navigations(graph, c.from)).toEqual(fresh);
    expect(graph.getPendingReferenceCount()).toBe(0);
  }, 120_000);
});

describe('a route that goes away', () => {
  it('lets a call two routes tied for bind to the one left', async () => {
    const files = {
      'package.json': JSON.stringify({ name: 'admin', dependencies: { react: '18', 'react-router-dom': '6' } }),
      'src/App.jsx':
        "import { Routes, Route } from 'react-router-dom'\n" +
        "import { User } from './User'\n" +
        'export const App = () => (\n' +
        '  <Routes>\n' +
        '    <Route path="/users/:id" element={<User />} />\n' +
        '  </Routes>\n' +
        ')\n',
      'src/User.jsx': 'export const User = () => <div>User</div>\n',
      'src/Admin.jsx':
        "import { useNavigate } from 'react-router-dom'\n" +
        'export const Admin = () => {\n' +
        '  const navigate = useNavigate()\n' +
        "  const open = () => navigate('/users/5')\n" +
        '  return <button onClick={open}>Open</button>\n' +
        '}\n',
    };
    const root = tempRoot();
    write(root, files);
    // A second route of the same shape: `/users/5` matches both, and a tie names nothing.
    put(root, 'src/App.jsx', files['src/App.jsx'].replace('  </Routes>', '    <Route path="/users/:name" element={<User />} />\n  </Routes>'));
    const graph = await index(root);
    expect(navigations(graph, 'src/Admin.jsx')).toEqual([]);

    put(root, 'src/App.jsx', files['src/App.jsx']);
    await graph.sync();
    expect(navigations(graph, 'src/Admin.jsx')).toEqual(['/users/5 → /users/:id']);
    expect(navigations(graph, 'src/Admin.jsx')).toEqual(await freshNavigations(files, 'src/Admin.jsx'));
  }, 60_000);
});

describe('reopenNavigationsFor', () => {
  const app = (name: string) => ({
    [`apps/${name}/package.json`]: JSON.stringify({ name, dependencies: { react: '18', 'react-router-dom': '6' } }),
    [`apps/${name}/src/App.jsx`]:
      "import { Routes, Route } from 'react-router-dom'\n" +
      "import { Home } from './Home'\n" +
      'export const App = () => (\n  <Routes>\n    <Route path="/" element={<Home />} />\n  </Routes>\n)\n',
    // Two calls to routes the app does not have, and one to its `/`.
    [`apps/${name}/src/Home.jsx`]:
      "import { useNavigate } from 'react-router-dom'\n" +
      'export const Home = () => {\n' +
      '  const navigate = useNavigate()\n' +
      "  const go = () => navigate('/login')\n" +
      "  const back = () => navigate('/back')\n" +
      "  const home = () => navigate('/')\n" +
      '  return <button onClick={go} onDoubleClick={back} onBlur={home}>Go</button>\n' +
      '}\n',
  });

  async function monorepo(): Promise<CodeGraph> {
    const root = tempRoot();
    write(root, { 'package.json': JSON.stringify({ name: 'mono', private: true, workspaces: ['apps/*'] }), ...app('web'), ...app('admin') });
    return index(root);
  }

  /** `<file> failed` per failed `navigate` call, `<file> → <route>` per navigation. */
  const navigationState = (graph: CodeGraph): string[] => [
    ...internals(graph).queries.getFailedCallsByTail(['navigate']).map((ref) => `${ref.filePath} failed`),
    ...internals(graph).queries.getResolvedNavigations().map((e) => `${e.sourceFilePath} → ${graph.getNode(e.target)?.name}`),
  ].sort();

  /** The app's `/` route, moved to `path` — a route of that app the sync added. */
  const routeAt = (route: Node, path: string): Node => ({ ...route, id: route.id.replace(/:\/$/, `:${path}`), name: path });

  it('re-opens the calls in the app the route belongs to, failed and resolved, and no others', async () => {
    const graph = await monorepo();
    const { queries, resolver } = internals(graph);
    const admin = ['apps/admin/src/Home.jsx failed', 'apps/admin/src/Home.jsx failed', 'apps/admin/src/Home.jsx → /'];
    expect(navigationState(graph)).toEqual([...admin, 'apps/web/src/Home.jsx failed', 'apps/web/src/Home.jsx failed', 'apps/web/src/Home.jsx → /']);
    const web = queries.getNodesByKind('route').find((r) => r.filePath === 'apps/web/src/App.jsx')!;

    expect(resolver.reopenNavigationsFor([routeAt(web, '/login')])).toBe(3);
    expect(navigationState(graph)).toEqual(admin);
    expect(graph.getPendingReferenceCount()).toBe(3);
  }, 60_000);

  it('leaves alone the calls in a file the sync just resolved', async () => {
    const graph = await monorepo();
    const { queries, resolver } = internals(graph);
    const web = queries.getNodesByKind('route').find((r) => r.filePath === 'apps/web/src/App.jsx')!;
    expect(resolver.reopenNavigationsFor([routeAt(web, '/login')], ['apps/web/src/Home.jsx'])).toBe(0);
    expect(graph.getPendingReferenceCount()).toBe(0);
  }, 60_000);

  it('skips a name more calls share than the ceiling', async () => {
    const graph = await monorepo();
    const { queries, resolver } = internals(graph);
    // Both apps gain a route: six `navigate` calls between them.
    const added = queries.getNodesByKind('route').map((r) => routeAt(r, '/login'));
    expect(resolver.reopenNavigationsFor(added, [], 5)).toBe(0);
    expect(resolver.reopenNavigationsFor(added, [], 6)).toBe(6);
  }, 60_000);

  it('passes over a route no router navigates to', async () => {
    const graph = await monorepo();
    const { queries, resolver } = internals(graph);
    // A nested route's relative path is not a destination of its own.
    const added = queries.getNodesByKind('route').map((r) => routeAt(r, 'login'));
    const lookup = vi.spyOn(QueryBuilder.prototype, 'getFailedCallsByTail');
    expect(resolver.reopenNavigationsFor(added)).toBe(0);
    expect(lookup).not.toHaveBeenCalled();
  }, 60_000);
});

describe('changedRoutes', () => {
  const route = (filePath: string, name: string, id = `route:${filePath}:1:${name}`): Node => ({
    id, kind: 'route', name, qualifiedName: `${filePath}::route:${name}`, filePath, language: 'jsx',
    startLine: 1, endLine: 1, startColumn: 0, endColumn: 0, updatedAt: 0,
  });

  it('is the routes on one side only, by file and path', () => {
    const kept = route('src/App.jsx', '/');
    const moved = route('src/App.jsx', '/cart');
    const gone = route('src/App.jsx', '/login');
    const added = route('src/Admin.jsx', '/admin');
    // A body edit moves a route's line, and with it its id: still the same route.
    const after = [{ ...kept, id: 'route:src/App.jsx:2:/', startLine: 2 }, moved, added];
    expect(changedRoutes([kept, moved, gone], after)).toEqual([gone, added]);
  });

  it('counts a route renamed in place as its old path and its new one', () => {
    const old = route('src/router.tsx', '/auth/sign-in', 'route:src/router.tsx:5:paths.auth.login.path');
    const renamed = { ...old, name: '/auth/login' };
    expect(changedRoutes([old], [renamed])).toEqual([old, renamed]);
  });
});

describe('a sync that changes no route', () => {
  it('looks up no failed navigation', async () => {
    const c = CASES[0]!;
    const root = tempRoot();
    write(root, c.files);
    const graph = await index(root);
    const lookup = vi.spyOn(QueryBuilder.prototype, 'getFailedCallsByTail');
    // A body edit to the file the routes are declared in, and to an unrelated one.
    put(root, c.route.file, c.files[c.route.file]!.replace('export default App', 'export default App // routes'));
    put(root, 'src/screens/LoginScreen.js', 'const LoginScreen = () => <div>Sign in</div>\nexport default LoginScreen\n');
    const result = await graph.sync();
    expect(result.filesModified).toBe(2);
    expect(lookup).not.toHaveBeenCalled();
  }, 60_000);

  it('takes no route snapshot without a router that navigates', async () => {
    const root = tempRoot();
    write(root, { 'package.json': JSON.stringify({ name: 'lib' }), 'src/a.ts': 'export function a() { return 1; }\n' });
    const graph = await index(root);
    const reopen = vi.spyOn(internals(graph).resolver, 'reopenNavigationsFor');
    put(root, 'src/a.ts', 'export function a() { return 2; }\n');
    expect((await graph.sync()).filesModified).toBe(1);
    expect(reopen).not.toHaveBeenCalled();
  }, 60_000);
});

describe('FrameworkResolver.navigation', () => {
  // Navigation calls each router's own tests resolve.
  const CALLS: Record<string, string[]> = {
    'react-router': ['history.push', 'history.replace', 'navigate', 'navigate.push', 'router.navigate', 'redirect'],
    nextjs: ['router.push', 'router.replace', 'router.prefetch', 'redirect', 'permanentRedirect', 'NextResponse.redirect'],
    'expo-router': ['router.push', 'router.replace', 'router.navigate', 'router.dismissTo', 'nav.push'],
    'vue-router': ['router.push', 'this.$router.push', '$router.replace', 'navigateTo'],
    'angular-router': ['this.router.navigate', 'router.navigateByUrl', 'this._router.createUrlTree', 'Router.parseUrl'],
    'tanstack-router': ['navigate', 'redirect', 'router.navigate', 'Route.navigate'],
    'sveltekit-router': ['goto', 'redirect'],
  };

  it('is set by every router that binds navigation calls, and finds each by its tail', () => {
    const routers = getAllFrameworkResolvers().filter((r) => r.navigation);
    expect(routers.map((r) => r.name).sort()).toEqual(Object.keys(CALLS).sort());
    for (const router of routers) {
      for (const call of CALLS[router.name]!) {
        expect(router.claimsReference?.(call), `${router.name} claims ${call}`).toBe(true);
        expect(router.navigation!.tails, `${router.name} ${call}`).toContain(referenceNameTail(call, 'calls'));
      }
    }
  });
});
