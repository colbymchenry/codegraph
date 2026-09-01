/**
 * The Steps view's model, without a browser: rows by the server's depth, the
 * words in a box by kind, one edge per pair with the Screens view's label
 * rule, and the panel's two lists.
 */
import { describe, it, expect } from 'vitest';
import { armWords, buildStepsModel, countWords, kindWord, kindWords, stepEdgeVisible, stepLabel, stepNeighbourhood, stepSub, stepViaText, triggerWords } from '../ui/src/lib/steps-model';
import { placeLabels } from '../ui/src/lib/screens-model';
import type { WireNodeRef, WireStep, WireStepLink, WireStepSite, WireStepsPayload } from '../ui/src/lib/wire';

function ref(name: string, file = 'src/a.tsx', language: WireNodeRef['language'] = 'tsx'): WireNodeRef {
  return { id: `function:${name}`, kind: 'function', name, qualifiedName: name, file, line: 1, endLine: 9, language, test: false };
}

function step(label: string, kind: WireStep['kind'], depth: number, extra: Partial<WireStep> = {}): WireStep {
  const node = kind === 'effect' ? null : ref(label, extra.node?.file ?? 'src/a.tsx');
  return { id: node?.id ?? `effect:fn:${label}`, kind, anchor: depth === 0, node, label, sub: 'src/a.tsx', depth, cut: null, ...extra };
}

function link(from: WireStep, to: WireStep, extra: Partial<WireStepLink> = {}): WireStepLink {
  return { id: `${from.id} ${to.id}`, from: from.id, to: to.id, kind: 'calls', via: [], when: '', label: '', synthesized: false, uncertain: false, sites: [], ...extra };
}

function payload(steps: WireStep[], links: WireStepLink[]): WireStepsPayload {
  return {
    anchor: steps[0]!.node!,
    ambiguous: [],
    project: 'app',
    steps,
    links,
    depth: 8,
    limit: 120,
    through: false,
    truncated: { steps: 0, hubs: 0, chrome: 0 },
    index: { lastIndexedAt: null, edges: 0, files: 0 },
    timing: { elapsedMs: 1 },
  };
}

