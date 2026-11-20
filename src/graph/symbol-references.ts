/**
 * Every place the code refers to one definition, line by line: what an agent
 * asking "who calls X", "what uses X" or "what breaks if X changes" would
 * otherwise grep for and then open each hit to name its function (#3407).
 *
 * Built from the index's edges. Some lines come from elsewhere:
 * - an edge that carries no line (a `references` edge names its symbol, not
 *   the spot) is placed by finding the name inside the referring symbol;
 * - a file that imports the name is read for the uses no edge records (a
 *   constant used inside a function the extractor linked only by the import);
 * - a reference the resolver gave up on but that is written with the
 *   definition's own package, module or class in front (`binding.Query` for
 *   gin's `Query` in package `binding`) is this definition too.
 * Each site is credited to the innermost symbol around it. References with the
 * name that can't be pinned to this definition are returned apart.
 *
 * Read-only and query-time: nothing here writes the index.
 */
import type CodeGraph from '../index';
import type { Edge, EdgeKind, Node, NodeKind, UnresolvedReference } from '../types';
import { goPackageReaderFor } from './go-package';

/** How a site depends on the definition, in the order an answer lists them. */
export type ReferenceRelation =
  | 'extends'
  | 'implements'
  | 'overrides'
  | 'instantiates'
  | 'calls'
  | 'uses'
  | 'exports'
  | 'imports';

export const REFERENCE_RELATION_ORDER: readonly ReferenceRelation[] = [
  'extends', 'implements', 'overrides', 'instantiates', 'calls', 'uses', 'exports', 'imports',
];

const RELATION_OF: Partial<Record<EdgeKind, ReferenceRelation>> = {
  extends: 'extends',
  implements: 'implements',
  overrides: 'overrides',
  instantiates: 'instantiates',
  calls: 'calls',
  references: 'uses',
  type_of: 'uses',
  returns: 'uses',
  decorates: 'uses',
  navigates: 'uses',
  exports: 'exports',
  imports: 'imports',
};

/** One line of code that depends on the definition. */
export interface ReferenceSite {
  relation: ReferenceRelation;
  filePath: string;
  /** 1-based line of the site; 0 when neither the edge nor the source places it. */
  line: number;
  /** The innermost symbol holding the site; null at file level. */
  owner: Node | null;
  /** The edge that links the site; absent for a use found in the source or by its written name. */
  edge?: Edge;
}

export interface SymbolReferences {
  /** One site per line, in relation order, then by file and line. */
  sites: ReferenceSite[];
  /**
   * References with the definition's name that the resolver could not tie to
   * any definition (`h.ServeHTTP()` on an interface value) and that aren't
   * written as this one's, at most `unlinkedLimit` of them.
   */
  unlinked: UnresolvedReference[];
  /** How many such references the index holds in all. */
  unlinkedTotal: number;
}

export interface ReferenceReadOptions {
  /**
   * A file's lines, or null when it can't be read or its indexed line numbers
   * can't be trusted (changed on disk since indexing). The caller caches.
   */
  readLines: (filePath: string) => readonly string[] | null;
  /** Most unlinked same-name references to return; 0 skips that list. */
  unlinkedLimit: number;
  /**
   * Most importing files read for uses no edge records. Past it, an importing
   * file contributes its import line and its linked sites only.
   */
  maxScannedFiles: number;
}

/** Kinds that can hold a site — what a reader names as "the caller". */
const OWNER_KINDS: ReadonlySet<NodeKind> = new Set<NodeKind>([
  'function', 'method', 'component', 'class', 'struct', 'interface', 'trait', 'protocol',
  'enum', 'union', 'module', 'namespace', 'variable', 'constant', 'property', 'field',
  'type_alias', 'route',
]);

/** Containers whose children are members: a member's name is not unique to it. */
export const MEMBER_CONTAINER_KINDS: ReadonlySet<NodeKind> = new Set<NodeKind>([
  'class', 'struct', 'interface', 'trait', 'protocol', 'enum', 'union',
]);

