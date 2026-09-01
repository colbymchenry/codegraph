import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { CodeGraph } from '../src';
import { initGrammars, loadAllGrammars } from '../src/extraction/grammars';
import { buildScreens } from '../src/ui-server/api/screens';
import { buildSteps } from '../src/ui-server/api/steps';
import {
  expoRouterResolver,
  routePathForFile,
  defaultExportName,
  readHrefArgument,
  readHrefViaLocal,
  normalizeHrefPath,
} from '../src/resolution/frameworks/expo-router';
import type { ResolutionContext, UnresolvedRef } from '../src/resolution/types';
import type { Node } from '../src/types';

// =============================================================================
// Route paths from file names
// =============================================================================

describe('expo-router: routePathForFile', () => {
  it.each([
    ['app/index.tsx', '/'],
    ['src/app/index.tsx', '/'],
    ['src/app/object-detail.tsx', '/object-detail'],
    ['src/app/capture/index.tsx', '/capture'],
    ['src/app/capture/review/index.tsx', '/capture/review'],
    ['src/app/sheets/need-help.tsx', '/sheets/need-help'],
    ['src/app/item/[id].tsx', '/item/[id]'],
    ['src/app/docs/[...slug].tsx', '/docs/[...slug]'],
    ['src/app/(tabs)/home.tsx', '/home'],
    ['src/app/(auth)/(stack)/login.tsx', '/login'],
    ['src/app/+not-found.tsx', '/+not-found'],
    ['src/app/settings.ios.tsx', '/settings'],
    ['src/app/legacy.js', '/legacy'],
    ['apps/mobile/src/app/home.tsx', '/home'],
  ])('%s → %s', (file, route) => {
    expect(routePathForFile(file)).toBe(route);
  });

  it.each([
    'src/app/_layout.tsx',
    'src/app/(tabs)/_layout.tsx',
    'src/app/+html.tsx',
    'src/app/+native-intent.tsx',
    'src/app/_private-helper.ts',
    'src/app/home.test.tsx',
    'src/app/__tests__/home.tsx',
    'src/app/types.d.ts',
    'src/app/styles.css',
    'src/components/app/thing.tsx'.replace('components/app/', 'components/'), // no app dir
    'src/appearance/theme.tsx',
  ])('%s is not a screen', (file) => {
    expect(routePathForFile(file)).toBeNull();
  });
});

// =============================================================================
// Default export → screen name
// =============================================================================

describe('expo-router: defaultExportName', () => {
  it.each([
    ['export default function ObjectDetail() {}', 'ObjectDetail'],
    ['export default async function Screen() {}', 'Screen'],
    ['export default class Legacy extends React.Component {}', 'Legacy'],
    ['function Home() {}\nexport default Home', 'Home'],
    ['function Home() {}\nexport default Home;', 'Home'],
    ['export default memo(Home)', 'Home'],
    ['export default React.memo(Home)', 'Home'],
    ['export default observer(Home, opts)', 'Home'],
    ['export { Home as default }', 'Home'],
  ])('%s → %s', (src, name) => {
    expect(defaultExportName(src)?.name).toBe(name);
  });

  it('yields null for an anonymous default export', () => {
    expect(defaultExportName('export default () => null')).toBeNull();
    expect(defaultExportName('export default function () {}')).toBeNull();
  });
});

// =============================================================================
// Reading the href argument
// =============================================================================

