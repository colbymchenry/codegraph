/**
 * React Router as a Screens app (`src/resolution/frameworks/react-router.ts`,
 * `src/resolution/react-router-synthesizer.ts`): `<Route path>` routes bound
 * to their screens by `frameworks/react.ts`, and the navigation half — the
 * `history.push` / `navigate` / `redirect` calls and the `<Link to>` markup
 * that carry a user from one screen to the next.
 *
 * The fixture is proshop's shape on purpose: a `frontend/` workspace whose
 * routes live in `src/App.js` and whose screens live in `src/screens/`, which
 * is what the app-root gate has to get right. Mirrors `nextjs.test.ts`.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { initGrammars, loadAllGrammars } from '../src/extraction/grammars';
import { buildScreens } from '../src/ui-server/api/screens';
import { buildSteps } from '../src/ui-server/api/steps';
import { reactRouterRoot, reactRouterNavVerb } from '../src/resolution/frameworks/react-router';
import type { Node } from '../src/types';

// =============================================================================
// The app root a route file owns
// =============================================================================

describe('react-router: reactRouterRoot', () => {
  it.each([
    ['frontend/src/App.js', 'frontend/'],
    ['src/App.tsx', ''],
    ['apps/web/src/routes/index.tsx', 'apps/web/'],
    ['client/App.jsx', 'client/'],
    ['App.jsx', ''],
  ])('%s → %s', (file, root) => {
    expect(reactRouterRoot(file)).toBe(root);
  });
});

describe('react-router: reactRouterNavVerb', () => {
  it.each([
    ['history.push', 'push'],
    ['history.replace', 'replace'],
    ['navigate', 'navigate'],
    ['router.navigate', 'navigate'],
    ['redirect', 'redirect'],
  ])('%s → %s', (name, verb) => {
    expect(reactRouterNavVerb(name)).toBe(verb);
  });

  it.each(['push', 'replace', 'paths.push', 'list.replace', 'items.navigate', 'go', 'goBack'])(
    '%s is not a navigation — an unqualified push is an array’s',
    (name) => {
      expect(reactRouterNavVerb(name)).toBeNull();
    }
  );
});

// =============================================================================
// The whole picture, indexed
// =============================================================================

describe('react-router: a routed app end to end', () => {
  let tmpDir: string;
  let cg: CodeGraph;

  function write(rel: string, content: string): void {
    const full = path.join(tmpDir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }

  beforeAll(async () => {
    await initGrammars();
    await loadAllGrammars();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-react-router-'));
    write('package.json', JSON.stringify({ name: 'shop', private: true }));
    write(
      'frontend/package.json',
      JSON.stringify({
        name: 'frontend',
        dependencies: { react: '18', 'react-router-dom': '5', 'react-router-bootstrap': '0.26' },
      })
    );
    write(
      'frontend/src/App.js',
      "import { BrowserRouter as Router, Route } from 'react-router-dom'\n" +
        "import LoginScreen from './screens/LoginScreen'\n" +
        "import ShippingScreen from './screens/ShippingScreen'\n" +
        "import PaymentScreen from './screens/PaymentScreen'\n" +
        "import PlaceOrderScreen from './screens/PlaceOrderScreen'\n" +
        "import ProductScreen from './screens/ProductScreen'\n" +
        "import CartScreen from './screens/CartScreen'\n" +
        'const App = () => (\n' +
        '  <Router>\n' +
        "    <Route path='/login' component={LoginScreen} />\n" +
        "    <Route path='/shipping' component={ShippingScreen} />\n" +
        "    <Route path='/payment' component={PaymentScreen} />\n" +
        "    <Route path='/placeorder' component={PlaceOrderScreen} />\n" +
        "    <Route path='/product/:id' component={ProductScreen} />\n" +
        "    <Route path='/cart/:id?' component={CartScreen} />\n" +
        '  </Router>\n' +
        ')\n' +
        'export default App\n'
    );
    // The screen the picture was wrong on: a guarded bounce out, and a push on
    // submit after the store action. Both are `history.push` with a literal.
    write(
      'frontend/src/screens/PaymentScreen.js',
      "import React, { useState } from 'react'\n" +
        "import { useDispatch, useSelector } from 'react-redux'\n" +
        "import CheckoutSteps from '../components/CheckoutSteps'\n" +
        "import { savePaymentMethod } from '../actions/cartActions'\n" +
        'const PaymentScreen = ({ history }) => {\n' +
        '  const cart = useSelector((state) => state.cart)\n' +
        '  const { shippingAddress } = cart\n' +
        '  if (!shippingAddress.address) {\n' +
        "    history.push('/shipping')\n" +
        '  }\n' +
        "  const [paymentMethod, setPaymentMethod] = useState('PayPal')\n" +
        '  const dispatch = useDispatch()\n' +
        '  const submitHandler = (e) => {\n' +
        '    e.preventDefault()\n' +
        '    dispatch(savePaymentMethod(paymentMethod))\n' +
        "    history.push('/placeorder')\n" +
        '  }\n' +
        '  return <form onSubmit={submitHandler}><CheckoutSteps step1 step2 step3 /></form>\n' +
        '}\n' +
        'export default PaymentScreen\n'
    );
    // A computed destination is not a destination: `redirect` is read off the
    // query string, so nothing static names a route.
    write(
      'frontend/src/screens/LoginScreen.js',
      "import React, { useEffect } from 'react'\n" +
        "import { Link } from 'react-router-dom'\n" +
        'const LoginScreen = ({ location, history, userInfo }) => {\n' +
        "  const redirect = location.search ? location.search.split('=')[1] : '/'\n" +
        '  useEffect(() => {\n' +
        '    if (userInfo) {\n' +
        '      history.push(redirect)\n' +
        '    }\n' +
        '  }, [history, userInfo, redirect])\n' +
        "  return <Link to='/shipping'>Continue</Link>\n" +
        '}\n' +
        'export default LoginScreen\n'
    );
    write(
      'frontend/src/screens/ShippingScreen.js',
      "import React from 'react'\n" +
        'const ShippingScreen = ({ history }) => {\n' +
        '  const submitHandler = () => {\n' +
        "    history.replace('/payment')\n" +
        '  }\n' +
        '  return <form onSubmit={submitHandler} />\n' +
        '}\n' +
        'export default ShippingScreen\n'
    );
    write(
      'frontend/src/screens/PlaceOrderScreen.js',
      "import React from 'react'\nconst PlaceOrderScreen = () => <div>Order</div>\nexport default PlaceOrderScreen\n"
    );
    // v6's hook, and a template hole that has to land on the `:id` route.
    write(
      'frontend/src/screens/ProductScreen.js',
      "import React from 'react'\n" +
        "import { useNavigate } from 'react-router-dom'\n" +
        'const ProductScreen = ({ match }) => {\n' +
        '  const navigate = useNavigate()\n' +
        '  const addToCart = () => {\n' +
        '    navigate(`/cart/${match.params.id}`)\n' +
        '  }\n' +
        '  return <button onClick={addToCart}>Add</button>\n' +
        '}\n' +
        'export default ProductScreen\n'
    );
    write(
      'frontend/src/screens/CartScreen.js',
      "import React from 'react'\nconst CartScreen = () => <div>Cart</div>\nexport default CartScreen\n"
    );
    // Navigation written as markup, including react-router-bootstrap's wrapper.
    write(
      'frontend/src/components/CheckoutSteps.js',
      "import React from 'react'\n" +
        "import { NavLink } from 'react-router-dom'\n" +
        "import { LinkContainer } from 'react-router-bootstrap'\n" +
        'const CheckoutSteps = ({ step1, step2 }) => (\n' +
        '  <nav>\n' +
        "    <LinkContainer to='/cart'><span>Cart</span></LinkContainer>\n" +
        "    {step1 ? <LinkContainer to='/login'><span>Sign In</span></LinkContainer> : null}\n" +
        "    {step2 ? <NavLink to='/placeorder'>Place Order</NavLink> : null}\n" +
        "    <a href='https://example.com'>Elsewhere</a>\n" +
        '  </nav>\n' +
        ')\n' +
        'export default CheckoutSteps\n'
    );
    write(
      'frontend/src/actions/cartActions.js',
      'export const savePaymentMethod = (data) => (dispatch) => {\n' +
        "  dispatch({ type: 'CART_SAVE_PAYMENT_METHOD', payload: data })\n" +
        "  localStorage.setItem('paymentMethod', JSON.stringify(data))\n" +
        '}\n'
    );
    // The precision floor: an array's `push` with a string that IS a route.
    write(
      'frontend/src/utils/breadcrumbs.js',
      'export const trail = () => {\n' +
        '  const paths = []\n' +
        "  paths.push('/placeorder')\n" +
        '  return paths\n' +
        '}\n'
    );
    cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();
  });

  afterAll(() => {
    cg?.close();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const route = (name: string): Node => {
    const r = cg.getNodesByKind('route').find((r) => r.name === name);
    if (!r) throw new Error(`no route ${name}: ${cg.getNodesByKind('route').map((r) => r.name).join(', ')}`);
    return r;
  };
  const sym = (name: string): Node => {
    const n = cg.getNodesByName(name).find((n) => n.kind !== 'route' && n.kind !== 'file' && n.kind !== 'import');
    if (!n) throw new Error(`no symbol ${name}`);
    return n;
  };
  // A handler written as `const submitHandler = () => {…}` inside a screen is a
  // symbol of its own (#1669), so a navigation it makes is ITS edge — the same
  // shape a `useCallback` handler has — and the screen reaches it by calling it.
  const symIn = (name: string, file: string): Node => {
    const n = cg.getNodesByName(name).find((n) => n.kind !== 'route' && n.kind !== 'file' && n.kind !== 'import' && n.filePath.endsWith(file));
    if (!n) throw new Error(`no symbol ${name} in ${file}`);
    return n;
  };
  const navs = (from: Node) => cg.getOutgoingEdges(from.id).filter((e) => e.kind === 'navigates');
  const hrefs = (from: Node) =>
    navs(from)
      .map((e) => (e.metadata as Record<string, unknown>).href as string)
      .sort();

  it('names every route and binds it to its screen', () => {
    expect(cg.getNodesByKind('route').map((r) => r.name).sort()).toEqual([
      '/cart/:id?',
      '/login',
      '/payment',
      '/placeorder',
      '/product/:id',
      '/shipping',
    ]);
    const bound = cg.getOutgoingEdges(route('/payment').id).find((e) => e.kind === 'references');
    expect(cg.getNode(bound!.target)?.name).toBe('PaymentScreen');
  });

  it('the payment screen pushes to both pages it leads to — the bounce out and the one on submit', () => {
    const payment = sym('PaymentScreen');
    const submit = symIn('submitHandler', 'PaymentScreen.js');
    // The bounce-out is the component's own; the push on submit belongs to its handler.
    expect(hrefs(payment)).toEqual(['/shipping']);
    expect(hrefs(submit)).toEqual(['/placeorder']);
    // `onSubmit={submitHandler}` is the screen's reference to it; the Screens
    // walk below rides that hop.
    expect(cg.getOutgoingEdges(payment.id).some((e) => e.target === submit.id && e.kind === 'references')).toBe(true);
    const byHref = new Map([...navs(payment), ...navs(submit)].map((e) => [(e.metadata as Record<string, unknown>).href, e]));
    expect(byHref.get('/shipping')!.target).toBe(route('/shipping').id);
    expect(byHref.get('/placeorder')!.target).toBe(route('/placeorder').id);
    expect(byHref.get('/placeorder')!.metadata).toMatchObject({ navMethod: 'push' });
  });

  it('history.replace navigates, and v6’s navigate() with a template hole reaches the :id route', () => {
    const shippingSubmit = symIn('submitHandler', 'ShippingScreen.js');
    expect(navs(shippingSubmit)[0]!.target).toBe(route('/payment').id);
    expect(navs(shippingSubmit)[0]!.metadata).toMatchObject({ href: '/payment', navMethod: 'replace' });
    const product = navs(sym('addToCart'));
    expect(product).toHaveLength(1);
    expect(product[0]!.target).toBe(route('/cart/:id?').id);
    expect(product[0]!.metadata).toMatchObject({ href: '/cart/${…}', navMethod: 'navigate' });
  });

  it('a <Link to> / <NavLink to> / <LinkContainer to> navigates from the component that renders it; an external <a> does not', () => {
    expect(hrefs(sym('LoginScreen'))).toEqual(['/shipping']);
    const link = navs(sym('LoginScreen'))[0]!;
    expect(link.provenance).toBe('heuristic');
    expect(link.metadata).toMatchObject({ synthesizedBy: 'react-router-link', href: '/shipping', navMethod: 'link' });
    // `/cart` reaches `/cart/:id?` — an optional parameter serves the bare path too.
    expect(hrefs(sym('CheckoutSteps'))).toEqual(['/cart', '/login', '/placeorder']);
  });

  it('a computed destination is left unresolved, and an array’s push is never claimed', () => {
    // `history.push(redirect)` — the path comes off the query string.
    expect(navs(sym('LoginScreen')).every((e) => (e.metadata as Record<string, unknown>).synthesizedBy === 'react-router-link')).toBe(true);
    expect(navs(sym('trail'))).toEqual([]);
  });

  it('lands on the Screens tab as transitions between screens', async () => {
    const screens = await buildScreens(cg, tmpDir);
    expect(screens.routed).toBe(true);
    const at = (p: string) => screens.screens.find((s) => s.path === p)!;
    const link = screens.links.find((l) => l.from === at('/payment').id && l.to === at('/placeorder').id)!;
    expect(link).toBeDefined();
    expect(link.sites[0]).toMatchObject({ href: '/placeorder', method: 'push' });
    // The submit handler is the hop between the screen and the push.
    expect(link.via.map((v) => v.name)).toEqual(['submitHandler']);
    expect(screens.links.find((l) => l.from === at('/shipping').id && l.to === at('/payment').id)).toBeDefined();
    expect(screens.links.find((l) => l.from === at('/product/:id').id && l.to === at('/cart/:id?').id)).toBeDefined();
  });

  it('the payment screen’s Steps picture draws the pages it leads to, not just its store write', async () => {
    const p = await buildSteps(cg, tmpDir, new URLSearchParams({ anchor: route('/payment').id }));
    const anchor = p.steps.find((s) => s.anchor)!;
    expect(anchor.sub).toBe('PaymentScreen');
    const store = p.steps.find((s) => s.kind === 'effect' && s.effect?.category === 'storage')!;
    expect(store.label).toContain("localStorage.setItem('paymentMethod'");
    // Its own two pushes, plus the link back to sign-in its checkout nav renders.
    const to = p.steps.filter((s) => s.kind === 'screen' && !s.anchor).map((s) => s.screen?.path).sort();
    expect(to).toEqual(['/cart/:id?', '/login', '/placeorder', '/shipping']);
    const placeorder = p.steps.find((s) => s.screen?.path === '/placeorder')!;
    expect(placeorder.cut).toBe('screen');
    const push = p.links.find((l) => l.to === placeorder.id)!;
    expect(push.kind).toBe('navigates');
    expect(push.sites.map((site) => site.text)).toContain('push /placeorder');
    // The bounce out is drawn with the condition that sends the user there.
    const shipping = p.steps.find((s) => s.screen?.path === '/shipping')!;
    const bounce = p.links.find((l) => l.to === shipping.id)!;
    expect(bounce.sites[0]).toMatchObject({ text: 'push /shipping', when: '!shippingAddress.address' });
  });
});

// =============================================================================
// One component at several addresses, and the destinations a login writes
// =============================================================================

describe('react-router: the shapes proshop is written in', () => {
  let tmpDir: string;
  let cg: CodeGraph;

  function write(rel: string, content: string): void {
    const full = path.join(tmpDir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }

  beforeAll(async () => {
    await initGrammars();
    await loadAllGrammars();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-rr-shapes-'));
    write('package.json', JSON.stringify({ name: 'shop', dependencies: { react: '18', 'react-router-dom': '5' } }));
    // One component, four addresses — proshop renders HomeScreen at all four.
    write(
      'src/App.js',
      "import { BrowserRouter as Router, Route } from 'react-router-dom'\n" +
        "import HomeScreen from './screens/HomeScreen'\n" +
        "import LoginScreen from './screens/LoginScreen'\n" +
        "import RegisterScreen from './screens/RegisterScreen'\n" +
        "import ProductScreen from './screens/ProductScreen'\n" +
        'const App = () => (\n' +
        '  <Router>\n' +
        "    <Route path='/search/:keyword' component={HomeScreen} exact />\n" +
        "    <Route path='/page/:pageNumber' component={HomeScreen} exact />\n" +
        "    <Route path='/' component={HomeScreen} exact />\n" +
        "    <Route path='/login' component={LoginScreen} />\n" +
        "    <Route path='/register' component={RegisterScreen} />\n" +
        "    <Route path='/product/:id' component={ProductScreen} />\n" +
        '  </Router>\n' +
        ')\n' +
        'export default App\n'
    );
    write(
      'src/screens/HomeScreen.js',
      "import React from 'react'\n" +
        "import { Link } from 'react-router-dom'\n" +
        'const HomeScreen = ({ match }) => {\n' +
        '  const keyword = match.params.keyword\n' +
        '  return <Link to={`/product/${keyword}`}>A product</Link>\n' +
        '}\n' +
        'export default HomeScreen\n'
    );
    // The destination every react-router app writes for "where to after login".
    write(
      'src/screens/LoginScreen.js',
      "import React, { useEffect } from 'react'\n" +
        "import { Link } from 'react-router-dom'\n" +
        'const LoginScreen = ({ location, history, userInfo }) => {\n' +
        "  const redirect = location.search ? location.search.split('=')[1] : '/'\n" +
        '  useEffect(() => {\n' +
        '    if (userInfo) {\n' +
        '      history.push(redirect)\n' +
        '    }\n' +
        '  }, [history, userInfo, redirect])\n' +
        '  return (\n' +
        '    <Link to={redirect ? `/register?redirect=${redirect}` : \'/register\'}>Register</Link>\n' +
        '  )\n' +
        '}\n' +
        'export default LoginScreen\n'
    );
    write(
      'src/screens/RegisterScreen.js',
      "import React from 'react'\nconst RegisterScreen = () => <div>Register</div>\nexport default RegisterScreen\n"
    );
    // proshop's paginator: one link, three destinations, chosen at runtime.
    write(
      'src/components/Paginate.js',
      "import React from 'react'\n" +
        "import { Link } from 'react-router-dom'\n" +
        'const Paginate = ({ isAdmin, keyword, x }) => (\n' +
        '  <Link\n' +
        '    to={\n' +
        '      !isAdmin\n' +
        '        ? keyword\n' +
        '          ? `/search/${keyword}`\n' +
        '          : `/page/${x}`\n' +
        "        : '/register'\n" +
        '    }\n' +
        '  >\n' +
        '    {x}\n' +
        '  </Link>\n' +
        ')\n' +
        'export default Paginate\n'
    );
    write(
      'src/screens/ProductScreen.js',
      "import React from 'react'\nconst ProductScreen = () => <div>Product</div>\nexport default ProductScreen\n"
    );
    cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();
  });

  afterAll(() => {
    cg?.close();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const route = (name: string): Node => {
    const r = cg.getNodesByKind('route').find((r) => r.name === name);
    if (!r) throw new Error(`no route ${name}`);
    return r;
  };
  const sym = (name: string): Node => {
    const n = cg.getNodesByName(name).find((n) => n.kind !== 'route' && n.kind !== 'file' && n.kind !== 'import');
    if (!n) throw new Error(`no symbol ${name}`);
    return n;
  };
  const navs = (from: Node) => cg.getOutgoingEdges(from.id).filter((e) => e.kind === 'navigates');

  it('a `to={cond ? … : …}` is read, because markup uses the same reader a push does', () => {
    const toRegister = navs(sym('LoginScreen')).find((e) => e.target === route('/register').id);
    expect(toRegister).toBeDefined();
    // Both arms name `/register`; the href shows the one as written.
    expect(toRegister!.metadata).toMatchObject({ synthesizedBy: 'react-router-link', href: '/register?redirect=${…}' });
  });

  it('a destination whose other arm is computed still names where it goes', () => {
    // `const redirect = location.search ? location.search.split('=')[1] : '/'`
    // then `history.push(redirect)` — `/` is where this lands by default.
    const home = navs(sym('LoginScreen')).find((e) => e.target === route('/').id);
    expect(home).toBeDefined();
    expect(home!.metadata).toMatchObject({ href: '/', navMethod: 'push' });
  });

  it('a destination written as a three-way choice draws all three, each with the arm it took', () => {
    const from = navs(sym('Paginate'));
    const byTarget = new Map(from.map((e) => [e.target, (e.metadata as Record<string, unknown>).href]));
    expect(byTarget.get(route('/search/:keyword').id)).toBe('/search/${…}');
    expect(byTarget.get(route('/page/:pageNumber').id)).toBe('/page/${…}');
    expect(byTarget.get(route('/register').id)).toBe('/register');
    // Each edge names the path it took, not the first arm's.
    expect(from).toHaveLength(3);
  });

  it('a link written under a condition carries that condition, and reads as a link', async () => {
    const screens = await buildScreens(cg, tmpDir);
    const at = (p: string) => screens.screens.find((s) => s.path === p)!;
    // `<Link to={redirect ? … : '/register'}>` is markup: the destination is
    // written right there, so it is a `link`, not a helper's `return` value.
    const toRegister = screens.links.find((l) => l.from === at('/login').id && l.to === at('/register').id)!;
    expect(toRegister.sites[0]!.method).toBe('link');
  });

  it('a component rendered at several addresses gives its navigation to EVERY one', async () => {
    const screens = await buildScreens(cg, tmpDir);
    const at = (p: string) => screens.screens.find((s) => s.path === p)!;
    // HomeScreen serves three routes; all three lead to the product page.
    for (const from of ['/', '/search/:keyword', '/page/:pageNumber']) {
      expect(screens.links.find((l) => l.from === at(from).id && l.to === at('/product/:id').id)).toBeDefined();
    }
    // …and none of them is left as a screen you can reach but never leave.
    for (const s of screens.screens) {
      if (s.path === '/product/:id' || s.path === '/register') continue;
      expect(screens.links.some((l) => l.from === s.id)).toBe(true);
    }
    expect(screens.dropped).toBe(0);
  });
});


describe('react-router: route declaration boundaries (#1348)', () => {
  let tmpDir: string;
  let cg: CodeGraph | undefined;

  afterEach(() => {
    cg?.close();
    cg = undefined;
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function index(source: string, extension: string) {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-rr-boundaries-'));
    fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({ dependencies: { react: '18' } }));
    fs.writeFileSync(path.join(tmpDir, `App.${extension}`), source);
    cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();
    const routes = cg.getNodesByKind('route');
    return {
      paths: routes.map((route) => route.name).sort(),
      bindings: routes.flatMap((route) => cg!.getOutgoingEdges(route.id)
        .filter((edge) => edge.kind === 'references')
        .map((edge) => `${route.name}->${cg!.getNode(edge.target)?.name}`)).sort(),
    };
  }

  it.each(['tsx', 'jsx', 'js'])('keeps nested/index JSX routes and long attributes local in %s', async (extension) => {
    const result = await index(`
      import { Routes, Route } from 'react-router-dom';
      function DashboardHome() { return null; }
      function Settings() { return null; }
      function Shell() { return null; }
      const comparison = count<limit;
      const fake = '<Route path="/fake" element={<DashboardHome/>}/>';
      export function App() {
        return <Routes>
          <Route path="/dashboard">
            <Route index element={<DashboardHome/>}/>
            <Route path="settings" element={<Settings/>}/>
          </Route>
          <Route path="/empty"></Route>
          <Route element={<Settings/>} path="/sibling"/>
          <Route element={<Shell title="a > b"><Settings path="/nested"/></Shell>}
            check={/}/.test('}')}
            handle={{ text: 'path="/borrowed"', nested: { element: <DashboardHome/> } }}
            title="${'x'.repeat(600)}" path="/long"/>
          <Route path="/no-element" handle={{ element: <DashboardHome/> }}/>
          <Route component={Settings} path="/legacy"/>
        </Routes>;
      }
    `, extension);
    expect(result).toEqual({
      // A nested route's path is relative to its parent's (`settings` under `/dashboard`).
      paths: ['/dashboard', '/dashboard/settings', '/empty', '/legacy', '/long', '/no-element', '/sibling'],
      bindings: ['/dashboard/settings->Settings', '/legacy->Settings', '/long->Shell', '/sibling->Settings'],
    });
  });

  it.each(['tsx', 'jsx', 'ts', 'js'])('pairs only direct data-router properties in either order in %s', async (extension) => {
    const result = await index(`
      import { createBrowserRouter } from 'react-router-dom';
      function DataIndex() { return null; }
      function DataSettings() { return null; }
      const routes = createBrowserRouter([
        { path: '/data', children: [
          { index: true, Component: DataIndex },
          { Component: DataSettings, path: 'prefs' }
        ] },
        { path: '/empty' },
        { Component: DataSettings, path: '/sibling' },
        { path: '/metadata', handle: { Component: DataIndex } },
        { Component: DataSettings, handle: { path: '/not-own' } },
        { path: '/long', handle: { text: '${'x'.repeat(600)}' }, Component: DataSettings },
        { 'Component': DataSettings, /* path: '/fake' */ 'path': '/quoted' /* trailing comment */ },
        { path: '', Component: DataSettings }
      ]);
    `, extension);
    expect(result).toEqual({
      // `{ index: true, Component: DataIndex }` is the page at its parent's address.
      paths: ['/', '/data', '/data/prefs', '/long', '/quoted', '/sibling'],
      bindings: ['/->DataSettings', '/data->DataIndex', '/data/prefs->DataSettings', '/long->DataSettings', '/quoted->DataSettings', '/sibling->DataSettings'],
    });
  });

  it('keeps nested JSX and comma-containing expressions inside their data-router property', async () => {
    const result = await index(`
      import { createMemoryRouter } from 'react-router-dom';
      function Shell() { return null; }
      function Child() { return null; }
      const router = createMemoryRouter([
        { element: <Shell title="a > b"><Child path="/fake"/>hello, world</Shell>,
          handle: { text: "}, path: '/fake'", callback: () => ({ path: '/also-fake' }) }, path: '/shell' },
        { path: '/none', handle: { element: <Child/> } },
        { path: '/child', element: <Child/> }
      ]);
    `, 'tsx');
    expect(result).toEqual({ paths: ['/child', '/shell'], bindings: ['/child->Child', '/shell->Shell'] });
  });
});

describe('react-router: v5 redirects and styled link wrappers', () => {
  let root: string;
  let cg: CodeGraph;
  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-rr-wrappers-'));
    const files: Record<string, string> = {
      'package.json': JSON.stringify({ name: 'app', dependencies: { react: '*', 'react-router-dom': '^5.0.0', 'styled-components': '*' } }),
      // react-boilerplate: the header's links are a styled Link, default-exported.
      'app/components/Header/HeaderLink.js': `import { Link } from 'react-router-dom';
