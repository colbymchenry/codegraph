/**
 * codegraph_explore's answer to a query that names ONE symbol (#3407).
 *
 * "What is X?", "who calls X?" and "what breaks if X changes?" reach explore as
 * a one-name query (`MODELS_MODULE_NAME`, `toValidURL callers`). Explore's
 * general path ranks files by their words, so it split the name into words and
 * filled its whole budget (~25,000 characters on a mid-size repo) with files
 * about `Snap`, `Center` and `THRESHOLD`, often without the one line that uses
 * the constant. The agent then grepped the name and opened every hit to name
 * its function: more tokens than not having codegraph at all.
 *
 * This answer is the definition's source and every line that depends on it,
 * each with the symbol it sits in and the line's text, so neither the grep nor
 * the Reads have anything left to find. It is as long as the symbol's use is,
 * not as long as the budget.
 */
import type CodeGraph from '../index';
import type { Edge, Node, NodeKind } from '../types';
import { isQueryNameToken, isTestPath } from '../search/query-utils';
import { findAllSymbols } from '../graph/named-symbol-flow';
import {
  collectReferenceSites,
  memberContainer,
  MEMBER_CONTAINER_KINDS,
  type ReferenceRelation,
  type ReferenceSite,
  type SymbolReferences,
} from '../graph/symbol-references';
import type { CallSiteRow } from '../graph/traversal';
import type { UnresolvedReference } from '../types';

/**
 * Words a one-symbol question carries besides the name — what is asked about
 * it, and the question's own scaffolding. Lowercase only: `User` or `Value`
 * written by the agent is a name, never one of these.
 */
const QUESTION_WORDS: ReadonlySet<string> = new Set([
  // the relation asked for
  'caller', 'callers', 'callee', 'callees', 'call', 'calls', 'called', 'calling',
  'use', 'uses', 'used', 'usage', 'usages', 'using', 'user', 'users',
  'reference', 'references', 'referenced', 'referencing', 'ref', 'refs',
  'dependent', 'dependents', 'depend', 'depends', 'dependency', 'dependencies',
  'impact', 'blast', 'radius', 'affect', 'affects', 'affected', 'break', 'breaks',
  'definition', 'defined', 'define', 'defines', 'declaration', 'declared', 'declare', 'declares',
  'implementation', 'implementations', 'implemented', 'implementer', 'implementers',
  'subclass', 'subclasses', 'override', 'overrides', 'overridden',
  'instantiated', 'instantiation', 'instantiations', 'instances', 'instance',
  'import', 'imports', 'imported', 'importer', 'importers',
  'value', 'type', 'signature', 'source', 'body', 'code',
  'site', 'sites', 'location', 'locations', 'place', 'places', 'occurrences',
  // the question around them
  'what', 'where', 'who', 'which', 'how', 'is', 'are', 'was', 'the', 'a', 'an', 'of', 'to',
  'in', 'on', 'by', 'for', 'from', 'and', 'or', 'it', 'its', 'this', 'that', 'does', 'do',
  'all', 'every', 'any', 'find', 'show', 'list', 'if', 'would', 'when', 'change', 'changes',
  'changed', 'changing', 'work', 'works',
]);

/**
 * The one symbol name an explore query asks about, or null when it names none
 * or several. `toValidURL callers`, `` `Engine.ServeHTTP` ``, "where is
 * noWritten defined?" each name one; a bag of names (a flow) or a question with
 * other content words does not, and keeps explore's general answer.
 */