describe('steps model', () => {
  const screen = step('/capture/review', 'screen', 0, { screen: { path: '/capture/review', component: ref('ReviewScreen') } });
  const handler = step('handleApprove', 'trigger', 1);
  const bridge = step('finalizeCaptureSession', 'bridge', 2, { node: ref('finalizeCaptureSession', 'ios/CaptureView.swift', 'swift') });
  const event = step('handleZipComplete', 'event', 3, { event: 'onZipComplete' });
  const effect = step('client.post', 'effect', 4, { sub: 'network · uploadARCapture', effect: { api: 'client.post', apis: ['client.post'], category: 'network', by: ref('uploadARCapture'), line: 3 } });
  const store = step('setZipUri', 'store', 4, { node: ref('setZipUri', 'src/storage/capture.storage.ts') });
  const home = step('/', 'screen', 4, { screen: { path: '/', component: null } });
  const links = [
    link(screen, handler, { kind: 'handler', trigger: { kind: 'prop', name: 'onPress', of: 'Button', in: 'ReviewScreen' } }),
    link(handler, bridge, { kind: 'bridge', when: '!busy' }),
    link(bridge, event, { kind: 'event', synthesized: true, via: [ref('emitZipComplete', 'ios/CaptureEvents.swift', 'swift')], when: 'result', label: 'via rn-event-channel · event onZipComplete' }),
    link(event, effect, { kind: 'effect', via: [ref('uploadARCapture')] }),
    link(event, store, { kind: 'store' }),
    link(event, home, { kind: 'navigates', when: 'unlimited' }),
    // A second way from the event to the store, unconditional: the pair is one edge saying "2 ways".
    { ...link(event, store, { kind: 'store', when: 'retry' }), id: 'second' },
  ];
  const model = buildStepsModel(payload([screen, handler, bridge, event, effect, store, home], links));

  it('puts the anchor on top and each row one step further away', () => {
    const y = (id: string) => model.layout.nodes.find((n) => n.id === id)!.y;
    expect(y(screen.id)).toBeLessThan(y(handler.id));
    expect(y(handler.id)).toBeLessThan(y(bridge.id));
    expect(y(bridge.id)).toBeLessThan(y(event.id));
    expect(y(event.id)).toBeLessThan(y(effect.id));
    expect(y(effect.id)).toBe(y(store.id));
    expect(y(effect.id)).toBe(y(home.id));
  });

  it('one edge per pair, labelled with the innermost condition or a count', () => {
    const edges = [...model.edges.values()];
    expect(edges).toHaveLength(6);
    // A link into a handler says the event, not the conditions.
    const toHandler = edges.find((e) => e.to === handler.id)!;
    expect(toHandler.label).toBe('onPress · <Button>');
    const toBridge = edges.find((e) => e.to === bridge.id)!;
    expect(toBridge.label).toBe('NOT busy');
    expect(toBridge.kind).toBe('bridge');
    const toEvent = edges.find((e) => e.to === event.id)!;
    expect(toEvent.synthesized).toBe(true);
    expect(toEvent.label).toBe('result');
    const toStore = edges.find((e) => e.to === store.id)!;
    expect(toStore.links).toHaveLength(2);
    expect(toStore.label).toBe('2 ways · 1 conditional');
    expect(toStore.kind).toBe('store');
  });

  it('counts steps per kind', () => {
    expect(model.counts).toEqual({ anchor: 0, screen: 2, trigger: 1, bridge: 1, event: 1, store: 1, effect: 1 });
  });

  it('words a box by its kind', () => {
    expect(stepLabel(bridge)).toBe('⇢ finalizeCaptureSession');
    expect(stepLabel(event)).toBe('⇠ onZipComplete');
    expect(stepLabel({ ...event, events: ['onZipComplete', 'onZipError', 'onCameraReady'] })).toBe('⇠ onZipComplete +2');
    expect(stepLabel(screen)).toBe('/capture/review');
    expect(stepSub(event)).toBe('handleZipComplete · a.tsx');
    expect(stepSub(bridge)).toBe('native · CaptureView.swift');
    expect(stepSub(store)).toBe('store · capture.storage.ts');
    expect(stepSub(effect)).toBe('network · uploadARCapture');
    expect(kindWord('effect')).toBe('outside the index');
    expect(triggerWords({ kind: 'option', name: 'onSubmit', of: 'useFormik', in: 'LoginButton' })).toBe('onSubmit · useFormik(…)');
    expect(triggerWords({ kind: 'callback', name: 'addListener', of: "'onZipComplete'", in: 'X' })).toBe("addListener('onZipComplete')");
    expect(triggerWords({ kind: 'callback', name: 'useEffect', of: null, in: 'X' })).toBe('useEffect');
    expect(stepSub({ ...handler, trigger: { kind: 'prop', name: 'onPress', of: 'Button', in: 'ReviewScreen' } })).toBe('onPress · <Button> · a.tsx');
    expect(stepViaText(links[2]!)).toBe('emitZipComplete');
  });

  it('labels a selected step at the far end of each line, and lists its links', () => {
    const pills = placeLabels(model, event.id);
    expect(pills.hidden).toBe(0);
    const words = [...pills.pills.values()].map((p) => p.text).sort();
    expect(words).toEqual(['← result', '→ 2 ways · 1 conditional', '→ unlimited']);
    const lists = stepNeighbourhood(payload([screen, handler, bridge, event, effect, store, home], links), event.id);
    expect(lists.arrivesFrom.map((l) => l.from)).toEqual([bridge.id]);
    expect(lists.leadsTo.map((l) => l.to)).toEqual([effect.id, store.id, home.id, store.id]);
  });
});

