import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { initGrammars } from '../src/extraction/grammars';
import { callArgumentsInSource, guardsInSource, guardLabel, supportsBranchGuards, triggerInSource } from '../src/graph/branch-guards';
import { buildNode } from '../src/ui-server/api/node';
import { buildFlow } from '../src/ui-server/api/flow';

beforeAll(async () => {
  await initGrammars();
});

/** Line (1-based) of the first line containing `needle`. */
function lineOf(src: string, needle: string): number {
  const i = src.split('\n').findIndex((l) => l.includes(needle));
  if (i < 0) throw new Error(`no line contains ${needle}`);
  return i + 1;
}

async function labelAt(src: string, needle: string, language: 'tsx' | 'typescript' | 'swift' = 'tsx') {
  const line = lineOf(src, needle);
  const column = src.split('\n')[line - 1]!.indexOf(needle);
  return guardLabel(await guardsInSource(src, language, line, column));
}

describe('branch guards: JS/TS', () => {
  const handlePress = `
export function ItemCard(props) {
  const handlePress = useCallback(() => {
    if (isUploading) return
    if (isCollected) {
      openObjectDetail(item, folderName)
      return
    }
    if (queueHasItems) {
      handleAddToQueue()
      return
    }
    handleStartCapture()
  }, [])
  return null
}
`;

  it('reads an if branch and the early-return guards before it', async () => {
    expect(await labelAt(handlePress, 'openObjectDetail(')).toBe('!isUploading && isCollected');
  });

  it('keeps a disjunctive guard in parentheses, so the join stays unambiguous', async () => {
    const src = `
function go(object) {
  if (isUploading) return
  if (!object?.id || !object?.name) {
    bail()
    return
  }
  proceed()
}
`;
    expect(await labelAt(src, 'bail(')).toBe('!isUploading && (!object?.id || !object?.name)');
    expect(await labelAt(src, 'proceed(')).toBe('!isUploading && !(!object?.id || !object?.name)');
  });

  it('turns each earlier early-return into a negated guard, in source order', async () => {
    expect(await labelAt(handlePress, 'handleAddToQueue(')).toBe('!isUploading && !isCollected && queueHasItems');
    expect(await labelAt(handlePress, 'handleStartCapture(')).toBe('!isUploading && !isCollected && !queueHasItems');
  });

  it('does not climb past a function that is declared or assigned to a name', async () => {
    const src = `
function outer() {
  if (outerCond) {
    const cb = () => {
      if (inner) run()
    }
    function named() { if (deep) walk() }
  }
}`;
    expect(await labelAt(src, 'run()')).toBe('inner');
    expect(await labelAt(src, 'walk()')).toBe('deep');
  });

  it('an inline callback inherits the conditions its definition sits under', async () => {
    const src = `
function verify(total) {
  if (selectedHasBarcode) {
    if (total > 1) {
      return { proceed: () => router.navigate('/barcode-matches') }
    }
    return { ok: true, proceed: () => captureObject(item) }
  }
  list.forEach((x) => { if (x.ok) keep(x) })
}`;
    expect(await labelAt(src, 'captureObject(item)')).toBe('selectedHasBarcode && !(total > 1)');
    expect(await labelAt(src, "router.navigate(")).toBe('selectedHasBarcode && total > 1');
    expect(await labelAt(src, 'keep(x)')).toBe('!selectedHasBarcode && x.ok');
  });

  it('reads else, else-if, and the arms of a ternary', async () => {
    const src = `
function f() {
  if (a) { one() } else if (b) { two() } else { three() }
  const x = ready ? go() : wait()
}`;
    expect(await labelAt(src, 'one()')).toBe('a');
    expect(await labelAt(src, 'two()')).toBe('!a && b');
    expect(await labelAt(src, 'three()')).toBe('!a && !b');
    expect(await labelAt(src, 'go()')).toBe('ready');
    expect(await labelAt(src, 'wait()')).toBe('!ready');
  });

  it('reads switch cases, && / || short-circuits, and catch', async () => {
    const src = `
function f() {
  switch (mode) {
    case 'verify': scan(); break
    default: capture()
  }
  ok && fire()
  ok || fallback()
  try { risky() } catch (e) { report(e) }
}`;
    expect(await labelAt(src, 'scan()')).toBe("mode === 'verify'");
    expect(await labelAt(src, 'capture()')).toBe('mode: default');
    expect(await labelAt(src, 'fire()')).toBe('ok');
    expect(await labelAt(src, 'fallback()')).toBe('!ok');
    expect(await labelAt(src, 'report(e)')).toBe('on error');
    expect(await labelAt(src, 'risky()')).toBe('');
  });

  it('negates readably: a bare !x guard reads as x, a compound one is parenthesised', async () => {
    const src = `
function f() {
  if (!ready) return
  if (a && b) { } else { alt() }
  if (count > 0) go()
  if (options?.verify !== false && (item.barcodes?.length ?? 0) > 0) verify()
}`;
    expect(await labelAt(src, 'alt()')).toBe('ready && !(a && b)');
    expect(await labelAt(src, 'go()')).toBe('ready && count > 0');
    expect(await labelAt(src, 'verify()')).toBe('ready && options?.verify !== false && (item.barcodes?.length ?? 0) > 0');
  });

  it('a call inside a condition is not guarded by that condition', async () => {
    const src = `
function f() {
  if (isReady()) run()
}`;
    expect(await labelAt(src, 'isReady()')).toBe('');
    expect(await labelAt(src, 'run()')).toBe('isReady()');
  });

  it('an if whose body does not always exit is not a guard', async () => {
    const src = `
function f() {
  if (x) { log() }
  go()
}`;
    expect(await labelAt(src, 'go()')).toBe('');
  });

  it('caps a very long condition', async () => {
    const cond = 'a'.repeat(120);
    const src = `function f() {\n  if (${cond}) go()\n}`;
    const label = await labelAt(src, 'go()');
    expect(label.length).toBeLessThan(90);
    expect(label.endsWith('…')).toBe(true);
  });
});

