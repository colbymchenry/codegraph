/**
 * Graph Query Functions
 *
 * Higher-level query functions built on top of traversal algorithms.
 */

import picomatch from 'picomatch';
import { Node, Edge, Context, Subgraph, EdgeKind } from '../types';
import { QueryBuilder } from '../db/queries';
import { GraphTraverser } from './traversal';

/**
 * Graph query manager for complex queries
 */
export class GraphQueryManager {
  private queries: QueryBuilder;
  private traverser: GraphTraverser;

  constructor(queries: QueryBuilder) {
    this.queries = queries;
    this.traverser = new GraphTraverser(queries);
  }

  /**
   * Get full context for a node
   *
   * Returns the focal node along with its ancestors, children,
   * and both incoming and outgoing references.
   *
   * @param nodeId - ID of the focal node
   * @returns Context object with all related information
   */
  getContext(nodeId: string): Context {
    const focal = this.queries.getNodeById(nodeId);

    if (!focal) {
      throw new Error(`Node not found: ${nodeId}`);
    }

    // Get ancestors (containment hierarchy)
    const ancestors = this.traverser.getAncestors(nodeId);

    // Get children
    const children = this.traverser.getChildren(nodeId);

    // Get incoming references (things that reference this node)
    const incomingEdges = this.queries.getIncomingEdges(nodeId);
    const nonContainsIncoming = incomingEdges.filter(e => e.kind !== 'contains');
    const incomingNodeMap = this.queries.getNodesByIds(nonContainsIncoming.map(e => e.source));
    const incomingRefs: Array<{ node: Node; edge: Edge }> = [];
    for (const edge of nonContainsIncoming) {
      const node = incomingNodeMap.get(edge.source);
      if (node) {
        incomingRefs.push({ node, edge });
      }
    }

    // Get outgoing references (things this node references)
    const outgoingEdges = this.queries.getOutgoingEdges(nodeId);
    const nonContainsOutgoing = outgoingEdges.filter(e => e.kind !== 'contains');
    const outgoingNodeMap = this.queries.getNodesByIds(nonContainsOutgoing.map(e => e.target));
    const outgoingRefs: Array<{ node: Node; edge: Edge }> = [];
    for (const edge of nonContainsOutgoing) {
      const node = outgoingNodeMap.get(edge.target);
      if (node) {
        outgoingRefs.push({ node, edge });
      }
    }

    // Get type information (type_of, returns edges)
    const types: Node[] = [];
    const typeEdgeKinds: EdgeKind[] = ['type_of', 'returns'];
    for (const kind of typeEdgeKinds) {
      const typeEdges = this.queries.getOutgoingEdges(nodeId, [kind]);
      for (const edge of typeEdges) {
        const typeNode = this.queries.getNodeById(edge.target);
        if (typeNode && !types.some((t) => t.id === typeNode.id)) {
          types.push(typeNode);
        }
      }
    }

    // Get relevant imports
    const imports: Node[] = [];
    const fileNode = ancestors.find((a) => a.kind === 'file');
    if (fileNode) {
      const importEdges = this.queries.getOutgoingEdges(fileNode.id, ['imports']);
      for (const edge of importEdges) {
        const importNode = this.queries.getNodeById(edge.target);
        if (importNode) {
          imports.push(importNode);
        }
      }
    }

    return {
      focal,
      ancestors,
      children,
      incomingRefs,
      outgoingRefs,
      types,
      imports,
    };
  }

  /**
   * Get dependencies of a file
   *
   * Returns all files that this file imports from.
   *
   * @param filePath - Path to the file
   * @returns Array of file paths this file depends on
   */
  getFileDependencies(filePath: string): string[] {
    const nodes = this.queries.getNodesByFile(filePath);
    const fileNode = nodes.find((n) => n.kind === 'file');

    if (!fileNode) {
      return [];
    }

    const dependencies = new Set<string>();
    const importEdges = this.queries.getOutgoingEdges(fileNode.id, ['imports']);
    const targetNodeMap = this.queries.getNodesByIds(importEdges.map(e => e.target));

    for (const edge of importEdges) {
      const targetNode = targetNodeMap.get(edge.target);
      if (targetNode && targetNode.filePath !== filePath) {
        dependencies.add(targetNode.filePath);
      }
    }

    return Array.from(dependencies);
  }

