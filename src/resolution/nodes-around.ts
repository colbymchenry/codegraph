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
const BLOCKS = new WeakMap<Node[], Node[][] | null>();

const NONE: readonly Node[] = [];

/**
 * Every node of `filePath` whose lines reach the block `line` is in, in the
 * order `context.getNodesInFile` gives them. A superset of the nodes that
 * hold `line`, so a caller filters these exactly as it filtered all of the
 * file's nodes — `n.startLine <= line && n.endLine >= line`, and whatever
 * else it asks — and gets the same nodes in the same order.
 */
export function nodesAroundLine(context: ResolutionContext, filePath: string, line: number): readonly Node[] {
  const nodes = context.getNodesInFile(filePath);
  if (nodes.length < FEW_NODES || !(line >= 0)) return nodes;
  let blocks = BLOCKS.get(nodes);
  if (blocks === undefined) {
    blocks = blocksOf(nodes);
    BLOCKS.set(nodes, blocks);
  }
  if (blocks === null) return nodes;
  return blocks[Math.floor(line / BLOCK_LINES)] ?? NONE;
}

/** The nodes that reach each block of lines, or null when one of them has no lines to go by: a caller then reads them all. */
function blocksOf(nodes: Node[]): Node[][] | null {
  const blocks: Node[][] = [];
  for (const n of nodes) {
    if (!(n.startLine >= 0) || !(n.endLine >= n.startLine)) return null;
    const last = Math.floor(n.endLine / BLOCK_LINES);
    for (let b = Math.floor(n.startLine / BLOCK_LINES); b <= last; b++) (blocks[b] ??= []).push(n);
  }
  return blocks;
}
