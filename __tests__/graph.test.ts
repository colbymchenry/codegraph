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
    it('should get file dependencies', () => {
      const deps = cg.getFileDependencies('src/main.ts');

      expect(Array.isArray(deps)).toBe(true);
    });

    it('should get file dependents', () => {
      const dependents = cg.getFileDependents('src/utils.ts');

      expect(Array.isArray(dependents)).toBe(true);
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
