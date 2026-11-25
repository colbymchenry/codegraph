/**
 * Offset-preserving source fixes the Pascal grammar needs before it parses a
 * Delphi unit (the extractor's `preParse`). Each one blanks syntax the grammar
 * has no rule for with spaces, or writes a word it knows in its place, keeping
 * every newline, so node positions and text stay where they are.
 *
 * - An attribute on a routine parameter, before or after its modifier:
 *   `const [ref] AValue: Integer`, `[ref] const Source: TVarData`,
 *   `const [MVCFromBody] Person: TPerson`, `[MVCFromQueryString('q', '')] Q: string`.
 *   The grammar's parameter rule takes no attribute, so the parse fell apart
 *   at the `[` and every member declared after it in the class was lost.
 *   The extractor reads nothing from an attribute, and a signature still
 *   shows it: Pascal signatures read the source as written.
 * - The inline variable of a `for … in` loop (Delphi 10.3): `for var lItem in
 *   AList do`, `for var lHandle: THandle in lHandles do`. The grammar's for-in
 *   rule takes a plain variable, so the whole loop became an error and no
 *   call in its body was read. Blanking `var` and the type leaves the loop
 *   the grammar knows. The resolver still finds the type: it reads a
 *   receiver's declaration from the source as written.
 * - A property override, which names an inherited property without its type
 *   to publish it or change a specifier: `property OwnsObjects;`, `property
 *   Cursor default crIBeam;`. The grammar's property rule needs the type, so
 *   the class fell apart at the first override and every member declared
 *   after it was lost. An override declares nothing new to index.
 * - A conditional right after a routine's header that doesn't hold whole
 *   bodies: `procedure KeyUp(…); {$IFDEF LINUX} var Code: Byte; {$ENDIF}`,
 *   `function Get: Integer; {$IFDEF HASINLINE}inline;{$ENDIF}`. The grammar
 *   reads a conditional there as alternative bodies only, so any other one
 *   broke the whole unit. Blanking its directives leaves its branches as
 *   plain code, which is how the grammar reads a conditional anywhere else.
 * - A branch holding only a `begin` that another branch of its conditional
 *   opens too: `{$IFDEF FOLDING} Index: Integer; begin … {$ELSE} begin
 *   {$ENDIF}`. Read together, the branches open one block more than the code
 *   closes, so every routine after it was lost. The other branch's `begin`
 *   stays. An assembler version that opens the body beside a Pascal one,
 *   `{$IFDEF WIN32_ASM} asm … {$ELSE} begin … {$ENDIF} end;`, is blanked
 *   whole, so the Pascal version is the body.
 * - A field, variable or typed constant of an anonymous record type:
 *   `AlgData: record case … end`, `Stack: array[1..32] of record First, Last:
 *   LongInt; end;`. The grammar knows a record only as a named type, so the
 *   record's `end` closed the class around it and the members declared after
 *   it were lost. The `record` (or the `packed` before it) is written over by
 *   `string` and the fields are blanked, so the declaration keeps its name:
 *   the fields belong to no type the graph could index them under.
 * - A re-raise, `raise` with no exception (`except Log; raise; end`). The
 *   grammar's `raise` takes an exception, so it read the next word (often
 *   the `end`) as one and the unit broke. The `raise` is blanked, or written
 *   over by `;` right before an `end` (`else raise end`), where the grammar
 *   needs a statement to end the list.
 * - A label that ends its block, right before `end`, `until`, `except` or
 *   `finally` (`quit: end;`). The grammar takes a label only before a
 *   statement, so it read the `end` as a name and the routine never closed,
 *   taking the routines after it along. The graph reads no labels.
 * - Alternative statements where the grammar takes one: `OP_X: {$IFDEF U}
 *   begin … end; {$ELSE} while … do Inc(N); {$ENDIF}` after a case label, or
 *   `then {$IFDEF X} A := 1 {$ELSE} A := 2 {$ENDIF} else …`. Read together,
 *   the branches are two statements, so the case arm broke and took the
 *   routines after it along. The conditional's directives become `begin`, `;`
 *   and `end`, which makes its branches one block and keeps the code of each.
 */

const MODIFIERS: ReadonlySet<string> = new Set(['const', 'var', 'out', 'constref']);
const ROUTINE_KEYWORDS: ReadonlySet<string> = new Set(['procedure', 'function', 'constructor', 'destructor', 'operator']);
/** An attribute group longer than this is not one (and keeps the scan linear). */
const MAX_ATTRIBUTE_LENGTH = 2000;
/** A for-in loop variable's type longer than this is not one. */
const MAX_LOOP_TYPE_LENGTH = 500;
/** Words that end a for-in variable's type without an `in`: not the for-in form. */
const NOT_A_FOR_IN: ReadonlySet<string> = new Set(['do', 'to', 'downto', 'begin', 'end']);
/**
 * Whether a file can hold anything to fix at all (the scan below decides): a directive, an attribute, a `for var`
 * loop, a property override, an anonymous record, a re-raise or a label (only a `goto` needs one).
 */
