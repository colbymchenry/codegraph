/**
 * Graph Traversal Algorithms
 *
 * BFS and DFS traversal for the code knowledge graph.
 */

import { Node, Edge, Subgraph, TraversalOptions, EdgeKind } from '../types';
import { QueryBuilder } from '../db/queries';

/**
 * Default traversal options
 */
const DEFAULT_OPTIONS: Required<TraversalOptions> = {
  maxDepth: Infinity,
  edgeKinds: [],
  nodeKinds: [],
  direction: 'outgoing',
  limit: 1000,
  includeStart: true,
};

/**
 * Result of a single traversal step
 */
interface TraversalStep {
  node: Node;
  edge: Edge | null;
  depth: number;
}

/**
 * Graph traverser for BFS and DFS traversal
 */
export class GraphTraverser {
  private queries: QueryBuilder;

  constructor(queries: QueryBuilder) {
    this.queries = queries;
  }

  /**
   * Traverse the graph using breadth-first search
   *
   * @param startId - Starting node ID
   * @param options - Traversal options
   * @returns Subgraph containing traversed nodes and edges
   */
  traverseBFS(startId: string, options: TraversalOptions = {}): Subgraph {
    const opts = { ...DEFAULT_OPTIONS, ...options };
    const startNode = this.queries.getNodeById(startId);

    if (!startNode) {
      return { nodes: new Map(), edges: [], roots: [] };
    }

    const nodes = new Map<string, Node>();
    const edges: Edge[] = [];
    const visited = new Set<string>();
    const queue: TraversalStep[] = [{ node: startNode, edge: null, depth: 0 }];

    if (opts.includeStart) {
      nodes.set(startNode.id, startNode);
    }

    while (queue.length > 0 && nodes.size < opts.limit) {
      const step = queue.shift()!;
      const { node, edge, depth } = step;

      if (visited.has(node.id)) {
        continue;
      }
      visited.add(node.id);

      // Add edge to result
      if (edge) {
        edges.push(edge);
      }

      // Check depth limit
      if (depth >= opts.maxDepth) {
        continue;
      }

      // Get adjacent edges, prioritizing structural edges (contains, calls)
      // over reference edges so BFS discovers internal structure before
      // fanning out to external references (e.g., component usages in templates).
      const adjacentEdges = this.getAdjacentEdges(node.id, opts.direction, opts.edgeKinds);
      adjacentEdges.sort((a, b) => {
        const priority = (e: Edge) => e.kind === 'contains' ? 0 : e.kind === 'calls' ? 1 : 2;
        return priority(a) - priority(b);
      });

      for (const adjEdge of adjacentEdges) {
        // Determine next node: for 'both' direction, edges can be either
        // incoming or outgoing, so pick whichever end is not the current node
        const nextNodeId = adjEdge.source === node.id ? adjEdge.target : adjEdge.source;

        if (visited.has(nextNodeId)) {
          continue;
        }

        const nextNode = this.queries.getNodeById(nextNodeId);
        if (!nextNode) {
          continue;
        }

        // Apply node kind filter
        if (opts.nodeKinds && opts.nodeKinds.length > 0 && !opts.nodeKinds.includes(nextNode.kind)) {
          continue;
        }

        // Add node to result
        nodes.set(nextNode.id, nextNode);

        // Queue for further traversal
        queue.push({ node: nextNode, edge: adjEdge, depth: depth + 1 });
      }
    }

    return {
      nodes,
      edges,
      roots: [startId],
    };
  }

  /**
   * Traverse the graph using depth-first search
   *
   * @param startId - Starting node ID
   * @param options - Traversal options
   * @returns Subgraph containing traversed nodes and edges
   */
  traverseDFS(startId: string, options: TraversalOptions = {}): Subgraph {
    const opts = { ...DEFAULT_OPTIONS, ...options };
    const startNode = this.queries.getNodeById(startId);

    if (!startNode) {
      return { nodes: new Map(), edges: [], roots: [] };
    }

    const nodes = new Map<string, Node>();
    const edges: Edge[] = [];
    const visited = new Set<string>();

    if (opts.includeStart) {
      nodes.set(startNode.id, startNode);
    }

    this.dfsRecursive(startNode, 0, opts, nodes, edges, visited);

    return {
      nodes,
      edges,
      roots: [startId],
    };
  }

