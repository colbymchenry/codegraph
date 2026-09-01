/**
 * The type hierarchy block on `/api/node` — ancestors up, subtypes down, and
 * the fan an interface call dispatches into (design spec §3.10).
 *
 * The walk itself is `src/graph/type-hierarchy.ts`, shared with
 * `codegraph_explore`'s interface-dispatch announcement so the two can never
 * print different implementation counts for the same interface. This module is
 * the renderer: it flattens the tree into rows the viewer can draw without
 * measuring anything, and caps the fan while keeping the true totals.
 *
 * It rides on `/api/node` rather than sitting behind its own endpoint for the
 * same reason `highlight` rides on `/api/source`: the block is part of the
 * Symbol view's first paint, and a second round-trip would let the screen
 * settle and then grow a tree above the code the reader had already started
 * reading. The cost of carrying it is gated to types — `canHaveHierarchy` is a
 * kind test, and the overwhelming majority of symbols a reader opens are
 * functions.
 */

import type { CodeGraph } from '../../index';
import type { Node } from '../../types';
import {
  buildTypeHierarchy,
  canHaveHierarchy,
  type HierarchyEntry,
  type HierarchyRelation,
  type TypeHierarchy,
} from '../../graph/type-hierarchy';
import { toNodeRef, wireList, type WireList, type WireNodeRef } from './wire';

/** Subtype rows carried on the payload. The viewer folds long fans again at 12. */
export const MAX_HIERARCHY_DESCENDANTS = 240;

/** Supertype rows carried on the payload. A chain longer than this is generated code. */
export const MAX_HIERARCHY_ANCESTORS = 24;

/** One type in the tree: the ref, its place, and how it got there. */
export interface WireHierarchyNode extends WireNodeRef {
  /** Steps from the focus, in whichever direction the row sits. 1 = direct. */
  depth: number;
  /** The row this one hangs off — the focus's id at depth 1. */
  parentId: string;
  relation: HierarchyRelation;
  /**
   * The edge was synthesized rather than parsed — Go's implicit interface
   * satisfaction is the common case. Drawn dashed, with `registeredAt` naming
   * the wiring site, exactly as the Flow strip draws a synthesized hop.
   */
  synthesized: boolean;
  via?: string;
  registeredAt?: string;
  /** Direct subtypes of this row that are NOT in the payload. */
  hiddenSubtypes: number;
}

/** Everything the type-hierarchy block draws. */
export interface WireHierarchy {
  /** Supertypes, nearest first. */
  ancestors: WireList<WireHierarchyNode>;
  /** Subtypes, breadth-first: depth 1 is complete before depth 2 starts. */
  descendants: WireList<WireHierarchyNode>;
  /** True number of DIRECT subtypes, whatever `descendants` was capped to. */
  direct: number;
  /** Of `direct`, the ones tied by `implements` — what a call through the type reaches. */
  implementers: number;
  /** Subtypes exist below what the walk returned. */
  bounded: boolean;
  /** A call through this type dispatches at runtime rather than to one target. */
  polymorphic: boolean;
}

/** A member of the focus that redeclares an ancestor's member. */
export interface WireOverride {
  /** The member it redeclares — open it to read what is being replaced. */
  baseId: string;
  baseTypeId: string;
  baseTypeName: string;
  /** `implements` reads as "satisfies", `extends` as "overrides". */
  relation: HierarchyRelation;
}

/**
 * Build the block, or `null` when there is nothing to draw.
 *
 * `null` is the answer for every function, and for a class that neither
 * extends nor is extended — the viewer draws no empty tree and no "no
 * hierarchy" note, because a class with no subtypes is the normal case and
 * saying so on every screen is noise.
 */
export function buildHierarchy(
  cg: CodeGraph,
  node: Node
): { wire: WireHierarchy; overrides: Map<string, WireOverride> } | null {
  if (!canHaveHierarchy(node)) return null;
  let hierarchy: TypeHierarchy | null;
  try {
    hierarchy = buildTypeHierarchy(cg, node);
  } catch {
    return null;
  }
  if (!hierarchy) return null;

  const ancestors = hierarchy.ancestors.slice(0, MAX_HIERARCHY_ANCESTORS).map(toWireHierarchyNode);
  const descendants = hierarchy.descendants
    .slice(0, MAX_HIERARCHY_DESCENDANTS)
    .map(toWireHierarchyNode);

  const overrides = new Map<string, WireOverride>();
  for (const [memberId, match] of hierarchy.overrides) {
    overrides.set(memberId, {
      baseId: match.baseId,
      baseTypeId: match.baseTypeId,
      baseTypeName: match.baseTypeName,
      relation: match.relation,
    });
  }

  return {
    wire: {
      ancestors: wireList(ancestors, hierarchy.ancestors.length),
      descendants: wireList(descendants, hierarchy.descendants.length),
      direct: hierarchy.directSubtypes,
      implementers: hierarchy.directImplementers,
      bounded: hierarchy.bounded,
      polymorphic: hierarchy.polymorphic,
    },
    overrides,
  };
}

function toWireHierarchyNode(entry: HierarchyEntry): WireHierarchyNode {
  const meta = (entry.edge.metadata ?? {}) as Record<string, unknown>;
  const wire: WireHierarchyNode = {
    ...toNodeRef(entry.node),
    depth: entry.depth,
    parentId: entry.parentId,
    relation: entry.relation,
    synthesized: entry.synthesized,
    hiddenSubtypes: entry.hiddenSubtypes,
  };
  if (typeof meta.synthesizedBy === 'string') wire.via = meta.synthesizedBy;
  else if (typeof meta.via === 'string') wire.via = meta.via;
  if (typeof meta.registeredAt === 'string') wire.registeredAt = meta.registeredAt;
  return wire;
}
