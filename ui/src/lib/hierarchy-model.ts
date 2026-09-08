/**
 * The type-hierarchy tree, laid out arithmetically (design spec §3.10).
 *
 * A tree of types has no natural coordinate that the code supplies — unlike the
 * callee rail, which is anchored to the line that calls it, and unlike the Map,
 * which is layered by dependency. So the one rule that keeps it honest is
 * determinism: rows are a fixed height, indents are a fixed step, and the
 * connectors are computed from those two numbers. Nothing is measured, nothing
 * is simulated, and the same payload always draws the same picture.
 *
 * Direction is spatial, as everywhere else in the viewer: what this type is
 * built ON sits above it, what is built on THIS sits below and to the right.
 * The focus is the one accent row in between.
 */

import type { WireHierarchy, WireHierarchyNode, WireNodeDetail, WireNodeRef } from './wire';

/** Row height, in px. Fixed, so connector geometry is arithmetic. */
export const HIER_ROW_H = 24;

/** Indent per descendant level, in px (design spec §3.10). */
export const HIER_INDENT = 22;

/** Left edge of a row's kind glyph, measured from the row's own indent. */
export const HIER_GLYPH_X = 18;

/**
 * Where a row's connector leaves it: the centre of its 16px kind glyph. Lines
 * hang off the glyph rather than off the row, so the trunk of a fan reads as
 * coming out of the type rather than out of the margin.
 */
export const HIER_PORT_X = HIER_GLYPH_X + 8;

/**
 * Subtypes drawn before the rest fold away.
 *
 * The spec's rule is "≥ 12 descendants fold": twelve rows is about the point
 * where a fan stops being a list you read and starts being a wall you scroll
 * past, and the count in the fold's label is the part that actually matters
 * once you are past it. Folding starts at the row AFTER this one — a fan of
 * exactly twelve draws twelve rows rather than eleven and a "+0 more".
 */
export const HIER_FOLD_AT = 12;

/** One drawn row: a type, or the focus itself. */
export interface HierarchyRow {
  /** `null` for the focus row, which is not a hierarchy entry. */
  entry: WireHierarchyNode | null;
  node: WireNodeRef;
  /** Which half of the tree this row belongs to. */
  side: 'ancestor' | 'focus' | 'descendant';
  /** Horizontal offset in px. Ancestors and the focus sit at 0. */
  indent: number;
  /** Row index from the top of the block, before any fold is applied. */
  index: number;
  /** The relation word shown beside the row: "extends", "implements", "". */
  word: string;
}

/** One orthogonal connector: down the vertical, then out along the horizontal. */
export interface HierarchyConnector {
  /** Row index the segment starts at (the row nearer the top). */
  fromIndex: number;
  /** Row index it ends at. */
  toIndex: number;
  x: number;
  /** Where the horizontal run ends. Equal to `x` when the two rows share an indent. */
  toX: number;
  relation: 'extends' | 'implements';
  synthesized: boolean;
}

/** Everything the block draws, in one pass over the payload. */
export interface HierarchyModel {
  rows: HierarchyRow[];
  connectors: HierarchyConnector[];
  /** Index of the focus row — the accent one. */
  focusIndex: number;
  /** Rows from this index on are behind the fold. `null` when nothing folds. */
  foldFrom: number | null;
  /** How many rows the fold hides. */
  foldCount: number;
  /** "implementations" / "subclasses" / "subtypes", chosen from what is folded. */
  foldNoun: string;
  /** The one-line claim above the tree, or `''` when there is nothing worth claiming. */
  headline: string;
  /** A note under the tree when the payload is not the whole truth. */
  note: string;
}

/**
 * Lay the tree out.
 *
 * Ancestors are emitted FARTHEST first so the focus's own parents end up
 * adjacent to it — read top to bottom, the block goes from the most general
 * type to the most specific. Descendants come out of the payload breadth-first
 * already, and stay in that order: a fold that trims the tail then trims the
 * deepest, least relevant end.
 */