describe('a decision drawn where it is made', () => {
  // The real shape this exists for: `return (await hasSeenWelcome(id)) ?
  // '/home/' : '/welcome/'` inside a store action, whose two returned routes
  // are two `navigates` edges out of ONE box. Each carried the whole
  // predicate — one of them the other's negation — and at rest the tree drew
  // both with no label at all, so nothing said it was a choice.
  const ON = 'await hasSeenWelcome(welcomeUserId())';
  const BRANCH = '140:9';
  const site = (when: string, not?: true): WireStepSite => ({
    file: 'src/org-user.storage.ts',
    line: 140,
    text: `push ${when}`,
    when,
    decision: { branch: BRANCH, on: ON, arm: when, form: 'ternary', ...(not ? { not: true as const } : {}) },
  });

  const anchor = step('/terms-of-service', 'screen', 0, { anchor: true });
  const resolve = step('resolvePostLoginRoute', 'store', 1, { node: ref('resolvePostLoginRoute', 'src/org-user.storage.ts') });
  const home = step('/home', 'screen', 2, { screen: { path: '/home', component: null } });
  const welcome = step('/welcome', 'screen', 2, { screen: { path: '/welcome', component: null } });
  const links = [
    link(anchor, resolve, { kind: 'store' }),
    link(resolve, home, { kind: 'navigates', when: ON, sites: [site(ON)] }),
    link(resolve, welcome, { kind: 'navigates', when: `!(${ON})`, sites: [site(`!(${ON})`, true)] }),
  ];
  const model = buildStepsModel(payload([anchor, resolve, home, welcome], links));
  const edgeTo = (id: string) => [...model.edges.values()].find((e) => e.to === id)!;

  it('says the condition once, under the box that decides it', () => {
    expect(model.decisions).toHaveLength(1);
    const d = model.decisions[0]!;
    expect(d.label).toBe('await hasSeenWelcome(welcomeUserId())?');
    // Under the deciding box and centred on it — not under the arms. The
    // condition may take more room than the box, since reading it is the
    // whole point of the caption.
    const box = model.layout.nodes.find((n) => n.id === resolve.id)!;
    expect(d.x + d.width / 2).toBeCloseTo(box.x + box.width / 2, 5);
    expect(d.width).toBeGreaterThanOrEqual(box.width);
    expect(d.y).toBeGreaterThan(box.y + box.height - 1);
  });

  it('each line out answers, instead of carrying the whole predicate', () => {
    expect(edgeTo(home.id).arm).toBe('yes');
    expect(edgeTo(home.id).label).toBe('yes');
    expect(edgeTo(welcome.id).arm).toBe('no');
    expect(edgeTo(welcome.id).label).toBe('no');
    // The line into the deciding box is not an arm of anything.
    expect(edgeTo(resolve.id).arm).toBeUndefined();
  });

  it('labels the arms at rest — and only the arms', () => {
    const arms = new Set([...model.edges.values()].filter((e) => e.arm !== undefined).map((e) => e.id));
    const pills = placeLabels(model, null, arms);
    expect([...pills.pills.values()].map((p) => p.text).sort()).toEqual(['→ no', '→ yes']);
    // With nothing asked for, the tree stays unlabelled as it always was.
    expect(placeLabels(model, null, false).pills.size).toBe(0);
  });

  it('keeps a lone arm, and a step reached either way, on a plain line', () => {
    // One drawn arm is a guard clause, not a choice.
    const only = buildStepsModel(
      payload([anchor, resolve, home], [link(anchor, resolve, { kind: 'store' }), link(resolve, home, { kind: 'navigates', when: ON, sites: [site(ON)] })])
    );
    expect(only.decisions).toEqual([]);
    expect([...only.edges.values()].every((e) => e.arm === undefined)).toBe(true);

    // A connector with a site that runs under NO condition is not exclusively
    // an arm — the step happens either way — so it never claims a side.
    const both = buildStepsModel(
      payload(
        [anchor, resolve, home, welcome],
        [
          link(anchor, resolve, { kind: 'store' }),
          link(resolve, home, { kind: 'navigates', when: ON, sites: [site(ON), { file: 'x.ts', line: 9, text: 'push', when: '' }] }),
          link(resolve, welcome, { kind: 'navigates', when: `!(${ON})`, sites: [site(`!(${ON})`, true)] }),
        ]
      )
    );
    expect(both.decisions).toEqual([]);
  });

  it('words a switch arm by its own value, and the default by else', () => {
    expect(armWords({ on: 'status', arm: "status === 'expired'", form: 'switch' })).toBe("'expired'");
    expect(armWords({ on: 'status', arm: 'anything', form: 'switch', not: true })).toBe('else');
    expect(armWords({ on: 'ready', arm: 'ready', form: 'if' })).toBe('yes');
    expect(armWords({ on: 'ready', arm: '!ready', form: 'if', not: true })).toBe('no');
  });
});

