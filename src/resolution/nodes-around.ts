/**
 * The nodes of a file that can hold a given line.
 *
 * Resolving a reference asks what is around it: the function it is in, the
 * class around that, the namespace around both. Each such question went
 * through every node of the file for the ones whose lines hold the
 * reference's, and a reference asks several of them. In a file of forty
 * thousand methods that call each other that was forty thousand nodes, a
 * few times over, for each of some hundred thousand references: a minute
 * for 4 MB of Ruby, most of one for Java.
 *
 * Here the file's lines are cut into blocks, and each block keeps the nodes
 * whose lines reach it, in the file's own order. The nodes around a line are
 * then looked for among its block's: the ones that hold it, a few that
 * start or end nearby, and nothing else.
 */

import type { Node } from '../types';
import type { ResolutionContext } from './types';

/** Lines to a block. A block's nodes are those around it and those that start or end in it. */
const BLOCK_LINES = 64;

/** Below this many nodes a pass over all of them is as quick. */
const FEW_NODES = 64;

/** By a file's nodes, as the context hands them out: for each block of lines, the nodes that reach it; null when a node's lines can't be read. */
const BLOCKS = new WeakMap<readonly Node[], Node[][] | null>();

const NONE: readonly Node[] = [];

/**
 * Every node of `filePath` whose lines reach the block `line` is in, in the
 * order `context.getNodesInFile` gives them. A superset of the nodes that
 * hold `line`, so a caller filters these exactly as it filtered all of the
 * file's nodes — `n.startLine <= line && n.endLine >= line`, and whatever
 * else it asks — and gets the same nodes in the same order.
 */
export function nodesAroundLine(context: ResolutionContext, filePath: string, line: number): readonly Node[] {
  return nodesAroundLineIn(context.getNodesInFile(filePath), line);
}

/** nodesAroundLine, for a file's nodes already in hand: the list the context gave, kept as it was given. */
export function nodesAroundLineIn(nodes: readonly Node[], line: number): readonly Node[] {
  if (nodes.length < FEW_NODES || !(line >= 0)) return nodes;
  let blocks = BLOCKS.get(nodes);
  if (blocks === undefined) {
    blocks = blocksOf(nodes);
    BLOCKS.set(nodes, blocks);
  }
  if (blocks === null) return nodes;
  return blocks[Math.floor(line / BLOCK_LINES)] ?? NONE;
}

/** By a file's nodes, as the context hands them out: those of each name. */
const BY_NAME = new WeakMap<readonly Node[], Map<string, Node[]>>();

/**
 * The nodes of `filePath` named `name`, in the order
 * `context.getNodesInFile` gives them. A caller filters these exactly as it
 * filtered all of the file's nodes, `n.name === name` and whatever else it
 * asks, and gets the same nodes in the same order. A routes file of some
 * thousand entries went through all of its controller's methods for each of
 * them; so did a call for each symbol of its own file that might be its target.
 */
export function nodesNamed(context: ResolutionContext, filePath: string, name: string | undefined | null): readonly Node[] {
  return nodesNamedIn(context.getNodesInFile(filePath), name);
}

/** nodesNamed, for a file's nodes already in hand: the list the context gave, kept as it was given. */
export function nodesNamedIn(nodes: readonly Node[], name: string | undefined | null): readonly Node[] {
  if (nodes.length < FEW_NODES || typeof name !== 'string') return nodes;
  let byName = BY_NAME.get(nodes);
  if (!byName) {
    byName = new Map();
    for (const n of nodes) {
      const same = byName.get(n.name);
      if (same) same.push(n);
      else byName.set(n.name, [n]);
    }
    BY_NAME.set(nodes, byName);
  }
  return byName.get(name) ?? NONE;
}

/** By a file's nodes, as the context hands them out: those under each qualified name. */
const UNDER = new WeakMap<Node[], Map<string, Node[]>>();

/**
 * The nodes of `filePath` whose qualified name starts with
 * `qualifiedName::` (a type's members, and theirs), in the order
 * `context.getNodesInFile` gives them: what a pass over the file's nodes for
 * `n.qualifiedName.startsWith(\`${qualifiedName}::\`)` finds.
 */
export function nodesUnder(context: ResolutionContext, filePath: string, qualifiedName: string): readonly Node[] {
  const nodes = context.getNodesInFile(filePath);
  if (nodes.length < FEW_NODES) return nodes.filter((n) => n.qualifiedName.startsWith(`${qualifiedName}::`));
  let under = UNDER.get(nodes);
  if (!under) {
    under = new Map();
    for (const n of nodes) {
      // Each owner the name spells: `A::B::c` is under `A` and under `A::B`.
      for (let at = n.qualifiedName.indexOf('::'); at >= 0; at = n.qualifiedName.indexOf('::', at + 1)) {
        const owner = n.qualifiedName.slice(0, at);
        const held = under.get(owner);
        if (held) held.push(n);
        else under.set(owner, [n]);
      }
    }
    UNDER.set(nodes, under);
  }
  return under.get(qualifiedName) ?? NONE;
}

/** By a file's nodes, as the context hands them out: those of each name, lowercased. */
const BY_LOWER_NAME = new WeakMap<Node[], Map<string, Node[]>>();

/**
 * The nodes of `filePath` whose name is `lowerName` whatever its case, in
 * the order `context.getNodesInFile` gives them: what a pass over the file's
 * nodes for `n.name.toLowerCase() === lowerName` finds. A routes file of some
 * thousand entries made that pass over its controller for each of them.
 */
export function nodesNamedLower(context: ResolutionContext, filePath: string, lowerName: string): readonly Node[] {
  const nodes = context.getNodesInFile(filePath);
  if (nodes.length < FEW_NODES) return nodes.filter((n) => n.name.toLowerCase() === lowerName);
  let byName = BY_LOWER_NAME.get(nodes);
  if (!byName) {
    byName = new Map();
    for (const n of nodes) {
      const lower = n.name.toLowerCase();
      const same = byName.get(lower);
      if (same) same.push(n);
      else byName.set(lower, [n]);
    }
    BY_LOWER_NAME.set(nodes, byName);
  }
  return byName.get(lowerName) ?? NONE;
}

/** The nodes that reach each block of lines, or null when one of them has no lines to go by: a caller then reads them all. */
function blocksOf(nodes: readonly Node[]): Node[][] | null {
  const blocks: Node[][] = [];
  for (const n of nodes) {
    if (!(n.startLine >= 0) || !(n.endLine >= n.startLine)) return null;
    const last = Math.floor(n.endLine / BLOCK_LINES);
    for (let b = Math.floor(n.startLine / BLOCK_LINES); b <= last; b++) (blocks[b] ??= []).push(n);
  }
  return blocks;
}