  /**
   * Recursive DFS helper
   */
  private dfsRecursive(
    node: Node,
    depth: number,
    opts: Required<TraversalOptions>,
    nodes: Map<string, Node>,
    edges: Edge[],
    visited: Set<string>
  ): void {
    if (visited.has(node.id) || nodes.size >= opts.limit || depth >= opts.maxDepth) {
      return;
    }

    visited.add(node.id);

    // Get adjacent edges
    const adjacentEdges = this.getAdjacentEdges(node.id, opts.direction, opts.edgeKinds);

    for (const edge of adjacentEdges) {
      // Determine next node: for 'both' direction, edges can be either
      // incoming or outgoing, so pick whichever end is not the current node
      const nextNodeId = edge.source === node.id ? edge.target : edge.source;

      if (visited.has(nextNodeId)) {
        continue;
      }

      const nextNode = this.queries.getNodeById(nextNodeId);
      if (!nextNode) {
        continue;
      }

      // Apply node kind filter
      if (opts.nodeKinds && opts.nodeKinds.length > 0 && !opts.nodeKinds.includes(nextNode.kind)) {
        continue;
      }

      // Add node and edge to result
      nodes.set(nextNode.id, nextNode);
      edges.push(edge);

      // Recurse
      this.dfsRecursive(nextNode, depth + 1, opts, nodes, edges, visited);
    }
  }

  /**
   * Get adjacent edges based on direction
   */
  private getAdjacentEdges(
    nodeId: string,
    direction: 'outgoing' | 'incoming' | 'both',
    edgeKinds?: EdgeKind[]
  ): Edge[] {
    const kinds = edgeKinds && edgeKinds.length > 0 ? edgeKinds : undefined;

    if (direction === 'outgoing') {
      return this.queries.getOutgoingEdges(nodeId, kinds);
    } else if (direction === 'incoming') {
      return this.queries.getIncomingEdges(nodeId, kinds);
    } else {
      // Both directions
      const outgoing = this.queries.getOutgoingEdges(nodeId, kinds);
      const incoming = this.queries.getIncomingEdges(nodeId, kinds);
      return [...outgoing, ...incoming];
    }
  }

  /**
   * Find all callers of a function/method
   *
   * @param nodeId - ID of the function/method node
   * @param maxDepth - Maximum depth to traverse (default: 1)
   * @returns Array of nodes that call this function
   */
  getCallers(nodeId: string, maxDepth: number = 1): Array<{ node: Node; edge: Edge }> {
    const result: Array<{ node: Node; edge: Edge }> = [];
    const visited = new Set<string>();

    this.getCallersRecursive(nodeId, maxDepth, 0, result, visited);

    return result;
  }

  private getCallersRecursive(
    nodeId: string,
    maxDepth: number,
    currentDepth: number,
    result: Array<{ node: Node; edge: Edge }>,
    visited: Set<string>
  ): void {
    if (currentDepth >= maxDepth || visited.has(nodeId)) {
      return;
    }
    visited.add(nodeId);

    const incomingEdges = this.queries.getIncomingEdges(nodeId, ['calls', 'references', 'imports']);

    for (const edge of incomingEdges) {
      const callerNode = this.queries.getNodeById(edge.source);
      if (callerNode && !visited.has(callerNode.id)) {
        result.push({ node: callerNode, edge });
        this.getCallersRecursive(callerNode.id, maxDepth, currentDepth + 1, result, visited);
      }
    }
  }

  /**
   * Find all functions/methods called by a function
   *
   * @param nodeId - ID of the function/method node
   * @param maxDepth - Maximum depth to traverse (default: 1)
   * @returns Array of nodes called by this function
   */
  getCallees(nodeId: string, maxDepth: number = 1): Array<{ node: Node; edge: Edge }> {
    const result: Array<{ node: Node; edge: Edge }> = [];
    const visited = new Set<string>();

    this.getCalleesRecursive(nodeId, maxDepth, 0, result, visited);

    return result;
  }

  private getCalleesRecursive(
    nodeId: string,
    maxDepth: number,
    currentDepth: number,
    result: Array<{ node: Node; edge: Edge }>,
    visited: Set<string>
  ): void {
    if (currentDepth >= maxDepth || visited.has(nodeId)) {
      return;
    }
    visited.add(nodeId);

    const outgoingEdges = this.queries.getOutgoingEdges(nodeId, ['calls', 'references', 'imports']);

    for (const edge of outgoingEdges) {
      const calleeNode = this.queries.getNodeById(edge.target);
      if (calleeNode && !visited.has(calleeNode.id)) {
        result.push({ node: calleeNode, edge });
        this.getCalleesRecursive(calleeNode.id, maxDepth, currentDepth + 1, result, visited);
      }
    }
  }