describe('words per project', () => {
  it('names the same box for an app, an API and a web app', () => {
    expect(kindWord('screen', 'app')).toBe('screen');
    expect(kindWord('screen', 'api')).toBe('endpoint');
    expect(kindWord('screen', 'web')).toBe('page');
    // A route that leads with a verb is an endpoint wherever it is.
    const endpoint = { id: 'r', kind: 'screen', anchor: false, node: null, label: 'POST /users', sub: 'createUser', depth: 1, cut: null, screen: { path: 'POST /users', component: null, endpoint: true, inline: false } } as const;
    expect(kindWord('screen', 'web', endpoint)).toBe('endpoint');
    expect(kindWords('store', 'api')).toEqual(['data call', 'data calls']);
    expect(kindWords('bridge', 'app')).toEqual(['native call', 'native calls']);
    expect(countWords(11, 'effect', 'api')).toBe('11 outside the index');
    expect(countWords(1, 'trigger')).toBe('1 handler');
    expect(countWords(3, 'trigger')).toBe('3 handlers');
  });
  it('says what fires a server-side step', () => {
    expect(triggerWords({ kind: 'request', name: 'POST', of: '/users', in: 'users.routes.ts', after: ['authenticate', 'validate(…)'] })).toBe('POST /users · after authenticate, validate(…)');
    expect(triggerWords({ kind: 'decorator', name: 'Process', of: "'email'", in: 'x.ts' })).toBe("@Process('email')");
    expect(triggerWords({ kind: 'load', name: 'GET', of: '/blog/[slug]', in: 'page.tsx' })).toBe('page load · /blog/[slug]');
  });
});

describe('row order', () => {
  it('lays a row out in the order the server gave, not by id', () => {
    const anchor = step('/login', 'screen', 0, { anchor: true });
    const a = step('User.findOne', 'effect', 1, { order: 0 });
    const b = step('jwt.sign', 'effect', 1, { order: 1 });
    const c = step('200', 'effect', 1, { order: 2 });
    const d = step('401', 'effect', 1, { order: 3 });
    const model = buildStepsModel(payload([anchor, d, c, b, a], [link(anchor, a), link(anchor, b), link(anchor, c), link(anchor, d)]));
    const row = model.layout.nodes.filter((n) => n.id !== anchor.id).sort((x, y) => x.x - y.x).map((n) => n.id);
    expect(row).toEqual([a.id, b.id, c.id, d.id]);
  });
});