const MAY_NEED_FIXES = /\{\$|\[|\bfor\s+var\b|\bproperty\b|\brecord\b|\braise\b|\bgoto\b/i;
/** A property override longer than this, up to its `;`, is not one. */
const MAX_OVERRIDE_LENGTH = 500;
/** A routine header's rest after its parameters, or a hint after it (`message WM_SIZE;`), longer than this is not one. */
const MAX_HEADER_PART_LENGTH = 500;
/** An anonymous record longer than this, `record` to `end`, is left alone. */
const MAX_RECORD_LENGTH = 20000;
/** The hints a routine's header can carry after its `;`: the grammar's procedure attributes. */
const ROUTINE_HINTS: ReadonlySet<string> = new Set([
  'static', 'virtual', 'dynamic', 'abstract', 'override', 'overload', 'reintroduce', 'inline',
  'stdcall', 'cdecl', 'pascal', 'register', 'safecall', 'assembler', 'noreturn', 'local', 'far',
  'near', 'default', 'nodefault', 'deprecated', 'experimental', 'message', 'platform',
  'unimplemented', 'cppdecl', 'cvar', 'mwpascal', 'nostackframe', 'interrupt', 'iocheck',
  'hardfloat', 'softfloat', 'ms_abi_default', 'ms_abi_cdecl', 'saveregisters', 'sysv_abi_default',
  'sysv_abi_cdecl', 'vectorcall', 'varargs', 'winapi', 'public', 'export', 'alias', 'dispid',
]);
/** Words that end a block's statements, so a label right before one labels no statement, and a `raise` re-raises. */
const LABEL_ENDS: ReadonlySet<string> = new Set(['end', 'until', 'except', 'finally']);
/** Words that open a block an `end` closes, for telling whether a conditional branch leaves one open. */
const BLOCK_OPENERS: ReadonlySet<string> = new Set(['begin', 'asm', 'try', 'case', 'record']);
/** Words an anonymous record's fields can't hold: a `record` before them is something else. */
const NOT_IN_RECORD_FIELDS: ReadonlySet<string> = new Set([
  'begin', 'class', 'object', 'interface', 'implementation', 'procedure', 'function', 'constructor',
  'destructor', 'property', 'type', 'var', 'const', 'private', 'protected', 'public', 'published', 'strict',
]);
/** Words that start a statement, for telling a conditional's branch holds statements rather than a type. */
const STATEMENT_KEYWORDS: ReadonlySet<string> = new Set([
  'begin', 'if', 'while', 'for', 'repeat', 'case', 'try', 'with', 'raise', 'inherited', 'goto', 'asm',
]);
/** Words a type can start with, so a name before `(` that is one of them starts no call. */
const TYPE_KEYWORDS: ReadonlySet<string> = new Set([
  'procedure', 'function', 'reference', 'class', 'record', 'object', 'interface', 'array', 'set', 'file',
  'packed', 'string', 'type', 'const', 'var', 'out',
]);
/** Words a statement can't end with: a branch ending in one holds a statement's head or a part of an expression. */
const STATEMENT_CONTINUES: ReadonlySet<string> = new Set([
  'then', 'do', 'else', 'of', 'and', 'or', 'xor', 'not', 'div', 'mod', 'shl', 'shr', 'in', 'is', 'as', 'to',
  'downto', 'until', 'goto', 'on',
]);

const CH_TAB = 9, CH_LF = 10, CH_CR = 13, CH_SPACE = 32, CH_DOLLAR = 36, CH_AMP = 38, CH_QUOTE = 39;
const CH_LPAREN = 40, CH_RPAREN = 41, CH_STAR = 42, CH_COMMA = 44, CH_DOT = 46, CH_SLASH = 47;
const CH_COLON = 58, CH_SEMI = 59, CH_LT = 60, CH_EQ = 61, CH_GT = 62, CH_AT = 64;
const CH_LBRACKET = 91, CH_RBRACKET = 93, CH_LBRACE = 123, CH_RBRACE = 125;

/** Identifier characters, `&` (Delphi's keyword escape) and any non-ASCII letter. */
function isIdentStart(c: number): boolean {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === CH_AMP || c >= 128;
}
function isIdentPart(c: number): boolean {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || (c >= 48 && c <= 57) || c >= 128;
}
function isSpace(c: number): boolean {
  return c === CH_SPACE || c === CH_TAB || c === CH_LF || c === CH_CR;
}

function wordEnd(s: string, i: number): number {
  while (i < s.length && isIdentPart(s.charCodeAt(i))) i++;
  return i;
}

/**
 * The index after the comment or string that starts at `i`, or -1 when none
 * does. Pascal comments are `{…}` (compiler directives included), `(*…*)` and
 * `//…`; a string is `'…'` with `''` for a quote and ends at its line's end
 * when unterminated.
 */
function commentOrStringEnd(s: string, i: number): number {
  const c = s.charCodeAt(i);
  if (c === CH_LBRACE) {
    const e = s.indexOf('}', i + 1);
    return e < 0 ? s.length : e + 1;
  }
  if (c === CH_LPAREN && s.charCodeAt(i + 1) === CH_STAR) {
    const e = s.indexOf('*)', i + 2);
    return e < 0 ? s.length : e + 2;
  }
  if (c === CH_SLASH && s.charCodeAt(i + 1) === CH_SLASH) {
    const e = s.indexOf('\n', i + 2);
    return e < 0 ? s.length : e;
  }
  if (c === CH_QUOTE) {
    let j = i + 1;
    while (j < s.length) {
      const d = s.charCodeAt(j);
      if (d === CH_QUOTE) {
        if (s.charCodeAt(j + 1) !== CH_QUOTE) return j + 1;
        j += 2;
        continue;
      }
      if (d === CH_LF) return j;
      j++;
    }
    return j;
  }
  return -1;
}

/** Whether a comment starts at `i`. */
function isCommentStart(s: string, i: number): boolean {
  const c = s.charCodeAt(i);
  return c === CH_LBRACE || (c === CH_LPAREN && s.charCodeAt(i + 1) === CH_STAR) || (c === CH_SLASH && s.charCodeAt(i + 1) === CH_SLASH);
}

/** The index of the first character from `i` that is neither whitespace nor in a comment. */
function skipTrivia(s: string, i: number): number {
  while (i < s.length) {
    if (isSpace(s.charCodeAt(i))) i++;
    else if (isCommentStart(s, i)) i = commentOrStringEnd(s, i);
    else break;
  }
  return i;
}

/** The index after the last character before `i` that is neither whitespace nor in a `{…}` or `(*…*)` comment. */
function tokenEndBefore(s: string, i: number): number {
  for (;;) {
    while (i > 0 && isSpace(s.charCodeAt(i - 1))) i--;
    if (i > 0 && s.charCodeAt(i - 1) === CH_RBRACE) {
      const open = s.lastIndexOf('{', i - 2);
      if (open < 0) return i;
      i = open;
    } else if (i > 1 && s.charCodeAt(i - 1) === CH_RPAREN && s.charCodeAt(i - 2) === CH_STAR) {
      const open = s.lastIndexOf('(*', i - 3);
      if (open < 0) return i;
      i = open;
    } else {
      return i;
    }
  }
}

/** The start of the identifier that ends at `i`, or -1 when none does. */
function wordStartBefore(s: string, i: number): number {
  let k = i;
  while (k > 0 && isIdentPart(s.charCodeAt(k - 1))) k--;
  if (k === i) return -1;
  if (k > 0 && s.charCodeAt(k - 1) === CH_AMP) k--;
  return isIdentStart(s.charCodeAt(k)) ? k : -1;
}

/** The index after the first `;` from `i` outside parentheses and brackets, or -1 when none comes within `max` characters. */
function semicolonEnd(s: string, i: number, max: number): number {
  const limit = Math.min(s.length, i + max);
  let depth = 0;
  while (i < limit) {
    const k = commentOrStringEnd(s, i);
    if (k >= 0) {
      i = k;
      continue;
    }
    const c = s.charCodeAt(i);
    if (c === CH_LPAREN || c === CH_LBRACKET) {
      depth++;
    } else if (c === CH_RPAREN || c === CH_RBRACKET) {
      depth--;
    } else if (c === CH_SEMI && depth <= 0) {
      return i + 1;
    }
    i++;
  }
  return -1;
}

/**
 * The index after the `]` closing the attribute group whose `[` is at `i`,
 * or -1 when the group doesn't close the way an attribute does: nested
 * brackets and parentheses balance, strings and comments are skipped, and an
 * attribute's arguments hold no `;`.
 */
function attributeEnd(s: string, i: number): number {
  const limit = Math.min(s.length, i + MAX_ATTRIBUTE_LENGTH);
  let depth = 0;
  let j = i;
  while (j < limit) {
    const k = commentOrStringEnd(s, j);
    if (k >= 0) {
      j = k;
      continue;
    }
    const c = s.charCodeAt(j);
    if (c === CH_LBRACKET || c === CH_LPAREN) {
      depth++;
    } else if (c === CH_RBRACKET || c === CH_RPAREN) {
      depth--;
      if (depth === 0) return c === CH_RBRACKET ? j + 1 : -1;
    } else if (c === CH_SEMI) {
      return -1;
    }
    j++;
  }
  return -1;
}

/**
 * The index after a routine's name — `Name`, `TFoo.Bar`, `TFoo<T>.Bar<U>`,
 * `Get<T: class, constructor>` — read from `i`, or `i` itself (trivia
 * skipped) when no name starts there (`procedure(…) of object`).
 */
function routineNameEnd(s: string, i: number): number {
  for (;;) {
    i = skipTrivia(s, i);
    if (!isIdentStart(s.charCodeAt(i))) return i;
    i = wordEnd(s, i + 1);
    let j = skipTrivia(s, i);
    if (s.charCodeAt(j) === CH_LT) {
      let depth = 0;
      for (; j < s.length; j++) {
        const c = s.charCodeAt(j);
        if (c === CH_LT) {
          depth++;
        } else if (c === CH_GT) {
          if (--depth === 0) {
            j++;
            break;
          }
        } else if (c === CH_SEMI || c === CH_LPAREN || c === CH_RPAREN || c === CH_LF) {
          return i; // not a generic parameter list
        }
      }
      i = j;
      j = skipTrivia(s, i);
    }
    if (s.charCodeAt(j) !== CH_DOT) return i;
    i = j + 1;
  }
}

/**
 * Walk the parameter list whose `(` is at `open`, pushing the `[from, to)`
 * range of each attribute group a parameter starts with — before or after its
 * modifier — onto `ranges`. Returns the index after the list's `)`.
 */
function scanParameterList(s: string, open: number, ranges: number[]): number {
  let depth = 0;
  let i = open;
  let atParameterStart = false;
  while (i < s.length) {
    if (atParameterStart) {
      atParameterStart = false;
      for (;;) {
        i = skipTrivia(s, i);
        const c = s.charCodeAt(i);
        if (c === CH_LBRACKET) {
          const end = attributeEnd(s, i);
          if (end < 0) break;
          ranges.push(i, end);
          i = end;
        } else if (isIdentStart(c)) {
          const e = wordEnd(s, i + 1);
          if (!MODIFIERS.has(s.slice(i, e).toLowerCase())) break;
          i = e;
        } else {
          break;
        }
      }
      continue;
    }
    const k = commentOrStringEnd(s, i);
    if (k >= 0) {
      i = k;
      continue;
    }
    const c = s.charCodeAt(i);
    if (c === CH_LPAREN || c === CH_LBRACKET) {
      if (++depth === 1) atParameterStart = true;
    } else if (c === CH_RPAREN || c === CH_RBRACKET) {
      if (--depth <= 0) return i + 1;
    } else if (c === CH_SEMI && depth === 1) {
      atParameterStart = true;
    }
    i++;
  }
  return i;
}

/** The word starting at `i`, lowercased, or '' when no word starts there. */
function lowerWordAt(s: string, i: number): string {
  return isIdentStart(s.charCodeAt(i)) ? s.slice(i, wordEnd(s, i + 1)).toLowerCase() : '';
}

/**
 * After a `for` keyword ending at `forEnd`, recognize `var Name in` or
 * `var Name: Type in` and push the `var` range and the `: Type` range onto
 * `ranges`. The type runs to the `in` at nesting depth 0, so generic types
 * (`TPair<string, TList<Integer>>`) and dotted names are whole. Any other
 * shape (`for var i := 0 to …`, which the grammar parses, or no `in`) adds
 * nothing. Returns the index to resume scanning from.
 */
function scanForInVariable(s: string, forEnd: number, ranges: number[]): number {
  const varStart = skipTrivia(s, forEnd);
  if (lowerWordAt(s, varStart) !== 'var') return forEnd;
  const varEnd = varStart + 3;
  const nameStart = skipTrivia(s, varEnd);
  if (!isIdentStart(s.charCodeAt(nameStart))) return forEnd;
  let i = skipTrivia(s, wordEnd(s, nameStart + 1));
  let typeStart = -1;
  if (s.charCodeAt(i) === CH_COLON && s.charCodeAt(i + 1) !== CH_EQ) {
    typeStart = i;
    const limit = Math.min(s.length, i + MAX_LOOP_TYPE_LENGTH);
    let depth = 0;
    i++;
    for (;;) {
      if (i >= limit) return forEnd;
      const k = commentOrStringEnd(s, i);
      if (k >= 0) {
        i = k;
        continue;
      }
      const c = s.charCodeAt(i);
      if (c === CH_LT || c === CH_LPAREN || c === CH_LBRACKET) {
        depth++;
      } else if (c === CH_GT || c === CH_RPAREN || c === CH_RBRACKET) {
        if (--depth < 0) return forEnd;
      } else if (c === CH_SEMI || c === CH_EQ) {
        return forEnd; // `for var i: Integer := 0 to …`, or no loop at all
      } else if (isIdentStart(c)) {
        const word = lowerWordAt(s, i);
        if (depth === 0 && word === 'in') break;
        if (NOT_A_FOR_IN.has(word)) return forEnd;
        i = wordEnd(s, i + 1);
        continue;
      }
      i++;
    }
  }
  if (lowerWordAt(s, i) !== 'in') return forEnd;
  ranges.push(varStart, varEnd);
  if (typeStart >= 0) ranges.push(typeStart, i);
  return i;
}

/**
 * After a `property` keyword running from `start` to `propertyEnd`,
 * recognize a property override, which names an inherited property without
 * its type to publish it or change a specifier — `property OwnsObjects;`,
 * `property Cursor default crIBeam;`, `property Color stored IsColorStored;`
 * — and push its range, keyword (or the `class` before it) to `;`, onto
 * `ranges`. A name followed by `:` or by an index list (`property
 * Items[Index: Integer]: T`) declares a property the grammar knows. Returns
 * the index to resume scanning from.
 */
function scanPropertyOverride(s: string, start: number, propertyEnd: number, ranges: number[]): number {
  const nameStart = skipTrivia(s, propertyEnd);
  if (!isIdentStart(s.charCodeAt(nameStart))) return propertyEnd;
  const i = skipTrivia(s, wordEnd(s, nameStart + 1));
  const next = s.charCodeAt(i);
  if (next === CH_COLON || next === CH_LBRACKET) return propertyEnd;
  const end = semicolonEnd(s, i, MAX_OVERRIDE_LENGTH);
  if (end < 0) return propertyEnd;
  const classStart = classBefore(s, start);
  ranges.push(classStart >= 0 ? classStart : start, end);
  return end;
}

/**
 * A conditional compiler directive group, from its `{$IF…}`, `{$IFDEF…}`,
 * `{$IFNDEF…}` or `{$IFOPT…}` to its `{$ENDIF}` or `{$IFEND}`. `bounds`
 * holds the `[start, end)` offsets of the group's own directives in order,
 * its `{$ELSE}`s and `{$ELSEIF…}`s between, so branch `b` runs from
 * `bounds[2b + 1]` to `bounds[2b + 2]`; `nested[b]` says whether another
 * group sits in that branch.
 */
interface ConditionalGroup {
  bounds: number[];
  nested: boolean[];
}

const COND_NONE = 0, COND_OPEN = 1, COND_ELSE = 2, COND_CLOSE = 3;

/** What the `{$…}` directive at `i` does to a conditional: opens one, starts its next branch, closes it, or none of these. */
function conditionalKind(s: string, i: number): number {
  let j = i + 2;
  while (j < s.length) {
    const c = s.charCodeAt(j) | 32;
    if (c < 97 || c > 122) break;
    j++;
  }
  switch (s.slice(i + 2, j).toLowerCase()) {
    case 'if': case 'ifdef': case 'ifndef': case 'ifopt': return COND_OPEN;
    case 'else': case 'elseif': return COND_ELSE;
    case 'endif': case 'ifend': return COND_CLOSE;
    default: return COND_NONE;
  }
}

/**
 * Every closed conditional group in `s`, innermost first. Directives in
 * strings and comments don't count, nor do `(*$…*)` ones, which the grammar
 * reads as comments.
 */
function conditionalGroups(s: string): ConditionalGroup[] {
  const groups: ConditionalGroup[] = [];
  const open: ConditionalGroup[] = [];
  const n = s.length;
  let i = 0;
  while (i < n) {
    const c = s.charCodeAt(i);
    const k = c === CH_LBRACE || c === CH_QUOTE || c === CH_LPAREN || c === CH_SLASH ? commentOrStringEnd(s, i) : -1;
    if (k < 0) {
      i++;
      continue;
    }
    if (c === CH_LBRACE && s.charCodeAt(i + 1) === CH_DOLLAR) {
      const kind = conditionalKind(s, i);
      const top = open[open.length - 1];
      if (kind === COND_OPEN) {
        if (top) top.nested[top.nested.length - 1] = true;
        open.push({ bounds: [i, k], nested: [false] });
      } else if (kind === COND_ELSE && top) {
        top.bounds.push(i, k);
        top.nested.push(false);
      } else if (kind === COND_CLOSE && top) {
        top.bounds.push(i, k);
        groups.push(open.pop()!);
      }
    }
    i = k;
  }
  return groups;
}

/**
 * Whether the code from `from` to `to` is a routine's locals and body, the
 * one conditional the grammar reads right after a routine's header: it ends
 * with the `end;` of a block that no routine declared in it owns. Code that
 * closes a block it didn't open (a local class type) counts as a body too,
 * so it stays the way the grammar reads it.
 */
function holdsBody(s: string, from: number, to: number): boolean {
  const blocks: string[] = [];
  let pending = 0; // routines declared at the top whose body hasn't come yet
  let own = false; // whether the last top-level block is no declared routine's
  let last = '';
  let beforeLast = '';
  let i = from;
  while (i < to) {
    const k = commentOrStringEnd(s, i);
    if (k >= 0) {
      if (s.charCodeAt(i) === CH_QUOTE) {
        beforeLast = last;
        last = "'";
      }
      i = k;
      continue;
    }
    const c = s.charCodeAt(i);
    if (isIdentStart(c)) {
      const e = wordEnd(s, i + 1);
      const word = e - i <= 11 ? s.slice(i, e).toLowerCase() : 'word';
      if (blocks.length === 0) {
        if (ROUTINE_KEYWORDS.has(word) && (last === '' || last === ';')) pending++;
        else if ((word === 'forward' || word === 'external') && pending > 0) pending--;
      }
      if (word === 'end') {
        if (blocks.pop() === undefined) return true;
      } else if (word === 'begin' || word === 'asm') {
        if (blocks.length === 0) {
          own = pending === 0;
          if (!own) pending--;
        }
        blocks.push(word);
      } else if (word === 'try' || word === 'record' || (word === 'case' && blocks[blocks.length - 1] !== 'record')) {
        blocks.push(word);
      }
      beforeLast = last;
      last = word;
      i = e;
      continue;
    }
    if (!isSpace(c)) {
      beforeLast = last;
      last = s[i]!;
    }
    i++;
  }
  return blocks.length === 0 && own && beforeLast === 'end' && last === ';';
}

/** Whether the code from `from` to `to` holds a `begin` or an `asm`: a body, or a part of one. */
function holdsBlock(s: string, from: number, to: number): boolean {
  let i = from;
  while (i < to) {
    const k = commentOrStringEnd(s, i);
    if (k >= 0) {
      i = k;
      continue;
    }
    if (isIdentStart(s.charCodeAt(i))) {
      const e = wordEnd(s, i + 1);
      if (e - i === 3 || e - i === 5) {
        const word = s.slice(i, e).toLowerCase();
        if (word === 'begin' || word === 'asm') return true;
      }
      i = e;
      continue;
    }
    i++;
  }
  return false;
}

/** The index of the first character from `i` that is neither whitespace nor in a comment, stopping at a conditional group's opening directive. */
function skipTriviaToGroup(s: string, i: number, groupAt: ReadonlyMap<number, ConditionalGroup>): number {
  while (i < s.length) {
    if (isSpace(s.charCodeAt(i))) i++;
    else if (isCommentStart(s, i) && !groupAt.has(i)) i = commentOrStringEnd(s, i);
    else break;
  }
  return i;
}

/**
 * From `i`, the index after a routine header's `;`, blank the directives of
 * each conditional that follows the header, past the hints it carries
 * (`overload;`, `inline;`), unless every branch of the conditional holds a
 * whole body: the one conditional the grammar reads there. When the
 * conditional holds no block at all (only locals or hints), the scan goes on
 * in its first branch, now plain code, so a conditional nested at its start
 * comes right after the header too.
 */
function blankConditionalsAfterHeader(s: string, i: number, groupAt: ReadonlyMap<number, ConditionalGroup>, ranges: number[]): void {
  for (;;) {
    i = skipTriviaToGroup(s, i, groupAt);
    const group = groupAt.get(i);
    if (group) {
      const { bounds } = group;
      let bodies = true;
      for (let b = 1; b < bounds.length - 1 && bodies; b += 2) bodies = holdsBody(s, bounds[b]!, bounds[b + 1]!);
      if (bodies) return; // the grammar reads these
      ranges.push(...bounds);
      i = holdsBlock(s, bounds[1]!, bounds[bounds.length - 2]!) ? bounds[bounds.length - 1]! : bounds[1]!;
      continue;
    }
    if (!ROUTINE_HINTS.has(lowerWordAt(s, i))) return;
    i = semicolonEnd(s, i, MAX_HEADER_PART_LENGTH);
    if (i < 0) return;
  }
}

const OPEN_BEGIN = 0, OPEN_ASM = 1, OPEN_OTHER = 2;

/**
 * The blocks the code from `from` to `to` leaves open, in order, each as its
 * opener's offset and kind (OPEN_BEGIN, OPEN_ASM, or OPEN_OTHER for `try`,
 * `case` and `record`), or null when it closes a block it didn't open.
 */
function openBlocks(s: string, from: number, to: number): Array<[number, number]> | null {
  const open: Array<[number, number]> = [];
  let i = from;
  while (i < to) {
    const k = commentOrStringEnd(s, i);
    if (k >= 0) {
      i = k;
      continue;
    }
    if (isIdentStart(s.charCodeAt(i))) {
      const e = wordEnd(s, i + 1);
      if (e - i >= 3 && e - i <= 6) {
        const word = s.slice(i, e).toLowerCase();
        if (word === 'end') {
          if (open.pop() === undefined) return null;
        } else if (BLOCK_OPENERS.has(word)) {
          open.push([i, word === 'begin' ? OPEN_BEGIN : word === 'asm' ? OPEN_ASM : OPEN_OTHER]);
        }
      }
      i = e;
      continue;
    }
    i++;
  }
  return open;
}

/**
 * In every conditional (holding no conditional of its own) whose branches
 * each leave blocks open for the code after it to close. When they all leave
 * the same number of `begin`s open, the `begin`s each branch after the first
 * leaves open are blanked: read together, they would open that many blocks
 * more than the code closes, and a branch's statements can sit in the first
 * branch's block, as the graph doesn't read nesting. When each opens one
 * body, some with `asm` and some with `begin` (an assembler and a Pascal
 * version of a routine sharing one `end`), each assembler branch is blanked
 * whole, so the Pascal one is the body; the graph reads nothing in assembler.
 */
function blankDuplicateBegins(s: string, groups: readonly ConditionalGroup[], ranges: number[]): void {
  for (const { bounds, nested } of groups) {
    if (nested.length < 2 || nested.includes(true)) continue;
    const open: Array<Array<[number, number]>> = [];
    for (let b = 0; b < nested.length; b++) {
      const blocks = openBlocks(s, bounds[2 * b + 1]!, bounds[2 * b + 2]!);
      if (!blocks || blocks.length === 0) break;
      open.push(blocks);
    }
    if (open.length < nested.length) continue;
    const kinds = (kind: number) => open.filter((o) => o.every(([, k]) => k === kind)).length;
    if (kinds(OPEN_BEGIN) === open.length && open.every((o) => o.length === open[0]!.length)) {
      for (let b = 1; b < open.length; b++) for (const [at] of open[b]!) ranges.push(at, at + 5);
    } else if (open.every((o) => o.length === 1) && kinds(OPEN_ASM) > 0 && kinds(OPEN_BEGIN) > 0 && kinds(OPEN_BEGIN) + kinds(OPEN_ASM) === open.length) {
      let kept = false;
      for (let b = 0; b < open.length; b++) {
        const [at, kind] = open[b]![0]!;
        if (kind === OPEN_ASM) ranges.push(bounds[2 * b + 1]!, bounds[2 * b + 2]!);
        else if (kept) ranges.push(at, at + 5);
        else kept = true;
      }
    }
  }
}

const SHAPE_NONE = -1, SHAPE_STATEMENTS = 0, SHAPE_STATEMENTS_SEMI = 1, SHAPE_EMPTY = 2;
const START_NONE = 0, START_STATEMENT = 1, START_CALL = 2, START_NAME = 3;

/**
 * Whether the code from `from` to `to`, a conditional's branch, holds whole statements: its blocks and brackets
 * close, every `if` has its `then` and every `while`, `for`, `with` and `on` its `do`, and it ends where a
 * statement can. It must start with a statement's keyword, assign at its top level or call a routine (`Foo(…)`,
 * `A.B(…)`); with `bare`, a lone name counts too (`Exit`, `List.Clear;`), which after a case label could just as
 * well be a type. Returns SHAPE_STATEMENTS (SHAPE_STATEMENTS_SEMI when it ends with `;`), SHAPE_EMPTY for no code,
 * or SHAPE_NONE.
 */
function statementsShape(s: string, from: number, to: number, bare: boolean): number {
  const blocks: boolean[] = []; // an open block each: true for a `repeat`, which `until` closes
  let depth = 0;
  let heads = 0; // `if`, `while`, `for`, `with` and `on` still waiting for their `then` or `do`
  let tokens = 0;
  let start = START_NONE;
  let name = 0; // reading the first dotted name: 1 after a part of it, 2 after its `.`, 0 when done
  let last = ''; // the last token: a word lowercased ('word' when long), '0' for a number, else its character
  let i = from;
  while (i < to) {
    const k = commentOrStringEnd(s, i);
    if (k >= 0) {
      if (s.charCodeAt(i) === CH_QUOTE) {
        tokens++;
        name = 0;
        last = "'";
      }
      i = k;
      continue;
    }
    const c = s.charCodeAt(i);
    if (isSpace(c)) {
      i++;
      continue;
    }
    tokens++;
    if (isIdentStart(c)) {
      const e = wordEnd(s, i + 1);
      const word = e - i <= 9 ? s.slice(i, e).toLowerCase() : 'word';
      if (word === 'begin' || word === 'try' || word === 'case' || word === 'asm') blocks.push(false);
      else if (word === 'repeat') blocks.push(true);
      else if (word === 'end' && blocks.pop() !== false) return SHAPE_NONE;
      else if (word === 'until' && blocks.pop() !== true) return SHAPE_NONE;
      else if (word === 'if' || word === 'while' || word === 'for' || word === 'with' || word === 'on') heads++;
      else if (word === 'then' || word === 'do') heads--;
      if (tokens === 1) {
        if (STATEMENT_KEYWORDS.has(word)) start = START_STATEMENT;
        else if (!TYPE_KEYWORDS.has(word) && !STATEMENT_CONTINUES.has(word) && word !== 'end') name = 1;
      } else {
        name = name === 2 ? 1 : 0;
      }
      last = word;
      i = e;
      continue;
    }
    if (c >= 48 && c <= 57) {
      name = 0;
      last = '0';
      i = wordEnd(s, i + 1);
      continue;
    }
    if (c === CH_COLON && s.charCodeAt(i + 1) === CH_EQ) {
      if (depth === 0 && start !== START_CALL) start = START_STATEMENT;
      name = 0;
      last = ':=';
      i += 2;
      continue;
    }
    if (c === CH_LPAREN || c === CH_LBRACKET) {
      if (c === CH_LPAREN && name === 1 && start === START_NONE) start = START_CALL;
      depth++;
    } else if ((c === CH_RPAREN || c === CH_RBRACKET) && --depth < 0) {
      return SHAPE_NONE;
    } else if (c === CH_SEMI && name === 1 && start === START_NONE) {
      start = START_NAME;
    }
    name = c === CH_DOT && name === 1 ? 2 : 0;
    last = s[i]!;
    i++;
  }
  if (tokens === 0) return SHAPE_EMPTY;
  if (depth !== 0 || blocks.length > 0 || heads !== 0) return SHAPE_NONE;
  if (name === 1 && start === START_NONE) start = START_NAME;
  if (start === START_NONE || (start === START_NAME && !bare)) return SHAPE_NONE;
  const ends = last === ';' || last === ')' || last === ']' || last === '^' || last === "'" || last === '0'
    || (isIdentStart(last.charCodeAt(0)) && !STATEMENT_CONTINUES.has(last));
  if (!ends) return SHAPE_NONE;
  return last === ';' ? SHAPE_STATEMENTS_SEMI : SHAPE_STATEMENTS;
}

/** Whether a blank range in `ranges` overlaps `[from, to)`. */
function overlapsRange(ranges: readonly number[], from: number, to: number): boolean {
  for (let r = 0; r < ranges.length; r += 2) if (ranges[r]! < to && ranges[r + 1]! > from) return true;
  return false;
}

/** Whether `[at, at + length)` holds no line break, so a word written there keeps every line where it is. */
function onOneLine(s: string, at: number, length: number): boolean {
  for (let i = at; i < at + length; i++) {
    const c = s.charCodeAt(i);
    if (c === CH_LF || c === CH_CR) return false;
  }
  return true;
}

/**
 * Read as one statement each conditional whose branches are alternative statements where the grammar takes just
 * one: after a case label, `then`, `else` or `do` (`label` maps each such group's opening directive to whether a
 * case label's `:` comes before it). Its opening directive becomes `begin`, each `{$ELSE}` a `;`, and its closing
 * directive `end`, or `end;` when its branches end with `;`. Read together, the branches of one after a case label
 * always broke the arm (`OP_X: begin … end; while … do Inc(N);`). After the others they break only when a branch
 * before the last has no `;` (`then A {$ELSE} B {$ENDIF} else C`), since `then A; B;` parses as it is. A group
 * holding another conditional is left alone, as is one whose branches end in a statement's head (`if … then`) for a
 * body after them.
 */
function wrapAlternativeStatements(
  s: string,
  groups: readonly ConditionalGroup[],
  label: ReadonlyMap<number, boolean>,
  ranges: readonly number[],
  words: Array<[number, number, string]>,
): void {
  for (const { bounds, nested } of groups) {
    const afterLabel = label.get(bounds[0]!);
    if (afterLabel === undefined || nested.length < 2 || nested.includes(true)) continue;
    let filled = 0;
    let semi = false;
    let breaks = afterLabel;
    let ok = true;
    for (let b = 0; b < nested.length && ok; b++) {
      const shape = statementsShape(s, bounds[2 * b + 1]!, bounds[2 * b + 2]!, !afterLabel);
      if (shape === SHAPE_EMPTY) continue;
      if (shape === SHAPE_NONE) ok = false;
      if (filled > 0 && !semi) breaks = true;
      filled++;
      semi = shape === SHAPE_STATEMENTS_SEMI;
    }
    if (!ok || filled < 2 || !breaks || !onOneLine(s, bounds[0]!, 5)) continue;
    let clear = true;
    for (let d = 0; d < bounds.length && clear; d += 2) clear = !overlapsRange(ranges, bounds[d]!, bounds[d + 1]!);
    if (!clear) continue;
    words.push([bounds[0]!, bounds[1]!, 'begin']);
    for (let d = 2; d < bounds.length - 2; d += 2) words.push([bounds[d]!, bounds[d + 1]!, ';']);
    words.push([bounds[bounds.length - 2]!, bounds[bounds.length - 1]!, semi ? 'end;' : 'end']);
  }
}

/**
 * The kind of statement position the token from `at` to `end` makes for what follows it: 1 for a case label's
 * `:`, 0 for `then`, `else` or `do`, -1 for anything else.
 */
function statementPosition(s: string, at: number, end: number): number {
  const length = end - at;
  if (length === 1) return s.charCodeAt(at) === CH_COLON ? 1 : -1;
  if (length < 2 || length > 4) return -1;
  const word = s.slice(at, end).toLowerCase();
  return word === 'then' || word === 'else' || word === 'do' ? 0 : -1;
}

/**
 * The start of the declaration that the `record` keyword at `i` gives an
 * anonymous type to: the first of the `Names` in `Names: [packed] record` or
 * `Names: [packed] array[…] of [packed] record`, or the `TName` in `TName =
 * array[…] of record`. -1 for a named record type (`TName = record`) and
 * anything else.
 */
function anonymousRecordDeclStart(s: string, i: number): number {
  let j = tokenEndBefore(s, i);
  let w = wordStartBefore(s, j);
  if (w >= 0 && lowerWordAt(s, w) === 'packed') {
    j = tokenEndBefore(s, w);
    w = wordStartBefore(s, j);
  }
  let array = false;
  if (w >= 0 && lowerWordAt(s, w) === 'of') {
    j = tokenEndBefore(s, w);
    if (s.charCodeAt(j - 1) === CH_RBRACKET) {
      const open = s.lastIndexOf('[', j - 1);
      if (open < 0) return -1;
      j = tokenEndBefore(s, open);
    }
    w = wordStartBefore(s, j);
    if (w < 0 || lowerWordAt(s, w) !== 'array') return -1;
    j = tokenEndBefore(s, w);
    w = wordStartBefore(s, j);
    if (w >= 0 && lowerWordAt(s, w) === 'packed') j = tokenEndBefore(s, w);
    array = true;
  }
  const c = s.charCodeAt(j - 1);
  if (c !== CH_COLON && !(c === CH_EQ && array)) return -1;
  let start = wordStartBefore(s, tokenEndBefore(s, j - 1));
  if (start < 0 || c === CH_EQ) return start;
  for (;;) {
    const k = tokenEndBefore(s, start);
    if (s.charCodeAt(k - 1) !== CH_COMMA) return start;
    const name = wordStartBefore(s, tokenEndBefore(s, k - 1));
    if (name < 0) return -1;
    start = name;
  }
}

/**
 * The index after the `end` closing a record whose fields start at `i`, or -1 when they hold what a record's fields
 * can't. A word like `procedure` or `object` is part of a field's type after `:`, `of` or `to` (`OnIdle: procedure
 * of object`, `Get: reference to function: Integer`, `Args: array of const`), and words in brackets are a
 * routine type's parameters.
 */
function recordEnd(s: string, i: number): number {
  const limit = Math.min(s.length, i + MAX_RECORD_LENGTH);
  let depth = 1;
  let brackets = 0;
  let prev = ''; // the token before: a word lowercased, or its character
  while (i < limit) {
    const k = commentOrStringEnd(s, i);
    if (k >= 0) {
      if (s.charCodeAt(i) === CH_QUOTE) prev = "'";
      i = k;
      continue;
    }
    const c = s.charCodeAt(i);
    if (isIdentStart(c)) {
      const e = wordEnd(s, i + 1);
      const word = s.slice(i, e).toLowerCase();
      if (brackets === 0) {
        if (word === 'end') {
          if (--depth === 0) return e;
        } else if (word === 'record') {
          depth++;
        } else if (NOT_IN_RECORD_FIELDS.has(word) && prev !== ':' && prev !== 'of' && prev !== 'to') {
          return -1;
        }
      }
      prev = word;
      i = e;
      continue;
    }
    if (c === CH_LPAREN || c === CH_LBRACKET) brackets++;
    else if (c === CH_RPAREN || c === CH_RBRACKET) brackets--;
    else if (c === CH_EQ && brackets === 0) return -1;
    if (!isSpace(c)) prev = s[i]!;
    i++;
  }
  return -1;
}

/**
 * At a `record` keyword from `start` to `end`, recognize the declaration of a field, variable or typed constant of
 * an anonymous record type, followed by its `;`, a typed constant's `=`, or the `)` or `end` after a last field. The
 * `record` (or the `packed` before it) is written over by `string`, a type the grammar knows, and the fields after
 * it are blanked through its `end`, so the declaration keeps its name and a typed constant its value. Returns the
 * index to resume from.
 */
function scanAnonymousRecord(s: string, start: number, end: number, ranges: number[], words: Array<[number, number, string]>): number {
  if (anonymousRecordDeclStart(s, start) < 0) return end;
  const first = lowerWordAt(s, skipTrivia(s, end));
  if (first === '' || NOT_IN_RECORD_FIELDS.has(first)) return end; // `<T: record>`, `R: record;`
  const close = recordEnd(s, end);
  if (close < 0) return end;
  const next = skipTrivia(s, close);
  const c = s.charCodeAt(next);
  const last = lowerWordAt(s, next) === 'end'; // a last field, whose `;` Pascal lets go but the grammar needs
  if (c !== CH_SEMI && c !== CH_EQ && c !== CH_RPAREN && !last) return end;
  const packed = wordStartBefore(s, tokenEndBefore(s, start));
  const at = packed >= 0 && lowerWordAt(s, packed) === 'packed' ? packed : start;
  words.push([at, at + 6, 'string']);
  if (last) {
    ranges.push(at + 6, close - 3);
    words.push([close - 3, close, ';']);
  } else {
    ranges.push(at + 6, close);
  }
  return close;
}

/**
 * `s` with every `[from, to)` range in `ranges` blanked to spaces, newlines kept, and every `[from, to, word]` in
 * `words` (which overlap neither each other nor a range) written over by its word, padded with spaces. Ranges may
 * come in any order and overlap.
 */
function applyEdits(s: string, ranges: readonly number[], words: ReadonlyArray<readonly [number, number, string]>): string {
  if (ranges.length === 0 && words.length === 0) return s;
  const edits: Array<readonly [number, number, string]> = words.slice();
  for (let r = 0; r < ranges.length; r += 2) edits.push([ranges[r]!, ranges[r + 1]!, '']);
  edits.sort((a, b) => a[0] - b[0]);
  let out = '';
  let last = 0;
  for (const [start, to, word] of edits) {
    const from = Math.max(start, last);
    if (to <= from) continue;
    const written = from === start && word.length <= to - from ? word : '';
    out += s.slice(last, from) + written + s.slice(from + written.length, to).replace(/[^\r\n]/g, ' ');
    last = to;
  }
  return out + s.slice(last);
}

/** The start of the `class` word before index `i`, past whitespace, or -1. */
function classBefore(s: string, i: number): number {
  let j = i;
  while (j > 0 && isSpace(s.charCodeAt(j - 1))) j--;
  const w = j - 5;
  return w >= 0 && s.slice(w, j).toLowerCase() === 'class' && (w === 0 || !isIdentPart(s.charCodeAt(w - 1))) ? w : -1;
}

/**
 * Blank what the Pascal grammar can't parse (see the file comment). Returns
 * the source unchanged when there is nothing to blank.
 */
export function preParsePascal(source: string): string {
  if (!MAY_NEED_FIXES.test(source)) return source;
  const directives = source.indexOf('{$') >= 0;
  const ranges: number[] = [];
  const words: Array<[number, number, string]> = [];
  const groups = directives ? conditionalGroups(source) : [];
  const groupAt = new Map<number, ConditionalGroup>();
  for (const group of groups) groupAt.set(group.bounds[0]!, group);
  // Each conditional's opening directive that comes where one statement goes: whether a case label is before it.
  const label = new Map<number, boolean>();
  // The last token read, start and end, for that; -1 right after a declaration the scan read past.
  let lastAt = -1;
  let lastEnd = -1;
  const n = source.length;
  let i = 0;
  while (i < n) {
    const k = commentOrStringEnd(source, i);
    if (k >= 0) {
      if (source.charCodeAt(i) === CH_QUOTE) {
        lastAt = i;
        lastEnd = k;
      } else if (lastAt >= 0 && source.charCodeAt(i + 1) === CH_DOLLAR && groupAt.has(i)) {
        const position = statementPosition(source, lastAt, lastEnd);
        if (position >= 0) label.set(i, position === 1);
      }
      i = k;
      continue;
    }
    const c = source.charCodeAt(i);
    if (isIdentStart(c)) {
      const e = wordEnd(source, i + 1);
      const len = e - i;
      const word = len >= 6 && len <= 11 ? source.slice(i, e).toLowerCase() : '';
      // `operator` is no reserved word in Delphi (a call `Operator([1, 2])` is
      // code), so it starts a header only after `class`.
      if (ROUTINE_KEYWORDS.has(word) && (word !== 'operator' || classBefore(source, i) >= 0)) {
        const open = skipTrivia(source, routineNameEnd(source, e));
        const next = source.charCodeAt(open) === CH_LPAREN ? scanParameterList(source, open, ranges) : e;
        if (groupAt.size > 0) {
          const headerEnd = semicolonEnd(source, next, MAX_HEADER_PART_LENGTH);
          if (headerEnd >= 0) blankConditionalsAfterHeader(source, headerEnd, groupAt, ranges);
        }
        i = next;
        lastAt = -1;
        continue;
      } else if (word === 'property') {
        i = scanPropertyOverride(source, i, e, ranges);
        lastAt = -1;
        continue;
      } else if (word === 'record') {
        i = scanAnonymousRecord(source, i, e, ranges, words);
        lastAt = -1;
        continue;
      } else if (len === 3 && source.slice(i, e).toLowerCase() === 'for') {
        i = scanForInVariable(source, e, ranges);
        lastAt = -1;
        continue;
      } else if (len === 5 && source.slice(i, e).toLowerCase() === 'raise') {
        // A re-raise: blanked, or an empty statement where one must end a list (`else raise end`).
        const next = skipTrivia(source, e);
        const after = lowerWordAt(source, next);
        if (source.charCodeAt(next) === CH_SEMI || after === 'else') ranges.push(i, e);
        else if (LABEL_ENDS.has(after)) words.push([i, e, ';']);
      } else {
        let colon = e;
        while (source.charCodeAt(colon) === CH_SPACE || source.charCodeAt(colon) === CH_TAB) colon++;
        // A label ending its block (`quit: end;`), not an assembler one (`@z:`).
        if (source.charCodeAt(colon) === CH_COLON && source.charCodeAt(colon + 1) !== CH_EQ && source.charCodeAt(i - 1) !== CH_AT
          && LABEL_ENDS.has(lowerWordAt(source, skipTrivia(source, colon + 1)))) ranges.push(i, colon + 1);
      }
      lastAt = i;
      lastEnd = e;
      i = e;
    } else if (c >= 48 && c <= 57) {
      lastAt = i;
      i = wordEnd(source, i + 1); // a number
      lastEnd = i;
    } else if (isSpace(c)) {
      i++;
    } else {
      lastAt = i;
      i += c === CH_COLON && source.charCodeAt(i + 1) === CH_EQ ? 2 : 1;
      lastEnd = i;
    }
  }
  if (groups.length > 0) {
    blankDuplicateBegins(source, groups, ranges);
    if (label.size > 0) wrapAlternativeStatements(source, groups, label, ranges, words);
  }
  return applyEdits(source, ranges, words);
}