  /**
   * Get the call graph for a function (both callers and callees)
   *
   * @param nodeId - ID of the function/method node
   * @param depth - Maximum depth in each direction (default: 2)
   * @returns Subgraph containing the call graph
   */
  getCallGraph(nodeId: string, depth: number = 2): Subgraph {
    const focalNode = this.queries.getNodeById(nodeId);
    if (!focalNode) {
      return { nodes: new Map(), edges: [], roots: [] };
    }

    const nodes = new Map<string, Node>();
    const edges: Edge[] = [];

    // Add focal node
    nodes.set(focalNode.id, focalNode);

    // Get callers
    const callers = this.getCallers(nodeId, depth);
    for (const { node, edge } of callers) {
      nodes.set(node.id, node);
      edges.push(edge);
    }

    // Get callees
    const callees = this.getCallees(nodeId, depth);
    for (const { node, edge } of callees) {
      nodes.set(node.id, node);
      edges.push(edge);
    }

    return {
      nodes,
      edges,
      roots: [nodeId],
    };
  }

  /**
   * Get the type hierarchy for a class/interface
   *
   * @param nodeId - ID of the class/interface node
   * @returns Subgraph containing the type hierarchy
   */
  getTypeHierarchy(nodeId: string): Subgraph {
    const focalNode = this.queries.getNodeById(nodeId);
    if (!focalNode) {
      return { nodes: new Map(), edges: [], roots: [] };
    }

    const nodes = new Map<string, Node>();
    const edges: Edge[] = [];
    const visited = new Set<string>();

    // Add focal node
    nodes.set(focalNode.id, focalNode);

    // Get ancestors (what this extends/implements)
    this.getTypeAncestors(nodeId, nodes, edges, visited);

    // Get descendants (what extends/implements this)
    this.getTypeDescendants(nodeId, nodes, edges, visited);

    return {
      nodes,
      edges,
      roots: [nodeId],
    };
  }

  private getTypeAncestors(
    nodeId: string,
    nodes: Map<string, Node>,
    edges: Edge[],
    visited: Set<string>
  ): void {
    if (visited.has(nodeId)) {
      return;
    }
    visited.add(nodeId);

    const outgoingEdges = this.queries.getOutgoingEdges(nodeId, ['extends', 'implements']);

    for (const edge of outgoingEdges) {
      const parentNode = this.queries.getNodeById(edge.target);
      if (parentNode && !nodes.has(parentNode.id)) {
        nodes.set(parentNode.id, parentNode);
        edges.push(edge);
        this.getTypeAncestors(parentNode.id, nodes, edges, visited);
      }
    }
  }

  private getTypeDescendants(
    nodeId: string,
    nodes: Map<string, Node>,
    edges: Edge[],
    visited: Set<string>
  ): void {
    if (visited.has(nodeId)) {
      return;
    }
    visited.add(nodeId);

    const incomingEdges = this.queries.getIncomingEdges(nodeId, ['extends', 'implements']);

    for (const edge of incomingEdges) {
      const childNode = this.queries.getNodeById(edge.source);
      if (childNode && !nodes.has(childNode.id)) {
        nodes.set(childNode.id, childNode);
        edges.push(edge);
        this.getTypeDescendants(childNode.id, nodes, edges, visited);
      }
    }
  }

  /**
   * Find all usages of a symbol
   *
   * @param nodeId - ID of the symbol node
   * @returns Array of nodes and edges that reference this symbol
   */
  findUsages(nodeId: string): Array<{ node: Node; edge: Edge }> {
    const result: Array<{ node: Node; edge: Edge }> = [];

    // Get all incoming edges (references, calls, type_of, etc.)
    const incomingEdges = this.queries.getIncomingEdges(nodeId);

    for (const edge of incomingEdges) {
      const sourceNode = this.queries.getNodeById(edge.source);
      if (sourceNode) {
        result.push({ node: sourceNode, edge });
      }
    }

    return result;
  }

  /**
   * Calculate the impact radius of a node
   *
   * Returns all nodes that could be affected by changes to this node.
   *
   * @param nodeId - ID of the node
   * @param maxDepth - Maximum depth to traverse (default: 3)
   * @returns Subgraph containing potentially impacted nodes
   */
  getImpactRadius(nodeId: string, maxDepth: number = 3): Subgraph {
    const focalNode = this.queries.getNodeById(nodeId);
    if (!focalNode) {
      return { nodes: new Map(), edges: [], roots: [] };
    }

    const nodes = new Map<string, Node>();
    const edges: Edge[] = [];
    const visited = new Set<string>();

    // Add focal node
    nodes.set(focalNode.id, focalNode);

    // Traverse incoming edges to find all dependents
    this.getImpactRecursive(nodeId, maxDepth, 0, nodes, edges, visited);

    return {
      nodes,
      edges,
      roots: [nodeId],
    };
  }