/** Most unresolved references read when matching them to the definition. */
const MAX_UNLINKED_READ = 400;

/** Sources whose whole body is read for more lines naming the definition: small, single-purpose spans. */
const BODY_SCANNED_KINDS: ReadonlySet<NodeKind> = new Set<NodeKind>([
  'function', 'method', 'component', 'variable', 'constant', 'property', 'field',
]);

/** Relations whose source may name the definition again in its body (not a class's `extends` line). */
const BODY_SCANNED_RELATIONS: ReadonlySet<ReferenceRelation> = new Set<ReferenceRelation>(['calls', 'uses', 'instantiates']);

/**
 * Most linked bodies read for those other lines. A symbol with more dependents
 * than this lists each one at its linked line anyway; the answer shows only
 * the first few dozen sites, so reading hundreds of files would buy nothing.
 */
const MAX_BODIES_SCANNED = 100;

/** How a language writes comments and strings, for telling a use of a name from prose about it. */
interface Syntax {
  /** Line-comment openers. */
  line: readonly string[];
  /** Block openers and their closers, checked before line comments (`--[[` before `--`). */
  block: ReadonlyArray<readonly [string, string]>;
  /** Single-line string delimiters. */
  quotes: readonly string[];
}

const C_STYLE: Syntax = { line: ['//'], block: [['/*', '*/']], quotes: ['"', "'"] };
const C_STYLE_TRIPLE: Syntax = { ...C_STYLE, block: [['/*', '*/'], ['"""', '"""']] };

/**
 * Languages with a known syntax. One missing here is scanned as written: its
 * comments and strings count, as they would for grep. Template languages
 * (Vue, Svelte, Astro) keep their quotes, since a template's attribute string
 * holds code (`:href="toValidURL(link)"`); Rust's `'` opens a lifetime, and
 * VB's opens a comment.
 */
const SYNTAX: Partial<Record<string, Syntax>> = {
  typescript: C_STYLE, javascript: C_STYLE, tsx: C_STYLE, jsx: C_STYLE, arkts: C_STYLE,
  java: C_STYLE_TRIPLE, kotlin: C_STYLE_TRIPLE, scala: C_STYLE_TRIPLE, swift: C_STYLE_TRIPLE, dart: C_STYLE_TRIPLE,
  c: C_STYLE, cpp: C_STYLE, objc: C_STYLE, csharp: C_STYLE, solidity: C_STYLE, cfscript: C_STYLE,
  go: { line: ['//'], block: [['/*', '*/']], quotes: ['"', "'", '`'] },
  rust: { line: ['//'], block: [['/*', '*/']], quotes: ['"'] },
  php: { line: ['//', '#'], block: [['/*', '*/']], quotes: ['"', "'"] },
  python: { line: ['#'], block: [['"""', '"""'], ["'''", "'''"]], quotes: ['"', "'"] },
  ruby: { line: ['#'], block: [['=begin', '=end']], quotes: ['"', "'"] },
  r: { line: ['#'], block: [], quotes: ['"', "'"] },
  nix: { line: ['#'], block: [['/*', '*/']], quotes: ['"'] },
  terraform: { line: ['#', '//'], block: [['/*', '*/']], quotes: ['"'] },
  lua: { line: ['--'], block: [['--[[', ']]']], quotes: ['"', "'"] },
  luau: { line: ['--'], block: [['--[[', ']]']], quotes: ['"', "'"] },
  erlang: { line: ['%'], block: [], quotes: ['"'] },
  vbnet: { line: ["'"], block: [], quotes: ['"'] },
  vue: { line: ['//'], block: [['/*', '*/'], ['<!--', '-->']], quotes: [] },
  svelte: { line: ['//'], block: [['/*', '*/'], ['<!--', '-->']], quotes: [] },
  astro: { line: ['//'], block: [['/*', '*/'], ['<!--', '-->']], quotes: [] },
};