import styled from 'styled-components';

export default styled(Link)\`
  color: #41addd;
\`;
`,
      'app/components/Header/index.js': `import React from 'react';
import HeaderLink from './HeaderLink';

export default function Header() {
  return (
    <nav>
      <HeaderLink to="/">Home</HeaderLink>
      <HeaderLink to="/features">Features</HeaderLink>
    </nav>
  );
}
`,
      'app/components/Nav.js': `import React from 'react';
import { NavLink } from 'react-router-dom';
import styled from 'styled-components';

const MenuLink = styled(NavLink)\`
  padding: 4px;
\`;

export default function Nav() {
  return <MenuLink to="/features">Features</MenuLink>;
}
`,
      // takenote: a guard renders v5's <Redirect to>.
      'app/router/PrivateRoute.js': `import React from 'react';
import { Route, Redirect } from 'react-router-dom';

export default function PrivateRoute({ component: Component, ...rest }) {
  return <Route {...rest} render={(props) => (rest.isAuthenticated ? <Component {...props} /> : <Redirect to="/" />)} />;
}
`,
      'app/containers/App.js': `import React from 'react';
import { Switch, Route } from 'react-router-dom';
import HomePage from './HomePage';
import FeaturePage from './FeaturePage';

export default function App() {
  return (
    <Switch>
      <Route exact path="/" component={HomePage} />
      <Route path="/features" component={FeaturePage} />
    </Switch>
  );
}
`,
      'app/containers/HomePage.js': `import React from 'react';
export default function HomePage() { return <h1>Home</h1>; }
`,
      'app/containers/FeaturePage.js': `import React from 'react';
export default function FeaturePage() { return <h1>Features</h1>; }
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

  const navsFrom = (name: string) => {
    const from = cg.getNodesByName(name).find((n) => n.kind === 'function' || n.kind === 'component')!;
    return cg
      .getOutgoingEdges(from.id)
      .filter((e) => e.kind === 'navigates')
      .map((e) => `${(e.metadata as Record<string, unknown>).navMethod} ${cg.getNode(e.target)!.name}`)
      .sort();
  };

  it('a styled(Link) wrapper, imported or local, is a link', () => {
    expect(navsFrom('Header')).toEqual(['link /', 'link /features']);
    expect(navsFrom('Nav')).toEqual(['link /features']);
  });

  it('v5’s <Redirect to> navigates', () => {
    expect(navsFrom('PrivateRoute')).toEqual(['redirect /']);
  });
});

// =============================================================================
// Route tables another file hands the router
// =============================================================================

function writeFiles(root: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
}

async function indexProject(files: Record<string, string>): Promise<{ root: string; cg: CodeGraph }> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-rr-tables-'));
  writeFiles(root, files);
  return { root, cg: await CodeGraph.init(root, { index: true }) };
}

/** `path -> Component` for what each route renders, `path ~> Layout` for each layout around it. */
function routeBindings(cg: CodeGraph): string[] {
  return cg.getNodesByKind('route').flatMap((r) => cg.getOutgoingEdges(r.id)
    .filter((e) => e.kind === 'references')
    .map((e) => `${r.name} ${(e.metadata as Record<string, unknown> | undefined)?.layout ? '~>' : '->'} ${cg.getNode(e.target)?.name}`))
    .sort();
}

/** `Source -> /path` for every navigation into a route. */
function navigations(cg: CodeGraph): string[] {
  return cg.getNodesByKind('route').flatMap((r) => cg.getIncomingEdges(r.id)
    .filter((e) => e.kind === 'navigates')
    .map((e) => `${cg.getNode(e.source)?.name} -> ${r.name}`))
    .sort();
}

const routeNames = (cg: CodeGraph): string[] => cg.getNodesByKind('route').map((r) => r.name).sort();

const component = (name: string): string => `export function ${name}() {\n  return <div>${name}</div>;\n}\n`;

/** jasontaylordev/CleanArchitecture's ClientApp-React and the ASP.NET Core React template it comes from. */
const ASPNET_TEMPLATE: Record<string, string> = {
  'src/Web/ClientApp/package.json': JSON.stringify({ name: 'web', dependencies: { react: '^18', 'react-router-dom': '^6' } }),
  'src/Web/ClientApp/src/AppRoutes.js': `import ApiAuthorzationRoutes from './components/api-authorization/ApiAuthorizationRoutes';
