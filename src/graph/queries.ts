/**
 * Graph Query Functions
 *
 * Higher-level query functions built on top of traversal algorithms.
 */

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
    const incomingRefs: Array<{ node: Node; edge: Edge }> = [];
    for (const edge of incomingEdges) {
      // Skip containment edges (already in ancestors)
      if (edge.kind === 'contains') {
        continue;
      }
      const node = this.queries.getNodeById(edge.source);
      if (node) {
        incomingRefs.push({ node, edge });
      }
    }

    // Get outgoing references (things this node references)
    const outgoingEdges = this.queries.getOutgoingEdges(nodeId);
    const outgoingRefs: Array<{ node: Node; edge: Edge }> = [];
    for (const edge of outgoingEdges) {
      // Skip containment edges (already in children)
      if (edge.kind === 'contains') {
        continue;
      }
      const node = this.queries.getNodeById(edge.target);
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
    // Follow the symbol-level cross-file edge graph, not just `imports`:
    // an `imports` edge here points from a file to its own local import
    // declarations (same-file), so the actual cross-file dependencies live in
    // the resolved calls/references/instantiates/extends/... edges.
    return this.queries.getDependencyFilePaths(filePath);
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
    // Previously this only followed `imports` edges into the file node or its
    // exported symbols and returned 0 dependents for *every* file — because an
    // `imports` edge here connects a file to its own local import declarations
    // (always same-file), never to the providing file. The real cross-file
    // dependency signal is the resolved symbol graph (calls/references/
    // instantiates/extends/implements/...), which is what blast-radius /
    // `affected` need. Delegate to the indexed projection of that graph.
    return this.queries.getDependentFilePaths(filePath);
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
    // Convert glob pattern to regex
    const regexPattern = pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*')
      .replace(/\?/g, '.');

    const regex = new RegExp(`^${regexPattern}$`);

    // This is inefficient for large graphs - would need FTS index on qualified_name
    // For now, use kind-based filtering if possible
    const allNodes: Node[] = [];
    const kinds: Node['kind'][] = [
      'class',
      'function',
      'method',
      'interface',
      'type_alias',
      'variable',
      'constant',
    ];

    for (const kind of kinds) {
      const nodes = this.queries.getNodesByKind(kind);
      for (const node of nodes) {
        if (regex.test(node.qualifiedName)) {
          allNodes.push(node);
        }
      }
    }

    return allNodes;
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

    const dfs = (filePath: string, path: string[]): void => {
      if (recursionStack.has(filePath)) {
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

      const dependencies = this.getFileDependencies(filePath);
      for (const dep of dependencies) {
        dfs(dep, [...path, filePath]);
      }

      recursionStack.delete(filePath);
    };

    for (const file of files) {
      if (!visited.has(file.path)) {
        dfs(file.path, []);
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
