/**
 * The Screens view's model, without a browser.
 *
 * What is under test is what makes the picture readable when a hub is
 * selected — the case the view exists for, and the case that first shipped as
 * a pile of pills under a knot of lines:
 *
 * - a label says the clause that decides the transition, not the first thirty
 *   characters of a chain two siblings share;
 * - a screen's row is its distance from the entry, and shared chrome hangs
 *   where what it opens is, never dragging a screen up beside the home screen;
 * - a return trip leaves the top of its box and arrives at the bottom of the
 *   other, so it is drawn around the boxes rather than through them;
 * - every pill sits at the far end of its line, in a lane, and no two overlap;
 *   one that fits nowhere is counted rather than drawn on top of something.
 *
 * The endpoint that feeds it is exercised against a real index in
 * `expo-router.test.ts`.
 */

import { describe, it, expect } from 'vitest';
import {
  buildScreensModel,
  clauses,
  edgeLabel,
  hoverPill,
  laneCount,
  nearestEdge,
  pairId,
  pillText,
  pillWidth,
  placeLabels,
  pointAt,
  screenCurve,
  screenEdgePath,
  tAtY,
  EDGE_LABEL_MAX,
  PILL_HEIGHT,
  SCREEN_LAYER_GAP,
  type Curve,
  type PillPlacement,
  type Point,
  type ScreensModel,
} from '../ui/src/lib/screens-model';
import { linkId, portPoint, NODE_HEIGHT, PORT_PITCH, type MapNodeLayout } from '../ui/src/lib/map-model';
import type {
  WireNodeRef,
  WireScreen,
  WireScreenLink,
  WireScreenOrigin,
  WireScreensPayload,
} from '../ui/src/lib/wire';

/* ------------------------------------------------------------- fixtures -- */

function ref(name: string): WireNodeRef {
  return {
    id: `function:${name}`,
    kind: 'function',
    name,
    qualifiedName: name,
    file: `src/${name}.tsx`,
    line: 1,
    endLine: 20,
    language: 'tsx',
    test: false,
  };
}

const R = (path: string): string => `route:${path}`;

function screen(path: string): WireScreen {
  return {
    id: R(path),
    path,
    file: `src/app${path === '/' ? '/index' : path}.tsx`,
    line: 1,
    component: ref(path === '/' ? 'Index' : path.replace(/[^a-z0-9]/gi, '')),
    incoming: 0,
    outgoing: 0,
  };
}

function origin(name: string, sharedBy?: number): WireScreenOrigin {
  return { id: `function:${name}`, node: ref(name), outgoing: 1, ...(sharedBy ? { sharedBy } : {}) };
}

let seq = 0;
/** `from`/`to` are screen paths, or a `function:` id for an origin. */
function link(from: string, to: string, when = '', over: Partial<WireScreenLink> = {}): WireScreenLink {
  const id = (s: string): string => (s.startsWith('function:') ? s : R(s));
  return {
    id: `l${seq++}`,
    from: id(from),
    to: id(to),
    fromOrigin: from.startsWith('function:'),
    via: [],
    when,
    sites: [],
    synthesized: false,
    ...over,
  };
}

function payload(
  screens: WireScreen[],
  links: WireScreenLink[],
  origins: WireScreenOrigin[] = [],
  entry: string | null = R('/')
): WireScreensPayload {
  return {
    routed: true,
    entry,
    screens,
    origins,
    links,
    dropped: 0,
    index: { lastIndexedAt: null, edges: 0, files: 0 },
    timing: { elapsedMs: 0 },
  };
}

function nodeOf(model: ScreensModel, id: string): MapNodeLayout {
  const node = model.layout.nodes.find((n) => n.id === id);
  expect(node, `no node ${id}`).toBeTruthy();
  return node!;
}

function layerOf(model: ScreensModel, id: string): number {
  return nodeOf(model, id).layer;
}

