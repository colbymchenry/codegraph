/**
 * Risk hotspots: the functions a reader should open first.
 *
 * Complexity is the one signal the graph did not already have — call counts,
 * fan-in, changed symbols and related tests all exist elsewhere. It is computed
 * HERE, at read time, from the file's own bytes with the tree-sitter grammars
 * already on disk, and never persisted: the AST is discarded after extraction
 * (no node carries a construct count, and the kernel's reserved per-node metrics
 * slot is unpopulated), so a stored metric would mean an extraction change, a
 * kernel ABI bump and a schema migration. A report over a bounded candidate set
 * does not need any of that.
 *
 * The score is a lead, not a verdict. Complexity counts are a coarse proxy —
 * TypeScript counts a plain `&&` as a decision, and the node-type tables below
 * are grammar-version-sensitive. Every language is pinned by a fixture test with
 * a known decision count; that test, not this comment, is what says the names
 * are right.
 */

import type { Node as SyntaxNode } from 'web-tree-sitter';
import type { Language, Node } from '../types';
import { hashContent } from '../extraction';
import { treeFor, MAX_PARSE_BYTES } from './branch-guards';

/** Loop node types already verified across the grammars (mirrors branch-guards' LOOP_TYPES). */
const LOOP_TYPES: readonly string[] = [
  'for_statement',
  'for_in_statement',
  'for_of_statement',
  'for_each_statement',
  'enhanced_for_statement',
  'foreach_statement',
  'for_range_loop',
  'for_expression',
  'while_statement',
  'while_expression',
  'do_statement',
  'do_while_statement',
  'repeat_while_statement',
  'loop_expression',
];

/** The operators that make a binary/boolean expression a decision point. */
const LOGICAL_OPERATORS: ReadonlySet<string> = new Set(['&&', '||', '??', 'and', 'or']);

/** The `catch`-family names: the grammars here disagree between all four, and Python says `except`. */
const CATCH_TYPES: readonly string[] = [
  'catch_clause',
  'catch_block',
  'catch_keyword',
  'except_clause',
  'except_group_clause',
];
/**
 * The `if`-family names across these grammars: Kotlin and Rust use expressions,
 * Python spells `else if` as `elif_clause`, and Swift has `guard`. A name no
 * grammar in the set uses is simply never matched.
 */
const IF_TYPES: readonly string[] = [
  'if_statement',
  'if_expression',
  'conditional_expression',
  'ternary_expression',
  'guard_statement',
  'elif_clause',
];

interface LanguageRules {
  /** Each occurrence of these node types adds one decision. */
  decisions: ReadonlySet<string>;
  /** Node types whose OPERATOR decides: only a logical operator counts. */
  logical: ReadonlySet<string>;
}

/**
 * Build the decision set for one language.
 *
 * `caseTypes` is per-language on purpose: the node type that represents "one
 * branch of a switch/match" is the single most divergent name across these
 * grammars — `switch_case` (JS/TS), `switch_label` (Java), `switch_section`
 * (C#), `case_statement` (C/C++), `expression_case`/`default_case` (Go),
 * `switch_entry` (Swift), `when_entry` (Kotlin), `case_clause` (Python),
 * `match_arm` (Rust). Every one of those was read off the grammar, not guessed.
 */
function rules(caseTypes: readonly string[], logical: readonly string[]): LanguageRules {
  return {
    decisions: new Set([...IF_TYPES, ...caseTypes, ...CATCH_TYPES, ...LOOP_TYPES]),
    logical: new Set(logical),
  };
}

/**
 * Verified against the grammars in `__tests__/hotspots.test.ts`, which parses a
 * fixture per language with a known decision count. `if_expression` doubles as
 * the `if` of Kotlin and Rust, and `conjunction_expression` /
 * `disjunction_expression` are what Swift and Kotlin use where JS has
 * `binary_expression` with a `&&` operator.
 */
const RULES_BY_LANGUAGE: Partial<Record<Language, LanguageRules>> = {
  typescript: rules(['switch_case', 'switch_default'], ['binary_expression']),
  tsx: rules(['switch_case', 'switch_default'], ['binary_expression']),
  javascript: rules(['switch_case', 'switch_default'], ['binary_expression']),
  jsx: rules(['switch_case', 'switch_default'], ['binary_expression']),
  java: rules(['switch_label'], ['binary_expression']),
  csharp: rules(['switch_section'], ['binary_expression']),
  c: rules(['case_statement'], ['binary_expression']),
  cpp: rules(['case_statement'], ['binary_expression']),
  objc: rules(['case_statement'], ['binary_expression']),
  go: rules(['expression_case', 'default_case', 'type_case', 'communication_case'], ['binary_expression']),
  swift: rules(['switch_entry'], ['conjunction_expression', 'disjunction_expression']),
  python: rules(['case_clause'], ['boolean_operator']),
  kotlin: rules(['when_entry'], ['conjunction_expression', 'disjunction_expression']),
  rust: rules(['match_arm', 'if_let_expression', 'while_let_expression'], ['binary_expression']),
};

/** The languages the hotspot report can count decisions for. */
export const HOTSPOT_LANGUAGES: readonly Language[] = Object.keys(RULES_BY_LANGUAGE) as Language[];

export function supportsHotspots(language: Language | string | undefined | null): boolean {
  return typeof language === 'string' && RULES_BY_LANGUAGE[language as Language] !== undefined;
}