export function oneSymbolQueryName(query: string): string | null {
  const names: string[] = [];
  for (const raw of query.split(/[\s,;?!]+/)) {
    const token = raw
      .replace(/^[`'"([{<]+/, '')
      .replace(/(?:\(\))?[`'")\]}>.:]*$/, '')
      .replace(/\(\)$/, '');
    if (!token) continue;
    if (token === token.toLowerCase() && QUESTION_WORDS.has(token)) continue;
    names.push(token);
    if (names.length > 1) return null;
  }
  const name = names[0];
  return name !== undefined && isQueryNameToken(name) ? name : null;
}

/** Node kinds that are a definition a one-symbol answer can be about. */
const DEFINITION_KINDS: ReadonlySet<NodeKind> = new Set<NodeKind>([
  'function', 'method', 'component', 'class', 'struct', 'interface', 'trait', 'protocol',
  'enum', 'union', 'type_alias', 'variable', 'constant', 'property', 'field', 'enum_member',
]);

/** Definitions per answer: more is an overloaded name, which explore's general path ranks. */
export const MAX_ONE_SYMBOL_DEFINITIONS = 3;

/**
 * What `name` defines: its hand-written, non-test definitions when it has any,
 * else all of them. Null for none, or more than {@link MAX_ONE_SYMBOL_DEFINITIONS}.
 */
export function oneSymbolDefinitions(cg: CodeGraph, name: string): Node[] | null {
  const qualified = /[.\/]|::/.test(name);
  let nodes = (qualified ? findAllSymbols(cg, name).nodes : cg.getNodesByName(name))
    .filter((n) => DEFINITION_KINDS.has(n.kind));
  nodes = [...new Map(nodes.map((n) => [n.id, n])).values()];
  if (nodes.length === 0) return null;
  const isGenerated = cg.generatedFilePredicate(nodes.map((n) => n.filePath));
  const handWritten = nodes.filter((n) => !isGenerated(n.filePath));
  if (handWritten.length > 0) nodes = handWritten;
  const nonTest = nodes.filter((n) => !isTestPath(n.filePath));
  if (nonTest.length > 0) nodes = nonTest;
  if (nodes.length > MAX_ONE_SYMBOL_DEFINITIONS) return null;
  return nodes.sort((a, b) => a.filePath.localeCompare(b.filePath) || a.startLine - b.startLine);
}

/** What the renderer needs from the tool handler. */
export interface OneSymbolContext {
  cg: CodeGraph;
  /** Hard cap on the answer, in characters (the project tier's explore ceiling). */
  maxChars: number;
  /** Source characters the definitions' bodies may take, together. */
  bodyChars: number;
  /** A file's lines, or null when unreadable or changed on disk since it was indexed. */
  readLines: (filePath: string) => readonly string[] | null;
  /** Whether a symbol is test code (by its file, or a test block inside one). */
  isTest: (node: Node) => boolean;
  /** The label a synthesized (dynamic-dispatch) edge carries, or null for a parsed one. */
  synthNote: (edge: Edge) => string | null;
  /** The note a cut body ends with, naming the explore query for the rest (explore's own wording). */
  elidedNote: (filePath: string, name: string, from: number, to: number) => string;
  /**
   * For dependents no test calls directly: whether tests reach them through
   * their callers (`tested via callers: …`), or what was searched.
   */
  testsThroughCallers: (dependents: Node[]) => string;
  /** Whether codegraph_node is on the tool list, so a follow-up may name it. */
  nodeServed: boolean;
}

/** What one rendered answer holds. */
export interface OneSymbolAnswer {
  text: string;
  /** The definition source the answer shows, for the session record. */
  shown: Array<{ filePath: string; start: number; end: number; chars: number }>;
  /** Every file the answer reads from (for the freshness check). */
  files: string[];
}

/** List caps, halved until the answer fits. */
interface Caps {
  sites: number;
  testFiles: number;
  /** Tests named across all test files. */
  testOwners: number;
  unlinked: number;
  holders: number;
  holderSites: number;
  callees: number;
  members: number;
}

const FULL_CAPS: Caps = {
  sites: 40, testFiles: 12, testOwners: 60, unlinked: 10,
  holders: 3, holderSites: 8, callees: 12, members: 80,
};

/** Lines listed for one test before "+N more". */
const MAX_LINES_PER_TEST = 5;

/** Languages that write a member path with `::` (everyone else reads `.`). */
const DOUBLE_COLON_LANGUAGES = new Set(['rust', 'cpp', 'c', 'php', 'perl']);

/** `BaseModelAdmin.to_field_allowed` — a symbol the way its language spells a member path. */
export function displayName(node: Node): string {
  const q = node.qualifiedName || node.name;
  return DOUBLE_COLON_LANGUAGES.has(node.language) ? q : q.replace(/::/g, '.');
}

/** `text` as inline code, whatever backticks it holds. */
function inlineCode(text: string): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = '`'.repeat(longest + 1);
  const pad = text.startsWith('`') || text.endsWith('`') ? ' ' : '';
  return `${fence}${pad}${text}${pad}${fence}`;
}

const MAX_SITE_TEXT = 160;

/** One source line as an answer shows it: trimmed, and cut when long. */
function siteText(lines: readonly string[] | null, line: number): string | null {
  if (!lines || line <= 0 || line > lines.length) return null;
  const text = lines[line - 1]!.trim();
  if (!text) return null;
  return text.length > MAX_SITE_TEXT ? `${text.slice(0, MAX_SITE_TEXT - 1)}…` : text;
}

const RELATION_TITLE: Record<ReferenceRelation, string> = {
  extends: 'Extended by',
  implements: 'Implemented by',
  overrides: 'Overridden by',
  instantiates: 'Instantiated by',
  calls: 'Called by',
  uses: 'Used by',
  exports: 'Re-exported by',
  imports: 'Imported by',
};

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Kinds whose uses are worth one more hop: a value that hands the definition on. */
const HOLDER_KINDS: ReadonlySet<NodeKind> = new Set<NodeKind>(['variable', 'constant', 'property', 'field']);

/** Callable kinds: these get their callees listed. */
const CALLABLE_KINDS: ReadonlySet<NodeKind> = new Set<NodeKind>(['function', 'method', 'component']);

/**
 * The answer for `defs` (from {@link oneSymbolDefinitions}), or null when a
 * definition's own file can't be read — explore's general path then answers,
 * with its handling for files that changed since indexing.
 */
export function renderOneSymbolAnswer(ctx: OneSymbolContext, name: string, defs: readonly Node[]): OneSymbolAnswer | null {
  if (defs.some((d) => ctx.readLines(d.filePath) === null)) return null;
  const collected = defs.map((def) => ({
    def,
    refs: collectReferenceSites(ctx.cg, def, {
      readLines: ctx.readLines,
      unlinkedLimit: FULL_CAPS.unlinked,
      maxScannedFiles: 200,
    }),
  }));

  let caps = FULL_CAPS;
  let bodyChars = ctx.bodyChars;
  const memo: Memo = { holders: new Map(), testNotes: new Map(), callees: new Map() };
  for (let attempt = 0; ; attempt++) {
    const answer = compose(ctx, memo, name, collected, caps, bodyChars);
    if (answer.text.length <= ctx.maxChars || attempt >= 4) {
      if (answer.text.length > ctx.maxChars) answer.text = cutAtLine(answer.text, ctx.maxChars);
      return answer;
    }
    caps = halve(caps);
    bodyChars = Math.floor(bodyChars * 0.7);
  }
}

function halve(c: Caps): Caps {
  const h = (n: number, min: number) => Math.max(min, Math.floor(n / 2));
  return {
    sites: h(c.sites, 5), testFiles: h(c.testFiles, 3), testOwners: h(c.testOwners, 10),
    unlinked: h(c.unlinked, 3), holders: h(c.holders, 1), holderSites: h(c.holderSites, 3),
    callees: h(c.callees, 4), members: h(c.members, 15),
  };
}

function cutAtLine(text: string, max: number): string {
  const cut = text.slice(0, max - 40);
  const at = cut.lastIndexOf('\n');
  return `${at > 0 ? cut.slice(0, at) : cut}\n… (cut to fit the answer's size limit)`;
}

type Collected = { def: Node; refs: SymbolReferences };

/** Lookups that don't depend on the caps, kept across the shrink-to-fit attempts. */
interface Memo {
  holders: Map<string, SymbolReferences | null>;
  testNotes: Map<string, string>;
  callees: Map<string, CallSiteRow[]>;
}

function compose(
  ctx: OneSymbolContext,
  memo: Memo,
  name: string,
  collected: readonly Collected[],
  caps: Caps,
  bodyChars: number,
): OneSymbolAnswer {
  const out: string[] = [];
  const shown: OneSymbolAnswer['shown'] = [];
  const files = new Set<string>();
  const perDefBody = Math.floor(bodyChars / collected.length);
  const perDefCaps = collected.length === 1 ? caps : halve(caps);

  if (collected.length > 1) {
    out.push(`**${collected.length} definitions named \`${name}\`** — each with every place that depends on it.`, '');
  }
  for (const [i, { def, refs }] of collected.entries()) {
    if (i > 0) out.push('---', '');
    renderDefinition(ctx, memo, def, refs, perDefCaps, perDefBody, out, shown, files);
  }
  return { text: out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd(), shown, files: [...files] };
}

function renderDefinition(
  ctx: OneSymbolContext,
  memo: Memo,
  def: Node,
  refs: SymbolReferences,
  caps: Caps,
  bodyChars: number,
  out: string[],
  shown: OneSymbolAnswer['shown'],
  files: Set<string>,
): void {
  const cg = ctx.cg;
  files.add(def.filePath);
  const end = def.endLine ?? def.startLine;
  const span = end > def.startLine ? `${def.startLine}-${end}` : `${def.startLine}`;

  const isTestSite = (s: ReferenceSite) => (s.owner ? ctx.isTest(s.owner) : isTestPath(s.filePath));
  const isEntry = (s: ReferenceSite) => s.relation === 'imports' || s.relation === 'exports';
  const production = refs.sites.filter((s) => !isTestSite(s));
  // A test file's import of the name says nothing its uses don't.
  const tests = refs.sites.filter((s) => isTestSite(s) && !isEntry(s));
  const usageSites = production.filter((s) => !isEntry(s));
  const usageFiles = new Set(usageSites.map((s) => s.filePath));
  const kindLabel = def.kind.replace(/_/g, ' ');
  const summary = usageSites.length > 0
    ? `${plural(usageSites.length, 'site')} in ${plural(usageFiles.size, 'file')} ${usageSites.length === 1 ? 'depends' : 'depend'} on it${tests.length > 0 ? `, plus ${plural(tests.length, 'site')} in tests` : ''}`
    : tests.length > 0
      ? `no references outside tests; ${plural(tests.length, 'site')} in tests`
      : refs.unlinkedTotal > 0
        ? `no reference the index could tie to it; same-named ones it could not tie to any definition are listed below`
        : 'nothing in the index refers to it';
  let memberNames = new Set<string>();
  if (MEMBER_CONTAINER_KINDS.has(def.kind)) {
    try { memberNames = new Set(cg.getChildren(def.id).map((c) => c.name)); } catch { /* none */ }
  }
  out.push(`**\`${displayName(def)}\`** (${kindLabel}) — defined at \`${def.filePath}:${def.startLine}\`; ${summary}.`, '');

  // The definition's source.
  const lines = ctx.readLines(def.filePath)!;
  out.push(`**\`${def.filePath}\`** — \`${def.name}\`, line${end > def.startLine ? 's' : ''} ${span}`, '');
  const body = definitionSource(ctx, def, lines, bodyChars, caps.members);
  out.push('```' + (def.language || ''), body.text, '```');
  if (body.note) out.push(body.note);
  out.push('');
  if (body.cut) {
    out.push(`> Some file sections were trimmed for size: the rest of \`${def.name}\` is one \`codegraph_explore\`${ctx.nodeServed ? ' (or `codegraph_node`)' : ''} away, with the line range named where the body stops.`, '');
  }
  if (body.shownTo >= body.shownFrom) {
    shown.push({ filePath: def.filePath, start: body.shownFrom, end: body.shownTo, chars: body.text.length });
  }

  // Production sites, by relation.
  const listed = usageSites.slice(0, caps.sites);
  let holders = 0;
  for (const relation of ['extends', 'implements', 'overrides', 'instantiates', 'calls', 'uses'] as const) {
    const group = listed.filter((s) => s.relation === relation);
    if (group.length === 0) continue;
    const total = usageSites.filter((s) => s.relation === relation).length;
    const groupFiles = new Set(usageSites.filter((s) => s.relation === relation).map((s) => s.filePath)).size;
    out.push(`**${RELATION_TITLE[relation]}** (${plural(total, 'site')}, ${plural(groupFiles, 'file')})`);
    for (const site of group) {
      files.add(site.filePath);
      out.push(`- ${siteLine(ctx, site)}${redefinedNote(cg, site, memberNames)}`);
      if (holders < caps.holders && site.owner && HOLDER_KINDS.has(site.owner.kind) && site.owner.id !== def.id) {
        const next = holderLine(ctx, memo, site.owner, caps.holderSites, files);
        if (next) { out.push(`  - ${next}`); holders++; }
      }
    }
    out.push('');
  }
  if (usageSites.length > listed.length) {
    const rest = usageSites.slice(listed.length);
    const byFile = countByFile(rest);
    out.push(`+${plural(rest.length, 'more site')} in ${plural(byFile.size, 'file')}: ${[...byFile].slice(0, 12).map(([f, n]) => `\`${f}\` (${n})`).join(', ')}${byFile.size > 12 ? ', …' : ''}`, '');
  }

  // Imports and re-exports: where the name enters a file. The uses are above.
  const entries = production.filter((s) => s.relation === 'imports' || s.relation === 'exports');
  if (entries.length > 0) {
    const shownEntries = entries.slice(0, caps.sites);
    out.push(`**Imported or re-exported in** ${shownEntries.map((s) => `\`${s.filePath}${s.line > 0 ? `:${s.line}` : ''}\``).join(', ')}${entries.length > shownEntries.length ? `, +${entries.length - shownEntries.length} more` : ''}`, '');
  }

  // Test sites: where, compactly.
  if (tests.length > 0) {
    const byFile = new Map<string, ReferenceSite[]>();
    for (const s of tests) {
      const list = byFile.get(s.filePath) ?? [];
      list.push(s);
      byFile.set(s.filePath, list);
    }
    out.push(`**In tests** (${plural(tests.length, 'site')}, ${plural(byFile.size, 'file')})`);
    // Each test by name with its lines, in line order, while the answer has
    // room: "who calls X?" about a function only tests call is a list of them.
    let named = 0;
    for (const [filePath, sites] of [...byFile].sort(([a], [b]) => a.localeCompare(b)).slice(0, caps.testFiles)) {
      const byOwner = new Map<string, { owner: Node | null; lines: number[] }>();
      for (const s of [...sites].sort((a, b) => a.line - b.line)) {
        const key = s.owner && s.owner.kind !== 'file' ? s.owner.id : '';
        const entry = byOwner.get(key) ?? { owner: key ? s.owner : null, lines: [] };
        if (s.line > 0 && !entry.lines.includes(s.line)) entry.lines.push(s.line);
        byOwner.set(key, entry);
      }
      const entries = [...byOwner.values()];
      const shownEntries = entries.slice(0, Math.max(0, caps.testOwners - named));
      named += shownEntries.length;
      const lineList = (lines: number[]) =>
        `${lines.slice(0, MAX_LINES_PER_TEST).join(', ')}${lines.length > MAX_LINES_PER_TEST ? `, +${lines.length - MAX_LINES_PER_TEST} more` : ''}`;
      const shown = shownEntries
        .map((e) => (e.owner ? `\`${displayName(e.owner)}\`${e.lines.length > 0 ? ` (${lineList(e.lines)})` : ''}` : lineList(e.lines)))
        .filter(Boolean)
        .join(', ');
      const rest = entries.length - shownEntries.length;
      const more = rest > 0 ? `${shown ? ', ' : ''}+${rest} more` : '';
      out.push(`- \`${filePath}\`${shown || more ? `: ${shown}${more}` : ''}`);
    }
    if (byFile.size > caps.testFiles) out.push(`- +${plural(byFile.size - caps.testFiles, 'more file')}`);
    out.push('');
  } else if (usageSites.length > 0) {
    // No test names it: say whether tests reach it through its dependents.
    let note = memo.testNotes.get(def.id);
    if (note === undefined) {
      const dependents = [...new Map(usageSites.filter((s) => s.owner).map((s) => [s.owner!.id, s.owner!])).values()];
      note = dependents.length > 0 ? ctx.testsThroughCallers(dependents) : '';
      memo.testNotes.set(def.id, note);
    }
    if (note) out.push(`**Tests** — none refer to it directly; ${note}.`, '');
  }

  // Same-named references the resolver could not tie to a definition.
  if (refs.unlinked.length > 0) {
    renderUnlinked(ctx, def, refs.unlinked, refs.unlinkedTotal, caps.unlinked, out, files);
  }

  // What it calls.
  if (CALLABLE_KINDS.has(def.kind)) {
    let callees = memo.callees.get(def.id);
    if (!callees) {
      try { callees = cg.getCallSites(def.id, 'callees').filter((r) => !r.recursive); } catch { callees = []; }
      memo.callees.set(def.id, callees);
    }
    if (callees.length > 0) {
      const shownCallees = callees.slice(0, caps.callees).map((r) => {
        const synth = ctx.synthNote(r.edges[0]!);
        return `\`${displayName(r.node)}\` (\`${r.node.filePath}:${r.node.startLine}\`)${synth ? ` [${synth}]` : ''}`;
      });
      out.push(`**Calls** ${shownCallees.join(', ')}${callees.length > caps.callees ? `, +${callees.length - caps.callees} more` : ''}`, '');
    }
  }

  const total = usageSites.length + tests.length;
  const unlinkedPart = refs.unlinkedTotal > 0 ? ', plus the same-named references it could not tie to a definition' : '';
  out.push(total === 0 && refs.unlinkedTotal === 0
    ? `> The index holds no reference to \`${def.name}\` anywhere in the code.`
    : total === 1
      ? `> This is the one place the index holds that refers to \`${def.name}\`, with its line${unlinkedPart}. Treat this as the grep for the name and a Read of the site.`
      : `> These are all ${total} places the index holds that refer to \`${def.name}\`, each with its line${unlinkedPart}. Treat this as the grep for the name and a Read of every site.`, '');
}