function edgeOf(model: ScreensModel, from: string, to: string) {
  const id = linkId({ source: from, target: to });
  const edge = model.layout.edges.find((e) => e.id === id);
  expect(edge, `no edge ${from} -> ${to}`).toBeTruthy();
  return edge!;
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}
const rectOf = (p: PillPlacement): Rect => ({ x: p.x - p.width / 2, y: p.y - PILL_HEIGHT / 2, w: p.width, h: PILL_HEIGHT });
const boxOf = (n: MapNodeLayout): Rect => ({ x: n.x, y: n.y, w: n.width, h: n.height });
const overlaps = (a: Rect, b: Rect): boolean => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** A home screen that opens twelve screens, six of which come back. */
function hub(): WireScreensPayload {
  const targets = Array.from({ length: 12 }, (_, i) => `/t${i}`);
  return payload(
    [screen('/'), screen('/home'), ...targets.map(screen)],
    [
      link('/', '/home'),
      ...targets.map((t, i) => link('/home', t, `ready && step === ${i}`)),
      ...targets.slice(0, 6).map((t, i) => link(t, '/home', `done${i}`)),
    ]
  );
}

/* ---------------------------------------------------------------- specs -- */

describe('clauses', () => {
  it('splits on the top-level && only', () => {
    expect(clauses('a && (b && c) && d')).toEqual(['a', '(b && c)', 'd']);
    expect(clauses('!(a || b) && items[i && j]')).toEqual(['!(a || b)', 'items[i && j]']);
  });

  it('leaves a string alone', () => {
    expect(clauses("x === 'a && b' && y")).toEqual(["x === 'a && b'", 'y']);
    expect(clauses('t === `${a && b}` && z')).toEqual(['t === `${a && b}`', 'z']);
  });

  it('returns a disjunction whole — it has no innermost term', () => {
    expect(clauses('a && b || c')).toEqual(['a && b || c']);
  });

  it('handles the edges', () => {
    expect(clauses('')).toEqual([]);
    expect(clauses('visible')).toEqual(['visible']);
  });
});

describe('edgeLabel', () => {
  const chain = 'uncollected && !(selectedDetectionItems.length > 0) && canProceed && ';

  it('says the innermost clause, with an ellipsis for what came before', () => {
    const collect = edgeLabel([link('/home', '/capture/collect', `${chain}guide.dontShowAgain.captureGuide`)]);
    const intro = edgeLabel([link('/home', '/guide', `${chain}!guide.dontShowAgain.captureGuide`)]);
    expect(collect).toBe('…guide.dontShowAgain.captureGuide');
    expect(intro).toBe('…NOT guide.dontShowAgain.captureGuide');
    // The whole point: two arms of a fork no longer read the same.
    expect(collect).not.toBe(intro);
  });

  it('prints a single clause without an ellipsis, and nothing when unconditional', () => {
    expect(edgeLabel([link('/home', '/queue', 'visible')])).toBe('visible');
    expect(edgeLabel([link('/home', '/queue')])).toBe('');
  });

  it('cuts an innermost clause that is itself too long, saying so at the end', () => {
    const label = edgeLabel([link('/a', '/b', 'x && ' + 'y'.repeat(60))]);
    expect(label.length).toBe(EDGE_LABEL_MAX);
    expect(label.startsWith('…')).toBe(true);
    expect(label.endsWith('…')).toBe(true);
  });

  it('counts several transitions between one pair', () => {
    expect(edgeLabel([link('/a', '/b', 'x'), link('/a', '/b')])).toBe('2 ways · 1 conditional');
    expect(edgeLabel([link('/a', '/b'), link('/a', '/b')])).toBe('2 ways');
  });
});