describe('branch guards: Swift', () => {
  it('reads guard, if/else, ternary and switch', async () => {
    const src = `
func decide() {
  guard ready else { bail(); return }
  if isCollected { open() } else if other { two() } else { close() }
  let x = flag ? a() : b()
  switch mode { case .verify: scan() default: capture() }
}`;
    expect(await labelAt(src, 'bail()', 'swift')).toBe('!ready');
    expect(await labelAt(src, 'open()', 'swift')).toBe('ready && isCollected');
    expect(await labelAt(src, 'two()', 'swift')).toBe('ready && !isCollected && other');
    expect(await labelAt(src, 'close()', 'swift')).toBe('ready && !isCollected && !other');
    expect(await labelAt(src, 'a()', 'swift')).toBe('ready && flag');
    expect(await labelAt(src, 'b()', 'swift')).toBe('ready && !flag');
    expect(await labelAt(src, 'scan()', 'swift')).toBe('ready && mode == .verify');
    expect(await labelAt(src, 'capture()', 'swift')).toBe('ready && mode: default');
  });

  it('joins multi-clause conditions and treats an early return as a guard', async () => {
    const src = `
func f() {
  if let item = current, item.count > 0 { use(item) }
  if busy { return }
  go()
}`;
    expect(await labelAt(src, 'use(item)', 'swift')).toBe('let item = current, item.count > 0');
    expect(await labelAt(src, 'go()', 'swift')).toBe('!busy');
  });
});

