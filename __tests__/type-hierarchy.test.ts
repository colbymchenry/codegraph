/**
 * The type hierarchy (CG-58) — the walk, the fan, and the tree the viewer draws.
 *
 * The walk half runs against a real indexed fixture rather than a stubbed
 * `CodeGraph`: the properties worth pinning are ones only a real index has —
 * that a Go struct satisfies an interface through a SYNTHESIZED `implements`
 * edge with no textual link between the two files, that a self-referential
 * `extends` in generated code does not loop, that the breadth-first order puts
 * every direct subtype ahead of any indirect one.
 *
 * The layout half is pure arithmetic over a payload, so it is asserted
 * directly. Everything the block does that could be WRONG rather than merely
 * ugly lives there: which row a connector attaches to, what folds, and which
 * noun the fold uses.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';
import type { Node } from '../src/types';
import {
  buildTypeHierarchy,
  canHaveHierarchy,
  countImplementers,
  DISPATCH_MIN_IMPLEMENTERS,
  MAX_DESCENDANTS,
} from '../src/graph/type-hierarchy';
import { buildHierarchy } from '../src/ui-server/api/hierarchy';
import {
  buildHierarchyModel,
  connectorPath,
  visibleHierarchy,
  HIER_FOLD_AT,
  HIER_GLYPH_X,
  HIER_INDENT,
  HIER_PORT_X,
  HIER_ROW_H,
} from '../ui/src/lib/hierarchy-model';
import type {
  WireHierarchy,
  WireHierarchyNode,
  WireNodeDetail,
} from '../ui/src/lib/wire';

// =============================================================================
// A real index
// =============================================================================

let tempDir: string;
let projectRoot: string;
let cg: CodeGraph;

/** The one node with this name and kind, or a failure that says which was missing. */
function nodeNamed(name: string, kind?: string): Node {
  const hits = cg
    .searchNodes(name, { limit: 40 })
    .map((r: any) => (r.node ?? r) as Node)
    .filter((n) => n.name === name && (!kind || n.kind === kind));
  expect(hits.length, `no ${kind ?? 'node'} named ${name}`).toBeGreaterThan(0);
  return hits[0]!;
}

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-hierarchy-'));
  projectRoot = path.join(tempDir, 'project');
  const src = path.join(projectRoot, 'src');
  fs.mkdirSync(src, { recursive: true });

  // A three-level TypeScript chain with a real override, plus an interface with
  // enough implementations to be a dispatch fan.
  fs.writeFileSync(
    path.join(src, 'shapes.ts'),
    `export interface Drawable {
  draw(): string;
}

export abstract class Shape implements Drawable {
  draw(): string {
    return 'shape';
  }
  area(): number {
    return 0;
  }
}

export class Square extends Shape {
  draw(): string {
    return 'square';
  }
}

export class Tile extends Square {
  label = 'tile';
}
`
  );

  // Nine implementations, so the fan clears DISPATCH_MIN_IMPLEMENTERS.
  const targets = [
    'Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot', 'Golf', 'Hotel', 'India',
  ];
  fs.writeFileSync(
    path.join(src, 'plugins.ts'),
    `export interface Plugin {
  run(): void;
}

${targets
  .map((name) => `export class ${name}Plugin implements Plugin {\n  run(): void {}\n}`)
  .join('\n\n')}
`
  );

  // Go: `System` satisfies `Clock` without either file naming the other. The
  // `implements` edge here is synthesized, which is the case the viewer draws
  // differently — the fixture mirrors `__tests__/fixtures/payroll-go`.
  fs.writeFileSync(path.join(projectRoot, 'go.mod'), 'module fixture\n\ngo 1.22\n');
  fs.writeFileSync(
    path.join(src, 'clock.go'),
    `package clock

import "time"

// Clock is the time seam.
type Clock interface {
	Now() time.Time
}

// System is the production clock.
type System struct{}

func (System) Now() time.Time { return time.Now().UTC() }

// Fixed is a frozen clock.
type Fixed struct{ At time.Time }

func (f Fixed) Now() time.Time { return f.At }
`
  );

  cg = CodeGraph.initSync(projectRoot, {
    config: { include: ['src/**/*.ts', 'src/**/*.go'], exclude: [] },
  });
  await cg.indexAll();
  cg.resolveReferences();
}, 120_000);

