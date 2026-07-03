/**
 * COBOL Language Extractor
 *
 * COBOL's AST (vendored, patched build of yutaro-sakamoto/tree-sitter-cobol)
 * is fundamentally different from block-structured languages, so extraction
 * runs almost entirely through the custom visitNode hook (the Pascal pattern):
 *
 * - A program (PROGRAM-ID) becomes a `module` node.
 * - PROCEDURE DIVISION sections and paragraphs become `function` nodes. The
 *   grammar emits them FLAT — a section_header/paragraph_header followed by
 *   sibling statements — so extents are reconstructed here: a paragraph runs
 *   from its header to the next header, a section to the next section header.
 * - PERFORM (including THRU ranges), GO TO, and CALL 'literal' become `calls`
 *   references. A dynamic CALL through a data name is skipped — announce,
 *   don't guess. EXEC CICS LINK/XCTL PROGRAM('X') with a literal target also
 *   becomes a `calls` reference; EXEC SQL INCLUDE X becomes an `imports`
 *   reference (DB2's COPY).
 * - COPY statements become `import` nodes + `imports` references.
 * - DATA DIVISION entries become `variable` (01/77 levels), `field` (nested
 *   levels, contained in their group item), or `constant` (88-level condition
 *   names) nodes, so impact queries on working-storage names work.
 * - Standalone copybooks (.cpy) parse via the grammar's copybook_fragment
 *   entry point: data copybooks yield their record structure, procedure
 *   copybooks yield paragraphs.
 *
 * The grammar is fixed-format (code area columns 8-72). preParse detects a
 * free-format file (division header or level number starting before column 8)
 * and indents every line by 7 spaces: line numbers are preserved, columns
 * drift by 7 — acceptable for line-oriented consumers.
 */

import type { Node as SyntaxNode } from 'web-tree-sitter';
import { getNodeText, getChildByField } from '../tree-sitter-helpers';
import type { ExtractorContext, LanguageExtractor } from '../tree-sitter-types';

