/**
 * COBOL copybooks a query names — one derivation of "the agent asked about
 * copybook X" (#2342).
 *
 * The COBOL extractor records every `COPY X` and `EXEC SQL INCLUDE X` as an
 * `import` node named X sitting on the include statement, and the resolver
 * links X to the indexed copybook file (`X.cpy`, …) with an `imports` edge
 * from the including scope. That `import` node is not the low-information
 * line an `import { Foo } from './foo'` is in JavaScript: a copybook member
 * name is how COBOL code is talked about, and the include statement is half of
 * the answer to a question about it. So a query token that names a copybook
 * asks for two things:
 *
 *  - the copybook's own source, when it is indexed (the record layout, the SQL
 *    host variables, the shared paragraphs), and
 *  - every statement that includes it — where that layout is pulled in, which
 *    is what changing it would touch.
 *
 * A member whose source is not in the project (a DB2 DCLGEN member, a
 * compiler-supplied copybook such as SQLCA or DFHAID) has include sites and no
 * file, and saying so is part of the answer too: it tells the reader there is
 * no copybook source here to go looking for.
 *
 * Shared by the context builder (entry points for `codegraph_explore` and
 * `codegraph context`) and by explore's renderer (pinning the copybook, listing
 * its include sites), so the two read one answer and cannot drift apart.
 */

import type { Edge, EdgeKind, Node } from '../types';

/** The queries this derivation needs — satisfied by `QueryBuilder`. */
export interface CopybookLookup {
  hasFilesOfLanguage(language: string): boolean;
  getCobolIncludesByMember(member: string, limit: number): Node[];
  getCobolFilesByStem(member: string): Node[];
  getIncomingEdges(targetId: string, kinds?: EdgeKind[]): Edge[];
}

/** One copybook member the query names, with what the index knows about it. */
export interface NamedCopybook {
  /** The member as the query spelled it. */
  member: string;
  /**
   * The indexed copybook file(s) the member resolves to — a `.cpy` file, or
   * any COBOL file an include actually resolved to. Empty when the member's
   * source is not indexed.
   */
  files: Node[];
  /** Every `COPY` / `EXEC SQL INCLUDE` statement naming the member, in file/line order. */
  includes: Node[];
}

/**
 * Most include statements gathered per member. A shared copybook in a large
 * estate is included by hundreds of programs; past this the list is a count.
 */
export const MAX_COPYBOOK_INCLUDES = 200;

/** Most query tokens looked up — a pasted paragraph must not become 200 probes. */
const MAX_MEMBER_TOKENS = 16;

/**
 * A COBOL word: letters, digits, hyphens and the national characters `$ # @`
 * (`CVACT01Y`, `CUST-REC`, `DFH$AID`). Wider than the identifier shapes the
 * generic symbol extraction knows — a copybook name with a digit in it
 * (`CVACT01Y`) was never extracted as a symbol at all.
 */
const COBOL_WORD = /[A-Za-z0-9$#@][A-Za-z0-9$#@-]*/g;

/**
 * The query's tokens that could name a copybook member. In a longer query a
 * plain lowercase word is skipped: `customer` in a prose question is English,
 * while a member name is written the way the code writes it (`CUSTOMER`,
 * `cvact01y`) — the same rule explore's own symbol seeding applies to bare
 * words. A query that is one word is a name lookup whatever its case
 * (`lgpolicy`, after the file `lgpolicy.cpy`).
 */
export function copybookMemberTokens(query: string): string[] {
  const words = (query.match(COBOL_WORD) ?? []).map((raw) => raw.replace(/-+$/, ''));
  const lone = words.length === 1;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const token of words) {
    if (token.length < 3 || !/[A-Za-z]/.test(token) || (!lone && /^[a-z]+$/.test(token))) continue;
    const key = token.toUpperCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(token);
    if (out.length >= MAX_MEMBER_TOKENS) break;
  }
  return out;
}

/**
 * Is this node a COBOL copybook include — the statement `COPY X` /
 * `EXEC SQL INCLUDE X` — rather than an import in any other language?
 */
export function isCopybookInclude(node: Pick<Node, 'kind' | 'language'>): boolean {
  return node.kind === 'import' && node.language === 'cobol';
}

/**
 * The copybooks `query` names. A token qualifies when the index holds a COBOL
 * include of that member or a copybook file with that name. A project without
 * COBOL answers after one index seek, so every other language's queries are
 * untouched.
 */
export function findNamedCopybooks(lookup: CopybookLookup, query: string): NamedCopybook[] {
  const tokens = copybookMemberTokens(query);
  if (tokens.length === 0 || !lookup.hasFilesOfLanguage('cobol')) return [];
  const named: NamedCopybook[] = [];
  for (const member of tokens) {
    const includes = lookup.getCobolIncludesByMember(member, MAX_COPYBOOK_INCLUDES);
    // A same-named PROGRAM (`COACTUPC.cbl` for the query `COACTUPC`) is not a
    // copybook: only a `.cpy` file, or a file some include resolved to, is.
    const files = lookup.getCobolFilesByStem(member).filter((file) =>
      /\.cpy$/i.test(file.filePath) || lookup.getIncomingEdges(file.id, ['imports']).length > 0);
    if (includes.length === 0 && files.length === 0) continue;
    named.push({ member, files, includes });
  }
  return named;
}