/**
 * For a subclass or implementer: the members it defines that the definition
 * also has — what a change to those members reaches. Empty for other sites.
 */
function redefinedNote(cg: CodeGraph, site: ReferenceSite, memberNames: ReadonlySet<string>): string {
  if (memberNames.size === 0 || !site.owner) return '';
  if (site.relation !== 'extends' && site.relation !== 'implements') return '';
  let shared: string[] = [];
  try {
    shared = [...new Set(cg.getChildren(site.owner.id).map((c) => c.name))].filter((n) => memberNames.has(n));
  } catch { /* none */ }
  if (shared.length === 0) return '';
  const shown = shared.slice(0, 10).map((n) => `\`${n}\``).join(', ');
  return ` — also defines ${shown}${shared.length > 10 ? `, +${shared.length - 10} more` : ''}`;
}

/** `ModelAdmin._changeform_view` — `options.py:2070`: `if to_field and not …` */
function siteLine(ctx: OneSymbolContext, site: ReferenceSite): string {
  const where = `\`${site.filePath}${site.line > 0 ? `:${site.line}` : site.owner ? `:${site.owner.startLine}` : ''}\``;
  const who = site.owner ? `\`${displayName(site.owner)}\` — ` : '';
  const text = site.line > 0 ? siteText(ctx.readLines(site.filePath), site.line) : null;
  const synth = site.edge ? ctx.synthNote(site.edge) : null;
  return `${who}${where}${text ? `: ${inlineCode(text)}` : ''}${synth ? ` [${synth}]` : ''}`;
}