describe('a screen laid out by region', () => {
  const A = { id: 'component:PanelA', label: 'PanelA' };
  const B = { id: 'component:PanelB', label: 'PanelB' };
  const anchor = step('/', 'screen', 0, { anchor: true });
  const a1 = step('tapSave', 'trigger', 1, { order: 0, region: A });
  const a2 = step('tapUndo', 'trigger', 1, { order: 1, region: A });
  const a3 = step('saveThing', 'store', 2, { order: 0, region: A, node: ref('saveThing', 'src/things.storage.ts') });
  const b1 = step('tapShare', 'trigger', 1, { order: 2, region: B, node: ref('tapShare', 'src/b.tsx') });
  const links = [
    link(anchor, a1),
    link(anchor, a2),
    link(anchor, b1),
    link(a1, a3, { kind: 'store' }),
    link(a1, b1),
    // Another region's way into a shared store — a lead-to line like any other.
    link(b1, a3, { kind: 'store' }),
  ];
  const model = buildStepsModel(payload([anchor, a1, a2, b1, a3], links));
  const at = (id: string) => model.layout.nodes.find((n) => n.id === id)!;
  const between = (id: string, zone: { x: number; width: number }) => {
    const n = at(id);
    return n.x >= zone.x && n.x + n.width <= zone.x + zone.width;
  };
  const edge = (from: string, to: string) => model.layout.edges.find((e) => e.source === from && e.target === to)!;

  it('names the regions in the order the walk met them, each holding its own boxes', () => {
    expect(model.regions!.map((z) => z.label)).toEqual(['PanelA', 'PanelB']);
    const [zoneA, zoneB] = model.regions!;
    expect(between(a1.id, zoneA!)).toBe(true);
    expect(between(a2.id, zoneA!)).toBe(true);
    expect(between(a3.id, zoneA!)).toBe(true);
    expect(between(b1.id, zoneB!)).toBe(true);
    // Side by side, not overlapping: the second region starts past the first.
    expect(zoneB!.x).toBeGreaterThanOrEqual(zoneA!.x + zoneA!.width);
  });

  it('keeps a step above what it sets in motion, inside its region', () => {
    expect(at(anchor.id).y).toBeLessThan(at(a1.id).y);
    expect(at(a3.id).y).toBeGreaterThan(at(a1.id).y);
    // A step that fires something is drawn as a cluster of its own — itself,
    // then what it fires under it, stepped in. A step that fires nothing does
    // not need one, so the two are no longer on the same line.
    expect(at(a3.id).x).toBeGreaterThan(at(a1.id).x);
  });

  it('spreads the steps that fire nothing along one line, and clusters the ones that do', () => {
    // A screen's handlers are siblings, not a hierarchy: giving each its own
    // line turned a flat region into a column. Only a step that sets something
    // in motion earns a cluster.
    const D = { id: 'component:PanelD', label: 'PanelD' };
    const root = step('/', 'screen', 0, { anchor: true });
    const flat = [0, 1, 2].map((i) => step(`tap${i}`, 'trigger', 1, { order: i, region: D }));
    const hub = step('tapRun', 'trigger', 1, { order: 3, region: D });
    const under = step('runThing', 'store', 2, { order: 4, region: D, node: ref('runThing', 'src/d.storage.ts') });
    const m = buildStepsModel(
      payload(
        [root, ...flat, hub, under],
        [...[...flat, hub].map((s) => link(root, s)), link(hub, under, { kind: 'store' })]
      )
    );
    const y = (id: string) => m.layout.nodes.find((n) => n.id === id)!.y;
    expect(new Set(flat.map((s) => y(s.id))).size).toBe(1);
    expect(y(hub.id)).toBeGreaterThan(y(flat[0]!.id));
    expect(y(under.id)).toBeGreaterThan(y(hub.id));
  });

  it('settles a region that holds a cycle instead of running to the bound', () => {
    // Relaxation over a cyclic graph never stops moving: one real screen sent
    // sixty-five of its boxes to rows 294-301 while the rest sat at 0-2.
    const E = { id: 'component:PanelE', label: 'PanelE' };
    const root = step('/', 'screen', 0, { anchor: true });
    const p1 = step('one', 'trigger', 1, { order: 0, region: E });
    const p2 = step('two', 'trigger', 2, { order: 1, region: E });
    const p3 = step('three', 'trigger', 3, { order: 2, region: E });
    const m = buildStepsModel(
      payload([root, p1, p2, p3], [link(root, p1), link(p1, p2), link(p2, p3), link(p3, p1)])
    );
    const ys = [p1, p2, p3].map((s) => m.layout.nodes.find((n) => n.id === s.id)!.y);
    const pitch = 40 + m.layerGap;
    // Three boxes, so at most three lines of them — not one line per pass.
    expect((Math.max(...ys) - Math.min(...ys)) / pitch).toBeLessThanOrEqual(2);
  });

  it('at rest hides only the screen’s own fan and what points back up; every other lead-to draws', () => {
    // The screen's one line into a region lands on the box nearest the region's
    // top-left that the screen leads to — `tapUndo`, which fires nothing and so
    // sits on the region's first line, not `tapSave`, which clustering moves
    // below it because it fires the store.
    expect(model.regionEntries).toEqual(new Set([a2.id, b1.id]));
    // One line from the screen into each region stands in for its whole fan.
    expect(stepEdgeVisible(model, edge(anchor.id, a2.id), null)).toBe(true);
    expect(stepEdgeVisible(model, edge(anchor.id, a1.id), null)).toBe(false);
    expect(stepEdgeVisible(model, edge(anchor.id, b1.id), null)).toBe(true);
    // A region's internal line, and another region's way into a shared step.
    expect(stepEdgeVisible(model, edge(a1.id, a3.id), null)).toBe(true);
    expect(stepEdgeVisible(model, edge(b1.id, a3.id), null)).toBe(true);
    // Two boxes on one row point sideways — back-ish, a click away as everywhere.
    expect(stepEdgeVisible(model, edge(a1.id, b1.id), null)).toBe(false);
    // Selecting a step brings out everything that touches it, and only that.
    expect(stepEdgeVisible(model, edge(a1.id, b1.id), a1.id)).toBe(true);
    expect(stepEdgeVisible(model, edge(anchor.id, b1.id), a1.id)).toBe(false);
  });

  it('stacks a handler above the store it calls, even when both are one hop from the screen', () => {
    // Anchor distance is flat inside a region: both of these are depth 1, and
    // side by side their link was a level arch, hidden at rest — the store
    // floated. The region's own links order its rows instead.
    const C = { id: 'component:PanelC', label: 'PanelC' };
    const root = step('/', 'screen', 0, { anchor: true });
    const h = step('tapCopy', 'trigger', 1, { order: 0, region: C });
    const s = step('copyThing', 'store', 1, { order: 1, region: C, node: ref('copyThing', 'src/c.storage.ts') });
    const m = buildStepsModel(payload([root, h, s], [link(root, h), link(root, s), link(h, s, { kind: 'store' })]));
    const y = (id: string) => m.layout.nodes.find((n) => n.id === id)!.y;
    expect(y(s.id)).toBeGreaterThan(y(h.id));
    const e = m.layout.edges.find((x) => x.source === h.id && x.target === s.id)!;
    expect(e.route).toBe('down');
    expect(stepEdgeVisible(m, e, null)).toBe(true);
  });

  it('a payload without regions keeps the rows, and the Map’s at-rest rule', () => {
    const plain = buildStepsModel(payload([step('/x', 'screen', 0, { anchor: true }), step('go', 'trigger', 1)], [link(step('/x', 'screen', 0, { anchor: true }), step('go', 'trigger', 1))]));
    expect(plain.regions).toBeNull();
    expect(plain.regionEntries).toBeNull();
  });
});

