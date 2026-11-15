/**
 * A plain-object copy of a tree-sitter tree for analyses that revisit nodes.
 *
 * Every web-tree-sitter accessor crosses into WASM and re-marshals its cursor
 * or node, so an analysis that reads fields, children and text repeatedly
 * spends most of its time at that boundary. One cursor walk, reading only
 * numeric ids and offsets, copies the subset of the Node API these analyses
 * use; positions come from the source text. Afterwards the tree can be deleted.
 *
 * Fields are those the cursor reports, so a field inherited through a hidden
 * grammar rule (Lua's `local_declaration`) can appear where Node's
 * childForFieldName returns null; every field Node reports matches exactly.
 */
import type { Point, Tree } from 'web-tree-sitter';

/** Source text plus a lazily built line index. Positions use UTF-16 code units, as web-tree-sitter does. */
class Document {
  private lineStarts: number[] | undefined;
  constructor(readonly source: string) {}
  point(index: number): Point {
    const starts = this.lineStarts ??= [0, ...[...this.source.matchAll(/\n/g)].map(match => match.index! + 1)];
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if (starts[middle]! <= index) low = middle; else high = middle - 1;
    }
    return { row: low, column: index - starts[low]! };
  }
}

const NONE: readonly SyntaxMirror[] = Object.freeze([]);
const NO_FIELDS: Readonly<Record<string, SyntaxMirror>> = Object.freeze(Object.create(null));

export class SyntaxMirror {
  readonly namedChildren: SyntaxMirror[];
  /** Named children other than comments. */
  readonly significantChildren: SyntaxMirror[];
  /** Named children and anonymous tokens, in source order. */
  readonly children: SyntaxMirror[];
  readonly fields: Record<string, SyntaxMirror>;
  hasError: boolean;
  private previous: SyntaxMirror | null = null;

  constructor(
    private readonly document: Document,
    readonly id: number,
    readonly type: string,
    readonly startIndex: number,
    readonly endIndex: number,
    readonly parent: SyntaxMirror | null,
    readonly isNamed: boolean,
    readonly isMissing: boolean,
  ) {
    this.hasError = type === 'ERROR' || isMissing;
    // Anonymous tokens are leaves; they share empty child lists.
    this.namedChildren = isNamed ? [] : NONE as SyntaxMirror[];
    this.significantChildren = isNamed ? [] : NONE as SyntaxMirror[];
    this.children = isNamed ? [] : NONE as SyntaxMirror[];
    this.fields = isNamed ? Object.create(null) : NO_FIELDS as Record<string, SyntaxMirror>;
  }

  get text(): string { return this.document.source.slice(this.startIndex, this.endIndex); }
  get startPosition(): Point { return this.document.point(this.startIndex); }
  get endPosition(): Point { return this.document.point(this.endIndex); }
  get previousNamedSibling(): SyntaxMirror | null { return this.previous; }
  childForFieldName(name: string): SyntaxMirror | null { return this.fields[name] ?? null; }
  descendantsOfType(type: string): SyntaxMirror[] {
    const found: SyntaxMirror[] = [];
    const pending = [...this.namedChildren].reverse();
    while (pending.length) {
      const node = pending.pop()!;
      if (node.type === type) found.push(node);
      for (let i = node.namedChildren.length - 1; i >= 0; i--) pending.push(node.namedChildren[i]!);
    }
    return found;
  }

  /** @internal */ attach(child: SyntaxMirror, field: string | null): void {
    if (child.isNamed) {
      child.previous = this.namedChildren.at(-1) ?? null;
      this.namedChildren.push(child);
      if (!child.type.endsWith('comment')) this.significantChildren.push(child);
    }
    this.children.push(child);
    if (field && !(field in this.fields)) this.fields[field] = child;
    if (child.hasError) this.hasError = true;
  }
}

/** Copy `tree` without recursion; the caller still owns and deletes the tree. */
export function mirrorTree(tree: Tree, source: string): SyntaxMirror {
  const language = tree.language;
  const document = new Document(source);
  const typeNames: string[] = [];
  const named: boolean[] = [];
  const fieldNames: Array<string | null> = [];
  // MISSING nodes only occur in trees with errors; skip the per-node check otherwise.
  const checkMissing = tree.rootNode.hasError;
  const cursor = tree.walk();
  let ids = 0;
  const create = (parent: SyntaxMirror | null): SyntaxMirror => {
    const typeId = cursor.nodeTypeId;
    return new SyntaxMirror(document, ids++, typeNames[typeId] ??= language.nodeTypeForId(typeId) ?? '',
      cursor.startIndex, cursor.endIndex, parent, named[typeId] ??= language.nodeTypeIsNamed(typeId), checkMissing && cursor.nodeIsMissing);
  };
  try {
    const root = create(null);
    let parent = root;
    if (!cursor.gotoFirstChild()) return root;
    for (;;) {
      const node = create(parent);
      const fieldId = cursor.currentFieldId;
      parent.attach(node, fieldId ? fieldNames[fieldId] ??= language.fieldNameForId(fieldId) : null);
      if (node.isNamed && cursor.gotoFirstChild()) { parent = node; continue; }
      while (!cursor.gotoNextSibling()) {
        cursor.gotoParent();
        // Errors propagate upward once a subtree is complete.
        if (parent.hasError && parent.parent) parent.parent.hasError = true;
        if (parent === root) return root;
        parent = parent.parent!;
      }
    }
  } finally {
    cursor.delete();
  }
}