/**
 * One more hop for a value that holds the definition (`var Query = queryBinding{}`):
 * who uses that value. Null when nothing does.
 */
function holderLine(ctx: OneSymbolContext, memo: Memo, holder: Node, cap: number, files: Set<string>): string | null {
  let refs = memo.holders.get(holder.id);
  if (refs === undefined) {
    try {
      refs = collectReferenceSites(ctx.cg, holder, { readLines: ctx.readLines, unlinkedLimit: 0, maxScannedFiles: 20 });
    } catch {
      refs = null;
    }
    memo.holders.set(holder.id, refs);
  }
  if (!refs) return null;
  const uses = refs.sites.filter((s) => s.relation !== 'imports' && s.relation !== 'exports' && s.owner?.id !== holder.id);
  if (uses.length === 0) return null;
  const isTestSite = (s: ReferenceSite) => (s.owner ? ctx.isTest(s.owner) : isTestPath(s.filePath));
  const production = uses.filter((s) => !isTestSite(s));
  const testCount = uses.length - production.length;
  const shownUses = production.slice(0, cap).map((s) => {
    files.add(s.filePath);
    return `${s.owner ? `\`${displayName(s.owner)}\` ` : ''}(\`${s.filePath}${s.line > 0 ? `:${s.line}` : ''}\`)`;
  });
  const more = production.length > cap ? `, +${production.length - cap} more` : '';
  const testPart = testCount > 0 ? `${shownUses.length > 0 ? '; ' : ''}${plural(testCount, 'site')} in tests` : '';
  return `\`${holder.name}\` is used by ${shownUses.join(', ')}${more}${testPart}`;
}