import { Counter } from "./components/Counter";
import { FetchData } from "./components/FetchData";
import { Home } from "./components/Home";
import { ProtectedRoute } from "./components/ProtectedRoute";
import AdminWrapper from "./components/AdminWrapper";
import { Users } from "./components/Users";

const AppRoutes = [
  {
    index: true,
    element: <Home />
  },
  {
    path: '/counter',
    element: <Counter />
  },
  {
    path: '/fetch-data',
    requireAuth: true,
    element: <ProtectedRoute><FetchData /></ProtectedRoute>
  },
  {
    path: 'admin/users',
    element: <AdminWrapper><Users /></AdminWrapper>
  },
  ...ApiAuthorzationRoutes
];

export default AppRoutes;
`,
  'src/Web/ClientApp/src/components/api-authorization/ApiAuthorizationRoutes.js': `import { Profile } from './Profile';
import { Login } from './Login';
import { ApplicationPaths } from './ApiAuthorizationConstants';

const ApiAuthorizationRoutes = [
  {
    path: '/authentication/profile',
    element: <Profile />
  },
  {
    path: ApplicationPaths.Login,
    element: loginAction('login')
  }
];

function loginAction(name) {
  return <Login action={name}></Login>;
}

export default ApiAuthorizationRoutes;
`,
  'src/Web/ClientApp/src/components/api-authorization/ApiAuthorizationConstants.js':
    "const prefix = '/authentication';\nexport const ApplicationPaths = {\n  Login: `${prefix}/login`,\n};\n",
  'src/Web/ClientApp/src/App.js': `import React, { Component } from 'react';