describe('branch guards: the arms of one decision', () => {
  /** The guards at the site, unjoined. */
  async function guardsAt(src: string, needle: string, language: 'tsx' | 'typescript' | 'swift' = 'tsx') {
    const line = lineOf(src, needle);
    const column = src.split('\n')[line - 1]!.indexOf(needle);
    return guardsInSource(src, language, line, column);
  }

  const ifElse = `
export async function authUser(req, res) {
  const user = await User.findOne({ email })
  if (user && (await user.matchPassword(password))) {
    res.json({ token: generateToken(user._id) })
  } else {
    res.status(401)
    throw new Error('Invalid email or password')
  }
}`;

  it('gives an if and its else the same branch, with negated flipped', async () => {
    const yes = await guardsAt(ifElse, 'res.json');
    const no = await guardsAt(ifElse, 'res.status');
    expect(yes).toHaveLength(1);
    expect(no).toHaveLength(1);
    expect(yes[0]!.text).toBe(no[0]!.text);
    expect(yes[0]!.negated).toBe(false);
    expect(no[0]!.negated).toBe(true);
    // The identity of the FORK, not of the arm: both arms of one `if`.
    expect(yes[0]!.branch).toBe(no[0]!.branch);
    expect(yes[0]!.branch).toMatch(/^\d+:\d+$/);
    // The else arm ends by throwing; the then arm runs on.
    expect(no[0]!.armExit).toBe('throw');
    expect(yes[0]!.armExit).toBeUndefined();
  });

  const earlyExit = `
export async function createReview(req, res) {
  const product = await Product.findById(req.params.id)
  if (!product) {
    res.status(404)
    throw new Error('Product not found')
  }
  await product.save()
}`;

  it('gives an early exit and the code it guards the same branch', async () => {
    const inside = await guardsAt(earlyExit, 'res.status');
    const after = await guardsAt(earlyExit, 'product.save');
    expect(inside).toHaveLength(1);
    expect(after).toHaveLength(1);
    expect(inside[0]!.branch).toBe(after[0]!.branch);
    expect(inside[0]!.negated).toBe(false);
    expect(after[0]!.negated).toBe(true);
    // The arm NOT taken throws — what the rail draws as the fork's terminal.
    expect(after[0]!.form).toBe('guard');
    expect(after[0]!.exit).toBe('throw');
    expect(inside[0]!.armExit).toBe('throw');
  });

  const switched = `
export function route(kind) {
  switch (kind) {
    case 'a':
      first()
      break
    case 'b':
      second()
      break
    default:
      other()
  }
}`;

  it('gives every case of one switch the same branch', async () => {
    const a = await guardsAt(switched, 'first()');
    const b = await guardsAt(switched, 'second()');
    const d = await guardsAt(switched, 'other()');
    expect(a[0]!.branch).toBe(b[0]!.branch);
    expect(a[0]!.branch).toBe(d[0]!.branch);
    expect([a[0]!.text, b[0]!.text, d[0]!.text]).toEqual(['kind === \'a\'', 'kind === \'b\'', 'kind: default']);
  });

  it('gives two try/catch blocks branches of their own', async () => {
    const src = `
export async function save() {
  try { await a() } catch (e) { first(e) }
  try { await b() } catch (e) { second(e) }
}`;
    const one = await guardsAt(src, 'first(e)');
    const two = await guardsAt(src, 'second(e)');
    expect(one[0]!.text).toBe('on error');
    expect(two[0]!.text).toBe('on error');
    expect(one[0]!.branch).not.toBe(two[0]!.branch);
  });

  it('does not call an arm an exit because a later elif raises', async () => {
    const src = `
def handler(user):
    if not user:
        raise HTTPException(400)
    elif not user.is_active:
        raise HTTPException(400)
    go(user)
`;
    // The `elif` arm raises; the arm it is written in runs on to `go(user)`.
    const after = await guardsInSource(src, 'python', lineOf(src, 'go(user)'), 4);
    expect(after.map((g) => g.armExit ?? null)).toEqual(after.map(() => null));
  });

  it('reads a Swift guard as an exit', async () => {
    const src = `
func load() {
  guard let user = current else { return }
  fetch(user)
}`;
    const after = await guardsAt(src, 'fetch(user)', 'swift');
    expect(after[0]!.form).toBe('guard');
    expect(after[0]!.exit).toBe('return');
    expect(after[0]!.branch).toMatch(/^\d+:\d+$/);
  });
});

describe('branch guards: unsupported', () => {
  it('reports no guards for a language without rules', async () => {
    expect(supportsBranchGuards('ruby')).toBe(false);
    expect(await guardsInSource('def f\n  if x\n    go()\n  end\nend\n', 'ruby', 3, 4)).toEqual([]);
  });
});

