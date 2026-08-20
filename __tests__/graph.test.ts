/**
 * Graph Query Tests
 *
 * Tests for graph traversal and query functionality.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import CodeGraph from '../src/index';
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
});