import { Route, Routes } from 'react-router-dom';
import AppRoutes from './AppRoutes';
import AuthorizeRoute from './components/api-authorization/AuthorizeRoute';
import { Layout } from './components/Layout';

export default class App extends Component {
  static displayName = App.name;

  render() {
    return (
      <Layout>
        <Routes>
          {AppRoutes.map((route, index) => {
            const { element, requireAuth, ...rest } = route;
            return <Route key={index} {...rest} element={requireAuth ? <AuthorizeRoute {...rest} element={element} /> : element} />;
          })}
        </Routes>
      </Layout>
    );
  }
}
`,
  'src/Web/ClientApp/src/components/NavMenu.js': `import { Link, NavLink, useNavigate } from 'react-router-dom';
import { menu } from '../menu';

export function NavMenu() {
  const navigate = useNavigate();
  const showProfile = () => {
    navigate('/authentication/profile');
  };
  return (
    <nav>
      <Link to="/">Home</Link>
      <Link to="/counter">Counter</Link>
      <Link to="/fetch-data">Fetch data</Link>
      <button onClick={showProfile}>Profile</button>
      {menu.map((item) => <NavLink key={item.path} to={item.path}>{item.element}</NavLink>)}
    </nav>
  );
}
`,
  // `{ path, element }` lists that are not route tables: a menu rendered as
  // links, a list nothing renders, and a table mapped into a path it does not
  // hold (`layout + path`).
  'src/Web/ClientApp/src/menu.js': `import { HelpIcon, SettingsIcon } from './icons';