describe('branch guards: on the wire', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('labels symbol-view rails and flow connectors with the call site\'s conditions', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-when-'));
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(
      path.join(dir, 'src', 'app.ts'),
      'export function helper() { return 1 }\n' +
        'export function other() { return 2 }\n' +
        'export function run(ready: boolean, busy: boolean) {\n' +
        '  if (busy) return\n' +
        '  if (ready) {\n' +
        '    helper()\n' +
        '  } else {\n' +
        '    other()\n' +
        '  }\n' +
        '}\n'
    );
    const cg = CodeGraph.initSync(dir);
    await cg.indexAll();
    const run = cg.getNodesByName('run')[0]!;
    const helper = cg.getNodesByName('helper')[0]!;

    type Rel = { node: { name: string }; edges: Array<{ when?: string }> };
    const view = (await buildNode(cg, dir, run.id)) as { outgoing: { items: Rel[] } };
    const byName = new Map(view.outgoing.items.map((r) => [r.node.name, r]));
    expect(byName.get('helper')?.edges[0]?.when).toBe('!busy && ready');
    expect(byName.get('other')?.edges[0]?.when).toBe('!busy && !ready');

    const callee = (await buildNode(cg, dir, helper.id)) as { incoming: { items: Rel[] } };
    expect(callee.incoming.items.find((r) => r.node.name === 'run')?.edges[0]?.when).toBe('!busy && ready');

    const flow = await buildFlow(cg, dir, new URLSearchParams('from=run&to=helper'));
    const hop = flow.flows[0]!.hops[1]!;
    expect(hop.edge?.when).toBe('!busy && ready');
    expect(hop.edge?.label).toBe('calls · when !busy && ready');

    cg.close();
  });
});


// =============================================================================
// Call arguments — what a site passes
// =============================================================================

async function argsAt(src: string, needle: string, language: 'tsx' | 'typescript' | 'swift' = 'tsx') {
  const line = lineOf(src, needle);
  const column = src.split('\n')[line - 1]!.indexOf(needle);
  return callArgumentsInSource(src, language, line, column);
}

describe('call arguments', () => {
  const login = `
async function handleLogin(values) {
  await SecureStore.setItemAsync('userEmail', values.email)
  const res = await client.post('/auth/login', { email: values.email, password, ...rest })
  Alert.alert(i18n.t('error_login_failed'), err.message, [{ text: 'OK' }])
  router.push({ pathname: '/item/[id]', params: { id } })
  captureView.finalizeCaptureSession()
  run(() => go(), async (x) => x, new Thing(1))
  const big = fetch(\`/api/\${id}\`, { method: 'POST', headers, body, mode, cache, credentials })
}
`;

  it('keeps literals and names whole, folds objects to their keys, arrays and functions to a shape', async () => {
    expect(await argsAt(login, 'SecureStore.setItemAsync(')).toBe("'userEmail', values.email");
    expect(await argsAt(login, 'client.post(')).toBe("'/auth/login', { email, password, ...rest }");
    expect(await argsAt(login, 'Alert.alert(')).toBe('i18n.t(…), err.message, […]');
    expect(await argsAt(login, 'router.push(')).toBe('{ pathname, params }');
    expect(await argsAt(login, 'run(')).toBe('() => …, () => …, new Thing(…)');
    expect(await argsAt(login, 'fetch(')).toBe('`/api/${id}`, { method, headers, body, mode, … }');
  });

  it('an empty argument list is an empty string; a position outside a call is null', async () => {
    expect(await argsAt(login, 'captureView.finalizeCaptureSession(')).toBe('');
    expect(await argsAt(login, 'async function handleLogin')).toBeNull();
  });

  it('Swift: labels stay with their values, a trailing closure is a shape', async () => {
    const src = `
class CaptureEvents {
  func emitZipComplete(result: ZipResult) {
    sendEvent(withName: "onZipComplete", body: ["zipURL": result.url])
    tracker.setup(side: side, angle: 45)
    DispatchQueue.main.async { finish() }
  }
}
`;
    expect(await argsAt(src, 'sendEvent(', 'swift')).toBe('withName: "onZipComplete", body: […]');
    expect(await argsAt(src, 'tracker.setup(', 'swift')).toBe('side: side, angle: 45');
    expect(await argsAt(src, 'DispatchQueue.main.async', 'swift')).toBe('{ … }');
  });
});