export function buildHierarchyModel(
  hierarchy: WireHierarchy,
  focus: WireNodeDetail
): HierarchyModel {
  const rows: HierarchyRow[] = [];

  const ancestors = [...hierarchy.ancestors.items].sort(
    (a, b) => b.depth - a.depth || a.name.localeCompare(b.name)
  );
  for (const entry of ancestors) {
    rows.push({
      entry,
      node: entry,
      side: 'ancestor',
      indent: 0,
      index: rows.length,
      // The plain relation word, on both halves of the tree. It reads off the
      // connector: this row is what the row below it extends or implements.
      // The block's header says which half is which.
      word: entry.relation,
    });
  }

  const focusIndex = rows.length;
  rows.push({ entry: null, node: focus, side: 'focus', indent: 0, index: focusIndex, word: '' });

  for (const entry of hierarchy.descendants.items) {
    rows.push({
      entry,
      node: entry,
      side: 'descendant',
      indent: entry.depth * HIER_INDENT,
      index: rows.length,
      word: entry.relation,
    });
  }

  // Descendant elbows look their parent up here. Ancestors are deliberately
  // excluded: a type that is somehow both above and below the focus (a cycle in
  // generated code) must not make a subtype hang off a supertype row.
  const byId = new Map(
    rows.filter((r) => r.side !== 'ancestor').map((row) => [row.node.id, row] as const)
  );
  const connectors: HierarchyConnector[] = [];

  // Ancestors: every row at indent 0, so each segment is a plain vertical to
  // the row below it. The relation is carried by the row's own word as well —
  // with two direct parents the line alone could not say which is which, and a
  // connector is structure, not the claim.
  for (let i = 0; i < focusIndex; i++) {
    const row = rows[i];
    const next = rows[i + 1];
    if (!row?.entry || !next) continue;
    connectors.push({
      fromIndex: i,
      toIndex: i + 1,
      x: HIER_PORT_X,
      toX: HIER_PORT_X,
      relation: row.entry.relation,
      synthesized: row.entry.synthesized,
    });
  }

  // Descendants: an elbow from the parent row's vertical out to this row's glyph.
  for (const row of rows) {
    if (row.side !== 'descendant' || !row.entry) continue;
    const parent = byId.get(row.entry.parentId) ?? rows[focusIndex];
    if (!parent) continue;
    connectors.push({
      fromIndex: parent.index,
      toIndex: row.index,
      x: parent.indent + HIER_PORT_X,
      // Stop two pixels short of the child's glyph, so the line meets the box
      // instead of running under it.
      toX: row.indent + HIER_GLYPH_X - 2,
      relation: row.entry.relation,
      synthesized: row.entry.synthesized,
    });
  }

  const descendantCount = rows.length - focusIndex - 1;
  const foldFrom = descendantCount > HIER_FOLD_AT ? focusIndex + 1 + HIER_FOLD_AT : null;
  const folded = foldFrom === null ? [] : rows.slice(foldFrom);

  return {
    rows,
    connectors,
    focusIndex,
    foldFrom,
    foldCount: folded.length,
    foldNoun: nounFor(folded.map((r) => r.entry).filter((e): e is WireHierarchyNode => !!e)),
    headline: headlineFor(hierarchy, focus),
    note: noteFor(hierarchy),
  };
}

/**
 * The word for a group of subtypes.
 *
 * "implementations" is what the spec asks for and what an interface's fan
 * actually is; a fan of `extends` edges is a class family, and calling those
 * implementations would be wrong in every language that has both.
 */
function nounFor(entries: readonly WireHierarchyNode[]): string {
  if (entries.length === 0) return 'subtypes';
  const implementsCount = entries.filter((e) => e.relation === 'implements').length;
  if (implementsCount === entries.length) return 'implementations';
  if (implementsCount === 0) return 'subclasses';
  return 'subtypes';
}

/**
 * The claim above the tree.
 *
 * The only claim worth making in a header is the one a reader cannot get by
 * counting the rows: that a call through this type does not go anywhere in
 * particular. Everything else the tree says for itself.
 */
function headlineFor(hierarchy: WireHierarchy, focus: WireNodeDetail): string {
  if (hierarchy.polymorphic) {
    return `A call through ${focus.name} dispatches to ${hierarchy.implementers} implementations — no single static target.`;
  }
  return '';
}

/** What the payload is NOT saying, when it is not saying all of it. */
function noteFor(hierarchy: WireHierarchy): string {
  const parts: string[] = [];
  if (hierarchy.descendants.truncated) {
    parts.push(
      `Showing ${hierarchy.descendants.shown} of ${hierarchy.descendants.total} subtypes`
    );
  } else if (hierarchy.bounded) {
    parts.push('Deeper subtypes exist below the levels walked');
  }
  if (hierarchy.ancestors.truncated) {
    parts.push(`${hierarchy.ancestors.total - hierarchy.ancestors.shown} more supertypes above`);
  }
  return parts.join(' · ');
}

/**
 * What is on screen for a given fold state.
 *
 * Connectors are filtered to the rows that are actually drawn, so a folded fan
 * never leaves a line running off into the fold's own label. The height is
 * arithmetic — {@link HIER_ROW_H} per row — which is the whole reason this
 * block needs no `ResizeObserver`.
 */
export function visibleHierarchy(
  model: HierarchyModel,
  expanded: boolean
): { rows: HierarchyRow[]; connectors: HierarchyConnector[]; height: number } {
  const count = expanded || model.foldFrom === null ? model.rows.length : model.foldFrom;
  return {
    rows: model.rows.slice(0, count),
    connectors: model.connectors.filter((c) => c.toIndex < count && c.fromIndex < count),
    height: count * HIER_ROW_H,
  };
}

/**
 * The SVG path for one connector: down, then out. Two straight runs and a
 * corner — never a curve, because a hierarchy is not a flow and a Bézier here
 * would read as one.
 */
export function connectorPath(c: HierarchyConnector): string {
  const y0 = c.fromIndex * HIER_ROW_H + HIER_ROW_H / 2;
  const y1 = c.toIndex * HIER_ROW_H + HIER_ROW_H / 2;
  if (c.toX <= c.x) return `M ${c.x} ${y0} L ${c.x} ${y1}`;
  return `M ${c.x} ${y0} L ${c.x} ${y1} L ${c.toX} ${y1}`;
}