describe('expo-router: readHrefArgument', () => {
  const read = (src: string, method = 'push', line = 1, column = 0) =>
    readHrefArgument(src.split('\n'), line, column, method);

  it('reads a plain string', () => {
    expect(read("router.push('/capture-queue')")).toEqual({
      path: '/capture-queue',
      display: '/capture-queue',
    });
  });

  it('drops the query string and hash from the path but keeps them for display', () => {
    expect(read('router.push("/sheets/setup-guide?kind=lighting")')).toEqual({
      path: '/sheets/setup-guide',
      display: '/sheets/setup-guide?kind=lighting',
    });
  });

  it('reads a template literal, keeping the static prefix and marking holes', () => {
    const src =
      'router.navigate(\n' +
      '  `/object-detail?detectionItem=${encodeParam(JSON.stringify(item))}${folderParam}` as any\n' +
      ')';
    expect(read(src, 'navigate')).toEqual({
      path: '/object-detail',
      display: '/object-detail?detectionItem=${…}${…}',
    });
  });

  it('keeps a hole that sits in the path itself', () => {
    const r = read('router.push(`/terms-of-service/term/${id}`)');
    expect(r?.display).toBe('/terms-of-service/term/${…}');
    expect(r?.path.startsWith('/terms-of-service/term/')).toBe(true);
  });

  it('reads pathname out of an Href object', () => {
    const src =
      "router.push({\n  pathname: '/detection/result/[id]',\n  params: { id: result.id },\n})";
    expect(read(src)).toEqual({
      path: '/detection/result/[id]',
      display: '/detection/result/[id]',
    });
  });

  it('reads both arms of a conditional argument', () => {
    const src =
      'router.navigate(\n' +
      '  (folder.id\n' +
      "    ? `/sheets/create-detection-item?folderId=${folder.id}`\n" +
      "    : '/sheets/create-detection-item') as any\n" +
      ')';
    const r = read(src, 'navigate');
    expect(r?.path).toBe('/sheets/create-detection-item');
    expect(r?.display).toBe('/sheets/create-detection-item?folderId=${…}');
    expect(r?.alternates?.map((a) => a.path)).toEqual(['/sheets/create-detection-item']);
  });

  it('reads the literal arm when the other is not one — a place the code demonstrably goes', () => {
    // Both arms readable is a fork, and `pageForHref` resolves it only when
    // they name the same route. One arm readable is not a fork: `/home` is
    // somewhere this call goes, and reporting it is not a guess. Dropping it
    // cost every react-router app its post-login transition, which is written
    // `const redirect = search ? search.split('=')[1] : '/'`.
    const r = read("router.push(ready ? '/home' : fallback)");
    expect(r?.path).toBe('/home');
    expect(r?.alternate).toBeUndefined();
    expect(read("router.push(ready ? fallback : '/home')")?.path).toBe('/home');
    // Neither arm readable is still nothing.
    expect(read('router.push(ready ? a : b)')).toBeNull();
  });

  it('pairs the arms of a NESTED conditional, and keeps all three', () => {
    // Taking the first `:` split this between `keyword` and '/page', reading
    // '/page' — a real path, from the wrong arm of the wrong conditional. Paired
    // properly it is a paginator that goes to one of three places, and the
    // picture draws all three rather than none.
    const r = read("router.push(!isAdmin ? keyword ? '/search' : '/page' : '/admin')");
    expect([r?.path, ...(r?.alternates ?? []).map((a) => a.path)]).toEqual(['/search', '/page', '/admin']);
  });

  it('reads only the first argument', () => {
    expect(read("router.push('/home', { withAnchor: true })")?.path).toBe('/home');
  });

  it('starts scanning at the column so an earlier call on the line is skipped', () => {
    const src = "list.push(x); router.push('/home')";
    expect(read(src, 'push', 1, src.indexOf('router'))?.path).toBe('/home');
  });

  it('returns null for a non-literal argument', () => {
    expect(read('router.push(href)')).toBeNull();
    expect(read('router.push(buildHref(item))')).toBeNull();
    expect(read('router.push({ pathname, params })')).toBeNull();
    expect(read('router.push()')).toBeNull();
  });

  it('does not run past the call: a later literal is not this call\'s argument', () => {
    expect(read("router.back()\nrouter.push('/home')", 'back')).toBeNull();
  });
});