describe('layering by distance from the entry', () => {
  it('hangs shared chrome one row above the shallowest screen it opens', () => {
    const model = buildScreensModel(
      payload(
        [screen('/'), screen('/home'), screen('/soak-test')],
        [link('/', '/home'), link('/home', '/soak-test'), link('function:TopBar', '/soak-test')],
        [origin('TopBar', 10)]
      )
    );
    // Higher layer = higher on the picture.
    expect(layerOf(model, R('/'))).toBe(layerOf(model, R('/home')) + 1);
    expect(layerOf(model, R('/soak-test'))).toBe(layerOf(model, R('/home')) - 1);
    // The top bar sits beside /home, not beside the entry — so what it opens
    // is below it AND below the screen the user actually opened it from.
    expect(layerOf(model, 'function:TopBar')).toBe(layerOf(model, R('/home')));
    expect(edgeOf(model, 'function:TopBar', R('/soak-test')).route).toBe('down');
  });

  it('never lets chrome pull a screen up the picture', () => {
    const model = buildScreensModel(
      payload(
        [screen('/'), screen('/a'), screen('/b'), screen('/c')],
        [link('/', '/a'), link('/a', '/b'), link('/b', '/c'), link('function:TopBar', '/c')],
        [origin('TopBar', 4)]
      )
    );
    expect(layerOf(model, R('/c'))).toBe(layerOf(model, R('/')) - 3);
    expect(layerOf(model, 'function:TopBar')).toBe(layerOf(model, R('/b')));
  });

  it('seeds what only an origin opens, from the top', () => {
    const model = buildScreensModel(
      payload([screen('/'), screen('/detail')], [link('function:openDetail', '/detail')], [origin('openDetail')])
    );
    expect(layerOf(model, 'function:openDetail')).toBe(layerOf(model, R('/')));
    expect(layerOf(model, R('/detail'))).toBe(layerOf(model, R('/')) - 1);
    // Reached through chrome is reached.
    expect(model.unreached).toBe(0);
  });

  it('measures distance over every transition, not the two-cycle-broken set', () => {
    // Three returns against one arrival: the Map's break would keep /a -> /
    // and drop / -> /a, and then /a would have no way of being one below /.
    const model = buildScreensModel(
      payload(
        [screen('/'), screen('/a')],
        [link('/', '/a'), link('/a', '/', 'x'), link('/a', '/', 'y'), link('/a', '/', 'z')]
      )
    );
    expect(layerOf(model, R('/a'))).toBe(layerOf(model, R('/')) - 1);
  });

  it('puts what nothing reaches in a band at the bottom, one empty row below the rest', () => {
    const model = buildScreensModel(
      payload([screen('/'), screen('/home'), screen('/orphan')], [link('/', '/home')])
    );
    expect(layerOf(model, R('/orphan'))).toBe(0);
    expect(layerOf(model, R('/home'))).toBe(2);
    expect(layerOf(model, R('/'))).toBe(3);
    expect(model.unreached).toBe(1);
    expect(model.nodes.get(R('/orphan'))!.unreached).toBe(true);
  });

  it('draws the same picture twice', () => {
    const a = buildScreensModel(hub());
    const b = buildScreensModel(hub());
    expect(a.layout).toEqual(b.layout);
  });
});

describe('directional ports', () => {
  it('routes a return from the top of its source to the bottom of its target', () => {
    const model = buildScreensModel(
      payload([screen('/'), screen('/home')], [link('/', '/home'), link('/home', '/', 'logout')])
    );
    const root = nodeOf(model, R('/'));
    const home = nodeOf(model, R('/home'));
    const down = edgeOf(model, R('/'), R('/home'));
    const up = edgeOf(model, R('/home'), R('/'));
    expect(down.route).toBe('down');
    expect(up.route).toBe('up');
    expect(up.back).toBe(true);
    // Down: bottom of / to top of /home. Up: top of /home to bottom of /.
    expect(portPoint(root, down.id, 'source').y).toBe(root.y + NODE_HEIGHT);
    expect(portPoint(home, down.id, 'target').y).toBe(home.y);
    expect(portPoint(home, up.id, 'source').y).toBe(home.y);
    expect(portPoint(root, up.id, 'target').y).toBe(root.y + NODE_HEIGHT);
    // And the node component draws exactly those ports: one of each on the
    // sides that face each other, nothing on the sides that do not.
    expect(home.ports.top.map((p) => p.type).sort()).toEqual(['source', 'target']);
    expect(root.ports.bottom.map((p) => p.type).sort()).toEqual(['source', 'target']);
    expect(home.ports.bottom).toEqual([]);
    expect(root.ports.top).toEqual([]);
  });

  it('joins two screens on one row over the top', () => {
    const model = buildScreensModel(
      payload(
        [screen('/'), screen('/a'), screen('/b')],
        [link('/', '/a'), link('/', '/b'), link('/a', '/b', 'next')]
      )
    );
    const a = nodeOf(model, R('/a'));
    const b = nodeOf(model, R('/b'));
    const level = edgeOf(model, R('/a'), R('/b'));
    expect(a.layer).toBe(b.layer);
    expect(level.route).toBe('level');
    expect(portPoint(a, level.id, 'source').y).toBe(a.y);
    expect(portPoint(b, level.id, 'target').y).toBe(b.y);
  });

  it('widens a hub to keep its ports apart, and spaces rows for the labels', () => {
    const targets = Array.from({ length: 20 }, (_, i) => `/t${i}`);
    const model = buildScreensModel(
      payload([screen('/'), screen('/home'), ...targets.map(screen)], [
        link('/', '/home'),
        ...targets.map((t) => link('/home', t)),
      ])
    );
    const home = nodeOf(model, R('/home'));
    expect(home.ports.bottom).toHaveLength(20);
    expect(home.width).toBeGreaterThanOrEqual((20 + 1) * PORT_PITCH);
    expect(home.y - nodeOf(model, R('/')).y).toBe(NODE_HEIGHT + SCREEN_LAYER_GAP);
    expect(model.layerGap).toBe(SCREEN_LAYER_GAP);
  });
});