export const menu = [
  { path: '/help', element: <HelpIcon /> },
  { path: '/settings', element: <SettingsIcon /> },
];
`,
  'src/Web/ClientApp/src/breadcrumbs.js': `import { Crumb } from './icons';
export const crumbs = [{ path: '/history', element: <Crumb /> }];
`,
  'src/Web/ClientApp/src/dashboard.js': `import { Route, Routes } from 'react-router-dom';
import { Stats } from './icons';
const dashboardRoutes = [{ path: '/stats', layout: '/admin', element: <Stats /> }];
export function Dashboard() {
  return <Routes>{dashboardRoutes.map((r) => <Route key={r.path} path={r.layout + r.path} element={r.element} />)}</Routes>;
}
`,
  'src/Web/ClientApp/src/icons.js': component('HelpIcon') + component('SettingsIcon') + component('Crumb') + component('Stats'),
  'src/Web/ClientApp/src/components/Home.js': component('Home'),
  'src/Web/ClientApp/src/components/Counter.js': component('Counter'),
  'src/Web/ClientApp/src/components/FetchData.js': component('FetchData'),
  'src/Web/ClientApp/src/components/ProtectedRoute.js': 'export function ProtectedRoute({ children }) {\n  return children;\n}\n',
  'src/Web/ClientApp/src/components/AdminWrapper.js': 'export default function AdminWrapper({ children }) {\n  return children;\n}\n',
  'src/Web/ClientApp/src/components/Users.js': component('Users'),
  'src/Web/ClientApp/src/components/Layout.js':
    "import { NavMenu } from './NavMenu';\nexport function Layout({ children }) {\n  return <div><NavMenu />{children}</div>;\n}\n",
  'src/Web/ClientApp/src/components/api-authorization/Profile.js': component('Profile'),
  'src/Web/ClientApp/src/components/api-authorization/Login.js': component('Login'),
  'src/Web/ClientApp/src/components/api-authorization/AuthorizeRoute.js':
    'export default function AuthorizeRoute({ element }) {\n  return element;\n}\n',
};

describe('react-router: a route table another file maps into <Route> (the ASP.NET Core React template)', () => {
  let root: string;
  let cg: CodeGraph;
  beforeAll(async () => {
    ({ root, cg } = await indexProject(ASPNET_TEMPLATE));
  });
  afterAll(() => {
    cg?.close();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it('reads the table App.js spreads into <Route {...rest}>, and the table it spreads in turn', () => {
    expect(routeBindings(cg)).toEqual([
      // `index: true` at the top of the table is the app's `/`.
      '/ -> Home',
      // `<AdminWrapper><Users /></AdminWrapper>` and
      // `<ProtectedRoute><FetchData /></ProtectedRoute>` render what they wrap.
      '/admin/users -> Users',
      '/authentication/profile -> Profile',
      '/counter -> Counter',
      '/fetch-data -> FetchData',
    ]);
    // An entry that renders a call's result names no component, so it is no route.
    expect(routeNames(cg)).toEqual(['/', '/admin/users', '/authentication/profile', '/counter', '/fetch-data']);
  });

  it('keeps each route at the line of its own object in the table', () => {
    const counter = cg.getNodesByKind('route').find((r) => r.name === '/counter')!;
    expect(counter.filePath).toBe('src/Web/ClientApp/src/AppRoutes.js');
    expect(counter.startLine).toBe(15);
  });

  it('makes no route of a menu, a list nothing hands the router, or a path the table does not hold', () => {
    for (const p of ['/help', '/settings', '/history', '/stats', '/admin/stats']) expect(routeNames(cg)).not.toContain(p);
  });

  it('gives the navigation that names those routes somewhere to go', () => {
    expect(navigations(cg)).toEqual([
      'NavMenu -> /',
      'NavMenu -> /counter',
      'NavMenu -> /fetch-data',
      'showProfile -> /authentication/profile',
    ]);
  });

  it('lands on the Screens tab', async () => {
    const screens = await buildScreens(cg, root);
    expect(screens.routed).toBe(true);
    expect(screens.screens.map((s) => s.path).sort()).toEqual(['/', '/admin/users', '/authentication/profile', '/counter', '/fetch-data']);
  });
});

describe('react-router: a table handed to useRoutes from another file, an index route under a layout', () => {
  let root: string;
  let cg: CodeGraph;
  beforeAll(async () => {
    ({ root, cg } = await indexProject({
      'package.json': JSON.stringify({ name: 'kit', dependencies: { react: '^18', 'react-router-dom': '^6' } }),
      // A table written as a function of the login state, the way many admin kits write it.
      'src/routes.jsx': `import { Navigate } from 'react-router-dom';
