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

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
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
    expect(hrefs(payment)).toEqual(['/placeorder', '/shipping']);
    const byHref = new Map(navs(payment).map((e) => [(e.metadata as Record<string, unknown>).href, e]));
    expect(byHref.get('/shipping')!.target).toBe(route('/shipping').id);
    expect(byHref.get('/placeorder')!.target).toBe(route('/placeorder').id);
    expect(byHref.get('/placeorder')!.metadata).toMatchObject({ navMethod: 'push' });
  });

  it('history.replace navigates, and v6’s navigate() with a template hole reaches the :id route', () => {
    expect(navs(sym('ShippingScreen'))[0]!.target).toBe(route('/payment').id);
    expect(navs(sym('ShippingScreen'))[0]!.metadata).toMatchObject({ href: '/payment', navMethod: 'replace' });
    const product = navs(sym('ProductScreen'));
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
    expect(link.via).toEqual([]);
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