describe('the curve', () => {
  it('runs from port to port through the vertical midpoint, monotonic in y', () => {
    const c = screenCurve('down', 0, 0, 100, 116);
    expect(pointAt(c, 0)).toEqual({ x: 0, y: 0 });
    expect(pointAt(c, 1)).toEqual({ x: 100, y: 116 });
    expect(pointAt(c, 0.3).y).toBeLessThan(pointAt(c, 0.6).y);
    expect(screenEdgePath('down', 0, 0, 100, 116)).toBe('M0,0 C0,58 100,58 100,116');
    // Height -> parameter -> height round-trips.
    const y = pointAt(c, 0.3).y;
    expect(tAtY(c, y, 'target')).toBeCloseTo(0.3, 5);
    expect(tAtY(c, y, 'source')).toBeCloseTo(0.3, 5);
  });

  it('arches a level edge above its row, searchable from either end', () => {
    const c = screenCurve('level', 0, 100, 200, 100);
    expect(c.y0).toBe(c.y3);
    expect(pointAt(c, 0.5).y).toBeLessThan(100);
    expect(tAtY(c, 90, 'target')!).toBeGreaterThan(0.5);
    expect(tAtY(c, 90, 'source')!).toBeLessThan(0.5);
    // Above the apex there is no curve.
    expect(tAtY(c, -900, 'target')).toBeNull();
  });
});