import DashboardLayout from './layouts/DashboardLayout';
import MainLayout from './layouts/MainLayout';
import { Account, Dashboard, Landing, Login } from './pages';

const routes = (isLoggedIn) => [
  {
    path: 'app',
    element: isLoggedIn ? <DashboardLayout /> : <Navigate to="/login" />,
    children: [
      { path: 'dashboard', element: <Dashboard /> },
      { path: 'account', element: <Account /> },
    ],
  },
  {
    path: '/',
    element: <MainLayout />,
    children: [
      { index: true, element: <Landing /> },
      { path: 'login', element: <Login /> },
    ],
  },
];

export default routes;
`,
      'src/App.jsx': `import { useRoutes } from 'react-router-dom';
import routes from './routes';

export default function App({ isLoggedIn }) {
  return useRoutes(routes(isLoggedIn));
}
`,
      'src/layouts/MainLayout.jsx': `import { Link, Outlet } from 'react-router-dom';
export default function MainLayout() {
  return <div><Link to="/app/dashboard">Dashboard</Link><Outlet /></div>;
}
`,
      'src/layouts/DashboardLayout.jsx': `import { Outlet } from 'react-router-dom';
export default function DashboardLayout() {
  return <Outlet />;
}
`,
      'src/pages.jsx': `import { useNavigate } from 'react-router-dom';