function renderUnlinked(
  ctx: OneSymbolContext,
  def: Node,
  unlinked: readonly UnresolvedReference[],
  total: number,
  cap: number,
  out: string[],
  files: Set<string>,
): void {
  const owners = ctx.cg.getNodesByIds([...new Set(unlinked.map((r) => r.fromNodeId))]);
  let member = false;
  try { member = memberContainer(ctx.cg, def) !== null; } catch { /* top-level */ }
  out.push(`**Other \`${def.name}\` references the index could not tie to a definition** (${total})${member
    ? ' — called on a value whose type it could not work out (an interface, a parameter, another type), so each may or may not reach this one:'
    : ':'}`);
  for (const r of unlinked.slice(0, cap)) {
    const owner = owners.get(r.fromNodeId);
    const filePath = r.filePath ?? owner?.filePath ?? '';
    files.add(filePath);
    const text = siteText(ctx.readLines(filePath), r.line);
    const who = owner && owner.kind !== 'file' ? `\`${displayName(owner)}\` — ` : '';
    out.push(`- ${who}\`${filePath}:${r.line}\`${text ? `: ${inlineCode(text)}` : ''}`);
  }
  if (total > Math.min(cap, unlinked.length)) out.push(`- +${total - Math.min(cap, unlinked.length)} more`);
  out.push('');
}