  private getImpactRecursive(
    nodeId: string,
    maxDepth: number,
    currentDepth: number,
    nodes: Map<string, Node>,
    edges: Edge[],
    visited: Set<string>
  ): void {
    if (currentDepth >= maxDepth || visited.has(nodeId)) {
      return;
    }
    visited.add(nodeId);

    // For container nodes (classes, interfaces, structs, etc.), also traverse
    // into their children so that callers of contained methods appear in impact
    const focalNode = this.queries.getNodeById(nodeId);
    if (focalNode) {
      const containerKinds = new Set(['class', 'interface', 'struct', 'trait', 'protocol', 'module', 'enum']);
      if (containerKinds.has(focalNode.kind)) {
        const containsEdges = this.queries.getOutgoingEdges(nodeId, ['contains']);
        for (const edge of containsEdges) {
          const childNode = this.queries.getNodeById(edge.target);
          if (childNode && !visited.has(childNode.id)) {
            nodes.set(childNode.id, childNode);
            edges.push(edge);
            // Recurse into children at the same depth (they're part of the same symbol)
            this.getImpactRecursive(childNode.id, maxDepth, currentDepth, nodes, edges, visited);
          }
        }
      }
    }

    // Get all incoming edges (things that depend on this node)
    const incomingEdges = this.queries.getIncomingEdges(nodeId);

    for (const edge of incomingEdges) {
      const sourceNode = this.queries.getNodeById(edge.source);
      if (sourceNode && !nodes.has(sourceNode.id)) {
        nodes.set(sourceNode.id, sourceNode);
        edges.push(edge);
        this.getImpactRecursive(sourceNode.id, maxDepth, currentDepth + 1, nodes, edges, visited);
      }
    }
  }

  /**
   * Find the shortest path between two nodes
   *
   * @param fromId - Starting node ID
   * @param toId - Target node ID
   * @param edgeKinds - Edge types to consider (all if empty)
   * @returns Array of nodes and edges forming the path, or null if no path exists
   */
  findPath(
    fromId: string,
    toId: string,
    edgeKinds: EdgeKind[] = []
  ): Array<{ node: Node; edge: Edge | null }> | null {
    const fromNode = this.queries.getNodeById(fromId);
    const toNode = this.queries.getNodeById(toId);

    if (!fromNode || !toNode) {
      return null;
    }

    // BFS to find shortest path
    const visited = new Set<string>();
    const queue: Array<{ nodeId: string; path: Array<{ node: Node; edge: Edge | null }> }> = [
      { nodeId: fromId, path: [{ node: fromNode, edge: null }] },
    ];

    while (queue.length > 0) {
      const { nodeId, path } = queue.shift()!;

      if (nodeId === toId) {
        return path;
      }

      if (visited.has(nodeId)) {
        continue;
      }
      visited.add(nodeId);

      // Get outgoing edges
      const outgoingEdges = this.queries.getOutgoingEdges(
        nodeId,
        edgeKinds.length > 0 ? edgeKinds : undefined
      );

      for (const edge of outgoingEdges) {
        if (!visited.has(edge.target)) {
          const nextNode = this.queries.getNodeById(edge.target);
          if (nextNode) {
            queue.push({
              nodeId: edge.target,
              path: [...path, { node: nextNode, edge }],
            });
          }
        }
      }
    }

    return null; // No path found
  }

  /**
   * Get the containment hierarchy for a node (ancestors)
   *
   * @param nodeId - ID of the node
   * @returns Array of ancestor nodes from immediate parent to root
   */
  getAncestors(nodeId: string): Node[] {
    const ancestors: Node[] = [];
    const visited = new Set<string>();
    let currentId = nodeId;

    while (true) {
      if (visited.has(currentId)) {
        break;
      }
      visited.add(currentId);

      // Look for 'contains' edges pointing to this node
      const containingEdges = this.queries.getIncomingEdges(currentId, ['contains']);

      const firstEdge = containingEdges[0];
      if (!firstEdge) {
        break;
      }

      // Typically there should be at most one containing parent
      const parentNode = this.queries.getNodeById(firstEdge.source);
      if (parentNode) {
        ancestors.push(parentNode);
        currentId = parentNode.id;
      } else {
        break;
      }
    }

    return ancestors;
  }

  /**
   * Get immediate children of a node
   *
   * @param nodeId - ID of the node
   * @returns Array of child nodes
   */
  getChildren(nodeId: string): Node[] {
    const containsEdges = this.queries.getOutgoingEdges(nodeId, ['contains']);
    const children: Node[] = [];

    for (const edge of containsEdges) {
      const childNode = this.queries.getNodeById(edge.target);
      if (childNode) {
        children.push(childNode);
      }
    }

    return children;
  }
}