describe('placing the labels', () => {
  it('fits five lanes between rows at the Screens gap, three at the Map\'s', () => {
    expect(laneCount(SCREEN_LAYER_GAP)).toBe(5);
    expect(laneCount(74)).toBe(3);
    expect(laneCount(10)).toBe(1);
  });

  it('puts every pill at the far end of its line, and none over another or over a box', () => {
    const model = buildScreensModel(hub());
    const home = nodeOf(model, R('/home'));
    const laid = placeLabels(model, R('/home'));
    // Twelve conditions out, six back; the entry's arrival is unconditional.
    expect(laid.pills.size + laid.hidden).toBe(18);
    expect(laid.hidden).toBe(0);

    const pills = [...laid.pills.values()];
    for (const a of pills) {
      for (const b of pills) {
        if (a !== b) expect(overlaps(rectOf(a), rectOf(b)), `${a.text} over ${b.text}`).toBe(false);
      }
      for (const node of model.layout.nodes) {
        expect(overlaps(rectOf(a), boxOf(node)), `${a.text} over ${node.id}`).toBe(false);
      }
    }

    for (let i = 0; i < 12; i++) {
      const target = nodeOf(model, R(`/t${i}`));
      const out = laid.pills.get(edgeOf(model, R('/home'), R(`/t${i}`)).id)!;
      expect(out.end).toBe('target');
      expect(out.text).toBe(`→ …step === ${i}`);
      // Above the screen it opens, inside the gap — and nearer to it than to /home.
      expect(out.y).toBeLessThan(target.y);
      expect(target.y - out.y).toBeLessThanOrEqual(SCREEN_LAYER_GAP);
      const farX = target.x + target.width / 2;
      const nearX = home.x + home.width / 2;
      expect(Math.abs(out.x - farX)).toBeLessThan(Math.abs(out.x - nearX) + 1);
    }
    for (let i = 0; i < 6; i++) {
      const source = nodeOf(model, R(`/t${i}`));
      const back = laid.pills.get(edgeOf(model, R(`/t${i}`), R('/home')).id)!;
      expect(back.end).toBe('source');
      expect(back.text).toBe(`← done${i}`);
      // A return leaves the top of its screen: the pill is above that box too.
      expect(back.y).toBeLessThan(source.y);
    }
  });

  it('draws nothing at rest, and the same thing every time', () => {
    const model = buildScreensModel(hub());
    expect(placeLabels(model, null).pills.size).toBe(0);
    const a = placeLabels(model, R('/home'));
    const b = placeLabels(model, R('/home'));
    expect([...a.pills.entries()]).toEqual([...b.pills.entries()]);
  });

  it('counts a pill that fits nowhere instead of drawing it on something', () => {
    const model = buildScreensModel(hub());
    // One lane only: the second pill above a screen that is both opened and
    // returned from has nowhere to go.
    const cramped: ScreensModel = { ...model, layerGap: 10 };
    expect(laneCount(cramped.layerGap)).toBe(1);
    const laid = placeLabels(cramped, R('/home'));
    expect(laid.hidden).toBeGreaterThan(0);
    expect(laid.pills.size + laid.hidden).toBe(18);
    const pills = [...laid.pills.values()];
    for (const a of pills) for (const b of pills) if (a !== b) expect(overlaps(rectOf(a), rectOf(b))).toBe(false);
  });

  it('labels the hovered line at its target end when nothing is selected', () => {
    const model = buildScreensModel(hub());
    const edge = edgeOf(model, R('/home'), R('/t3'));
    const pill = hoverPill(model, edge.id, null)!;
    expect(pill.end).toBe('target');
    expect(pill.text).toBe('→ …step === 3');
    expect(pill.y).toBeLessThan(nodeOf(model, R('/t3')).y);
    // Seen from the target, the same line arrives.
    const arriving = hoverPill(model, edge.id, R('/t3'))!;
    expect(arriving.end).toBe('source');
    expect(arriving.text).toBe('← …step === 3');
  });

  it('says nothing for an unconditional line unless told what to say', () => {
    const model = buildScreensModel(hub());
    const edge = edgeOf(model, R('/'), R('/home'));
    expect(hoverPill(model, edge.id, null)).toBeNull();
    expect(hoverPill(model, edge.id, R('/home'), '← always')?.text).toBe('← always');
    expect(pillText(model.edges.get(edge.id)!, edge, null)).toBe('');
  });

  it('keeps a transient pill clear of the ones the selection placed', () => {
    const model = buildScreensModel(hub());
    const laid = placeLabels(model, R('/home'));
    // /t6 is opened by /home (a pill above it) and, in this payload, returns
    // nothing; a row hovered for an unconditional return needs a lane of its
    // own above the same box.
    const ret = link('/t6', '/home');
    const withReturn = buildScreensModel({ ...hub(), links: [...hub().links, ret] });
    const base = placeLabels(withReturn, R('/home'));
    const edge = edgeOf(withReturn, R('/t6'), R('/home'));
    expect(base.pills.has(edge.id)).toBe(false);
    const pill = hoverPill(withReturn, edge.id, R('/home'), '← always', base)!;
    for (const other of base.pills.values()) {
      expect(overlaps(rectOf(pill), rectOf(other)), `over ${other.text}`).toBe(false);
    }
    expect(pill.lane).toBeGreaterThan(0);
    void laid;
  });

  it('sizes a pill from its text', () => {
    expect(pillWidth('→ x')).toBeGreaterThan(pillWidth('→'));
    expect(pairId(link('/a', '/a'))).toBeNull();
    expect(pairId(link('/a', '/b'))).toBe(linkId({ source: R('/a'), target: R('/b') }));
  });
});

/* --------------------------------------------------------------- tracks -- */

function orientation(a: Point, b: Point, c: Point): number {
  return Math.sign((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x));
}

/** Proper crossing of two segments (shared endpoints and touching do not count). */
function segmentsCross(p1: Point, p2: Point, p3: Point, p4: Point): boolean {
  const o1 = orientation(p1, p2, p3);
  const o2 = orientation(p1, p2, p4);
  const o3 = orientation(p3, p4, p1);
  const o4 = orientation(p3, p4, p2);
  return o1 !== 0 && o2 !== 0 && o3 !== 0 && o4 !== 0 && o1 !== o2 && o3 !== o4;
}