/** One decision site, 1-based line. */
export interface DecisionSite {
  line: number;
  column: number;
}

/** The operator of a logical expression, whatever the grammar calls the field. */
function operatorOf(node: SyntaxNode): string | null {
  const field = node.childForFieldName('operator');
  if (field) return field.text;
  for (const child of node.children) {
    if (child && LOGICAL_OPERATORS.has(child.text)) return child.text;
  }
  return null;
}

/**
 * Every decision point in a tree, by 1-based line.
 *
 * A `switch` counts its cases, not itself; an `else if` is one `if_statement`
 * and counts once. Nested functions are walked like any other node — the caller
 * decides which function a decision belongs to by range.
 */
export function decisionSites(root: SyntaxNode, language: Language): DecisionSite[] {
  const rules = RULES_BY_LANGUAGE[language];
  if (!rules) return [];
  const sites: DecisionSite[] = [];
  const walk = (node: SyntaxNode): void => {
    if (rules.decisions.has(node.type)) {
      sites.push({ line: node.startPosition.row + 1, column: node.startPosition.column });
    } else if (rules.logical.has(node.type)) {
      const operator = operatorOf(node);
      if (operator !== null && LOGICAL_OPERATORS.has(operator)) {
        sites.push({ line: node.startPosition.row + 1, column: node.startPosition.column });
      }
    }
    for (const child of node.namedChildren) if (child) walk(child);
  };
  walk(root);
  return sites;
}

/** A callable to attribute decisions to, in the file's own line numbers. */
export interface CallableRange {
  id: string;
  startLine: number;
  endLine: number;
  startColumn?: number;
  endColumn?: number;
}

/**
 * `1 + decisions` for each callable in a file, from ONE parse.
 *
 * A decision belongs to the innermost callable whose line range contains it; a
 * decision outside every callable (top-level code) is not counted for anyone.
 * Returns an empty map when the language has no rules, the file is over the byte
 * cap, or it cannot be parsed — absence, not a zero that looks like "simple".
 */
export async function computeFileComplexities(
  absPath: string,
  language: Language,
  callables: readonly CallableRange[],
  maxBytes = MAX_PARSE_BYTES,
  expectedHash?: string
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (callables.length === 0 || !supportsHotspots(language)) return out;
  const cached = await treeFor(absPath, language, maxBytes);
  if (!cached || cached.tree.rootNode.hasError || (expectedHash !== undefined && hashContent(cached.source) !== expectedHash)) return out;
  const sites = decisionSites(cached.tree.rootNode, language);
  // Innermost first: the greatest start line whose range still contains the line.
  const ordered = [...callables].sort((a, b) => b.startLine - a.startLine || (b.startColumn ?? 0) - (a.startColumn ?? 0));
  for (const callable of callables) out.set(callable.id, 1);
  for (const site of sites) {
    const owner = ordered.find(c => site.line >= c.startLine && site.line <= c.endLine
      && (site.line !== c.startLine || site.column >= (c.startColumn ?? 0))
      && (site.line !== c.endLine || site.column < (c.endColumn ?? Infinity)));
    if (owner) out.set(owner.id, (out.get(owner.id) ?? 1) + 1);
  }
  return out;
}

/** Weights the score combines signals with; exported so tests pin them. */
export const HOTSPOT_WEIGHTS = {
  /** A symbol in the current diff is likelier to be the one being asked about. */
  changed: 1.5,
  /** Related test evidence provides a ranking discount, not a coverage guarantee. */
  tested: 0.75,
} as const;

/**
 * The report defaults live here rather than at the assembly layer, so the CLI, the MCP tool and the
 * public API cannot drift into three different "default" caps.
 */
export const DEFAULT_HOTSPOT_ITEMS = 20;
/** Files parsed for complexity in one report; beyond this the report says it truncated. */
export const DEFAULT_HOTSPOT_FILES = 2_000;
/** Score at or above which the report counts a symbol as gated. */
export const DEFAULT_HOTSPOT_THRESHOLD = 50;

/**
 * complexity × (1 + callers), boosted when the symbol changed and discounted
 * when something already covers it.
 *
 * `weights` is a parameter rather than a closed-over constant so a project can retune the ranking
 * through API options; omitted fields keep `HOTSPOT_WEIGHTS`.
 */
export function scoreHotspot(
  input: {
    complexity: number;
    callerCount: number;
    changed: boolean;
    hasTests: boolean;
  },
  weights: { changed: number; tested: number } = HOTSPOT_WEIGHTS
): number {
  const base = input.complexity * (1 + input.callerCount);
  const changed = input.changed ? weights.changed : 1;
  const tested = input.hasTests ? weights.tested : 1;
  return Math.round(base * changed * tested * 100) / 100;
}

/** One scored row, before the report sorts and caps it. */
export interface HotspotRow {
  node: Node;
  complexity: number;
  callerCount: number;
  changed: boolean;
  hasTests: boolean;
  testFiles: string[];
  score: number;
}

/** Highest score first; ties broken by file then line so the order is stable. */
export function rankHotspots(rows: readonly HotspotRow[], maxItems: number): HotspotRow[] {
  return [...rows]
    .sort(
      (a, b) =>
        b.score - a.score ||
        a.node.filePath.localeCompare(b.node.filePath) ||
        a.node.startLine - b.node.startLine ||
        a.node.id.localeCompare(b.node.id)
    )
    .slice(0, maxItems);
}