afterAll(() => {
  cg?.close();
  if (tempDir && fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('canHaveHierarchy', () => {
  it('is false for a function, so the walk never runs for one', () => {
    expect(canHaveHierarchy({ kind: 'function' } as Node)).toBe(false);
    expect(canHaveHierarchy({ kind: 'method' } as Node)).toBe(false);
    expect(canHaveHierarchy({ kind: 'class' } as Node)).toBe(true);
    expect(canHaveHierarchy({ kind: 'interface' } as Node)).toBe(true);
    expect(canHaveHierarchy({ kind: 'struct' } as Node)).toBe(true);
    expect(canHaveHierarchy({ kind: 'trait' } as Node)).toBe(true);
  });
});

describe('buildTypeHierarchy — upward', () => {
  it('walks past the direct parent to the whole chain', () => {
    const hierarchy = buildTypeHierarchy(cg, nodeNamed('Tile', 'class'));
    expect(hierarchy).not.toBeNull();
    const byName = new Map(hierarchy!.ancestors.map((a) => [a.node.name, a]));
    expect(byName.get('Square')?.depth).toBe(1);
    expect(byName.get('Shape')?.depth).toBe(2);
    // `Shape implements Drawable`, so the interface is three steps up from Tile.
    expect(byName.get('Drawable')?.depth).toBe(3);
    expect(byName.get('Square')?.relation).toBe('extends');
    expect(byName.get('Drawable')?.relation).toBe('implements');
  });

  it('nearest ancestors come first', () => {
    const hierarchy = buildTypeHierarchy(cg, nodeNamed('Tile', 'class'))!;
    const depths = hierarchy.ancestors.map((a) => a.depth);
    expect(depths).toEqual([...depths].sort((a, b) => a - b));
  });
});

describe('buildTypeHierarchy — the fan', () => {
  it('returns every direct subtype before any indirect one', () => {
    const hierarchy = buildTypeHierarchy(cg, nodeNamed('Shape', 'class'))!;
    const depths = hierarchy.descendants.map((d) => d.depth);
    expect(depths).toEqual([...depths].sort((a, b) => a - b));
    expect(hierarchy.descendants.map((d) => d.node.name)).toContain('Square');
    expect(hierarchy.descendants.map((d) => d.node.name)).toContain('Tile');
    expect(hierarchy.directSubtypes).toBe(1);
  });

  it('hangs an indirect subtype off its own parent, not off the focus', () => {
    const focus = nodeNamed('Shape', 'class');
    const hierarchy = buildTypeHierarchy(cg, focus)!;
    const square = hierarchy.descendants.find((d) => d.node.name === 'Square')!;
    const tile = hierarchy.descendants.find((d) => d.node.name === 'Tile')!;
    expect(square.parentId).toBe(focus.id);
    expect(tile.parentId).toBe(square.node.id);
  });

  it('calls a nine-implementation interface polymorphic', () => {
    const hierarchy = buildTypeHierarchy(cg, nodeNamed('Plugin', 'interface'))!;
    expect(hierarchy.directImplementers).toBeGreaterThanOrEqual(DISPATCH_MIN_IMPLEMENTERS);
    expect(hierarchy.polymorphic).toBe(true);
    expect(hierarchy.directSubtypes).toBe(hierarchy.descendants.filter((d) => d.depth === 1).length);
  });

  it('does not call a two-implementation interface polymorphic', () => {
    const hierarchy = buildTypeHierarchy(cg, nodeNamed('Clock', 'interface'))!;
    expect(hierarchy.directSubtypes).toBe(2);
    expect(hierarchy.polymorphic).toBe(false);
  });
});

describe('buildTypeHierarchy — Go implicit satisfaction', () => {
  it('finds the implementations of an interface no file names', () => {
    const hierarchy = buildTypeHierarchy(cg, nodeNamed('Clock', 'interface'))!;
    const names = hierarchy.descendants.map((d) => d.node.name).sort();
    expect(names).toEqual(['Fixed', 'System']);
    expect(hierarchy.descendants.every((d) => d.relation === 'implements')).toBe(true);
  });

  it('marks the synthesized edge, and keeps where it was wired', () => {
    const hierarchy = buildTypeHierarchy(cg, nodeNamed('Clock', 'interface'))!;
    const system = hierarchy.descendants.find((d) => d.node.name === 'System')!;
    expect(system.synthesized).toBe(true);
    const meta = (system.edge.metadata ?? {}) as Record<string, unknown>;
    expect(meta.synthesizedBy).toBe('go-implements');
    expect(String(meta.registeredAt)).toContain('clock.go');
  });
});

describe('buildTypeHierarchy — overrides', () => {
  it('marks a member that redeclares an ancestor s, and names the ancestor', () => {
    const hierarchy = buildTypeHierarchy(cg, nodeNamed('Square', 'class'))!;
    const matches = [...hierarchy.overrides.values()];
    const draw = matches.find((m) => m.baseTypeName === 'Shape');
    expect(draw, 'Square.draw should be matched against Shape.draw').toBeTruthy();
    expect(draw!.relation).toBe('extends');
  });

  it('leaves a member that declares something new unmarked', () => {
    const hierarchy = buildTypeHierarchy(cg, nodeNamed('Tile', 'class'))!;
    // `label` exists on nothing above Tile.
    const named = [...hierarchy.overrides.values()].map((m) => m.memberId);
    const label = cg
      .getOutgoingEdges(nodeNamed('Tile', 'class').id)
      .filter((e) => e.kind === 'contains')
      .map((e) => cg.getNode(e.target))
      .find((n) => n?.name === 'label');
    if (label) expect(named).not.toContain(label.id);
  });

  it('can be switched off without changing the tree', () => {
    const focus = nodeNamed('Square', 'class');
    const withOverrides = buildTypeHierarchy(cg, focus)!;
    const without = buildTypeHierarchy(cg, focus, { overrides: false })!;
    expect(without.overrides.size).toBe(0);
    expect(without.descendants.length).toBe(withOverrides.descendants.length);
    expect(without.ancestors.length).toBe(withOverrides.ancestors.length);
  });
});

describe('countImplementers', () => {
  it('counts distinct types, and agrees with the fan it sits beside', () => {
    const plugin = nodeNamed('Plugin', 'interface');
    const hierarchy = buildTypeHierarchy(cg, plugin)!;
    expect(countImplementers(cg, plugin.id)).toBe(hierarchy.directSubtypes);
  });

  it('is zero for a type nothing extends', () => {
    expect(countImplementers(cg, nodeNamed('Tile', 'class').id)).toBe(0);
  });
});

describe('the /api/node block', () => {
  it('is null for a function', () => {
    const fn = cg
      .searchNodes('run', { limit: 40 })
      .map((r: any) => (r.node ?? r) as Node)
      .find((n) => n.kind === 'method');
    if (fn) expect(buildHierarchy(cg, fn)).toBeNull();
  });

  it('is null for a type with no hierarchy at all', () => {
    const orphan = { id: 'x', kind: 'class', name: 'Nope' } as Node;
    expect(buildHierarchy(cg, orphan)).toBeNull();
  });

  it('carries a total that equals the list beneath it', () => {
    const built = buildHierarchy(cg, nodeNamed('Plugin', 'interface'))!;
    expect(built.wire.descendants.items.length).toBe(built.wire.descendants.shown);
    expect(built.wire.descendants.total).toBe(built.wire.descendants.items.length);
    expect(built.wire.descendants.truncated).toBe(false);
    expect(built.wire.direct).toBe(built.wire.descendants.total);
  });

  it('lifts the synthesized edge s wiring onto the row', () => {
    const built = buildHierarchy(cg, nodeNamed('Clock', 'interface'))!;
    const system = built.wire.descendants.items.find((d) => d.name === 'System')!;
    expect(system.synthesized).toBe(true);
    expect(system.via).toBe('go-implements');
    expect(system.registeredAt).toContain('clock.go');
  });

  it('hands the outline its override marks', () => {
    const built = buildHierarchy(cg, nodeNamed('Square', 'class'))!;
    expect([...built.overrides.values()].some((o) => o.baseTypeName === 'Shape')).toBe(true);
  });
});

// =============================================================================
// The bounds, against a synthetic graph
// =============================================================================

/**
 * A `CodeGraph` stub holding only what the walk reads.
 *
 * A fan wide enough to hit {@link MAX_DESCENDANTS} would be thousands of files
 * to index for one assertion, and the property being pinned is arithmetic
 * rather than extraction: that the cap stops materialising rows, keeps counting
 * the direct ones, and says it was bounded.
 */
function stubGraph(childCount: number): any {
  const type = (id: string, name: string): Node =>
    ({
      id,
      kind: 'class',
      name,
      qualifiedName: name,
      filePath: `src/${name}.ts`,
      startLine: 1,
      endLine: 2,
      startColumn: 0,
      endColumn: 0,
      language: 'typescript',
    }) as Node;

  const root = type('root', 'Root');
  const children = Array.from({ length: childCount }, (_, i) => type(`c${i}`, `Child${i}`));
  const all = new Map<string, Node>([[root.id, root], ...children.map((c) => [c.id, c] as const)]);

  return {
    getIncomingEdgesTo: (ids: string[]) =>
      ids.includes('root')
        ? children.map((c) => ({ source: c.id, target: 'root', kind: 'extends' }))
        : [],
    getOutgoingEdgesFrom: () => [],
    getNodesByIds: (ids: string[]) =>
      new Map(ids.map((id) => [id, all.get(id)!]).filter(([, n]) => !!n) as Array<[string, Node]>),
    root,
  };
}

describe('the descendant bound', () => {
  it('stays unbounded under the cap', () => {
    const cgStub = stubGraph(10);
    const hierarchy = buildTypeHierarchy(cgStub, cgStub.root)!;
    expect(hierarchy.descendants.length).toBe(10);
    expect(hierarchy.directSubtypes).toBe(10);
    expect(hierarchy.bounded).toBe(false);
  });

  it('stops materialising rows past the cap but keeps the direct count true', () => {
    const cgStub = stubGraph(MAX_DESCENDANTS + 37);
    const hierarchy = buildTypeHierarchy(cgStub, cgStub.root)!;
    expect(hierarchy.descendants.length).toBe(MAX_DESCENDANTS);
    // The number of subtypes is not the number of rows, and says so.
    expect(hierarchy.directSubtypes).toBe(MAX_DESCENDANTS + 37);
    expect(hierarchy.bounded).toBe(true);
  });

  it('reports the cap through the wire block as a truncated list', () => {
    const cgStub = stubGraph(MAX_DESCENDANTS + 37);
    const built = buildHierarchy(cgStub, cgStub.root)!;
    expect(built.wire.descendants.truncated).toBe(true);
    expect(built.wire.descendants.items.length).toBeLessThan(built.wire.descendants.total);
    expect(built.wire.bounded).toBe(true);
    expect(built.wire.direct).toBe(MAX_DESCENDANTS + 37);
  });
});

// =============================================================================
// The tree the viewer draws
// =============================================================================

const FOCUS: WireNodeDetail = {
  id: 'focus',
  kind: 'interface',
  name: 'Clock',
  qualifiedName: 'Clock',
  file: 'src/clock.ts',
  line: 1,
  endLine: 3,
  language: 'typescript' as WireNodeDetail['language'],
  test: false,
  startColumn: 0,
  endColumn: 0,
  lines: 3,
};

function entry(
  name: string,
  depth: number,
  parentId: string,
  relation: 'extends' | 'implements' = 'implements'
): WireHierarchyNode {
  return {
    id: name,
    kind: 'class',
    name,
    qualifiedName: name,
    file: `src/${name}.ts`,
    line: 1,
    endLine: 2,
    language: 'typescript' as WireNodeDetail['language'],
    test: false,
    depth,
    parentId,
    relation,
    synthesized: false,
    hiddenSubtypes: 0,
  };
}

function hierarchyOf(
  ancestors: WireHierarchyNode[],
  descendants: WireHierarchyNode[],
  extra: Partial<WireHierarchy> = {}
): WireHierarchy {
  return {
    ancestors: {
      total: ancestors.length,
      shown: ancestors.length,
      truncated: false,
      items: ancestors,
    },
    descendants: {
      total: descendants.length,
      shown: descendants.length,
      truncated: false,
      items: descendants,
    },
    direct: descendants.filter((d) => d.depth === 1).length,
    implementers: descendants.filter((d) => d.depth === 1 && d.relation === 'implements').length,
    bounded: false,
    polymorphic: false,
    ...extra,
  };
}

describe('buildHierarchyModel', () => {
  it('puts the focus between the two halves, farthest ancestor at the top', () => {
    const model = buildHierarchyModel(
      hierarchyOf(
        [entry('Base', 2, 'Mid', 'extends'), entry('Mid', 1, 'focus', 'extends')],
        [entry('Sub', 1, 'focus', 'extends')]
      ),
      FOCUS
    );
    expect(model.rows.map((r) => r.node.name)).toEqual(['Base', 'Mid', 'Clock', 'Sub']);
    expect(model.focusIndex).toBe(2);
    expect(model.rows[2]!.side).toBe('focus');
  });

  it('indents each descendant level and leaves ancestors at zero', () => {
    const model = buildHierarchyModel(
      hierarchyOf([entry('Base', 1, 'focus', 'extends')], [
        entry('Sub', 1, 'focus', 'extends'),
        entry('SubSub', 2, 'Sub', 'extends'),
      ]),
      FOCUS
    );
    const indents = Object.fromEntries(model.rows.map((r) => [r.node.name, r.indent]));
    expect(indents.Base).toBe(0);
    expect(indents.Clock).toBe(0);
    expect(indents.Sub).toBe(HIER_INDENT);
    expect(indents.SubSub).toBe(HIER_INDENT * 2);
  });

  it('draws a descendant connector from its own parent row, not from the focus', () => {
    const model = buildHierarchyModel(
      hierarchyOf([], [entry('Sub', 1, 'focus', 'extends'), entry('SubSub', 2, 'Sub', 'extends')]),
      FOCUS
    );
    const rowOf = (name: string) => model.rows.findIndex((r) => r.node.name === name);
    const deep = model.connectors.find((c) => c.toIndex === rowOf('SubSub'))!;
    expect(deep.fromIndex).toBe(rowOf('Sub'));
    // Leaves the parent's glyph centre, meets the child's glyph.
    expect(deep.x).toBe(HIER_INDENT + HIER_PORT_X);
    expect(deep.toX).toBe(HIER_INDENT * 2 + HIER_GLYPH_X - 2);
  });

  it('never hangs a descendant off an ancestor row that shares its name', () => {
    // A cycle in generated code: `Loop` is both above and below the focus.
    const model = buildHierarchyModel(
      hierarchyOf([entry('Loop', 1, 'focus', 'extends')], [entry('Loop', 1, 'focus', 'extends')]),
      FOCUS
    );
    const descendantRow = model.rows.findIndex((r) => r.side === 'descendant');
    const connector = model.connectors.find((c) => c.toIndex === descendantRow)!;
    expect(connector.fromIndex).toBe(model.focusIndex);
  });

  it('carries the relation into the connector so implements can be dashed', () => {
    const model = buildHierarchyModel(
      hierarchyOf([], [entry('Impl', 1, 'focus', 'implements')]),
      FOCUS
    );
    expect(model.connectors[0]!.relation).toBe('implements');
  });

  it('claims a dispatch only when the payload says the type is polymorphic', () => {
    const plain = buildHierarchyModel(hierarchyOf([], [entry('A', 1, 'focus')]), FOCUS);
    expect(plain.headline).toBe('');

    const fan = buildHierarchyModel(
      hierarchyOf([], [entry('A', 1, 'focus')], { polymorphic: true, implementers: 9 }),
      FOCUS
    );
    expect(fan.headline).toContain('9 implementations');
    expect(fan.headline).toContain('Clock');
  });
});

describe('the fold', () => {
  const fan = (n: number, relation: 'extends' | 'implements' = 'implements') =>
    hierarchyOf(
      [],
      Array.from({ length: n }, (_, i) => entry(`Impl${i}`, 1, 'focus', relation))
    );

  it('does not fold a fan of exactly the threshold — a "+0 more" is not a fold', () => {
    const model = buildHierarchyModel(fan(HIER_FOLD_AT), FOCUS);
    expect(model.foldFrom).toBeNull();
    expect(model.foldCount).toBe(0);
  });

  it('folds the tail past the threshold and counts what it hid', () => {
    const model = buildHierarchyModel(fan(HIER_FOLD_AT + 5), FOCUS);
    expect(model.foldCount).toBe(5);
    expect(model.foldNoun).toBe('implementations');
    const folded = visibleHierarchy(model, false);
    expect(folded.rows.length).toBe(model.focusIndex + 1 + HIER_FOLD_AT);
    expect(visibleHierarchy(model, true).rows.length).toBe(model.rows.length);
  });

  it('never leaves a connector running into the fold', () => {
    const model = buildHierarchyModel(fan(HIER_FOLD_AT + 5), FOCUS);
    const folded = visibleHierarchy(model, false);
    for (const connector of folded.connectors) {
      expect(connector.toIndex).toBeLessThan(folded.rows.length);
      expect(connector.fromIndex).toBeLessThan(folded.rows.length);
    }
  });

  it('calls a family of subclasses subclasses, not implementations', () => {
    const model = buildHierarchyModel(fan(HIER_FOLD_AT + 2, 'extends'), FOCUS);
    expect(model.foldNoun).toBe('subclasses');
  });

  it('heights are the row count times the row height, with nothing measured', () => {
    const model = buildHierarchyModel(fan(HIER_FOLD_AT + 5), FOCUS);
    expect(visibleHierarchy(model, false).height).toBe(
      (model.focusIndex + 1 + HIER_FOLD_AT) * HIER_ROW_H
    );
    expect(visibleHierarchy(model, true).height).toBe(model.rows.length * HIER_ROW_H);
  });
});

describe('connectorPath', () => {
  it('is two straight runs and a corner, never a curve', () => {
    const path = connectorPath({
      fromIndex: 0,
      toIndex: 1,
      x: 26,
      toX: 38,
      relation: 'extends',
      synthesized: false,
    });
    expect(path).toBe(`M 26 ${HIER_ROW_H / 2} L 26 ${HIER_ROW_H + HIER_ROW_H / 2} L 38 ${HIER_ROW_H + HIER_ROW_H / 2}`);
    expect(path).not.toContain('C');
  });

  it('drops the horizontal run when the two rows share an indent', () => {
    const path = connectorPath({
      fromIndex: 0,
      toIndex: 1,
      x: 26,
      toX: 26,
      relation: 'implements',
      synthesized: false,
    });
    expect(path.match(/L/g)).toHaveLength(1);
  });
});

describe('the note under the tree', () => {
  it('says how much of the fan is on screen when it was capped', () => {
    const payload = hierarchyOf([], [entry('A', 1, 'focus')]);
    payload.descendants.total = 900;
    payload.descendants.truncated = true;
    const model = buildHierarchyModel(payload, FOCUS);
    expect(model.note).toContain('900');
  });

  it('says deeper subtypes exist when the walk stopped rather than the list', () => {
    const model = buildHierarchyModel(
      hierarchyOf([], [entry('A', 1, 'focus')], { bounded: true }),
      FOCUS
    );
    expect(model.note).toContain('Deeper subtypes');
  });

  it('is empty when the payload is the whole truth', () => {
    expect(buildHierarchyModel(hierarchyOf([], [entry('A', 1, 'focus')]), FOCUS).note).toBe('');
  });
});