describe('a link too far to draw is said in words', () => {
  // Two chains in one region, and a link from the tail of the first to the
  // tail of the second. The clusters are drawn one under the other, so that
  // one link has to cross the whole region — the kind of line that, times a
  // hundred, crossed itself six hundred and fifty-two times on a real screen.
  const G = { id: 'component:PanelG', label: 'PanelG' };
  const anchor = step('/', 'screen', 0, { anchor: true });
  const chain = (p: string) =>
    [0, 1, 2, 3].map((i) => step(`${p}${i}`, 'trigger', i + 1, { order: i, region: G, node: ref(`${p}${i}`, 'src/g.tsx') }));
  const a = chain('a');
  const b = chain('b');
  const links = [
    link(anchor, a[0]!),
    link(anchor, b[0]!),
    ...a.slice(1).map((s, i) => link(a[i]!, s)),
    ...b.slice(1).map((s, i) => link(b[i]!, s)),
    // The long one, from the bottom of the first cluster to the bottom of the second.
    link(a[3]!, b[3]!),
  ];
  const model = buildStepsModel(payload([anchor, ...a, ...b], links));
  const far = model.layout.edges.find((e) => e.source === a[3]!.id && e.target === b[3]!.id)!;
  const near = model.layout.edges.find((e) => e.source === a[0]!.id && e.target === a[1]!.id)!;

  it('draws the hop a reader can follow and words the one they cannot', () => {
    expect(stepEdgeVisible(model, near, null)).toBe(true);
    expect(stepEdgeVisible(model, far, null)).toBe(false);
    expect(model.stubbed.has(far.id)).toBe(true);
    expect(model.stubbed.has(near.id)).toBe(false);
  });

  it('says it at BOTH ends, so neither box reads as wired to nothing', () => {
    expect(model.stubs.get(a[3]!.id) ?? []).toContainEqual(
      expect.objectContaining({ edge: far.id, dir: 'out', label: 'b3' })
    );
    expect(model.stubs.get(b[3]!.id) ?? []).toContainEqual(
      expect.objectContaining({ edge: far.id, dir: 'in', label: 'a3' })
    );
  });

  it('draws every one of a box\u2019s real lines again when it is selected', () => {
    expect(stepEdgeVisible(model, far, a[3]!.id)).toBe(true);
    expect(stepEdgeVisible(model, far, b[3]!.id)).toBe(true);
    // ...and still not for an unrelated selection.
    expect(stepEdgeVisible(model, far, a[1]!.id)).toBe(false);
  });

  it('never words the screen\u2019s own fan \u2014 that is already one line per region', () => {
    for (const list of model.stubs.values()) {
      for (const stub of list) expect(stub.other).not.toBe(anchor.id);
    }
  });

  it('leaves a picture whose every line is local alone', () => {
    const plain = buildStepsModel(
      payload([step('/x', 'screen', 0, { anchor: true }), step('go', 'trigger', 1)], [
        link(step('/x', 'screen', 0, { anchor: true }), step('go', 'trigger', 1)),
      ])
    );
    expect(plain.stubbed.size).toBe(0);
    expect(plain.stubs.size).toBe(0);
  });
});

