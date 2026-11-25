/**
 * C# source as its syntax tree has it, for what resolution needs and the
 * index does not keep: a name as it is written (its whole path, the type
 * arguments on each part), where it stands, and what is declared around it.
 * A Razor file is read as the C# class Razor compiles it to (./razor-csharp).
 *
 * Trees are native memory: a few are kept per resolution context, and
 * `releaseCsharpUnits` frees the rest between references. Nothing read from a
 * tree outlives the lookup of the reference it was read for.
 */

import type { Node as SyntaxNode, Tree } from 'web-tree-sitter';
import { getParser, loadGrammarsForLanguages } from '../extraction/grammars';
import { blankCsharpPreprocessorDirectives } from '../extraction/languages/csharp';
import { razorRootNamespace } from './dotnet-projects';
import { razorAsCsharp, type RazorCsharp } from './razor-csharp';
import type { ResolutionContext } from './types';

export type { SyntaxNode };

/** One file's C#. */
export interface CsharpUnit {
  /** The file, project-relative. */
  file: string;
  root: SyntaxNode;
  /**
   * The smallest node at a position the extractor reported for a reference
   * (`line` 1-based): several where a Razor line holds more than one piece of
   * C#, none where it holds no C# code.
   */
  nodesAt(line: number, column: number): SyntaxNode[];
  /** The identifiers spelled `name` among what a Razor directive or tag on `line` names; none in a C# file. */
  identifiersOn(line: number, name: string): SyntaxNode[];
  /** Whether the type written at `node` may take type arguments it does not write: a Razor component tag. */
  typeArgumentsUnwritten(node: SyntaxNode): boolean;
}

/** Loads the C# grammar: asynchronous, so it runs before resolution starts reading C#. */
export async function loadCsharpGrammar(): Promise<void> {
  await loadGrammarsForLanguages(['csharp']);
}

interface HeldUnit {
  unit: CsharpUnit;
  tree: Tree;
}

const UNITS = new WeakMap<ResolutionContext, Map<string, HeldUnit | null>>();

/** How many trees stay parsed between references. */
const KEPT_UNITS = 24;

function isRazorFile(file: string): boolean {
  return /\.(razor|cshtml)$/i.test(file);
}

function parseCsharp(text: string): Tree {
  const parser = getParser('csharp');
  if (!parser) throw new Error('The C# grammar is not loaded: ReferenceResolver.prepare() runs before a C# or Razor name is looked up in F#.');
  const tree = parser.parse(blankCsharpPreprocessorDirectives(text));
  if (!tree) throw new Error('The C# parser returned no tree.');
  return tree;
}

function csharpFileUnit(file: string, tree: Tree): CsharpUnit {
  const root = tree.rootNode;
  return {
    file,
    root,
    nodesAt: (line, column) => [root.descendantForPosition({ row: line - 1, column })].filter((n): n is SyntaxNode => n !== null),
    identifiersOn: () => [],
    typeArgumentsUnwritten: () => false,
  };
}

/** Every identifier spelled `name` on row `row`. */
function identifiersOnRow(root: SyntaxNode, row: number, name: string): SyntaxNode[] {
  const found: SyntaxNode[] = [];
  const visit = (node: SyntaxNode): void => {
    if (node.startPosition.row > row || node.endPosition.row < row) return;
    if (node.type === 'identifier' && node.text === name) found.push(node);
    for (const child of node.namedChildren) if (child) visit(child);
  };
  visit(root);
  return found;
}

function razorUnit(file: string, tree: Tree, razor: RazorCsharp): CsharpUnit {
  const root = tree.rootNode;
  return {
    file,
    root,
    nodesAt: (line, column) => (razor.codeRows.get(line) ?? [])
      .map((row) => root.descendantForPosition({ row, column }))
      .filter((n): n is SyntaxNode => n !== null),
    identifiersOn: (line, name) => (razor.directiveRows.get(line) ?? []).flatMap((row) => identifiersOnRow(root, row, name)),
    typeArgumentsUnwritten: (node) => razor.tagRows.has(node.startPosition.row),
  };
}

/** The C# of project file `file` (a `.cs`, or a Razor file as the class it compiles to); null for a file that cannot be read. */
export function csharpUnitOf(file: string, context: ResolutionContext): CsharpUnit | null {
  let units = UNITS.get(context);
  if (!units) UNITS.set(context, (units = new Map()));
  const held = units.get(file);
  if (held !== undefined) {
    // Most recently read last.
    units.delete(file);
    units.set(file, held);
    return held?.unit ?? null;
  }
  let made: HeldUnit | null = null;
  if (isRazorFile(file)) {
    if (context.readFile(file) !== null) {
      const razor = razorAsCsharp(file, (p) => context.readFile(p), (dir) => razorRootNamespace(dir, context));
      const tree = parseCsharp(razor.text);
      made = { tree, unit: razorUnit(file, tree, razor) };
    }
  } else {
    const text = context.readFile(file);
    if (text !== null) {
      const tree = parseCsharp(text);
      made = { tree, unit: csharpFileUnit(file, tree) };
    }
  }
  units.set(file, made);
  return made?.unit ?? null;
}

/** Frees all but the trees read last. Called between references: no node of a freed tree may be in use. */
export function releaseCsharpUnits(context: ResolutionContext, keep = KEPT_UNITS): void {
  const units = UNITS.get(context);
  if (!units) return;
  while (units.size > keep) {
    const oldest = units.keys().next().value as string;
    units.get(oldest)?.tree.delete();
    units.delete(oldest);
  }
}

/** Forget every tree; called when the resolver drops its caches. */
export function clearCsharpUnits(context: ResolutionContext): void {
  releaseCsharpUnits(context, 0);
  UNITS.delete(context);
}

/** A node's child in field `field`, or null. */
export function fieldOf(node: SyntaxNode, field: string): SyntaxNode | null {
  return node.childForFieldName(field);
}

/** The named children of a node. */
export function namedChildrenOf(node: SyntaxNode): SyntaxNode[] {
  return node.namedChildren.filter((c): c is SyntaxNode => c !== null);
}

/** Whether a node has a child token of type `token` (`static`, `global`, `this`). */
export function hasToken(node: SyntaxNode, token: string): boolean {
  for (let i = 0; i < node.childCount; i++) if (node.child(i)?.type === token) return true;
  return false;
}

export function samePosition(a: SyntaxNode, b: SyntaxNode): boolean {
  return a.startPosition.row === b.startPosition.row && a.startPosition.column === b.startPosition.column;
}

/** Whether `inner` is `outer` or inside it. */
export function isWithin(inner: SyntaxNode, outer: SyntaxNode): boolean {
  return inner.startIndex >= outer.startIndex && inner.endIndex <= outer.endIndex;
}