// =============================================================================
// Triggers — what fires a site
// =============================================================================

async function triggerAt(src: string, needle: string, language: 'tsx' | 'typescript' | 'swift' = 'tsx') {
  const line = lineOf(src, needle);
  const column = src.split('\n')[line - 1]!.indexOf(needle);
  return triggerInSource(src, language, line, column);
}

describe('triggers', () => {
  const login = `
function LoginButton({ values }) {
  const formik = useFormik({
    initialValues: values,
    onSubmit: (v) => {
      handleLogin(v.email, v.password)
    },
  })
  useEffect(() => {
    warmUp()
  }, [])
  useEffect(() => {
    const sub = nativeEmitter.addListener('onZipComplete', (data) => { finish(data) })
    return () => sub.remove()
  }, [])
  const handleRemove = useCallback(() => {
    removeCredential(values.email)
  }, [values])
  fetchThing().then(() => done())
  return (
    <View>
      <Button onPress={formik.submitForm} />
      <TouchableOpacity onPress={() => handleSelectAccount(account)} />
      <Pressable onPress={handleRemove} />
      <Row.Item onLongPress={() => { if (ok) confirm() }} />
      <KeyboardAvoidingView behavior={isAndroid() ? 'height' : 'padding'} />
      <FlatList renderItem={({ item }) => renderRow(item)} keyExtractor={keyOf} />
    </View>
  )
}
function warn() {
  Alert.alert('Remove?', 'Sure?', [{ text: 'OK', onPress: () => removeAll() }], { cancelable: true })
}
`;

  it('a call under a JSX prop: the prop and the element', async () => {
    expect(await triggerAt(login, 'handleSelectAccount(')).toEqual({ kind: 'prop', name: 'onPress', of: 'TouchableOpacity' });
    expect(await triggerAt(login, 'confirm()')).toEqual({ kind: 'prop', name: 'onLongPress', of: 'Row.Item' });
    // A handler passed as a value: the site IS the attribute.
    expect(await triggerAt(login, 'handleRemove} />')).toEqual({ kind: 'prop', name: 'onPress', of: 'Pressable' });
    // A function under any prop fires later; a value computed in a prop runs at render.
    expect(await triggerAt(login, 'renderRow(item)')).toEqual({ kind: 'prop', name: 'renderItem', of: 'FlatList' });
    expect(await triggerAt(login, 'isAndroid()')).toBeNull();
    expect(await triggerAt(login, 'keyOf}')).toBeNull();
  });

  it('a call under an on* option: the key and the call it configures', async () => {
    expect(await triggerAt(login, 'handleLogin(')).toEqual({ kind: 'option', name: 'onSubmit', of: 'useFormik' });
    // The option's object inside an array argument: still the call it configures.
    expect(await triggerAt(login, 'removeAll()')).toEqual({ kind: 'option', name: 'onPress', of: 'Alert.alert' });
  });

  it('a call inside a runs-later callback: the callee and its first literal', async () => {
    expect(await triggerAt(login, 'warmUp()')).toEqual({ kind: 'callback', name: 'useEffect', of: null });
    expect(await triggerAt(login, 'finish(data)')).toEqual({ kind: 'callback', name: 'addListener', of: "'onZipComplete'" });
    expect(await triggerAt(login, 'done()')).toEqual({ kind: 'callback', name: 'then', of: null });
  });

  it('a named handler is its own story: nothing fires the call inside it, from here', async () => {
    expect(await triggerAt(login, 'removeCredential(')).toBeNull();
    // A plain call in a component body is fired by nothing in particular.
    expect(await triggerAt(login, 'fetchThing()')).toBeNull();
    expect(await triggerAt(login, 'handleLogin(', 'swift')).toBeNull();
  });
});
