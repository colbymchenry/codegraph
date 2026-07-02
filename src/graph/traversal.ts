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
    // Enqueue-once guard, tracked separately from `visited` (which is only set
    // on dequeue). Guarding the enqueue on `visited` alone let a target
    // reachable via two edges get queued twice; the second dequeue then hit
    // `visited.has → continue` and its edge was never recorded, so parallel
    // edges (A calls AND references B, or two `calls` on different lines — edges
    // are unique on source+target+kind+line+col) went missing from the result
    // (#1090). `enqueued` makes each node queued exactly once.
    const enqueued = new Set<string>([startNode.id]);
    // Edge-identity dedup so a `direction:'both'` scan — which encounters A→B
    // from both endpoints — records each edge once.
    const seenEdges = new Set<string>();
    const edgeKey = (e: Edge) =>
      `${e.source}|${e.target}|${e.kind}|${e.line ?? -1}|${e.column ?? -1}`;
    const queue: TraversalStep[] = [{ node: startNode, edge: null, depth: 0 }];

    if (opts.includeStart) {
      nodes.set(startNode.id, startNode);
    }

    while (queue.length > 0 && nodes.size < opts.limit) {
      const step = queue.shift()!;
      const { node, depth } = step;

      if (visited.has(node.id)) {
        continue;
      }
      visited.add(node.id);

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

      // Batch-fetch neighbors we might newly enqueue in one query (was N+1 per
      // BFS step). Already-queued/visited neighbors are already in `nodes`, so
      // they don't need re-fetching to record an edge back to them.
      const wantIds = adjacentEdges
        .map((e) => (e.source === node.id ? e.target : e.source))
        .filter((id) => !visited.has(id) && !enqueued.has(id));
      const neighborNodes = wantIds.length > 0 ? this.queries.getNodesByIds(wantIds) : new Map();

      for (const adjEdge of adjacentEdges) {
        const nextNodeId = adjEdge.source === node.id ? adjEdge.target : adjEdge.source;
        const nextNode = neighborNodes.get(nextNodeId) ?? nodes.get(nextNodeId);
        if (!nextNode) continue;

        if (opts.nodeKinds && opts.nodeKinds.length > 0 && !opts.nodeKinds.includes(nextNode.kind)) {
          continue;
        }

        // Enqueue each neighbor exactly once, and only while under the node
        // budget — the cap is checked per-add here, not just on the outer
        // `while`, so one high-degree node can't overshoot `opts.limit` (#1087).
        if (!visited.has(nextNodeId) && !enqueued.has(nextNodeId)) {
          if (nodes.size >= opts.limit) continue;
          enqueued.add(nextNodeId);
          nodes.set(nextNode.id, nextNode);
          queue.push({ node: nextNode, edge: adjEdge, depth: depth + 1 });
        }

        // Record every distinct edge among kept nodes. Collecting on the
        // adjacency scan (rather than once per dequeue) is what preserves
        // parallel edges to the same target (#1090); `nextNode` is guaranteed
        // to be in `nodes` at this point (just added, or already in-set).
        const ek = edgeKey(adjEdge);
        if (!seenEdges.has(ek)) {
          seenEdges.add(ek);
          edges.push(adjEdge);
        }
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

    // Batch-fetch unvisited neighbors (was N+1 per DFS step).
    const wantIds = adjacentEdges
      .map((e) => (e.source === node.id ? e.target : e.source))
      .filter((id) => !visited.has(id));
    const neighborNodes = wantIds.length > 0 ? this.queries.getNodesByIds(wantIds) : new Map();

    for (const edge of adjacentEdges) {
      // Cap per-add, not just at the top of each frame: the top-of-function
      // guard only stops the next recursion, so without this every sibling of
      // the first over-budget child still got inserted, overshooting
      // `opts.limit` by a node's full fan-out (#1088).
      if (nodes.size >= opts.limit) break;

      const nextNodeId = edge.source === node.id ? edge.target : edge.source;
      if (visited.has(nextNodeId)) continue;

      const nextNode = neighborNodes.get(nextNodeId);
      if (!nextNode) continue;

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
    // Mark visited BEFORE the depth check, not after. Folding both into one
    // guard meant that when `currentDepth >= maxDepth` fired we returned without
    // marking the node — so a caller reachable from the same parent via two
    // edges (two call sites, or calls + references) was pushed once per edge,
    // duplicating it in `result` at the default `maxDepth=1` (#1086).
    if (visited.has(nodeId)) {
      return;
    }
    visited.add(nodeId);
    if (currentDepth >= maxDepth) {
      return;
    }

    // `instantiates` counts as a caller: constructing a class (`Foo(...)` /
    // `new Foo()`) is calling its constructor, so the instantiation site is a
    // caller of the class. Without it, `callers <Class>` surfaced only the
    // importing file (via `imports`) and missed every construction site —
    // the opposite of "what breaks if I change this class?" (#774).
    const incomingEdges = this.queries.getIncomingEdges(nodeId, ['calls', 'references', 'imports', 'instantiates']);
    if (incomingEdges.length === 0) return;

    // Batch-fetch all caller nodes in one round-trip instead of one
    // getNodeById per edge (was N+1 — meaningful on functions with many callers).
    const sourceIds = incomingEdges.map((e) => e.source);
    const callerNodes = this.queries.getNodesByIds(sourceIds);

    for (const edge of incomingEdges) {
      const callerNode = callerNodes.get(edge.source);
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
    // Mark visited before the depth check — see getCallersRecursive: the merged
    // guard dropped the `visited.add` at the depth boundary, duplicating a
    // callee reached from the same node via two edges at `maxDepth=1` (#1086).
    if (visited.has(nodeId)) {
      return;
    }
    visited.add(nodeId);
    if (currentDepth >= maxDepth) {
      return;
    }

    // Symmetric with getCallers: a function that constructs a class
    // (`Foo(...)` / `new Foo()`) has that class as a callee, so callers and
    // callees stay inverses of each other and `trace` can cross the
    // instantiation boundary (function → class → its methods) (#774).
    const outgoingEdges = this.queries.getOutgoingEdges(nodeId, ['calls', 'references', 'imports', 'instantiates']);
    if (outgoingEdges.length === 0) return;

    // Batch-fetch callee nodes (was N+1 — see getCallersRecursive note).
    const targetIds = outgoingEdges.map((e) => e.target);
    const calleeNodes = this.queries.getNodesByIds(targetIds);

    for (const edge of outgoingEdges) {
      const calleeNode = calleeNodes.get(edge.target);
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
    if (outgoingEdges.length === 0) return;
    const parents = this.queries.getNodesByIds(outgoingEdges.map((e) => e.target));

    for (const edge of outgoingEdges) {
      const parentNode = parents.get(edge.target);
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
    if (incomingEdges.length === 0) return;
    const children = this.queries.getNodesByIds(incomingEdges.map((e) => e.source));

    for (const edge of incomingEdges) {
      const childNode = children.get(edge.source);
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
    if (incomingEdges.length === 0) return result;

    // Batch-fetch source nodes (was N+1).
    const sources = this.queries.getNodesByIds(incomingEdges.map((e) => e.source));
    for (const edge of incomingEdges) {
      const sourceNode = sources.get(edge.source);
      if (sourceNode) result.push({ node: sourceNode, edge });
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
    // Mark visited before the depth check so a node collected at the depth
    // boundary still lands in `visited`. Otherwise it could sit in `nodes` but
    // not `visited`, and the two loops below — which used different sets to
    // gate re-processing — would disagree about it (#1089).
    if (visited.has(nodeId)) {
      return;
    }
    visited.add(nodeId);
    if (currentDepth >= maxDepth) {
      return;
    }

    // For container nodes (classes, interfaces, structs, etc.), also traverse
    // into their children so that callers of contained methods appear in impact
    const focalNode = this.queries.getNodeById(nodeId);
    if (focalNode) {
      const containerKinds = new Set(['class', 'interface', 'struct', 'trait', 'protocol', 'module', 'enum']);
      if (containerKinds.has(focalNode.kind)) {
        const containsEdges = this.queries.getOutgoingEdges(nodeId, ['contains']);
        if (containsEdges.length > 0) {
          const children = this.queries.getNodesByIds(containsEdges.map((e) => e.target));
          for (const edge of containsEdges) {
            const childNode = children.get(edge.target);
            if (childNode && !visited.has(childNode.id)) {
              nodes.set(childNode.id, childNode);
              edges.push(edge);
              // Recurse into children at the same depth (they're part of the same symbol)
              this.getImpactRecursive(childNode.id, maxDepth, currentDepth, nodes, edges, visited);
            }
          }
        }
      }
    }

    // Get all incoming edges (things that depend on this node). Exclude
    // `contains`: a container "contains" its members but does not *depend* on
    // them, so following it upward would climb to the parent class and then
    // re-expand every sibling member — exploding impact for a leaf symbol. (#536)
    const incomingEdges = this.queries.getIncomingEdges(nodeId).filter((e) => e.kind !== 'contains');
    if (incomingEdges.length === 0) return;
    const sources = this.queries.getNodesByIds(incomingEdges.map((e) => e.source));

    for (const edge of incomingEdges) {
      const sourceNode = sources.get(edge.source);
      if (!sourceNode) continue;
      // Record the dependency edge unconditionally. The gate used to also gate
      // edge collection (`!nodes.has(...)`), so a second incoming edge into a
      // node already collected via another path was silently dropped from
      // `edges` even though it's a real dependency (#1089). Each node's incoming
      // edges are fetched once (nodes are expanded once), so no edge repeats.
      edges.push(edge);
      if (!visited.has(sourceNode.id)) {
        nodes.set(sourceNode.id, sourceNode);
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
      if (outgoingEdges.length === 0) continue;

      // Batch-fetch only the unvisited targets (was N+1 per BFS frontier).
      const wantIds = outgoingEdges
        .map((e) => e.target)
        .filter((id) => !visited.has(id));
      const nextNodes = wantIds.length > 0 ? this.queries.getNodesByIds(wantIds) : new Map();

      for (const edge of outgoingEdges) {
        if (!visited.has(edge.target)) {
          const nextNode = nextNodes.get(edge.target);
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
    if (containsEdges.length === 0) return [];

    // Batch-fetch (was N+1).
    const childNodes = this.queries.getNodesByIds(containsEdges.map((e) => e.target));
    const children: Node[] = [];
    for (const edge of containsEdges) {
      const childNode = childNodes.get(edge.target);
      if (childNode) children.push(childNode);
    }
    return children;
  }
}