function crossings(a: readonly Point[], b: readonly Point[]): number {
  let n = 0;
  for (let i = 1; i < a.length; i++) {
    for (let j = 1; j < b.length; j++) {
      if (segmentsCross(a[i - 1]!, a[i]!, b[j - 1]!, b[j]!)) n++;
    }
  }
  return n;
}

describe('tracks — each line its own height through the gap', () => {
  /** A hub with six screens to one side and four to the other, three of which return. */
  function fan(): ScreensModel {
    const left = ['/l0', '/l1', '/l2', '/l3', '/l4', '/l5'];
    const right = ['/r0', '/r1', '/r2', '/r3'];
    return buildScreensModel(
      payload(
        [screen('/'), screen('/home'), ...left.map(screen), ...right.map(screen)],
        [
          link('/', '/home'),
          ...[...left, ...right].map((t, i) => link('/home', t, `c${i}`)),
          ...left.slice(0, 3).map((t, i) => link(t, '/home', `back${i}`)),
        ]
      )
    );
  }

  /** The hub's lines into the row below it, split by which side their far end sits on. */
  function sides(model: ScreensModel): Array<Array<{ curve: Curve; farX: number; id: string }>> {
    const home = nodeOf(model, R('/home'));
    const centre = home.x + home.width / 2;
    const lines = model.layout.edges
      .filter((e) => (e.source === R('/home') || e.target === R('/home')) && e.route !== 'level')
      .map((e) => {
        const curve = model.curves.get(e.id)!;
        const far = e.source === R('/home') ? { x: curve.x3, y: curve.y3 } : { x: curve.x0, y: curve.y0 };
        return { id: e.id, curve, farX: far.x, farY: far.y };
      })
      .filter((l) => l.farY > home.y + home.height);
    return [lines.filter((l) => l.farX < centre), lines.filter((l) => l.farX >= centre)];
  }

  it('ranks a fan by reach: the farthest-out line runs nearest the hub, every line on its own track', () => {
    const model = fan();
    const home = nodeOf(model, R('/home'));
    const bottom = home.y + home.height;
    const [left, right] = sides(model);
    expect(left!.length + right!.length).toBe(13);
    // Left: farther left first; its track is the highest (smallest y).
    const l = [...left!].sort((a, b) => a.farX - b.farX);
    for (let i = 1; i < l.length; i++) expect(l[i]!.curve.y1).toBeGreaterThan(l[i - 1]!.curve.y1 + 4);
    // Right: farther right first, mirrored.
    const r = [...right!].sort((a, b) => b.farX - a.farX);
    for (let i = 1; i < r.length; i++) expect(r[i]!.curve.y1).toBeGreaterThan(r[i - 1]!.curve.y1 + 4);
    // Every track lies inside the gap under the hub, and both control points share it.
    for (const line of [...l, ...r]) {
      expect(line.curve.y1).toBeGreaterThan(bottom);
      expect(line.curve.y1).toBeLessThan(bottom + SCREEN_LAYER_GAP);
      expect(line.curve.y2).toBe(line.curve.y1);
    }
  });

  it('never lets two lines of one fan cross — returns included', () => {
    const model = fan();
    for (const group of sides(model)) {
      for (const a of group) {
        for (const b of group) {
          if (a.id >= b.id) continue;
          expect(
            crossings(model.polylines.get(a.id)!, model.polylines.get(b.id)!),
            `${a.id} crosses ${b.id}`
          ).toBe(0);
        }
      }
    }
  });

  it('keeps a line that spans several rows on a track beside its fan, and runs the rest vertically', () => {
    // Downward lines are always one row (a row IS distance from the entry);
    // a return can come from any depth. Two rows down, straight back home.
    const model = buildScreensModel(
      payload(
        [screen('/'), screen('/home'), screen('/mid'), screen('/deep')],
        [link('/', '/home'), link('/home', '/mid'), link('/mid', '/deep'), link('/deep', '/home', 'done')]
      )
    );
    const home = nodeOf(model, R('/home'));
    const deep = nodeOf(model, R('/deep'));
    expect(home.layer - deep.layer).toBe(2);
    const curve = model.curves.get(edgeOf(model, R('/deep'), R('/home')).id)!;
    // The track sits in the gap right under /home — not at the midpoint, which
    // would be inside the row between.
    expect(curve.y1).toBeGreaterThan(home.y + home.height);
    expect(curve.y1).toBeLessThan(home.y + home.height + SCREEN_LAYER_GAP);
    expect(curve.y2).toBe(curve.y1);
    // Both ends leave and arrive vertically.
    expect(curve.x1).toBe(curve.x0);
    expect(curve.x2).toBe(curve.x3);
  });

  it('nests level arches, the wider one higher', () => {
    const model = buildScreensModel(
      payload(
        [screen('/'), screen('/a'), screen('/b'), screen('/c')],
        [link('/', '/a'), link('/', '/b'), link('/', '/c'), link('/a', '/b', 'x'), link('/a', '/c', 'y')]
      )
    );
    const a = nodeOf(model, R('/a'));
    const centre = a.x + a.width / 2;
    const ab = model.curves.get(edgeOf(model, R('/a'), R('/b')).id)!;
    const ac = model.curves.get(edgeOf(model, R('/a'), R('/c')).id)!;
    // Both arches leave a's top towards the same side (the row is b, c, a or a, b, c).
    expect(Math.sign(ab.x3 - centre)).toBe(Math.sign(ac.x3 - centre));
    const [wide, narrow] = Math.abs(ab.x3 - ab.x0) > Math.abs(ac.x3 - ac.x0) ? [ab, ac] : [ac, ab];
    expect(wide.y1).toBeLessThan(narrow.y1);
    expect(narrow.y1).toBeLessThan(a.y);
  });

  it('draws the same tracks twice', () => {
    expect([...fan().curves.entries()]).toEqual([...fan().curves.entries()]);
  });
});