describe('expo-router: readHrefViaLocal', () => {
  const viaLocal = (src: string, method = 'navigate') => {
    const lines = src.split('\n');
    const line = lines.findIndex((l) => l.includes(`.${method}(`)) + 1;
    return readHrefViaLocal(lines, line, 0, method, 1);
  };

  it('reads a local const assigned a literal', () => {
    expect(viaLocal("function f() {\n  const href = '/home'\n  router.navigate(href as any)\n}")?.path).toBe('/home');
  });

  it('reads a multi-line ternary initializer whose arms are literals', () => {
    const src =
      'function f(params) {\n' +
      '  const href = params.length\n' +
      '    ? `/barcode-scan?${params.join("&")}`\n' +
      "    : '/barcode-scan'\n" +
      '  if (options?.replace) {\n' +
      '    router.navigate(href as any)\n' +
      '  }\n}';
    const r = viaLocal(src);
    expect(r?.path).toBe('/barcode-scan');
    expect(r?.alternates?.map((a) => a.path)).toEqual(['/barcode-scan']);
  });

  it('reads a typed declaration and an Href object initializer', () => {
    expect(viaLocal("const href: Href = '/home'\nrouter.navigate(href)")?.path).toBe('/home');
    expect(viaLocal("const href = { pathname: '/item/[id]', params: { id } }\nrouter.navigate(href)")?.path).toBe('/item/[id]');
  });

  it('refuses a computed initializer, a reassignment, and a non-identifier argument', () => {
    expect(viaLocal("const href = build()\nrouter.navigate(href)")).toBeNull();
    expect(viaLocal("const href = '/home'\nhref = other\nrouter.navigate(href)")).toBeNull();
    expect(viaLocal("router.navigate(a.b)")).toBeNull();
  });

  it('is not confused by ?. and ?? in an initializer', () => {
    expect(viaLocal("const href = options?.href ?? '/home'\nrouter.navigate(href)")).toBeNull();
  });
});

// =============================================================================
// Href normalization
// =============================================================================

describe('expo-router: normalizeHrefPath', () => {
  it('strips trailing slash and group segments, decodes segments', () => {
    expect(normalizeHrefPath('/capture/', 'src/services/nav.ts')).toEqual(['capture']);
    expect(normalizeHrefPath('/(tabs)/home', 'src/services/nav.ts')).toEqual(['home']);
    expect(normalizeHrefPath('/a%20b', 'src/services/nav.ts')).toEqual(['a b']);
    expect(normalizeHrefPath('/', 'src/services/nav.ts')).toEqual([]);
  });

  it('resolves a relative href against the screen the call is in', () => {
    expect(normalizeHrefPath('./review', 'src/app/capture/index.tsx')).toEqual(['capture', 'review']);
    expect(normalizeHrefPath('review', 'src/app/capture/index.tsx')).toEqual(['capture', 'review']);
    expect(normalizeHrefPath('../home', 'src/app/capture/review.tsx')).toEqual(['home']);
  });

  it('refuses a relative href from a non-screen file', () => {
    expect(normalizeHrefPath('./review', 'src/services/nav.ts')).toBeNull();
  });
});

// =============================================================================
// extract(): route node + screen ref
// =============================================================================

describe('expo-router: extract', () => {
  it('emits a route node named by path and a calls ref to the default export', () => {
    const src = "import React from 'react'\n\nexport default function ObjectDetail() {\n  return null\n}\n";
    const { nodes, references } = expoRouterResolver.extract!('src/app/object-detail.tsx', src);
    expect(nodes).toHaveLength(1);
    expect(nodes[0]!.kind).toBe('route');
    expect(nodes[0]!.name).toBe('/object-detail');
    expect(nodes[0]!.language).toBe('tsx');
    expect(references).toHaveLength(1);
    expect(references[0]!.fromNodeId).toBe(nodes[0]!.id);
    expect(references[0]!.referenceName).toBe('ObjectDetail');
    expect(references[0]!.referenceKind).toBe('calls');
    expect(references[0]!.line).toBe(3);
  });

  it('emits nothing for a layout or a non-app file', () => {
    expect(expoRouterResolver.extract!('src/app/_layout.tsx', 'export default function L() {}')).toEqual({
      nodes: [],
      references: [],
    });
    expect(expoRouterResolver.extract!('src/services/nav.ts', 'export default function x() {}')).toEqual({
      nodes: [],
      references: [],
    });
  });
});

// =============================================================================
// resolve(): a navigation call → the route node, as a navigates edge
// =============================================================================

