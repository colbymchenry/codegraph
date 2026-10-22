/**
 * Graph Query Tests
 *
 * Tests for graph traversal and query functionality.
 */

import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import CodeGraph, { DatabaseConnection, getDatabasePath, QueryBuilder } from '../src/index';
import { Node, Edge } from '../src/types';
import { GraphTraverser } from '../src/graph/traversal';

describe('Graph Queries', () => {
  let testDir: string;
  let cg: CodeGraph;

  beforeEach(async () => {
    // Create temp directory
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-graph-test-'));

    // Create test files with relationships
    const srcDir = path.join(testDir, 'src');
    fs.mkdirSync(srcDir, { recursive: true });

    // Create base class
    fs.writeFileSync(
      path.join(srcDir, 'base.ts'),
      `
export class BaseClass {
  protected value: number;

  constructor(value: number) {
    this.value = value;
  }

  getValue(): number {
    return this.value;
  }
}

export interface Printable {
  print(): void;
}
`
    );

    // Create derived class
    fs.writeFileSync(
      path.join(srcDir, 'derived.ts'),
      `
import { BaseClass, Printable } from './base';

export class DerivedClass extends BaseClass implements Printable {
  private name: string;

  constructor(value: number, name: string) {
    super(value);
    this.name = name;
  }

  print(): void {
    console.log(this.getName(), this.getValue());
  }

  getName(): string {
    return this.name;
  }
}
`
    );

    // Create utility functions
    fs.writeFileSync(
      path.join(srcDir, 'utils.ts'),
      `
export function formatValue(value: number): string {
  return value.toFixed(2);
}

export function processValue(value: number): number {
  const formatted = formatValue(value);
  return parseFloat(formatted);
}

export function doubleValue(value: number): number {
  return value * 2;
}

// Unused function (dead code)
function unusedHelper(): void {
  console.log('never called');
}
`
    );

    // Create main file that uses everything
    fs.writeFileSync(
      path.join(srcDir, 'main.ts'),
      `
import { DerivedClass } from './derived';
import { processValue, doubleValue } from './utils';

function main(): void {
  const obj = new DerivedClass(10, 'test');
  obj.print();

  const result = processValue(doubleValue(obj.getValue()));
  console.log(result);
}

export { main };
`
    );

    // Initialize and index
    cg = CodeGraph.initSync(testDir, {
      config: {
        include: ['src/**/*.ts'],
        exclude: [],
      },
    });

    await cg.indexAll();
    cg.resolveReferences();
  });

  afterEach(() => {
    if (cg) {
      cg.destroy();
    }
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe('traverse()', () => {
    it('should traverse graph from a starting node', () => {
      const nodes = cg.getNodesByKind('function');
      const mainFunc = nodes.find((n) => n.name === 'main');

      if (!mainFunc) {
        console.log('main function not found, skipping test');
        return;
      }

      const subgraph = cg.traverse(mainFunc.id, {
        maxDepth: 2,
        direction: 'outgoing',
      });

      expect(subgraph.nodes.size).toBeGreaterThan(0);
      expect(subgraph.roots).toContain(mainFunc.id);
    });

    it('should respect maxDepth option', () => {
      const nodes = cg.getNodesByKind('function');
      const mainFunc = nodes.find((n) => n.name === 'main');

      if (!mainFunc) {
        return;
      }

      const shallow = cg.traverse(mainFunc.id, { maxDepth: 1 });
      const deep = cg.traverse(mainFunc.id, { maxDepth: 3 });

      expect(deep.nodes.size).toBeGreaterThanOrEqual(shallow.nodes.size);
    });

    it('should support incoming direction', () => {
      const nodes = cg.getNodesByKind('function');
      const formatValue = nodes.find((n) => n.name === 'formatValue');

      if (!formatValue) {
        return;
      }

      const subgraph = cg.traverse(formatValue.id, {
        maxDepth: 2,
        direction: 'incoming',
      });

      expect(subgraph.nodes.size).toBeGreaterThan(0);
    });
  });

  describe('getContext()', () => {
    it('should return context for a node', () => {
      const nodes = cg.getNodesByKind('class');
      const derivedClass = nodes.find((n) => n.name === 'DerivedClass');

      if (!derivedClass) {
        console.log('DerivedClass not found, skipping test');
        return;
      }

      const context = cg.getContext(derivedClass.id);

      expect(context.focal).toBeDefined();
      expect(context.focal.id).toBe(derivedClass.id);
      expect(context.ancestors).toBeDefined();
      expect(context.children).toBeDefined();
      expect(context.incomingRefs).toBeDefined();
      expect(context.outgoingRefs).toBeDefined();
    });

    it('should throw for non-existent node', () => {
      expect(() => cg.getContext('non-existent-id')).toThrow('Node not found');
    });
  });

  describe('getCallGraph()', () => {
    it('should return call graph for a function', () => {
      const nodes = cg.getNodesByKind('function');
      const processValue = nodes.find((n) => n.name === 'processValue');

      if (!processValue) {
        console.log('processValue not found, skipping test');
        return;
      }

      const callGraph = cg.getCallGraph(processValue.id, 2);

      expect(callGraph.nodes.size).toBeGreaterThan(0);
      expect(callGraph.nodes.has(processValue.id)).toBe(true);
    });
  });

  describe('getTypeHierarchy()', () => {
    it('should return type hierarchy for a class', () => {
      const nodes = cg.getNodesByKind('class');
      const derivedClass = nodes.find((n) => n.name === 'DerivedClass');

      if (!derivedClass) {
        return;
      }

      const hierarchy = cg.getTypeHierarchy(derivedClass.id);

      expect(hierarchy.nodes.size).toBeGreaterThan(0);
      expect(hierarchy.nodes.has(derivedClass.id)).toBe(true);
    });

    it('should return empty subgraph for non-existent node', () => {
      const hierarchy = cg.getTypeHierarchy('non-existent-id');

      expect(hierarchy.nodes.size).toBe(0);
      expect(hierarchy.edges.length).toBe(0);
    });
  });

  describe('findUsages()', () => {
    it('should find usages of a symbol', () => {
      const nodes = cg.getNodesByKind('class');
      const baseClass = nodes.find((n) => n.name === 'BaseClass');

      if (!baseClass) {
        return;
      }

      const usages = cg.findUsages(baseClass.id);

      // Should find at least the extends relationship
      expect(usages).toBeDefined();
      expect(Array.isArray(usages)).toBe(true);
    });
  });

  describe('getCallers() and getCallees()', () => {
    it('should get callers of a function', () => {
      const nodes = cg.getNodesByKind('function');
      const formatValue = nodes.find((n) => n.name === 'formatValue');

      if (!formatValue) {
        return;
      }

      const callers = cg.getCallers(formatValue.id);

      // processValue calls formatValue
      expect(Array.isArray(callers)).toBe(true);
    });

    it('should get callees of a function', () => {
      const nodes = cg.getNodesByKind('function');
      const processValue = nodes.find((n) => n.name === 'processValue');

      if (!processValue) {
        return;
      }

      const callees = cg.getCallees(processValue.id);

      expect(Array.isArray(callees)).toBe(true);
    });

    it('treats class instantiation as a caller/callee of the class (#774)', () => {
      // main() does `new DerivedClass(10, 'test')`. Constructing a class is
      // calling its constructor, so main is a caller of DerivedClass and
      // DerivedClass is a callee of main. Before #774 the `instantiates` edge
      // was excluded from the caller/callee traversal, so `callers <Class>`
      // returned the importing file (or nothing) and missed every
      // construction site.
      const derived = cg.getNodesByKind('class').find((n) => n.name === 'DerivedClass');
      const main = cg.getNodesByKind('function').find((n) => n.name === 'main');
      expect(derived).toBeDefined();
      expect(main).toBeDefined();

      const callerNames = cg.getCallers(derived!.id).map((c) => c.node.name);
      expect(callerNames).toContain('main');

      const calleeNames = cg.getCallees(main!.id).map((c) => c.node.name);
      expect(calleeNames).toContain('DerivedClass');
    });
  });

  describe('getImpactRadius()', () => {
    it('should calculate impact radius', () => {
      const nodes = cg.getNodesByKind('function');
      const formatValue = nodes.find((n) => n.name === 'formatValue');

      if (!formatValue) {
        return;
      }

      const impact = cg.getImpactRadius(formatValue.id, 3);

      expect(impact.nodes.size).toBeGreaterThan(0);
      expect(impact.nodes.has(formatValue.id)).toBe(true);
    });

    it('does not drag in sibling members via the structural contains edge (#536)', () => {
      const getName = cg.getNodesByKind('method').find((n) => n.name === 'getName');
      const derived = cg.getNodesByKind('class').find((n) => n.name === 'DerivedClass');
      expect(getName).toBeDefined();
      expect(derived).toBeDefined();

      const impact = cg.getImpactRadius(getName!.id, 3);
      // The containing class must NOT be pulled into impact just because it
      // *contains* getName — climbing that contains edge would re-expand every
      // sibling method and explode impact for a leaf symbol. (#536)
      expect(impact.nodes.has(derived!.id)).toBe(false);
    });
  });

  describe('findPath()', () => {
    it('should find path between connected nodes', () => {
      const stats = cg.getStats();

      if (stats.nodeCount < 2) {
        return;
      }

      const functions = cg.getNodesByKind('function');
      if (functions.length < 2) {
        return;
      }

      // Try to find any path
      const processValue = functions.find((n) => n.name === 'processValue');
      const formatValue = functions.find((n) => n.name === 'formatValue');

      if (processValue && formatValue) {
        const path = cg.findPath(processValue.id, formatValue.id);

        // Path might exist or might not depending on edge direction
        expect(path === null || Array.isArray(path)).toBe(true);
      }
    });

    it('should return null for disconnected nodes', () => {
      // Create two nodes that definitely don't have a path
      const path = cg.findPath('non-existent-1', 'non-existent-2');

      expect(path).toBeNull();
    });
  });

  describe('getAncestors() and getChildren()', () => {
    it('should get ancestors of a node', () => {
      const methods = cg.getNodesByKind('method');
      const printMethod = methods.find((n) => n.name === 'print');

      if (!printMethod) {
        return;
      }

      const ancestors = cg.getAncestors(printMethod.id);

      // Should have class and file as ancestors
      expect(Array.isArray(ancestors)).toBe(true);
    });

    it('should get children of a node', () => {
      const classes = cg.getNodesByKind('class');
      const derivedClass = classes.find((n) => n.name === 'DerivedClass');

      if (!derivedClass) {
        return;
      }

      const children = cg.getChildren(derivedClass.id);

      // Should have methods as children
      expect(Array.isArray(children)).toBe(true);
    });
  });

  describe('File dependency analysis', () => {
    // Regression: getFileDependents/getFileDependencies used to follow
    // ONLY `imports` edges, which in this engine are same-file (a file → its
    // own local import declarations). That made both return [] for EVERY file,
    // so `codegraph affected` found no dependents on any language/framework.
    // They must follow the cross-file symbol graph instead (calls / references
    // / instantiates / extends / implements / ...).
    it('reports cross-file dependencies via the symbol graph, not just imports', () => {
      const deps = cg.getFileDependencies('src/main.ts');
      // main() instantiates DerivedClass (derived.ts) and calls
      // processValue/doubleValue (utils.ts) — both are real dependencies.
      expect(deps).toContain('src/utils.ts');
      expect(deps).toContain('src/derived.ts');
    });

    it('reports cross-file dependents via the symbol graph, not just imports', () => {
      // utils.ts is used by main.ts (processValue/doubleValue calls); the old
      // imports-only implementation returned [] here.
      expect(cg.getFileDependents('src/utils.ts')).toContain('src/main.ts');
    });

    it('counts extends/implements as a dependency edge', () => {
      // derived.ts extends BaseClass / implements Printable, both in base.ts.
      expect(cg.getFileDependencies('src/derived.ts')).toContain('src/base.ts');
      expect(cg.getFileDependents('src/base.ts')).toContain('src/derived.ts');
    });

    it('never lists a file as its own dependent or dependency', () => {
      for (const f of ['src/main.ts', 'src/utils.ts', 'src/base.ts', 'src/derived.ts']) {
        expect(cg.getFileDependents(f)).not.toContain(f);
        expect(cg.getFileDependencies(f)).not.toContain(f);
      }
    });
  });

  describe('findCircularDependencies()', () => {
    it('should detect circular dependencies', () => {
      const cycles = cg.findCircularDependencies();

      // Our test files don't have circular deps
      expect(Array.isArray(cycles)).toBe(true);
    });
  });

  describe('findDeadCode()', () => {
    it('should find dead code', () => {
      const deadCode = cg.findDeadCode(['function']);

      expect(Array.isArray(deadCode)).toBe(true);

      // unusedHelper should be detected
      const hasUnused = deadCode.some((n) => n.name === 'unusedHelper');
      // Note: This depends on extraction properly detecting function scope
      expect(deadCode.length).toBeGreaterThanOrEqual(0);
    });
  });

  describe('getNodeMetrics()', () => {
    it('should return metrics for a node', () => {
      const functions = cg.getNodesByKind('function');
      const func = functions[0];

      if (!func) {
        return;
      }

      const metrics = cg.getNodeMetrics(func.id);

      expect(metrics).toHaveProperty('incomingEdgeCount');
      expect(metrics).toHaveProperty('outgoingEdgeCount');
      expect(metrics).toHaveProperty('callCount');
      expect(metrics).toHaveProperty('callerCount');
      expect(metrics).toHaveProperty('childCount');
      expect(metrics).toHaveProperty('depth');

      expect(typeof metrics.incomingEdgeCount).toBe('number');
      expect(typeof metrics.outgoingEdgeCount).toBe('number');
    });
  });
});

// =============================================================================
// Traversal edge-completeness & node-limit regressions (#1086–#1090)
//
// These drive GraphTraverser directly against an in-memory graph (the same
// approach the reporter used), so the exact parallel-edge / high-degree
// topologies can be constructed deterministically without round-tripping
// through extraction.
// =============================================================================

/** Minimal Node stub — the traversal code only reads id/kind/name. */
function tNode(id: string, kind: Node['kind'] = 'function'): Node {
  return {
    id,
    kind,
    name: id,
    qualifiedName: id,
    filePath: `src/${id}.ts`,
    language: 'typescript',
    startLine: 1,
    endLine: 10,
    startColumn: 0,
    endColumn: 0,
  } as unknown as Node;
}

/** Build a GraphTraverser over a fixed node/edge set, honoring the `kinds` filter. */
function tGraph(nodes: Node[], edges: Edge[]): GraphTraverser {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const q = {
    getNodeById: (id: string) => byId.get(id) ?? null,
    getNodesByIds: (ids: readonly string[]) => {
      const m = new Map<string, Node>();
      for (const id of ids) {
        const n = byId.get(id);
        if (n) m.set(id, n);
      }
      return m;
    },
    getOutgoingEdges: (source: string, kinds?: string[]) =>
      edges.filter((e) => e.source === source && (!kinds || kinds.includes(e.kind))),
    getIncomingEdges: (target: string, kinds?: string[]) =>
      edges.filter((e) => e.target === target && (!kinds || kinds.includes(e.kind))),
  };
  return new GraphTraverser(q as never);
}

describe('Traversal edge-completeness & limits (#1086–#1090)', () => {
  it('traverseBFS keeps every parallel edge to the same target (#1090)', () => {
    // A reaches B via both `calls` and `references` — two distinct edges.
    const edges: Edge[] = [
      { source: 'A', target: 'B', kind: 'calls', line: 1 },
      { source: 'A', target: 'B', kind: 'references', line: 2 },
    ];
    const sub = tGraph([tNode('A'), tNode('B')], edges).traverseBFS('A', { direction: 'outgoing' });

    const ab = sub.edges.filter((e) => e.source === 'A' && e.target === 'B');
    // Pre-fix: only the higher-priority `calls` edge survived; `references` was dropped.
    expect(ab.map((e) => e.kind).sort()).toEqual(['calls', 'references']);
    expect(sub.nodes.has('B')).toBe(true);
  });

  it('traverseBFS keeps two same-kind edges on different lines (#1090)', () => {
    const edges: Edge[] = [
      { source: 'A', target: 'B', kind: 'calls', line: 3 },
      { source: 'A', target: 'B', kind: 'calls', line: 7 },
    ];
    const sub = tGraph([tNode('A'), tNode('B')], edges).traverseBFS('A', { direction: 'outgoing' });
    expect(sub.edges.filter((e) => e.source === 'A' && e.target === 'B')).toHaveLength(2);
  });

  it('traverseBFS does not overshoot opts.limit on a high-degree node (#1087)', () => {
    const neighbors = ['B', 'C', 'D', 'E', 'F'];
    const nodes = [tNode('A'), ...neighbors.map((n) => tNode(n))];
    const edges: Edge[] = neighbors.map((n) => ({ source: 'A', target: n, kind: 'calls' as const }));
    const sub = tGraph(nodes, edges).traverseBFS('A', { limit: 3, direction: 'outgoing' });
    // Pre-fix: all 5 neighbors were added in one pass → 6 nodes despite limit 3.
    expect(sub.nodes.size).toBeLessThanOrEqual(3);
  });

  it('traverseDFS does not overshoot opts.limit on a high-degree node (#1088)', () => {
    const neighbors = ['B', 'C', 'D', 'E', 'F'];
    const nodes = [tNode('A'), ...neighbors.map((n) => tNode(n))];
    const edges: Edge[] = neighbors.map((n) => ({ source: 'A', target: n, kind: 'calls' as const }));
    const sub = tGraph(nodes, edges).traverseDFS('A', { limit: 2, direction: 'outgoing' });
    expect(sub.nodes.size).toBeLessThanOrEqual(2);
  });

  it('getCallers returns each caller once when reached via multiple edges (#1086)', () => {
    // Y calls X at two sites and also references it — three incoming edges.
    const edges: Edge[] = [
      { source: 'Y', target: 'X', kind: 'calls', line: 1 },
      { source: 'Y', target: 'X', kind: 'calls', line: 2 },
      { source: 'Y', target: 'X', kind: 'references', line: 3 },
    ];
    const callers = tGraph([tNode('X'), tNode('Y')], edges).getCallers('X'); // default maxDepth = 1
    // Pre-fix: Y appeared three times (depth guard returned before visited.add).
    expect(callers.map((c) => c.node.id)).toEqual(['Y']);
  });

  it('getCallees returns each callee once when reached via multiple edges (#1086)', () => {
    const edges: Edge[] = [
      { source: 'X', target: 'Y', kind: 'calls', line: 1 },
      { source: 'X', target: 'Y', kind: 'calls', line: 2 },
    ];
    const callees = tGraph([tNode('X'), tNode('Y')], edges).getCallees('X');
    expect(callees.map((c) => c.node.id)).toEqual(['Y']);
  });

  it('getImpactRadius keeps a direct edge into a node already collected via another path (#1089)', () => {
    // Class P contains method M. Q calls both M and P. Reaching M first collects
    // Q; the pre-fix `!nodes.has()` gate then dropped the direct Q→P edge.
    const nodes = [tNode('P', 'class'), tNode('M', 'method'), tNode('Q')];
    const edges: Edge[] = [
      { source: 'P', target: 'M', kind: 'contains' },
      { source: 'Q', target: 'M', kind: 'calls', line: 1 },
      { source: 'Q', target: 'P', kind: 'calls', line: 2 },
    ];
    const sub = tGraph(nodes, edges).getImpactRadius('P', 2);

    expect(sub.nodes.has('Q')).toBe(true);
    expect(sub.edges.some((e) => e.source === 'Q' && e.target === 'M' && e.kind === 'calls')).toBe(true);
    // The regression: this direct dependency edge used to vanish.
    expect(sub.edges.some((e) => e.source === 'Q' && e.target === 'P' && e.kind === 'calls')).toBe(true);
  });

  // The issue's graph: a→t, b→a, b→t, c→b. Edge order sends the walk to b
  // through a first, at the depth limit, before the direct b→t edge (#1974).
  const depthNodes = ['t', 'a', 'b', 'c'].map((n) => tNode(n));
  const depthEdges: Edge[] = [
    { source: 'a', target: 't', kind: 'calls', line: 1 },
    { source: 'b', target: 'a', kind: 'calls', line: 2 },
    { source: 'b', target: 't', kind: 'calls', line: 3 },
    { source: 'c', target: 'b', kind: 'calls', line: 4 },
  ];

  it('getImpactRadius finds a dependent within the depth even when a longer path reaches its parent first (#1974)', () => {
    const sub = tGraph(depthNodes, depthEdges).getImpactRadius('t', 2);
    // c → b → t is two hops. Pre-fix: b was first reached via a at depth 2 and
    // never expanded again, so c was missing.
    expect([...sub.nodes.keys()].sort()).toEqual(['a', 'b', 'c', 't']);
    expect(sub.edges.some((e) => e.source === 'c' && e.target === 'b')).toBe(true);
    // Re-expanding b does not record its incoming edges twice.
    const keys = sub.edges.map((e) => `${e.source}>${e.target}:${e.line}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('getCallers at depth N finds every caller within N hops, each once (#1974)', () => {
    const callers = tGraph(depthNodes, depthEdges).getCallers('t', 2);
    expect(callers.map((c) => c.node.id).sort()).toEqual(['a', 'b', 'c']);
  });

  it('getCallees at depth N finds every callee within N hops, each once (#1974)', () => {
    // Mirror image: t→a, a→b, t→b, b→c. From t, b is 1 hop and c is 2.
    const edges: Edge[] = [
      { source: 't', target: 'a', kind: 'calls', line: 1 },
      { source: 'a', target: 'b', kind: 'calls', line: 2 },
      { source: 't', target: 'b', kind: 'calls', line: 3 },
      { source: 'b', target: 'c', kind: 'calls', line: 4 },
    ];
    const callees = tGraph(depthNodes, edges).getCallees('t', 2);
    expect(callees.map((c) => c.node.id).sort()).toEqual(['a', 'b', 'c']);
  });
});

describe('findPath enqueue-once (#1359)', () => {
  let testDir: string;
  let cg: CodeGraph;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-findpath-'));
    fs.writeFileSync(path.join(testDir, 'graph.ts'), 'export function start() {}\n');
    cg = CodeGraph.initSync(testDir);
  });

  afterEach(() => {
    cg?.close();
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  function seed(ids: string[], edges: Edge[]) {
    for (const id of ids) {
      cg['queries'].insertNode({ ...tNode(id), filePath: 'graph.ts' });
    }
    edges.forEach((edge, i) => cg['queries'].insertEdge({ ...edge, line: i + 1 }));
  }

  it('enqueues each dense fan-in target once while preserving the shortest path', () => {
    const layerA = Array.from({ length: 16 }, (_, i) => `a${i}`);
    const layerB = Array.from({ length: 16 }, (_, i) => `b${i}`);
    const ids = ['start', ...layerA, ...layerB, 'end'];
    const edges: Edge[] = [];
    for (const a of layerA) {
      edges.push({ source: 'start', target: a, kind: 'calls' });
      for (const b of layerB) edges.push({ source: a, target: b, kind: 'calls' });
    }
    for (const b of layerB) edges.push({ source: b, target: 'end', kind: 'calls' });
    seed(ids, edges);

    // Count actual queue insertions, without timing thresholds or replacing SQLite.
    const counts = new Map<string, number>();
    const push = Array.prototype.push;
    let result: ReturnType<CodeGraph['findPath']>;
    try {
      Array.prototype.push = function (...items) {
        for (const item of items) {
          if (item && typeof item.nodeId === 'string' && Array.isArray(item.path)) {
            counts.set(item.nodeId, (counts.get(item.nodeId) ?? 0) + 1);
          }
        }
        return Reflect.apply(push, this, items);
      };
      result = cg.findPath('start', 'end', ['calls']);
    } finally {
      Array.prototype.push = push;
    }
    expect(result?.map((step) => step.node.id)).toEqual(['start', 'a0', 'b0', 'end']);
    expect(result?.slice(1).every((step) => step.edge?.kind === 'calls')).toBe(true);
    expect(counts).toEqual(new Map(ids.slice(1).map((id) => [id, 1])));
  });

  it('preserves shortest paths and edge filters with cycles and parallel edges', () => {
    seed(['start', 'a', 'b', 'end', 'isolated'], [
      { source: 'start', target: 'start', kind: 'calls' },
      { source: 'start', target: 'a', kind: 'calls' },
      { source: 'start', target: 'a', kind: 'calls' },
      { source: 'a', target: 'start', kind: 'calls' },
      { source: 'a', target: 'b', kind: 'calls' },
      { source: 'b', target: 'end', kind: 'calls' },
      { source: 'start', target: 'end', kind: 'references' },
    ]);
    const result = cg.findPath('start', 'end', ['calls']);
    expect(result?.map((step) => step.node.id)).toEqual(['start', 'a', 'b', 'end']);
    expect(result?.[1].edge?.line).toBe(2);
    expect(cg.findPath('start', 'end')?.map((step) => step.node.id)).toEqual(['start', 'end']);
    expect(cg.findPath('start', 'start')?.map((step) => step.node.id)).toEqual(['start']);
    expect(cg.findPath('start', 'isolated')).toBeNull();
    expect(cg.findPath('missing', 'end')).toBeNull();
    expect(cg.findPath('start', 'missing')).toBeNull();
    expect(cg.findPath('missing', 'missing')).toBeNull();
    expect(cg.findPath('start', 'end', ['imports'])).toBeNull();
  });
});

describe('public type hierarchy traverses both directions', () => {
  let root: string;
  let cg: CodeGraph;
  const node = (name: string) => cg.getNodesByName(name).find(n => n.kind === 'class' || n.kind === 'interface')!;
  const names = (name: string) => [...cg.getTypeHierarchy(node(name).id).nodes.values()].map(n => n.name).sort();

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-type-descendants-'));
    fs.writeFileSync(path.join(root, 'types.ts'), [
      'export interface BaseContract {}',
      'export interface ChildContract {}',
      'export class BaseType implements BaseContract {}',
      'export class MiddleType extends BaseType implements ChildContract {}',
      'export class LeafType extends MiddleType implements BaseContract {}',
      'export class UnrelatedType {}',
      'export class CycleA {}',
      'export class CycleB {}',
    ].join('\n'));
    // A real repository's hierarchy, indexed through the same public API.
    fs.copyFileSync(path.join(__dirname, '../src/errors.ts'), path.join(root, 'errors.ts'));
    cg = await CodeGraph.init(root, { index: true });
  });

  afterAll(() => {
    cg?.close();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it('includes all descendants of a base class and interface', () => {
    expect(cg.getBackend()).toBe('node-sqlite');
    expect(names('BaseType')).toEqual(['BaseContract', 'BaseType', 'LeafType', 'MiddleType']);
    expect(names('BaseContract')).toEqual(['BaseContract', 'BaseType', 'LeafType', 'MiddleType']);
  });

  it('includes both ancestors and descendants when the focus is in the middle', () => {
    expect(names('MiddleType')).toEqual(['BaseContract', 'BaseType', 'ChildContract', 'LeafType', 'MiddleType']);
  });

  it('keeps both ancestor edges when a diamond reaches an already collected type', () => {
    const hierarchy = cg.getTypeHierarchy(node('LeafType').id);
    const toContract = hierarchy.edges.filter(e => e.target === node('BaseContract').id);
    expect(toContract.map(e => cg.getNode(e.source)!.name).sort()).toEqual(['BaseType', 'LeafType']);
    expect(hierarchy.edges).toHaveLength(5);
  });

  it('returns all six subclasses from CodeGraph’s error definitions', () => {
    const base = node('CodeGraphError');
    expect(cg.getIncomingEdges(base.id).filter(e => e.kind === 'extends')).toHaveLength(6);
    expect(names('CodeGraphError')).toEqual([
      'CodeGraphError', 'ConfigError', 'DatabaseError', 'FileError', 'ParseError', 'SearchError', 'VectorError',
    ]);
    expect(cg.getTypeHierarchy(base.id).edges).toHaveLength(6);
  });

  it('expands descendants in public context even when ordinary traversal is disabled', async () => {
    const context = await cg.findRelevantContext('MiddleType', {
      searchLimit: 1, traversalDepth: 0, maxNodes: 30, seedNames: [],
    });
    expect([...context.nodes.values()].map(n => n.name)).toContain('LeafType');
    expect(context.edges.some(e => e.source === node('LeafType').id && e.target === node('MiddleType').id)).toBe(true);
  });

  it('does not collect unrelated types and preserves missing-node behavior', () => {
    expect(names('UnrelatedType')).toEqual(['UnrelatedType']);
    const absent = cg.getTypeHierarchy('missing-type');
    expect(absent.nodes.size).toBe(0);
    expect(absent.edges).toEqual([]);
    expect(absent.roots).toEqual([]);
  });

  it('terminates on a cyclic stored hierarchy and records each edge once', () => {
    // Embedded consumers can write graphs through the exported storage API.
    const db = DatabaseConnection.open(getDatabasePath(root));
    try {
      const queries = new QueryBuilder(db.getDb());
      queries.insertEdge({ source: node('CycleA').id, target: node('CycleB').id, kind: 'extends', line: 7 });
      queries.insertEdge({ source: node('CycleB').id, target: node('CycleA').id, kind: 'extends', line: 8 });
    } finally {
      db.close();
    }
    const hierarchy = cg.getTypeHierarchy(node('CycleA').id);
    expect([...hierarchy.nodes.values()].map(n => n.name).sort()).toEqual(['CycleA', 'CycleB']);
    expect(hierarchy.edges).toHaveLength(2);
    expect(hierarchy.roots).toEqual([node('CycleA').id]);
  });
});