describe('pointing at a line', () => {
  it('answers the nearest line within reach, and nothing beyond it', () => {
    const model = buildScreensModel(hub());
    const edge = edgeOf(model, R('/home'), R('/t4'));
    const on = model.polylines.get(edge.id)![12]!;
    expect(nearestEdge(model, { x: on.x + 1, y: on.y + 1 }, null, 10)?.id).toBe(edge.id);
    expect(nearestEdge(model, { x: -5000, y: -5000 }, null, 10)).toBeNull();
    // Reach is a distance, not a hint.
    expect(nearestEdge(model, { x: on.x + 30, y: on.y + 30 }, null, 10)).toBeNull();
  });

  it('only considers the lines it is asked about', () => {
    const model = buildScreensModel(hub());
    const near = edgeOf(model, R('/home'), R('/t4'));
    const other = edgeOf(model, R('/home'), R('/t9'));
    const on = model.polylines.get(near.id)![12]!;
    expect(nearestEdge(model, on, new Set([other.id]), 1e9)?.id).toBe(other.id);
    expect(nearestEdge(model, on, new Set(), 1e9)).toBeNull();
  });

  it('tells two lines a few pixels apart from each other', () => {
    const model = buildScreensModel(hub());
    const home = nodeOf(model, R('/home'));
    // Two lines to neighbouring screens on the same side: at a height in the
    // gap where both run, the pointer just above one, then just below the
    // other, meets each in turn.
    const [a, b] = model.layout.edges
      .filter((e) => e.source === R('/home'))
      .map((e) => ({ id: e.id, curve: model.curves.get(e.id)! }))
      .filter((l) => l.curve.x3 < home.x)
      .sort((p, q) => p.curve.x3 - q.curve.x3);
    expect(a && b).toBeTruthy();
    const y = (a!.curve.y1 + b!.curve.y1) / 2;
    const x = Math.max(a!.curve.x3, b!.curve.x3) + 40;
    const hit = nearestEdge(model, { x, y: y - 1 }, null, 60)!;
    const hit2 = nearestEdge(model, { x, y: y + 1 }, null, 60)!;
    expect(new Set([hit.id, hit2.id]).size).toBeGreaterThanOrEqual(1);
    expect([a!.id, b!.id]).toContain(hit.id);
  });
});