describe('expo-router: resolve', () => {
  const route = (filePath: string): Node => expoRouterResolver.extract!(filePath, '').nodes[0]!;
  const routes = [
    route('src/app/index.tsx'),
    route('src/app/object-detail.tsx'),
    route('src/app/capture/index.tsx'),
    route('src/app/item/[id].tsx'),
    route('src/app/docs/[...slug].tsx'),
  ];
  const files: Record<string, string> = {
    'src/services/nav.ts':
      "import { router } from 'expo-router'\n" +
      "export function openDetail(item) {\n" +
      '  router.navigate(\n' +
      '    `/object-detail?detectionItem=${encode(item)}` as any\n' +
      '  )\n' +
      '}\n' +
      "export function openItem(id) { router.push(`/item/${id}`) }\n" +
      "export function openDoc() { router.push({ pathname: '/docs/[...slug]', params: { slug: ['a'] } }) }\n" +
      "export function openCapture() { router.replace('/capture/') }\n" +
      "export function missing() { router.push('/nowhere') }\n" +
      "export function computed(h) { router.push(h) }\n" +
      "export function notNav(list) { list.push('/capture') }\n" +
      "export function fork(x) { router.push(x ? '/capture' : '/object-detail') }\n" +
      "export function sameScreen(x) { router.push(x ? '/capture?x=1' : '/capture/') }\n" +
      "export function viaWrapper() { safePush('/capture/') }\n",
  };
  const context = {
    getNodesByKind: (kind: Node['kind']) => (kind === 'route' ? routes : []),
    getProjectRoot: () => '/proj',
    readFile: (p: string) => files[p] ?? null,
    getFileLines: (p: string) => files[p]?.split('\n') ?? null,
    getAllFiles: () => Object.keys(files),
    getNodesInFile: () => [],
    getNodesByName: () => [],
    getNodesByQualifiedName: () => [],
    getNodesByLowerName: () => [],
    fileExists: () => true,
    getImportMappings: () => [],
  } as unknown as ResolutionContext;

  const ref = (referenceName: string, line: number, column = 0): UnresolvedRef => ({
    fromNodeId: 'function:src',
    referenceName,
    referenceKind: 'calls',
    line,
    column,
    filePath: 'src/services/nav.ts',
    language: 'typescript',
  });

  it('claims router navigation method names through the name pre-filter', () => {
    expect(expoRouterResolver.claimsReference!('router.push')).toBe(true);
    expect(expoRouterResolver.claimsReference!('nav.navigate')).toBe(true);
    expect(expoRouterResolver.claimsReference!('safePush')).toBe(true);
    expect(expoRouterResolver.claimsReference!('guardedNavigate')).toBe(true);
    expect(expoRouterResolver.claimsReference!('router.back')).toBe(false);
    expect(expoRouterResolver.claimsReference!('fetch')).toBe(false);
    expect(expoRouterResolver.claimsReference!('Push')).toBe(false);
  });

  it('binds a project wrapper named for the verb, remembering the wrapper', () => {
    const r = expoRouterResolver.resolve(ref('safePush', 15, 27), context);
    expect(r?.targetNodeId).toBe(routes[2]!.id);
    expect(r?.metadata).toEqual({ href: '/capture/', navMethod: 'push', via: 'safePush' });
  });

  it('binds a multi-line template href to its route as a navigates edge with the href', () => {
    const r = expoRouterResolver.resolve(ref('router.navigate', 3, 2), context);
    expect(r).not.toBeNull();
    expect(r!.targetNodeId).toBe(routes[1]!.id);
    expect(r!.edgeKind).toBe('navigates');
    expect(r!.resolvedBy).toBe('framework');
    expect(r!.metadata).toEqual({ href: '/object-detail?detectionItem=${…}', navMethod: 'navigate' });
  });

  it('matches an interpolated segment against a [param] route', () => {
    const r = expoRouterResolver.resolve(ref('router.push', 7, 29), context);
    expect(r?.targetNodeId).toBe(routes[3]!.id);
  });

  it('matches a pathname object against a catch-all route', () => {
    const r = expoRouterResolver.resolve(ref('router.push', 8, 28), context);
    expect(r?.targetNodeId).toBe(routes[4]!.id);
  });

  it('normalizes a trailing slash onto an index route', () => {
    const r = expoRouterResolver.resolve(ref('router.replace', 9, 32), context);
    expect(r?.targetNodeId).toBe(routes[2]!.id);
  });

  it('returns null for a path with no screen and for a computed href', () => {
    expect(expoRouterResolver.resolve(ref('router.push', 10, 28), context)).toBeNull();
    expect(expoRouterResolver.resolve(ref('router.push', 11, 30), context)).toBeNull();
  });

  it('gates on the string naming a real screen, not on the receiver being called router', () => {
    // `const nav = useRouter(); nav.push('/x')` must bind, so the receiver is
    // not consulted; a non-router `push` of a real screen path binds too.
    expect(expoRouterResolver.resolve(ref('list.push', 12, 32), context)?.targetNodeId).toBe(routes[2]!.id);
  });

  it('binds a conditional whose arms name the same screen, and draws BOTH when they fork', () => {
    const same = expoRouterResolver.resolve(ref('router.push', 14, 33), context);
    expect(same?.targetNodeId).toBe(routes[2]!.id);
    expect(same?.alsoTargets).toBeUndefined();
    // A fork reaches both screens, and each becomes an edge of its own.
    const forked = expoRouterResolver.resolve(ref('router.push', 13, 27), context);
    expect(forked).not.toBeNull();
    expect([forked!.targetNodeId, ...(forked!.alsoTargets ?? []).map((t) => t.targetNodeId)]).toHaveLength(2);
  });

  it('ignores refs that are not calls or not JS/TS', () => {
    expect(
      expoRouterResolver.resolve({ ...ref('router.push', 9, 32), referenceKind: 'references' }, context)
    ).toBeNull();
    expect(expoRouterResolver.resolve({ ...ref('router.push', 9, 32), language: 'swift' }, context)).toBeNull();
  });
});