/**
 * The lines in `from..to` whose CODE names the definition — not a comment, a
 * docstring or a string literal about it. `state` carries an open block
 * comment or docstring from one line to the next; a scan starts outside one.
 */
function codeMentionLines(
  lines: readonly string[],
  from: number,
  to: number,
  pattern: RegExp,
  language: string | undefined,
): number[] {
  const syntax = language ? SYNTAX[language] : undefined;
  const found: number[] = [];
  const state: { close: string | null } = { close: null };
  for (let ln = Math.max(1, from); ln <= Math.min(to, lines.length); ln++) {
    const text = lines[ln - 1]!;
    if (!syntax) {
      if (pattern.test(text)) found.push(ln);
      continue;
    }
    // Cheap reject first: most lines don't name it at all, but a block that
    // opens on one must still be tracked.
    if (!pattern.test(text) && state.close === null && !syntax.block.some(([open]) => text.includes(open))) continue;
    if (pattern.test(codeOf(text, syntax, state))) found.push(ln);
  }
  return found;
}

/** `line` with its comments and strings blanked, given the block `state` it starts in. */
function codeOf(line: string, syntax: Syntax, state: { close: string | null }): string {
  let out = '';
  let i = 0;
  scan: while (i < line.length) {
    if (state.close !== null) {
      const end = line.indexOf(state.close, i);
      if (end < 0) return out;
      i = end + state.close.length;
      state.close = null;
      out += ' ';
      continue;
    }
    for (const [open, close] of syntax.block) {
      if (line.startsWith(open, i)) { state.close = close; i += open.length; continue scan; }
    }
    for (const opener of syntax.line) if (line.startsWith(opener, i)) return out;
    const ch = line[i]!;
    if (syntax.quotes.includes(ch)) {
      let j = i + 1;
      while (j < line.length && line[j] !== ch) j += line[j] === '\\' ? 2 : 1;
      if (j >= line.length) return out; // an unclosed string runs to the end of the line
      i = j + 1;
      out += ' ';
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/** `name` as a whole word: not inside a longer identifier, in any script. */
export function wholeNamePattern(name: string): RegExp {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\p{L}\\p{N}_$])${escaped}(?![\\p{L}\\p{N}_$])`, 'u');
}

/**
 * The innermost symbol of `nodes` (one file's) whose span holds `line`, or
 * null at file level. The narrowest span wins; on a tie, the later start (the
 * nested one).
 */
export function innermostOwner(nodes: readonly Node[], line: number): Node | null {
  let best: Node | null = null;
  for (const n of nodes) {
    if (!OWNER_KINDS.has(n.kind)) continue;
    const end = n.endLine ?? n.startLine;
    if (n.startLine > line || end < line) continue;
    if (!best) { best = n; continue; }
    const span = end - n.startLine;
    const bestSpan = (best.endLine ?? best.startLine) - best.startLine;
    if (span < bestSpan || (span === bestSpan && n.startLine > best.startLine)) best = n;
  }
  return best;
}

/** The class-like symbol `def` is a member of, or null for a top-level definition. */
export function memberContainer(cg: CodeGraph, def: Node, incoming?: readonly Edge[]): Node | null {
  const edges = incoming ?? cg.getIncomingEdges(def.id);
  for (const e of edges) {
    if (e.kind !== 'contains') continue;
    const parent = cg.getNode(e.source);
    if (parent && MEMBER_CONTAINER_KINDS.has(parent.kind)) return parent;
  }
  return null;
}

/**
 * What code writes in front of `def`'s name to mean it, and nothing else, from
 * elsewhere: a member's class (`BaseModelAdmin.to_field_allowed`), or a Go
 * top-level name's package (`binding.Query`, by the file's `package` clause).
 * A module name is left out: `config.get(…)` is as often a dict that happens to
 * be called `config`, and an import-qualified use of a module resolves anyway.
 */
export function homeQualifiers(cg: CodeGraph, def: Node, container: Node | null): string[] {
  if (container) return [container.name];
  if (def.language !== 'go') return [];
  const pkg = goPackageReaderFor(cg)?.(def.filePath);
  return pkg ? [pkg] : [];
}

/** The relation a parked reference would have had as an edge. */
function relationOfKind(kind: string): ReferenceRelation {
  return RELATION_OF[kind as EdgeKind] ?? 'uses';
}

/**
 * Every site that refers to `def`. See the module comment for where the lines
 * come from.
 */
export function collectReferenceSites(cg: CodeGraph, def: Node, opts: ReferenceReadOptions): SymbolReferences {
  const incoming = cg.getIncomingEdges(def.id);
  const container = memberContainer(cg, def, incoming);
  const pattern = wholeNamePattern(def.name);
  const linked = incoming.filter((e) => e.kind !== 'contains' && RELATION_OF[e.kind] !== undefined);
  const sources = cg.getNodesByIds([...new Set(linked.map((e) => e.source))]);
  // A definition's own members naming it (a Go receiver, a `self: Foo`
  // annotation) are part of it, not things that depend on it.
  let ownMembers = new Set<string>();
  try { ownMembers = new Set(cg.getChildren(def.id).map((c) => c.id)); } catch { /* none */ }

  const fileNodes = new Map<string, Node[]>();
  const nodesIn = (filePath: string): Node[] => {
    let nodes = fileNodes.get(filePath);
    if (!nodes) {
      try { nodes = cg.getNodesInFile(filePath); } catch { nodes = []; }
      fileNodes.set(filePath, nodes);
    }
    return nodes;
  };
  /**
   * The narrowest symbol holding `line` in `source`'s file: a call edge's
   * source IS the caller, but a reference from a class may sit in one of its
   * methods.
   */
  const ownerAt = (source: Node, line: number): Node => {
    if (source.kind === 'function' || source.kind === 'method' || source.kind === 'component') return source;
    return innermostOwner(nodesIn(source.filePath), line) ?? source;
  };

  // One site per file and line; when two relations land on one line, the one
  // listed first in REFERENCE_RELATION_ORDER keeps it.
  const byLine = new Map<string, ReferenceSite>();
  const rank = (r: ReferenceRelation) => REFERENCE_RELATION_ORDER.indexOf(r);
  const keyOf = (filePath: string, line: number) => `${filePath}\0${line}`;
  const add = (site: ReferenceSite): void => {
    if (site.relation === 'uses' && site.owner && ownMembers.has(site.owner.id)) return;
    const key = keyOf(site.filePath, site.line);
    const held = byLine.get(key);
    if (!held || rank(site.relation) < rank(held.relation)) byLine.set(key, site);
  };

  const importingFiles: string[] = [];
  /** Files some symbol (not just the file's imports) is linked from. */
  const filesWithSymbolSites = new Set<string>();
  /** Linked functions and values whose other lines naming the definition are uses too. */
  const bodiesToScan = new Map<string, Node>();
  for (const edge of linked) {
    const source = sources.get(edge.source);
    if (!source) continue;
    const relation = RELATION_OF[edge.kind]!;
    const filePath = source.filePath;
    const atFileLevel = source.kind === 'file';
    if (relation === 'imports' && !importingFiles.includes(filePath)) importingFiles.push(filePath);
    if (!atFileLevel) filesWithSymbolSites.add(filePath);
    if (typeof edge.line === 'number' && edge.line > 0) {
      add({ relation, filePath, line: edge.line, owner: atFileLevel ? null : ownerAt(source, edge.line), edge });
      if (BODY_SCANNED_KINDS.has(source.kind) && BODY_SCANNED_RELATIONS.has(relation)
          && bodiesToScan.size < MAX_BODIES_SCANNED) bodiesToScan.set(source.id, source);
      continue;
    }
    if (atFileLevel) {
      add({ relation, filePath, line: 0, owner: null, edge });
      continue;
    }
    // No line on the edge: find the name in the referring symbol's code (not
    // a comment or a string about it).
    const lines = opts.readLines(filePath);
    const hits = lines
      ? codeMentionLines(lines, source.startLine, source.endLine ?? source.startLine, pattern, source.language)
      : [];
    for (const ln of hits) add({ relation, filePath, line: ln, owner: ownerAt(source, ln), edge });
    if (hits.length === 0) add({ relation, filePath, line: 0, owner: source, edge });
  }

  // The rest of a linked function's lines that name the definition — a type
  // annotation beside the call the edge records, a second read of a constant.
  // The function is already a dependent; these are its other lines to edit.
  if (!container) {
    for (const source of bodiesToScan.values()) {
      const lines = opts.readLines(source.filePath);
      if (!lines) continue;
      for (const ln of codeMentionLines(lines, source.startLine, source.endLine ?? source.startLine, pattern, source.language)) {
        if (byLine.has(keyOf(source.filePath, ln))) continue;
        add({ relation: 'uses', filePath: source.filePath, line: ln, owner: ownerAt(source, ln) });
      }
    }
  }

  // Uses a file that imports the name makes of it when the import is the only
  // edge it has (a constant read inside a function the extractor tied to the
  // file alone). Only for a definition whose name is its own — a member's name
  // (`update`) is in every file that calls some other type's `update`.
  if (!container) {
    const scanned = importingFiles
      .filter((f) => f !== def.filePath && !filesWithSymbolSites.has(f))
      .slice(0, Math.max(0, opts.maxScannedFiles));
    for (const filePath of scanned) {
      const lines = opts.readLines(filePath);
      if (!lines) continue;
      const nodes = nodesIn(filePath);
      for (const ln of codeMentionLines(lines, 1, lines.length, pattern, nodes[0]?.language)) {
        if (byLine.has(keyOf(filePath, ln))) continue;
        add({ relation: 'uses', filePath, line: ln, owner: innermostOwner(nodes, ln) });
      }
    }
  }

  // Parked references written as this definition's (`binding.Query`): sites.
  const homes = homeQualifiers(cg, def, container);
  const written = homes.flatMap((h) => [`${h}.${def.name}`, `${h}::${def.name}`]);
  let writtenAsThis: UnresolvedReference[] = [];
  try { writtenAsThis = cg.getUnlinkedReferencesWritten(written, MAX_UNLINKED_READ); } catch { /* none */ }
  if (writtenAsThis.length > 0) {
    const owners = cg.getNodesByIds([...new Set(writtenAsThis.map((r) => r.fromNodeId))]);
    for (const r of writtenAsThis) {
      if (r.referenceKind === 'imports') continue;
      const from = owners.get(r.fromNodeId);
      const filePath = r.filePath ?? from?.filePath;
      if (!filePath) continue;
      const owner = from && from.kind !== 'file' ? ownerAt(from, r.line) : innermostOwner(nodesIn(filePath), r.line);
      add({ relation: relationOfKind(r.referenceKind), filePath, line: r.line, owner });
    }
  }

  const sites = [...byLine.values()].sort((a, b) =>
    rank(a.relation) - rank(b.relation)
    || a.filePath.localeCompare(b.filePath)
    || a.line - b.line);

  let unlinked: UnresolvedReference[] = [];
  let unlinkedTotal = 0;
  if (opts.unlinkedLimit > 0) {
    try {
      // One that is already a site (linked one way, parked another, or written
      // as this definition's) is not unlinked.
      const found = cg.getUnlinkedReferencesNamed(def.name, Math.min(MAX_UNLINKED_READ, opts.unlinkedLimit + sites.length));
      const isSite = (r: UnresolvedReference) => byLine.has(keyOf(r.filePath ?? '', r.line));
      unlinked = found.refs.filter((r) => !isSite(r)).slice(0, opts.unlinkedLimit);
      unlinkedTotal = Math.max(unlinked.length, found.total - found.refs.filter(isSite).length);
    } catch { /* never fail an answer over the unlinked list */ }
  }
  return { sites, unlinked, unlinkedTotal };
}