/** EXEC CICS LINK/XCTL — program target, quoted literal or data name. */
const EXEC_CICS_PROGRAM_RE =
  /\b(?:LINK|XCTL)\b[\s\S]*?\bPROGRAM\s*\(\s*(?:['"]([A-Za-z0-9$#@-]+)['"]|([A-Za-z0-9-]+))\s*\)/i;
/** EXEC CICS RETURN/START — next transaction, quoted literal or data name. */
const EXEC_CICS_TRANSID_RE =
  /\b(?:RETURN|START)\b[\s\S]*?\bTRANSID\s*\(\s*(?:['"]([A-Za-z0-9$#@]{1,4})['"]|([A-Za-z0-9-]+))\s*\)/i;
/** EXEC SQL INCLUDE <member> — the SQL flavor of COPY. */
const EXEC_SQL_INCLUDE_RE = /\bSQL\b[\s\S]*?\bINCLUDE\s+([A-Za-z0-9$#@-]+)/i;
/** The VALUE literal in a data item's signature ("PIC X(04) VALUE 'CB00'"). */
const VALUE_LITERAL_RE = /\bVALUE\s+['"]([A-Za-z0-9$#@-]+)['"]/i;

function line(node: SyntaxNode): number {
  return node.startPosition.row + 1;
}

function endLineOf(node: SyntaxNode): number {
  return node.endPosition.row + 1;
}

/** Collapse whitespace runs so multi-line clauses read as one signature. */
function collapse(text: string, cap = 120): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > cap ? flat.slice(0, cap - 1) + '…' : flat;
}

function currentScope(ctx: ExtractorContext): string | undefined {
  return ctx.nodeStack[ctx.nodeStack.length - 1];
}

/**
 * DB2 convention writes `EXEC SQL INCLUDE member END-EXEC` with no sentence
 * period, sitting between paragraphs like a COPY — which derails the
 * grammar's sentence machinery. Terminate the single-line form by writing a
 * period into the character right after END-EXEC (a space), or appending one
 * at end of line. Both are offset-preserving for every other character.
 */
function terminateSqlIncludes(source: string): string {
  const lineRe = /^([ \t]*(?:[0-9]{6})?[ \t]+EXEC\s+SQL\s+INCLUDE\s+[A-Za-z0-9$#@-]+\s+END-EXEC)([ \t]|$)/i;
  return source
    .split('\n')
    .map((l) => {
      if (!/END-EXEC/i.test(l) || /END-EXEC\s*\./i.test(l)) return l;
      const m = lineRe.exec(l);
      if (!m) return l;
      const head = m[1]!;
      return m[2] === '' ? head + '.' : head + '.' + l.slice(head.length + 1);
    })
    .join('\n');
}

function addRef(
  ctx: ExtractorContext,
  fromNodeId: string | undefined,
  referenceName: string,
  referenceKind: 'calls' | 'imports' | 'references',
  at: SyntaxNode
): void {
  if (!fromNodeId || !referenceName) return;
  ctx.addUnresolvedReference({
    fromNodeId,
    referenceName,
    referenceKind,
    line: line(at),
    column: at.startPosition.column,
  });
}

/** COPY <book> [IN/OF lib] — import node + imports reference. */
function handleCopy(node: SyntaxNode, ctx: ExtractorContext): void {
  const book = getChildByField(node, 'book');
  if (!book) return;
  const name = getNodeText(book, ctx.source)
    .trim()
    .replace(/^['"]|['"]$/g, '');
  if (!name) return;
  ctx.createNode('import', name, node, {
    signature: collapse(getNodeText(node, ctx.source)),
  });
  addRef(ctx, currentScope(ctx), name, 'imports', node);
}

/**
 * A CICS option can name its target through a data item instead of a
 * literal (`TRANSID(WS-TRANID)` with `05 WS-TRANID ... VALUE 'CB00'`).
 * Dereference it against the SAME FILE's already-extracted data items —
 * the DATA DIVISION precedes the PROCEDURE DIVISION, so they are in
 * ctx.nodes by the time EXEC blocks are mined. Anything else (copybook
 * arrays, computed names) is dynamic dispatch: skipped, not guessed.
 */
function derefSameFileValue(name: string, ctx: ExtractorContext): string | undefined {
  const upper = name.toUpperCase();
  for (const node of ctx.nodes) {
    if (node.filePath !== ctx.filePath) continue;
    if (node.kind !== 'variable' && node.kind !== 'field' && node.kind !== 'constant') continue;
    if (node.name.toUpperCase() !== upper) continue;
    const value = node.signature ? VALUE_LITERAL_RE.exec(node.signature) : null;
    return value?.[1];
  }
  return undefined;
}

/**
 * EXEC ... END-EXEC blocks are opaque single nodes. Mine the text for the
 * statically-resolvable shapes: CICS LINK/XCTL to a program (cross-program
 * call), CICS RETURN/START TRANSID (the pseudo-conversational hop — emitted
 * as a `cics-transid:XXXX` reference the CICS framework resolver maps to
 * the owning program), and SQL INCLUDE (a copybook import).
 */
function handleExec(
  node: SyntaxNode,
  ctx: ExtractorContext,
  fromNodeId: string | undefined
): void {
  const text = getNodeText(node, ctx.source);
  const cics = EXEC_CICS_PROGRAM_RE.exec(text);
  if (cics) {
    const program = cics[1] ?? (cics[2] ? derefSameFileValue(cics[2], ctx) : undefined);
    if (program) addRef(ctx, fromNodeId, program, 'calls', node);
  }
  const transid = EXEC_CICS_TRANSID_RE.exec(text);
  if (transid) {
    const tx = transid[1] ?? (transid[2] ? derefSameFileValue(transid[2], ctx) : undefined);
    if (tx && /^[A-Za-z0-9$#@]{1,4}$/.test(tx)) {
      addRef(ctx, fromNodeId, `cics-transid:${tx.toUpperCase()}`, 'calls', node);
    }
  }
  const include = EXEC_SQL_INCLUDE_RE.exec(text);
  if (include?.[1]) {
    ctx.createNode('import', include[1], node, {
      signature: collapse(text),
    });
    addRef(ctx, fromNodeId ?? currentScope(ctx), include[1], 'imports', node);
  }
}

/**
 * Walk a run of DATA DIVISION entries (working-storage section children or a
 * record_description_list). Level numbers drive nesting: an entry closes all
 * open entries with level >= its own. 88-level condition names attach to the
 * open item as constants and never open a scope.
 */
function walkDataEntries(entries: SyntaxNode[], ctx: ExtractorContext): void {
  interface Item {
    node: SyntaxNode;
    level: number;
    name: string | null;
  }
  const items: (Item | null)[] = entries.map((e) => {
    if (e.type !== 'data_description') return null;
    const levelNode = e.namedChildren.find((c: SyntaxNode) => c?.type === 'level_number');
    const nameNode = e.namedChildren.find((c: SyntaxNode) => c?.type === 'entry_name');
    const level = levelNode ? parseInt(getNodeText(levelNode, ctx.source), 10) : NaN;
    const name = nameNode ? getNodeText(nameNode, ctx.source).trim() : null;
    return { node: e, level: Number.isFinite(level) ? level : 1, name };
  });

  /** Levels 01, 66, and 77 always open at top level, whatever came before. */
  const isTopLevel = (level: number): boolean => level === 1 || level === 66 || level === 77;

  /** A group item extends to the last entry before the next level <= its own. */
  const groupEnd = (i: number): number => {
    const self = items[i]!;
    let end = endLineOf(self.node);
    for (let j = i + 1; j < entries.length; j++) {
      const it = items[j];
      if (!it) continue;
      if (it.level !== 88 && (it.level <= self.level || isTopLevel(it.level))) break;
      end = Math.max(end, endLineOf(it.node));
    }
    return end;
  };

  const open: { level: number }[] = [];
  let pushed = 0;
  const closeTo = (level: number) => {
    while (open.length > 0 && open[open.length - 1]!.level >= level) {
      open.pop();
      ctx.popScope();
      pushed--;
    }
  };

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    if (entry.type === 'copy_statement') {
      handleCopy(entry, ctx);
      continue;
    }
    if (entry.type === 'exec_statement') {
      handleExec(entry, ctx, currentScope(ctx));
      continue;
    }
    const item = items[i];
    if (!item) continue;

    const isCondition = item.level === 88;
    if (!isCondition) closeTo(isTopLevel(item.level) ? 0 : item.level);

    // FILLER / unnamed entries carry no symbol; they only occupy layout space.
    if (!item.name || /^FILLER$/i.test(item.name)) continue;

    const kind = isCondition ? 'constant' : open.length === 0 ? 'variable' : 'field';
    const created = ctx.createNode(kind, item.name, item.node, {
      endLine: isCondition ? endLineOf(item.node) : groupEnd(i),
      signature: collapse(getNodeText(item.node, ctx.source)),
    });
    if (created && !isCondition) {
      ctx.pushScope(created.id);
      open.push({ level: item.level });
      pushed++;
    }
  }
  while (pushed > 0) {
    ctx.popScope();
    pushed--;
  }
}

/**
 * Special registers and CICS/SQL communication areas — writes to these are
 * runtime plumbing, not project data flow; referencing them would only mint
 * dangling refs (they have no declaration node).
 */
const SPECIAL_REGISTER_RE = /^(RETURN-CODE|SQLCODE|SQLSTATE|TALLY|EIB[A-Z-]+|DFH[A-Z-]+|WHEN-COMPILED|LENGTH|ADDRESS)$/i;

/** The base data name of an assignment target (first WORD, ignoring subscripts/OF-qualifiers). */
function targetBaseName(target: SyntaxNode, source: string): SyntaxNode | null {
  if (target.type === 'WORD') return target;
  for (const child of target.namedChildren) {
    if (!child) continue;
    const found = targetBaseName(child, source);
    if (found) return found;
  }
  return null;
}

/**
 * Emit a `references` ref for every data item a statement WRITES (MOVE TO,
 * ADD TO/GIVING, SUBTRACT FROM/GIVING, COMPUTE =). Write-sites are what an
 * impact query on a working-storage or copybook field needs: "what changes
 * WS-TOTAL" is the COBOL analogue of value-reference edges. Read operands
 * are deliberately not tracked — they would multiply edge volume for little
 * impact value.
 */
function emitWriteRefs(
  statement: SyntaxNode,
  fields: string[],
  fromNodeId: string | undefined,
  ctx: ExtractorContext
): void {
  for (const field of fields) {
    for (const target of statement.childrenForFieldName(field)) {
      if (!target) continue;
      const word = targetBaseName(target, ctx.source);
      if (!word) continue;
      const name = getNodeText(word, ctx.source).trim();
      if (!name || SPECIAL_REGISTER_RE.test(name)) continue;
      addRef(ctx, fromNodeId, name, 'references', word);
    }
  }
}

/**
 * Collect call/import references from a statement subtree, attributed to the
 * enclosing paragraph/section (or the program when no paragraph is open).
 */
function collectRefs(
  node: SyntaxNode,
  fromNodeId: string | undefined,
  ctx: ExtractorContext
): void {
  switch (node.type) {
    case 'move_statement':
      emitWriteRefs(node, ['dst'], fromNodeId, ctx);
      return;
    case 'add_statement':
      emitWriteRefs(node, ['to', 'giving'], fromNodeId, ctx);
      return;
    case 'compute_statement':
      emitWriteRefs(node, ['left'], fromNodeId, ctx);
      return;
    case 'subtract_statement': {
      // SUBTRACT x FROM t — `from` is the target; with GIVING, `giving` is.
      const hasGiving = node.childrenForFieldName('giving').length > 0;
      emitWriteRefs(node, [hasGiving ? 'giving' : 'from'], fromNodeId, ctx);
      return;
    }
    case 'perform_statement_call_proc': {
      // PERFORM A [THRU B] — every label is a paragraph/section call target.
      const proc = getChildByField(node, 'procedure');
      if (proc) {
        for (const label of proc.namedChildren) {
          if (label?.type !== 'label') continue;
          const name = getNodeText(label, ctx.source).trim();
          addRef(ctx, fromNodeId, name, 'calls', label);
        }
      }
      return;
    }
    case 'call_statement': {
      // CALL 'PROG' — static cross-program call. CALL data-name is dynamic
      // dispatch through a variable: skipped (announce, don't guess).
      const x = getChildByField(node, 'x');
      if (x?.type === 'string') {
        const name = getNodeText(x, ctx.source).replace(/^['"]|['"]$/g, '').trim();
        addRef(ctx, fromNodeId, name, 'calls', x);
      }
      return;
    }
    case 'goto_statement': {
      const to = getChildByField(node, 'to');
      if (to) {
        addRef(ctx, fromNodeId, getNodeText(to, ctx.source).trim(), 'calls', to);
      }
      return;
    }
    case 'exec_statement':
      handleExec(node, ctx, fromNodeId);
      return;
    case 'copy_statement':
      handleCopy(node, ctx);
      return;
    default:
      for (const child of node.namedChildren) {
        if (child) collectRefs(child, fromNodeId, ctx);
      }
  }
}

/** "PARA-NAME." → "PARA-NAME"; "SEC-NAME SECTION." → "SEC-NAME". */
function headerName(header: SyntaxNode, source: string): string {
  const text = getNodeText(header, source).trim().replace(/\.$/, '').trim();
  return text.split(/\s+/)[0] ?? text;
}

/**
 * Walk the flat PROCEDURE DIVISION (or a procedure copybook fragment):
 * reconstruct section/paragraph extents from header positions and attribute
 * the sibling statements between headers to the open paragraph.
 */
function walkProcedureChildren(
  children: SyntaxNode[],
  divisionEndLine: number,
  ctx: ExtractorContext
): void {
  /** 1-based last line of the region started at children[i]. */
  const regionEnd = (i: number, sectionsOnly: boolean): number => {
    for (let j = i + 1; j < children.length; j++) {
      const c = children[j]!;
      if (c.type === 'section_header' || (!sectionsOnly && c.type === 'paragraph_header')) {
        // Header starts at 0-based row R → the region ends on 1-based line R.
        return Math.max(c.startPosition.row, line(children[i]!));
      }
    }
    return divisionEndLine;
  };

  let currentFnId = currentScope(ctx);
  let sectionPushed = false;

  for (let i = 0; i < children.length; i++) {
    const child = children[i]!;
    if (child.type === 'section_header') {
      if (sectionPushed) {
        ctx.popScope();
        sectionPushed = false;
      }
      const created = ctx.createNode('function', headerName(child, ctx.source), child, {
        endLine: regionEnd(i, true),
        signature: 'SECTION',
      });
      if (created) {
        ctx.pushScope(created.id);
        sectionPushed = true;
        currentFnId = created.id;
      }
    } else if (child.type === 'paragraph_header') {
      const created = ctx.createNode('function', headerName(child, ctx.source), child, {
        endLine: regionEnd(i, false),
      });
      if (created) currentFnId = created.id;
    } else {
      collectRefs(child, currentFnId, ctx);
    }
  }
  if (sectionPushed) ctx.popScope();
}

/** Program name from identification_division > program_name. */
function programName(programNode: SyntaxNode, source: string): string | null {
  const idDiv = programNode.namedChildren.find(
    (c: SyntaxNode) => c?.type === 'identification_division'
  );
  const nameNode = idDiv?.namedChildren.find((c: SyntaxNode) => c?.type === 'program_name');
  if (!nameNode) return null;
  return getNodeText(nameNode, source).trim().replace(/^['"]|['"]$/g, '').replace(/\.$/, '');
}

export const cobolExtractor: LanguageExtractor = {
  // All extraction flows through the visitNode hook — COBOL's flat,
  // column-oriented AST doesn't fit the generic type-list dispatch.
  functionTypes: [],
  classTypes: [],
  methodTypes: [],
  interfaceTypes: [],
  structTypes: [],
  enumTypes: [],
  typeAliasTypes: [],
  importTypes: [],
  callTypes: [],
  variableTypes: [],
  nameField: 'name',
  bodyField: 'body',
  paramsField: 'parameters',

  preParse: (source: string) => {
    // The grammar implements fixed-format column rules (sequence area 1-6,
    // indicator 7, code 8-72). A free-format file — where real code starts
    // before column 8 — would have its first characters eaten as sequence
    // area, corrupting the whole parse. Scan for a decisive marker line
    // (division header, PROGRAM-ID, or a level-number entry) preceded only
    // by whitespace: if it opens before column 8 the file is free-format,
    // and every line is shifted right by 7 spaces. Line numbers are
    // preserved; columns drift by 7 (consumers are line-oriented). A
    // sequence-numbered fixed file never matches — its columns 1-6 hold
    // digits, not whitespace.
    const marker =
      /^([ \t]*)(IDENTIFICATION\s+DIVISION|ID\s+DIVISION|PROGRAM-ID\b|\d{2}[ \t]+[A-Za-z])/i;
    let freeFormat = false;
    for (const l of source.split(/\r?\n/)) {
      const m = marker.exec(l);
      if (!m) continue;
      freeFormat = m[1]!.length < 7;
      break;
    }
    if (!freeFormat) return terminateSqlIncludes(source);
    // "CGWIDE" in the first line's sequence area tells the scanner to relax
    // the column-72 right margin — free-format lines routinely exceed it,
    // and truncating them there would corrupt strings and statements.
    return terminateSqlIncludes(
      source
        .split('\n')
        .map((l, i) => {
          if (i === 0) return 'CGWIDE ' + l;
          return l.length > 0 ? '       ' + l : l;
        })
        .join('\n')
    );
  },

  visitNode: (node: SyntaxNode, ctx: ExtractorContext): boolean => {
    switch (node.type) {
      case 'program_definition': {
        const name = programName(node, ctx.source);
        const moduleNode = name ? ctx.createNode('module', name, node) : null;
        if (moduleNode) ctx.pushScope(moduleNode.id);
        for (const child of node.namedChildren) {
          if (child) ctx.visitNode(child);
        }
        if (moduleNode) ctx.popScope();
        return true;
      }
      case 'procedure_division': {
        walkProcedureChildren(node.namedChildren.filter(Boolean) as SyntaxNode[], endLineOf(node), ctx);
        return true;
      }
      case 'working_storage_section':
      case 'record_description_list': {
        walkDataEntries(node.namedChildren.filter(Boolean) as SyntaxNode[], ctx);
        return true;
      }
      case 'copybook_fragment': {
        const children = node.namedChildren.filter(Boolean) as SyntaxNode[];
        if (children.some((c) => c.type === 'record_description_list')) {
          for (const child of children) ctx.visitNode(child);
        } else {
          // Procedure copybook: paragraphs + statements, flat under the fragment.
          walkProcedureChildren(children, endLineOf(node), ctx);
        }
        return true;
      }
      case 'copy_statement':
        handleCopy(node, ctx);
        return true;
      case 'exec_statement':
        handleExec(node, ctx, currentScope(ctx));
        return true;
      default:
        return false;
    }
  },
};