// =============================================================================
// End to end: index a small Expo app and walk tap → screen
// =============================================================================

describe('expo-router: end-to-end', () => {
  beforeAll(async () => {
    await initGrammars();
    await loadAllGrammars();
  });

  let tmpDir: string | undefined;
  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  });

  function write(rel: string, content: string) {
    const full = path.join(tmpDir!, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }

  it('connects a component tap to the screen it navigates to', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-expo-router-'));
    write(
      'package.json',
      JSON.stringify({ name: 'app', dependencies: { expo: '52', 'expo-router': '4', react: '18' } })
    );
    write('src/app/_layout.tsx', "export default function Layout() { return null }\n");
    write(
      'src/app/index.tsx',
      "import { ItemCard } from '../components/item-card'\n" +
        'export default function Home() {\n' +
        "  return <ItemCard item={{ id: '1' }} collected />\n" +
        '}\n'
    );
    write(
      'src/app/object-detail.tsx',
      "export default function ObjectDetail() {\n  return null\n}\n"
    );
    write('src/app/item/[id].tsx', "export default function Item() { return null }\n");
    write(
      'src/services/nav.ts',
      "import { router } from 'expo-router'\n" +
        'export function openObjectDetail(item: { id: string }) {\n' +
        '  router.navigate(\n' +
        '    `/object-detail?detectionItem=${JSON.stringify(item)}` as any\n' +
        '  )\n' +
        '}\n' +
        'export function openItem(id: string) {\n' +
        "  router.push({ pathname: '/item/[id]', params: { id } })\n" +
        '}\n'
    );
    write(
      'src/app/welcome.tsx',
      "export default function Welcome() { return null }\n"
    );
    write(
      'src/services/post-login.ts',
      // The literal-union return type is the trap: its routes are string
      // literals too, BEFORE the ternary — the scan must skip the signature
      // or the annotation's guardless positions win.
      'export const resolvePostLoginRoute = async (): Promise<\n' +
        "  '/welcome/' | '/'\n" +
        '> => {\n' +
        "  return (await seen()) ? '/' : '/welcome/'\n" +
        '}\n' +
        'async function seen() { return true }\n' +
        "export function apiPath() { return '/api/users' }\n"
    );
    write(
      'src/services/login.ts',
      "import { router } from 'expo-router'\n" +
        "import { resolvePostLoginRoute, apiPath } from './post-login'\n" +
        'export async function finishLogin() {\n' +
        '  router.replace(await resolvePostLoginRoute())\n' +
        '}\n' +
        'export function fetchUsers() { return fetch(apiPath()) }\n'
    );
    write(
      'src/components/item-card.tsx',
      "import { openObjectDetail } from '../services/nav'\n" +
        'export function ItemCard(props: { item: { id: string }; collected: boolean }) {\n' +
        '  const handlePress = () => {\n' +
        '    if (props.collected) openObjectDetail(props.item)\n' +
        '  }\n' +
        '  return handlePress\n' +
        '}\n'
    );

    const cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();

    const routes = cg.getNodesByKind('route');
    expect(routes.map((r) => r.name).sort()).toEqual(['/', '/item/[id]', '/object-detail', '/welcome']);
    const detailRoute = routes.find((r) => r.name === '/object-detail')!;

    // route → its screen component
    const screen = cg.getNodesByName('ObjectDetail').find((n) => n.kind !== 'route')!;
    expect(screen).toBeDefined();
    const toScreen = cg.getOutgoingEdges(detailRoute.id).find((e) => e.target === screen.id);
    expect(toScreen?.kind).toBe('calls');

    // navigation call → route, as a navigates edge that remembers the href
    const opener = cg.getNodesByName('openObjectDetail')[0]!;
    const nav = cg.getOutgoingEdges(opener.id).find((e) => e.target === detailRoute.id);
    expect(nav?.kind).toBe('navigates');
    expect(nav?.metadata?.href).toBe('/object-detail?detectionItem=${…}');
    expect(nav?.metadata?.navMethod).toBe('navigate');
    expect(nav?.metadata?.refKind).toBe('calls');

    // the pathname-object form binds the dynamic route
    const itemRoute = routes.find((r) => r.name === '/item/[id]')!;
    const openItem = cg.getNodesByName('openItem')[0]!;
    expect(cg.getOutgoingEdges(openItem.id).some((e) => e.target === itemRoute.id && e.kind === 'navigates')).toBe(true);

    // the route's callers are the navigators — what "who opens this screen" asks
    const callers = cg.getCallers(detailRoute.id);
    expect(callers.map((c) => c.node.name)).toContain('openObjectDetail');

    // `router.replace(await resolvePostLoginRoute())`: the helper's return
    // literals become heuristic navigates edges FROM THE HELPER, one per screen,
    // remembering the push site; the plain `calls` edge from the pusher closes
    // the chain. A helper nothing navigates with (`apiPath`) is never read.
    const helper = cg.getNodesByName('resolvePostLoginRoute')[0]!;
    const fromHelper = cg.getOutgoingEdges(helper.id).filter((e) => e.kind === 'navigates');
    expect(fromHelper.map((e) => routes.find((r) => r.id === e.target)?.name).sort()).toEqual(['/', '/welcome']);
    expect(fromHelper.every((e) => e.provenance === 'heuristic')).toBe(true);
    expect(fromHelper[0]!.metadata?.synthesizedBy).toBe('expo-router-return');
    expect(fromHelper[0]!.metadata?.registeredAt).toBe('src/services/login.ts:4');
    // Each return literal carries its own POSITION: the two arms of
    // `return (await seen()) ? '/' : '/welcome/'` share a line, and only the
    // column lets the guard reader say which arm an edge is — without it both
    // navigations read as `always`.
    const welcomeEdge = fromHelper.find((e) => routes.find((r) => r.id === e.target)?.name === '/welcome')!;
    const rootEdge = fromHelper.find((e) => routes.find((r) => r.id === e.target)?.name === '/')!;
    expect(rootEdge.line).toBe(welcomeEdge.line);
    expect(typeof rootEdge.column).toBe('number');
    expect(welcomeEdge.column!).toBeGreaterThan(rootEdge.column!);
    const finishLogin = cg.getNodesByName('finishLogin')[0]!;
    expect(cg.getOutgoingEdges(finishLogin.id).some((e) => e.target === helper.id && e.kind === 'calls')).toBe(true);
    const apiPath = cg.getNodesByName('apiPath')[0]!;
    expect(cg.getOutgoingEdges(apiPath.id).some((e) => e.kind === 'navigates')).toBe(false);

    // The Screens payload: the tap on ItemCard is attributed back to the Home
    // screen through the JSX-render hop, with the chain and its condition.
    const screens = await buildScreens(cg, tmpDir);
    expect(screens.routed).toBe(true);
    const home = screens.screens.find((s) => s.path === '/')!;
    expect(screens.entry).toBe(home.id);
    const detail = screens.screens.find((s) => s.path === '/object-detail')!;
    const tap = screens.links.find((l) => l.from === home.id && l.to === detail.id)!;
    expect(tap).toBeDefined();
    expect(tap.via.map((v) => v.name)).toEqual(['ItemCard', 'openObjectDetail']);
    expect(tap.when).toBe('props.collected');
    expect(tap.sites[0]!.href).toBe('/object-detail?detectionItem=${…}');
    // Navigation nothing on a screen reaches is an origin, not dropped: the
    // post-login helper, and `openItem`, which the fixture never calls.
    const fromOrigins = screens.links.filter((l) => l.fromOrigin);
    expect(fromOrigins.map((l) => screens.screens.find((s) => s.id === l.to)!.path).sort()).toEqual(['/', '/item/[id]', '/welcome']);
    expect(screens.origins.map((o) => o.node.name)).toEqual(['openItem', 'resolvePostLoginRoute']);
    expect(screens.dropped).toBe(0);

    // The steps walk reads each arm's own condition off the literal's column:
    // where the app goes after login is a fork, not two `always`es.
    const steps = await buildSteps(cg, tmpDir, new URLSearchParams({ symbol: 'finishLogin' }));
    const stepByLabel = (label: string) => steps.steps.find((s) => s.label === label)!;
    const toRoot = steps.links.find((l) => l.to === stepByLabel('/').id)!;
    const toWelcome = steps.links.find((l) => l.to === stepByLabel('/welcome').id)!;
    expect(toRoot.when).toMatch(/await seen\(\)/);
    expect(toRoot.when).not.toMatch(/!/);
    expect(toWelcome.when).toMatch(/!\s*\(?\s*await seen\(\)/);

    // …and each site names the DECISION its condition belongs to, so the two
    // arms can be drawn as one choice rather than as two lines that happen to
    // read as each other's negation. Same branch, opposite arms, one `on`.
    const rootArm = toRoot.sites[0]!.decision!;
    const welcomeArm = toWelcome.sites[0]!.decision!;
    expect(rootArm.branch).toBe(welcomeArm.branch);
    expect(rootArm.branch).not.toBe('');
    expect(rootArm.form).toBe('ternary');
    expect(rootArm.on).toBe(welcomeArm.on);
    expect(rootArm.on).toMatch(/await seen\(\)/);
    expect(rootArm.on).not.toMatch(/^!/);
    expect(rootArm.not).toBeUndefined();
    expect(welcomeArm.not).toBe(true);
    expect(rootArm.arm).not.toBe(welcomeArm.arm);

    cg.close();
  });
});