describe('a stub names the box without its kind mark', () => {
  it('drops the ⇢ / ⇠ a bridge or an event wears, so the direction reads alone', () => {
    const H = { id: 'component:PanelH', label: 'PanelH' };
    const anchor = step('/', 'screen', 0, { anchor: true });
    const mk = (p: string) => [
      step(`${p}0`, 'trigger', 1, { order: 0, region: H, node: ref(`${p}0`, 'src/h.tsx') }),
      step(`${p}1`, 'trigger', 2, { order: 1, region: H, node: ref(`${p}1`, 'src/h.tsx') }),
      step(`${p}2`, 'trigger', 3, { order: 2, region: H, node: ref(`${p}2`, 'src/h.tsx') }),
      step(`${p}3`, 'bridge', 4, { order: 3, region: H, node: ref(`${p}3`, 'ios/H.swift', 'swift') }),
    ];
    const a = mk('a');
    const b = mk('b');
    const links = [
      link(anchor, a[0]!),
      link(anchor, b[0]!),
      ...a.slice(1).map((s, i) => link(a[i]!, s)),
      ...b.slice(1).map((s, i) => link(b[i]!, s)),
      link(a[3]!, b[3]!),
    ];
    const m = buildStepsModel(payload([anchor, ...a, ...b], links));
    expect(stepLabel(b[3]!)).toBe('⇢ b3');
    expect(m.stubs.get(a[3]!.id) ?? []).toContainEqual(
      expect.objectContaining({ dir: 'out', label: 'b3' })
    );
  });
});