export function Dashboard() { return <div>Dashboard</div>; }
export function Account() { return <div>Account</div>; }
export function Landing() { return <div>Landing</div>; }
export function Login() {
  const navigate = useNavigate();
  const onSubmit = () => navigate('/app/account');
  return <form onSubmit={onSubmit} />;
}
`,
    }));
  });
  afterAll(() => {
    cg?.close();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it('reads the table the function returns, nested paths composed', () => {
    expect(routeBindings(cg)).toEqual([
      // The index route is the page at `/`; MainLayout is the layout around it, not a second `/`.
      '/ -> Landing',
      '/ ~> MainLayout',
      // `app`'s element is a choice made at runtime: a path to sit under, no layout.
      '/app/account -> Account',
      '/app/dashboard -> Dashboard',
      '/login -> Login',
      '/login ~> MainLayout',
    ]);
  });

  it("draws a layout's links on every screen inside it", async () => {
    expect(navigations(cg)).toEqual([
      'MainLayout -> /app/dashboard',
      'onSubmit -> /app/account',
      // The table's own guard: `isLoggedIn ? <DashboardLayout /> : <Navigate to="/login" />`.
      'routes -> /login',
    ]);
    const screens = await buildScreens(cg, root);
    expect(screens.routed).toBe(true);
    const at = (p: string) => screens.screens.find((s) => s.path === p)!.id;
    for (const from of ['/', '/login']) {
      expect(screens.links.find((l) => l.from === at(from) && l.to === at('/app/dashboard'))).toBeDefined();
    }
    expect(screens.links.find((l) => l.from === at('/login') && l.to === at('/app/account'))).toBeDefined();
  });
});

describe("react-router: route objects in their own files, handed to createBrowserRouter (codedthemes' admin templates)", () => {
  let root: string;
  let cg: CodeGraph;
  beforeAll(async () => {
    ({ root, cg } = await indexProject({
      'package.json': JSON.stringify({ name: 'berry', dependencies: { react: '^18', 'react-router-dom': '^7' } }),
      'src/routes/index.jsx': `import { createBrowserRouter } from 'react-router-dom';

// routes
import AuthenticationRoutes from './AuthenticationRoutes';
import MainRoutes from './MainRoutes';

const router = createBrowserRouter([MainRoutes, AuthenticationRoutes], {
  basename: import.meta.env.VITE_APP_BASE_NAME
});

export default router;
`,
      'src/routes/MainRoutes.jsx': `import { lazy } from 'react';
import MainLayout from '../layout/MainLayout';
import Loadable from '../ui-component/Loadable';

const DashboardDefault = Loadable(lazy(() => import('../views/DashboardDefault')));
// An import only the app's own build resolves (\`baseUrl\`).
const SamplePage = Loadable(lazy(() => import('views/sample-page')));

const MainRoutes = {
  path: '/',
  element: <MainLayout />,
  children: [
    {
      path: '/',
      element: <DashboardDefault />
    },
    {
      path: 'dashboard',
      children: [
        {
          path: 'default',
          element: <DashboardDefault />
        }
      ]
    },
    {
      path: '/sample-page',
      element: <SamplePage />
    }
  ]
};

export default MainRoutes;
`,
      'src/routes/AuthenticationRoutes.jsx': `import MinimalLayout from '../layout/MinimalLayout';
import LoginPage from '../views/LoginPage';

const AuthenticationRoutes = {
  path: '/',
  element: <MinimalLayout />,
  children: [
    {
      path: '/pages/login',
      element: <LoginPage />
    }
  ]
};