// =============================================================================
// The backward walk must not leave the app's own execution context
// =============================================================================

/**
 * A navigation written inside a component the graph can only reach BACKWARDS
 * through the native bridge belongs to the screen whose file it is written in
 * — not to whichever screen happened to start the round trip.
 *
 * The shape, from a real Expo app: `/capture` renders `ARCapturePage`, which
 * renders `memo(CaptureComponent)`; the `router.push` lives in an inline
 * listener inside `CaptureComponent`. Nothing points at `CaptureComponent`
 * except Swift emitters — the walk skips `file` nodes, and `memo(x)` leaves no
 * edge from the memo to the function — so before the guard the walk escaped
 * through `rn-event-channel`, came back down into `ReviewScreen` (which had
 * called the native module), and filed four of `/capture`'s navigations under
 * `/capture/review`, whose only remaining feed was itself. It also carried the
 * Swift guards home as conditions on a JavaScript navigation.
 */
describe('expo-router screens: attribution stops at the native bridge', () => {
  let tmpDir: string | undefined;

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  });

  function write(rel: string, content: string) {
    const full = path.join(tmpDir!, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }

  it('files the push on the screen whose file holds it, not on the screen that started the round trip', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-expo-bridge-'));
    write(
      'package.json',
      JSON.stringify({
        name: 'app',
        dependencies: { expo: '52', 'expo-router': '4', react: '18', 'react-native': '0.76' },
      })
    );
    write('src/app/_layout.tsx', 'export default function Layout() { return null }\n');
    write('src/app/index.tsx', 'export default function Home() { return null }\n');

    // The Swift side: a method the JS calls, which ends in the event emit.
    write(
      'ios/CaptureView.swift',
      `import Foundation
@objc(CaptureView)
class CaptureView: NSObject {
  @objc func startRetake() {
    CaptureEvents.shared.emitCaptureComplete()
  }
}
`
    );
    // The ObjC bridging shim, without which the JS side never reaches Swift.
    write(
      'ios/CaptureView.m',
      `#import <React/RCTBridgeModule.h>
@interface RCT_EXTERN_MODULE(CaptureView, NSObject)
RCT_EXTERN_METHOD(startRetake)
@end
`
    );
    write(
      'ios/CaptureEvents.swift',
      `import Foundation
class CaptureEvents: RCTEventEmitter {
  func emitCaptureComplete() {
    guard Thread.isMainThread else { return }
    sendEvent(withName: "onCaptureComplete", body: nil)
  }
}
`
    );

    // /capture — the push is written HERE, in an inline listener inside a
    // sibling of the route's own default export.
    write(
      'src/app/capture/index.tsx',
      `import { memo, useEffect } from 'react'
import { router } from 'expo-router'
const MemoizedCaptureComponent = memo(CaptureComponent)
export default function ARCapturePage() {
  return <MemoizedCaptureComponent />
}
function CaptureComponent() {
  useEffect(() => {
    const sub = nativeEmitter.addListener('onCaptureComplete', (data) => {
      if (!isRetakeBatchActive) {
        router.push('/capture/review')
      }
    })
    return () => sub.remove()
  }, [])
  return null
}
`
    );

    // /capture/review — calls into the native module, which is what makes the
    // Swift emitter backwards-reachable from this screen.
    write(
      'src/app/capture/review/index.tsx',
      `import { NativeModules } from 'react-native'
const { CaptureView } = NativeModules
export default function ReviewScreen() {
  function handleRetake() {
    CaptureView.startRetake()
  }
  return handleRetake
}
`
    );

    const cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();

    // The escape route the walk used to take really is in the graph.
    const capture = cg.getNodesByName('CaptureComponent').find((n) => n.kind !== 'route')!;
    const bridged = cg
      .getIncomingEdgesTo([capture.id], ['calls'])
      .filter((e) => (e.metadata as Record<string, unknown> | undefined)?.synthesizedBy === 'rn-event-channel');
    expect(bridged.length).toBeGreaterThan(0);
    // …and it really is a route back OUT to the other screen: without the
    // guard the walk runs handleRetake > startRetake > emitCaptureComplete >
    // CaptureComponent and lands the push on /capture/review.
    const startRetake = cg.getNodesByName('startRetake').find((n) => n.language === 'swift')!;
    expect(cg.getIncomingEdgesTo([startRetake.id], ['calls']).map((e) => cg.getNodesByIds([e.source]).get(e.source)?.name)).toContain(
      'handleRetake'
    );

    const screens = await buildScreens(cg, tmpDir);
    const from = (path: string) => screens.screens.find((s) => s.path === path)!;
    const review = from('/capture/review');
    const links = screens.links.filter((l) => l.to === review.id);

    // One transition into /capture/review, and it comes from /capture.
    expect(links.map((l) => screens.screens.find((s) => s.id === l.from)?.path)).toEqual(['/capture']);
    // Written right there: no chain, and no Swift guard smuggled in.
    expect(links[0]!.via).toEqual([]);
    expect(links[0]!.when).toBe('!isRetakeBatchActive');
    expect(links[0]!.sites[0]!.file).toBe('src/app/capture/index.tsx');
    // …and /capture/review is not left feeding only itself.
    expect(screens.links.some((l) => l.from === review.id && l.to === review.id)).toBe(false);

    cg.close();
  });
});