  /**
   * Get dependents of a file
   *
   * Returns all files that import from this file.
   *
   * @param filePath - Path to the file
   * @returns Array of file paths that depend on this file
   */
  getFileDependents(filePath: string): string[] {
    const nodes = this.queries.getNodesByFile(filePath);
    const dependents = new Set<string>();

    // Collect all incoming import edges for exported symbols
    const allSourceIds: string[] = [];
    const edgesBySource = new Map<string, Edge[]>();
    for (const node of nodes) {
      if (node.isExported) {
        const incomingEdges = this.queries.getIncomingEdges(node.id, ['imports']);
        for (const edge of incomingEdges) {
          allSourceIds.push(edge.source);
          if (!edgesBySource.has(edge.source)) edgesBySource.set(edge.source, []);
          edgesBySource.get(edge.source)!.push(edge);
        }
      }
    }
    const sourceNodeMap = this.queries.getNodesByIds(allSourceIds);
    for (const [sourceId] of edgesBySource) {
      const sourceNode = sourceNodeMap.get(sourceId);
      if (sourceNode && sourceNode.filePath !== filePath) {
        dependents.add(sourceNode.filePath);
      }
    }

    return Array.from(dependents);
  }

  /**
   * Get all symbols exported by a file
   *
   * @param filePath - Path to the file
   * @returns Array of exported nodes
   */
  getExportedSymbols(filePath: string): Node[] {
    const nodes = this.queries.getNodesByFile(filePath);
    return nodes.filter((n) => n.isExported);
  }

  /**
   * Find symbols by qualified name pattern
   *
   * @param pattern - Pattern to match (supports * wildcard)
   * @returns Array of matching nodes
   */
  findByQualifiedName(pattern: string): Node[] {
    // Use picomatch for safe glob matching (no ReDoS risk)
    const isMatch = picomatch(pattern, { dot: true });

    const kinds: Node['kind'][] = [
      'class',
      'function',
      'method',
      'interface',
      'type_alias',
      'variable',
      'constant',
    ];

    // Batch-fetch all nodes of relevant kinds
    const allKindNodes = this.queries.getNodesByKinds(kinds);
    return allKindNodes.filter(node => isMatch(node.qualifiedName));
  }

  /**
   * Get the module/package structure
   *
   * Returns a tree structure of files organized by directory.
   *
   * @returns Map of directory paths to contained files
   */
  getModuleStructure(): Map<string, string[]> {
    const files = this.queries.getAllFiles();
    const structure = new Map<string, string[]>();

    for (const file of files) {
      const parts = file.path.split('/');
      const dir = parts.slice(0, -1).join('/') || '.';

      if (!structure.has(dir)) {
        structure.set(dir, []);
      }
      structure.get(dir)!.push(file.path);
    }

    return structure;
  }

  /**
   * Find circular dependencies in the graph
   *
   * @returns Array of cycles, each cycle is an array of node IDs
   */
  findCircularDependencies(): string[][] {
    const files = this.queries.getAllFiles();
    const cycles: string[][] = [];
    const visited = new Set<string>();
    const recursionStack = new Set<string>();
    const depsCache = new Map<string, string[]>();

    const getDeps = (filePath: string): string[] => {
      let deps = depsCache.get(filePath);
      if (deps === undefined) {
        deps = this.getFileDependencies(filePath);
        depsCache.set(filePath, deps);
      }
      return deps;
    };

    const dfs = (filePath: string, path: string[], pathSet: Set<string>): void => {
      if (pathSet.has(filePath)) {
        // Found a cycle
        const cycleStart = path.indexOf(filePath);
        if (cycleStart !== -1) {
          cycles.push(path.slice(cycleStart));
        }
        return;
      }

      if (visited.has(filePath)) {
        return;
      }

      visited.add(filePath);
      recursionStack.add(filePath);
      path.push(filePath);
      pathSet.add(filePath);

      const dependencies = getDeps(filePath);
      for (const dep of dependencies) {
        dfs(dep, path, pathSet);
      }

      path.pop();
      pathSet.delete(filePath);
      recursionStack.delete(filePath);
    };

    for (const file of files) {
      if (!visited.has(file.path)) {
        dfs(file.path, [], new Set());
      }
    }

    return cycles;
  }