function countByFile(sites: readonly ReferenceSite[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const s of sites) counts.set(s.filePath, (counts.get(s.filePath) ?? 0) + 1);
  return counts;
}

/**
 * The definition's source, line-numbered: all of it when it fits `budget`. A
 * short definition (a constant, one line) brings two lines either side; a long
 * function is cut with a note naming the explore query for the rest; a class
 * too big for the budget shows its head and a member list.
 */
function definitionSource(
  ctx: OneSymbolContext,
  def: Node,
  lines: readonly string[],
  budget: number,
  maxMembers: number,
): { text: string; note: string | null; cut: boolean; shownFrom: number; shownTo: number } {
  const end = Math.min(def.endLine ?? def.startLine, lines.length);
  const start = Math.max(1, Math.min(def.startLine, end));
  const numbered = (from: number, to: number) => {
    const rows: string[] = [];
    for (let ln = from; ln <= to; ln++) rows.push(`${ln}\t${lines[ln - 1] ?? ''}`);
    return rows.join('\n');
  };
  if (end - start <= 2) {
    const from = Math.max(1, start - 2);
    const to = Math.min(lines.length, end + 2);
    return { text: numbered(from, to), note: null, cut: false, shownFrom: from, shownTo: to };
  }
  const whole = numbered(start, end);
  if (whole.length <= budget) return { text: whole, note: null, cut: false, shownFrom: start, shownTo: end };

  if (MEMBER_CONTAINER_KINDS.has(def.kind) || def.kind === 'module' || def.kind === 'namespace') {
    let children: Node[] = [];
    try {
      children = ctx.cg.getChildren(def.id)
        .filter((c) => c.kind !== 'import' && c.kind !== 'export')
        .sort((a, b) => a.startLine - b.startLine);
    } catch { /* none */ }
    if (children.length > 0) {
      const headEnd = Math.max(start, Math.min(end, children[0]!.startLine - 1, start + 15));
      const head = numbered(start, headEnd);
      const memberLines = children.slice(0, maxMembers).map((c) =>
        `- \`${c.name}\` (${c.kind.replace(/_/g, ' ')}) :${c.startLine}${c.signature ? ` — ${inlineCode(c.signature.length > 140 ? `${c.signature.slice(0, 139)}…` : c.signature)}` : ''}`);
      const more = children.length > maxMembers ? `\n- +${children.length - maxMembers} more members` : '';
      const note = `\n**Members** (${children.length}) — the body is ${end - start + 1} lines; codegraph_explore \`${def.name}.<member>\` returns a member's source, or \`${def.filePath}:<from>-<to>\` a span:\n${memberLines.join('\n')}${more}`;
      return { text: head, note, cut: false, shownFrom: start, shownTo: headEnd };
    }
  }
  // A long body: as many lines as fit, then — inside the block, where the
  // body stops — the explore query that returns the rest.
  let to = start;
  let size = 0;
  for (let ln = start; ln <= end; ln++) {
    const row = `${ln}\t${lines[ln - 1] ?? ''}`.length + 1;
    if (size + row > budget && ln > start) break;
    size += row;
    to = ln;
  }
  const rest = to < end ? ctx.elidedNote(def.filePath, def.name, to + 1, end) : '';
  return { text: numbered(start, to) + rest, note: null, cut: to < end, shownFrom: start, shownTo: to };
}