describe('regions fill the canvas instead of squaring off into rows', () => {
  it('lets a short region tuck under another short one, without reordering them', () => {
    // Squaring the regions into rows made every row as tall as its tallest
    // member: one real screen's canvas came out 44% region and 56% nothing.
    const anchor = step('/', 'screen', 0, { anchor: true });
    const region = (n: string) => ({ id: `component:${n}`, label: n });
    const short = (n: string, order: number) =>
      step(n, 'trigger', 1, { order, region: region('R' + n), node: ref(n, `src/${n}.tsx`) });
    // One tall region (a chain), then several short ones beside it.
    const tallR = region('Tall');
    const chain = [0, 1, 2, 3, 4, 5].map((i) =>
      step(`t${i}`, 'trigger', i + 1, { order: i, region: tallR, node: ref(`t${i}`, 'src/t.tsx') })
    );
    const a = short('alpha', 10), b = short('beta', 11), c = short('gamma', 12);
    const steps = [anchor, ...chain, a, b, c];
    const links = [
      ...[chain[0]!, a, b, c].map((s) => link(anchor, s)),
      ...chain.slice(1).map((s, i) => link(chain[i]!, s)),
    ];
    const m = buildStepsModel(payload(steps, links));
    const zone = (n: string) => m.regions!.find((z) => z.label === n)!;
    const tall = zone('Tall');
    // The short regions are laid out after the tall one and do not wait for it.
    for (const n of ['Ralpha', 'Rbeta', 'Rgamma']) {
      expect(zone(n).y).toBeLessThan(tall.y + tall.height);
    }
    // …and the order still reads left to right: an earlier region is never
    // pushed below a later one.
    expect(zone('Ralpha').y).toBeLessThanOrEqual(zone('Rgamma').y);
    // The canvas is not taller than the tall region needs it to be.
    const H = Math.max(...m.layout.nodes.map((n) => n.y + n.height));
    expect(H).toBeLessThan(tall.y + tall.height + 200);
  });
});

describe('the width a picture wraps at is tried, not estimated', () => {
  it('lets a wide spread run wide instead of wrapping into a column', () => {
    // A cluster spends lines on its own structure, so `total width / line
    // width` badly under-counts the lines a region takes: a formula tuned on
    // that estimate wrapped a 98-box region into a 4,356px column. The widths
    // are cheap to try exactly, so they are tried.
    const R = { id: 'component:Wide', label: 'Wide' };
    const anchor = step('/', 'screen', 0, { anchor: true });
    const hub = step('startEverything', 'trigger', 1, { order: 0, region: R, node: ref('startEverything', 'src/w.tsx') });
    const leaves = Array.from({ length: 24 }, (_, i) =>
      step(`writeSomeValue${i}`, 'store', 2, { order: i + 1, region: R, node: ref(`writeSomeValue${i}`, 'src/w.storage.ts') })
    );
    const m = buildStepsModel(
      payload([anchor, hub, ...leaves], [link(anchor, hub), ...leaves.map((l) => link(hub, l, { kind: 'store' }))])
    );
    const W = Math.max(...m.layout.nodes.map((n) => n.x + n.width));
    const H = Math.max(...m.layout.nodes.map((n) => n.y + n.height));
    // At a fixed 720px these twenty-four boxes wrapped into eight lines and the
    // picture came out taller than wide; it should now be at least as wide.
    expect(W).toBeGreaterThan(H);
  });
});