  /**
   * Get complexity metrics for a node
   *
   * @param nodeId - ID of the node
   * @returns Object containing various complexity metrics
   */
  getNodeMetrics(nodeId: string): {
    incomingEdgeCount: number;
    outgoingEdgeCount: number;
    callCount: number;
    callerCount: number;
    childCount: number;
    depth: number;
  } {
    const incomingEdges = this.queries.getIncomingEdges(nodeId);
    const outgoingEdges = this.queries.getOutgoingEdges(nodeId);

    const callEdges = outgoingEdges.filter((e) => e.kind === 'calls');
    const callerEdges = incomingEdges.filter((e) => e.kind === 'calls');
    const containsEdges = outgoingEdges.filter((e) => e.kind === 'contains');

    const ancestors = this.traverser.getAncestors(nodeId);

    return {
      incomingEdgeCount: incomingEdges.length,
      outgoingEdgeCount: outgoingEdges.length,
      callCount: callEdges.length,
      callerCount: callerEdges.length,
      childCount: containsEdges.length,
      depth: ancestors.length,
    };
  }

  /**
   * Find dead code (nodes with no incoming references)
   *
   * @param kinds - Node kinds to check (default: functions, methods, classes)
   * @returns Array of unreferenced nodes
   */
  findDeadCode(kinds?: Node['kind'][]): Node[] {
    const targetKinds = kinds || ['function', 'method', 'class'];
    const deadCode: Node[] = [];

    for (const kind of targetKinds) {
      const nodes = this.queries.getNodesByKind(kind);
      for (const node of nodes) {
        // Skip exported symbols (they may be used externally)
        if (node.isExported) {
          continue;
        }

        const incomingEdges = this.queries.getIncomingEdges(node.id);

        // Filter out containment edges
        const references = incomingEdges.filter((e) => e.kind !== 'contains');

        if (references.length === 0) {
          deadCode.push(node);
        }
      }
    }

    return deadCode;
  }

  /**
   * Get subgraph containing nodes matching a filter
   *
   * @param filter - Filter function to select nodes
   * @param includeEdges - Whether to include edges between matching nodes
   * @returns Subgraph containing matching nodes
   */
  getFilteredSubgraph(
    filter: (node: Node) => boolean,
    includeEdges: boolean = true
  ): Subgraph {
    const nodes = new Map<string, Node>();
    const edges: Edge[] = [];

    // Get all nodes of common kinds
    const kinds: Node['kind'][] = [
      'file',
      'module',
      'class',
      'struct',
      'interface',
      'trait',
      'function',
      'method',
      'variable',
      'constant',
      'enum',
      'type_alias',
    ];

    for (const kind of kinds) {
      const kindNodes = this.queries.getNodesByKind(kind);
      for (const node of kindNodes) {
        if (filter(node)) {
          nodes.set(node.id, node);
        }
      }
    }

    // Include edges between matching nodes
    if (includeEdges) {
      for (const nodeId of nodes.keys()) {
        const outgoing = this.queries.getOutgoingEdges(nodeId);
        for (const edge of outgoing) {
          if (nodes.has(edge.target)) {
            edges.push(edge);
          }
        }
      }
    }

    return {
      nodes,
      edges,
      roots: [],
    };
  }

  /**
   * Access the underlying traverser for direct traversal operations
   */
  getTraverser(): GraphTraverser {
    return this.traverser;
  }
}