export default AuthenticationRoutes;
`,
      'src/layout/MainLayout.jsx': 'export default function MainLayout() {\n  return <main />;\n}\n',
      'src/layout/MinimalLayout.jsx': 'export default function MinimalLayout() {\n  return <main />;\n}\n',
      'src/views/DashboardDefault.jsx': 'export default function DashboardDefault() {\n  return <div />;\n}\n',
      'src/views/LoginPage.jsx': 'export default function LoginPage() {\n  return <div />;\n}\n',
      'src/ui-component/Loadable.jsx': 'export default function Loadable(Component) {\n  return (props) => <Component {...props} />;\n}\n',
      // The repository's other app, with pages of the same names.
      'next/package.json': JSON.stringify({ name: 'berry-next', dependencies: { next: '^15', react: '^18' } }),
      'next/src/views/sample-page.jsx': 'export default function SamplePage() {\n  return <div />;\n}\n',
      'next/src/views/default.jsx': 'export default function DashboardDefault() {\n  return <div />;\n}\n',
    }));
  });
  afterAll(() => {
    cg?.close();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it('reads each route object the array names, its children under its path', () => {
    expect(routeBindings(cg)).toEqual([
      // MainRoutes' `/` child claims its layout's address.
      '/ -> DashboardDefault',
      '/ ~> MainLayout',
      // No child of the login layout claims `/`, so it is a page there of its
      // own — the rule Angular and Vue routes follow.
      '/ -> MinimalLayout',
      '/dashboard/default -> DashboardDefault',
      '/dashboard/default ~> MainLayout',
      '/pages/login -> LoginPage',
      '/pages/login ~> MinimalLayout',
      '/sample-page -> SamplePage',
      '/sample-page ~> MainLayout',
    ].sort());
  });

  it('binds a page the route file loads lazily to the module it loads, and never to a same-named page of another app', () => {
    const rendered = (p: string): string[] => cg.getNodesByKind('route').filter((r) => r.name === p).flatMap((r) => cg.getOutgoingEdges(r.id)
      .filter((e) => e.kind === 'references' && !(e.metadata as Record<string, unknown> | undefined)?.layout)
      .map((e) => { const n = cg.getNode(e.target)!; return `${n.kind} ${n.name} ${n.filePath}`; }));
    expect(rendered('/dashboard/default')).toEqual(['function DashboardDefault src/views/DashboardDefault.jsx']);
    // Its module is out of reach, so the page is the declaration itself.
    expect(rendered('/sample-page')).toEqual(['constant SamplePage src/routes/MainRoutes.jsx']);
  });
});

describe('react-router: a table mapped inside <Route path> in the same file', () => {
  let root: string;
  let cg: CodeGraph;
  beforeAll(async () => {
    ({ root, cg } = await indexProject({
      'ClientApp/package.json': JSON.stringify({ name: 'client', dependencies: { react: '^18', 'react-router-dom': '^6' } }),
      'ClientApp/src/routes.js': `import { Routes, Route } from 'react-router-dom';
import DashboardLayout from './layouts/dashboard';
import DashboardApp from './pages/DashboardApp';
import LandingPage from './pages/LandingPage';
import TicketDetail from './pages/TicketDetail';

const DashboardRoutes = [
    {
        path: 'app',
        requireAuth: true,
        element: <DashboardApp/>
    },
    {
        path: 'tickets/:id',
        requireAuth: true,
        element: <TicketDetail/>
    }
];

export default function Router() {
    return (
        <Routes>
            <Route path="landing" element={<LandingPage/>}/>
            <Route path="/dashboard" element={<DashboardLayout/>}>
                {DashboardRoutes.map((route, index) => {
                    const {element, requireAuth, ...rest} = route;
                    return <Route key={index} {...rest} element={element}/>;
                })}
            </Route>
        </Routes>
    );
}
`,
      'ClientApp/src/layouts/dashboard.js': 'export default function DashboardLayout() {\n  return <div />;\n}\n',
      'ClientApp/src/pages/DashboardApp.js': 'export default function DashboardApp() {\n  return <div />;\n}\n',
      'ClientApp/src/pages/LandingPage.js': 'export default function LandingPage() {\n  return <div />;\n}\n',
      'ClientApp/src/pages/TicketDetail.js': 'export default function TicketDetail() {\n  return <div />;\n}\n',
    }));
  });
  afterAll(() => {
    cg?.close();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it("composes the table's relative paths onto the <Route path> it is mapped inside", () => {
    expect(routeBindings(cg)).toEqual([
      '/dashboard -> DashboardLayout',
      '/dashboard/app -> DashboardApp',
      '/dashboard/tickets/:id -> TicketDetail',
      '/landing -> LandingPage',
    ]);
  });
});

describe('react-router: a route table as the files around it change', () => {
  let root: string;
  let cg: CodeGraph;
  const app = (body: string) => `import { Route, Routes } from 'react-router-dom';
import AppRoutes from './AppRoutes';
import { Counter } from './Counter';

export default function App() {
  return (
    <Routes>
      ${body}
    </Routes>
  );
}
`;
  const MAPPED = app('{AppRoutes.map(({ element, ...rest }, index) => <Route key={index} {...rest} element={element} />)}');
  const table = (extra: string) => `import { Counter } from './Counter';
import { Home } from './Home';
import { FetchData } from './FetchData';

const AppRoutes = [${extra}
  { index: true, element: <Home /> },
  { path: '/counter', element: <Counter /> },
];

export default AppRoutes;
`;
  beforeAll(async () => {
    ({ root, cg } = await indexProject({
      'package.json': JSON.stringify({ name: 'app', dependencies: { react: '^18', 'react-router-dom': '^6' } }),
      'src/AppRoutes.js': table(''),
      'src/App.js': MAPPED,
      'src/Home.js': component('Home'),
      'src/Counter.js': component('Counter'),
      'src/FetchData.js': component('FetchData'),
      'src/NavMenu.js': `import { Link, useNavigate } from 'react-router-dom';
export function NavMenu() {
  const navigate = useNavigate();
  const goHome = () => navigate('/');
  return <nav><button onClick={goHome}>Home</button><Link to="/counter">Counter</Link></nav>;
}
`,
    }));
  });
  afterAll(() => {
    cg?.close();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it('starts with the table read', () => {
    expect(routeNames(cg)).toEqual(['/', '/counter']);
    expect(navigations(cg)).toEqual(['NavMenu -> /counter', 'goHome -> /']);
  });

  it('an edit to the table moves its routes, and what navigated to them still does', async () => {
    writeFiles(root, { 'src/AppRoutes.js': table("\n  { path: '/fetch-data', element: <FetchData /> },") });
    await cg.sync();
    expect(routeBindings(cg)).toEqual(['/ -> Home', '/counter -> Counter', '/fetch-data -> FetchData']);
    expect(navigations(cg)).toEqual(['NavMenu -> /counter', 'goHome -> /']);
  });

  it('a file that stops handing the table over takes its routes with it, and putting it back brings them back', async () => {
    writeFiles(root, { 'src/App.js': app('<Route path="/static" element={<Counter />} />') });
    await cg.sync();
    expect(routeNames(cg)).toEqual(['/static']);
    writeFiles(root, { 'src/App.js': MAPPED });
    await cg.sync();
    expect(routeNames(cg)).toEqual(['/', '/counter', '/fetch-data']);
    expect(navigations(cg)).toContain('NavMenu -> /counter');
  });

  it('deleting that file is a change too', async () => {
    fs.rmSync(path.join(root, 'src/App.js'));
    await cg.sync();
    expect(routeNames(cg)).toEqual([]);
  });
});
