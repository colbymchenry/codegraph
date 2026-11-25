/**
 * What a Supabase project's migrations define, read without a grammar.
 *
 * tree-sitter-sql (0.3.13) parses plain SQL but not the Postgres a Supabase
 * project writes: on supabase/supabase's own migrations 76 of 286 statements
 * come back with ERROR trees, among them 23 of its 39 `CREATE FUNCTION`s
 * (`SECURITY DEFINER`, `SET search_path`, `RETURNS TABLE`). Every body is a dollar-quoted string to it anyway
 * (`LANGUAGE sql` and `LANGUAGE plpgsql` alike), so reading bodies would be
 * ours to do even with it.
 *
 * So this reads the files the way Drupal reads its routing yml: it masks what
 * is not code (comments, strings), keeps dollar-quoted bodies aside, finds the
 * statements by their opening words, and replays them in file order — the
 * order a database applies migrations in — so that the last definition of a
 * function stands and a later DROP retires it.
 *
 * Bodies are read against a closed list: only names the migrations define as
 * a table or view count as one. A body names CTEs, aliases and columns the
 * same way it names tables; a closed list tells them apart where a parser of
 * the body would have to understand it.
 */

export interface MigrationFile {
  /** Project-relative path; its name orders the migrations. */
  path: string;
  content: string;
}

export interface SqlFunction {
  name: string;
  schema: string;
  filePath: string;
  /** Line the CREATE starts on. */
  line: number;
  /** Line the body ends on (its closing dollar quote), or the CREATE's line. */
  endLine: number;
  language: string | null;
  /** The CREATE up to its body: name, arguments, RETURNS. */
  signature: string;
  /** Tables and views the body reads; Supabase-owned ones qualified (`auth.users`). */
  reads: string[];
  /** Tables the body writes (INSERT, UPDATE, DELETE, MERGE, TRUNCATE). */
  writes: string[];
  /** Other functions of the project the body calls. */
  calls: string[];
}

export interface SqlTable {
  name: string;
  schema: string;
  filePath: string;
  line: number;
  /** Line the statement's closing semicolon is on. */
  endLine: number;
}

export interface SqlView extends SqlTable {
  materialized: boolean;
  /** Tables and views its query selects from. */
  reads: string[];
  /** Functions of the project its query calls. */
  calls: string[];
}

export interface SqlPolicy {
  name: string;
  /** The table it guards, by name. */
  table: string;
  filePath: string;
  line: number;
  endLine: number;
  /** Tables its USING / WITH CHECK expressions query (`EXISTS (SELECT … FROM profiles)`). */
  reads: string[];
  /** Functions of the project those expressions call (`is_admin()`). */
  calls: string[];
}

export interface SqlTrigger {
  name: string;
  /** The table it fires on; qualified when Supabase owns it (`auth.users`). */
  table: string;
  function: string;
  filePath: string;
  line: number;
  endLine: number;
}

export interface SqlModel {
  functions: SqlFunction[];
  tables: SqlTable[];
  views: SqlView[];
  policies: SqlPolicy[];
  triggers: SqlTrigger[];
  /** Supabase-owned tables something here reads or fires on, qualified. */
  externalTables: string[];
}

/** Schemas Supabase creates itself. Their tables are in no migration. */
const EXTERNAL_SCHEMAS = new Set(['auth', 'storage', 'realtime', 'vault']);

const IDENT = String.raw`(?:"(?:[^"]|"")+"|[A-Za-z_][A-Za-z_0-9$]*)`;
const QNAME = String.raw`(${IDENT}(?:\s*\.\s*${IDENT})?)`;

const cleanName = (q: string): string => q.replace(/\s+/g, '').replace(/"/g, '').toLowerCase();
const bareName = (q: string): string => cleanName(q).split('.').pop()!;
const schemaOf = (q: string): string => {
  const parts = cleanName(q).split('.');
  return parts.length > 1 ? parts[0]! : 'public';
};

interface Body { start: number; end: number }

/**
 * Comments and plain strings blanked to spaces (newlines kept, so offsets and
 * line numbers still match the source), and where each dollar-quoted body is.
 */
function mask(src: string): { text: string; bodies: Body[] } {
  const out = src.split('');
  const bodies: Body[] = [];
  const blank = (a: number, b: number) => {
    for (let k = a; k < b; k++) if (out[k] !== '\n') out[k] = ' ';
  };
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (c === '-' && n === '-') {
      const e = src.indexOf('\n', i);
      const end = e < 0 ? src.length : e;
      blank(i, end);
      i = end;
      continue;
    }
    if (c === '/' && n === '*') {
      const e = src.indexOf('*/', i + 2);
      const end = e < 0 ? src.length : e + 2;
      blank(i, end);
      i = end;
      continue;
    }
    if (c === "'") {
      // '' is an escaped quote inside the string, not its end
      let k = i + 1;
      while (k < src.length) {
        if (src[k] === "'" && src[k + 1] === "'") { k += 2; continue; }
        if (src[k] === "'") break;
        k++;
      }
      blank(i + 1, k);
      i = k + 1;
      continue;
    }
    if (c === '$') {
      const tag = /^\$(?:[A-Za-z_][A-Za-z_0-9]*)?\$/.exec(src.slice(i, i + 64))?.[0];
      if (tag) {
        const close = src.indexOf(tag, i + tag.length);
        const end = close < 0 ? src.length : close;
        bodies.push({ start: i + tag.length, end });
        i = close < 0 ? src.length : close + tag.length;
        continue;
      }
    }
    i++;
  }
  return { text: out.join(''), bodies };
}

function lineAt(src: string, index: number): number {
  let line = 1;
  for (let k = 0; k < index && k < src.length; k++) if (src[k] === '\n') line++;
  return line;
}

/** Line of the first semicolon at or after `from` in `top` (bodies blanked, so theirs do not count). */
function statementEndLine(top: string, src: string, from: number): number {
  const semi = top.indexOf(';', from);
  return lineAt(src, semi < 0 ? src.length : semi);
}

/** The same text with every dollar-quoted body blanked, so statements inside one are not read as top-level. */
function withoutBodies(text: string, bodies: Body[]): string {
  const out = text.split('');
  for (const b of bodies) for (let k = b.start; k < b.end; k++) if (out[k] !== '\n') out[k] = ' ';
  return out.join('');
}

type FunctionDef = Omit<SqlFunction, 'reads' | 'writes' | 'calls'>;

type Event =
  | { at: number; kind: 'create-function'; fn: FunctionDef; body: string; signature: string }
  /** `signature` null: `DROP FUNCTION f` without arguments, every overload. */
  | { at: number; kind: 'drop-function'; name: string; signature: string | null };

const WRITE_BEFORE = /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM|MERGE\s+INTO|TRUNCATE(?:\s+TABLE)?)\s+(?:ONLY\s+)?$/i;
const TABLE_POSITION_BEFORE = /\b(?:FROM|JOIN|INTO|UPDATE|TABLE)\s+(?:ONLY\s+)?$/i;

// ---------------------------------------------------------------- signatures
//
// Postgres tells overloads apart by the types of the input arguments alone:
// not their names, not their defaults, not OUT arguments. `CREATE OR REPLACE`
// with other types makes a second function beside the first, and a DROP that
// names types removes that one only. Read by name alone, `DROP FUNCTION
// f(int)` would retire an `f(text)` the database still has.

/** The text between the parenthesis at `open` and its match, nesting respected. */
function argumentList(text: string, open: number): string | null {
  if (text[open] !== '(') return null;
  let depth = 0;
  for (let k = open; k < text.length; k++) {
    if (text[k] === '(') depth++;
    else if (text[k] === ')' && --depth === 0) return text.slice(open + 1, k);
  }
  return null;
}

function splitTopLevel(list: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = '';
  for (const c of list) {
    if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth--;
    if (c === ',' && depth === 0) { parts.push(cur); cur = ''; } else cur += c;
  }
  if (cur.trim()) parts.push(cur);
  return parts;
}

const TYPE_ALIASES: Record<string, string> = {
  int: 'integer', int4: 'integer', integer: 'integer',
  int8: 'bigint', bigint: 'bigint', int2: 'smallint', smallint: 'smallint',
  bool: 'boolean', boolean: 'boolean',
  varchar: 'character varying', 'character varying': 'character varying',
  char: 'character', character: 'character', bpchar: 'character',
  float8: 'double precision', 'double precision': 'double precision',
  float4: 'real', real: 'real', decimal: 'numeric', numeric: 'numeric',
  timestamptz: 'timestamptz', 'timestamp with time zone': 'timestamptz',
  timestamp: 'timestamp', 'timestamp without time zone': 'timestamp',
  timetz: 'timetz', 'time with time zone': 'timetz', 'time without time zone': 'time',
};
/** Types spelled in more than one word, so the first word is not an argument name. */
const MULTIWORD_TYPE = /^(?:character\s+varying|double\s+precision|bit\s+varying|(?:timestamp|time)\s+with(?:out)?\s+time\s+zone)\b/;

function argumentType(arg: string): string | null {
  let a = arg.replace(/\s+/g, ' ').trim().toLowerCase();
  a = a.replace(/\s+(?:default\b|=).*$/, '').trim();
  const mode = /^(in|out|inout|variadic)\s+/.exec(a);
  if (mode?.[1] === 'out') return null; // not part of the signature
  if (mode) a = a.slice(mode[0].length);
  const words = a.split(' ');
  // a single word is a type (DROP names types only); more words lead with the
  // argument's name unless they spell a multi-word type
  let type = words.length > 1 && !MULTIWORD_TYPE.test(a) ? words.slice(1).join(' ') : a;
  const array = /(\[\])+$/.exec(type)?.[0] ?? '';
  type = type.slice(0, type.length - array.length).replace(/\(.*\)$/, '').replace(/^(?:public|pg_catalog)\./, '').replace(/"/g, '').trim();
  return (TYPE_ALIASES[type] ?? type) + array;
}

function signatureOf(list: string): string {
  return splitTopLevel(list).map(argumentType).filter((t): t is string => t !== null).join(',');
}

interface RefsIn { reads: string[]; writes: string[]; calls: string[] }

/**
 * The tables, views and functions a piece of SQL names, read against the
 * closed lists of what the migrations define. `self` is left out of calls so a
 * recursive function does not call itself.
 */
function refsIn(
  text: string,
  self: string | null,
  known: ReadonlySet<string>,
  functionNames: ReadonlySet<string>,
  external: Set<string>
): RefsIn {
  const reads = new Set<string>();
  const writes = new Set<string>();
  const calls = new Set<string>();
  for (const m of text.matchAll(new RegExp(String.raw`${IDENT}(?:\s*\.\s*${IDENT})?`, 'g'))) {
    const before = text.slice(Math.max(0, m.index! - 40), m.index!);
    if (/\.\s*$/.test(before)) continue; // a column of an alias, `p.products`
    const after = text.slice(m.index! + m[0].length);
    const name = bareName(m[0]);
    if (EXTERNAL_SCHEMAS.has(schemaOf(m[0]))) {
      if (TABLE_POSITION_BEFORE.test(before)) {
        const q = cleanName(m[0]);
        external.add(q);
        (WRITE_BEFORE.test(before) ? writes : reads).add(q);
      }
      continue;
    }
    if (functionNames.has(name) && name !== self && /^\s*\(/.test(after)) calls.add(name);
    else if (known.has(name) && name !== self) (WRITE_BEFORE.test(before) ? writes : reads).add(name);
  }
  for (const w of writes) reads.delete(w);
  return { reads: [...reads].sort(), writes: [...writes].sort(), calls: [...calls].sort() };
}

export function scanMigrations(files: readonly MigrationFile[]): SqlModel {
  const ordered = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  // name → its overloads by signature; `seq` orders them, the newest stands for the name
  const functions = new Map<string, Map<string, { fn: FunctionDef; body: string; seq: number }>>();
  let seq = 0;
  const tables = new Map<string, SqlTable>();
  // views and policies keep their query text; it is read once every table is known
  const views = new Map<string, Omit<SqlView, 'reads' | 'calls'> & { query: string }>();
  const policies = new Map<string, Omit<SqlPolicy, 'reads' | 'calls'> & { query: string }>();
  const triggers = new Map<string, SqlTrigger>();

  for (const file of ordered) {
    const src = file.content;
    const { text, bodies } = mask(src);
    const top = withoutBodies(text, bodies);
    const events: Event[] = [];

    for (const m of top.matchAll(new RegExp(String.raw`\bCREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+${QNAME}\s*\(`, 'gi'))) {
      const body = bodies.find((b) => b.start > m.index!);
      const headEnd = body ? body.start : m.index! + m[0].length;
      const head = top.slice(m.index!, Math.min(headEnd + 400, top.length));
      const language = /\bLANGUAGE\s+([a-z_]+)/i.exec(head)?.[1]?.toLowerCase() ?? null;
      const signature = src.slice(m.index!, headEnd).replace(/\s*\$[A-Za-z_0-9]*\$?$/, '').replace(/\s+/g, ' ').trim();
      const args = argumentList(top, m.index! + m[0].length - 1) ?? '';
      events.push({
        at: m.index!,
        kind: 'create-function',
        signature: signatureOf(args),
        body: body ? src.slice(body.start, body.end) : '',
        fn: {
          name: bareName(m[1]!),
          schema: schemaOf(m[1]!),
          filePath: file.path,
          line: lineAt(src, m.index!),
          endLine: body ? lineAt(src, body.end) : lineAt(src, m.index!),
          language,
          signature,
        },
      });
    }
    for (const m of top.matchAll(new RegExp(String.raw`\bDROP\s+FUNCTION\s+(?:IF\s+EXISTS\s+)?${QNAME}(\s*\()?`, 'gi'))) {
      const args = m[2] ? argumentList(top, m.index! + m[0].length - 1) : null;
      events.push({ at: m.index!, kind: 'drop-function', name: bareName(m[1]!), signature: args === null ? null : signatureOf(args) });
    }
    // In the order the file states them: a DROP and the CREATE after it are a
    // signature change, a CREATE and a DROP after it retire the function.
    events.sort((a, b) => a.at - b.at);
    for (const e of events) {
      if (e.kind === 'create-function') {
        const overloads = functions.get(e.fn.name) ?? functions.set(e.fn.name, new Map()).get(e.fn.name)!;
        overloads.set(e.signature, { fn: e.fn, body: e.body, seq: seq++ });
      } else if (e.signature === null) {
        functions.delete(e.name);
      } else {
        const overloads = functions.get(e.name);
        overloads?.delete(e.signature);
        if (overloads?.size === 0) functions.delete(e.name);
      }
    }

    for (const m of top.matchAll(new RegExp(String.raw`\bCREATE\s+(?:UNLOGGED\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?${QNAME}`, 'gi'))) {
      const name = bareName(m[1]!);
      if (!tables.has(name)) tables.set(name, { name, schema: schemaOf(m[1]!), filePath: file.path, line: lineAt(src, m.index!), endLine: statementEndLine(top, src, m.index!) });
    }
    for (const m of top.matchAll(new RegExp(String.raw`\bCREATE\s+(?:OR\s+REPLACE\s+)?(MATERIALIZED\s+)?VIEW\s+(?:IF\s+NOT\s+EXISTS\s+)?${QNAME}`, 'gi'))) {
      const name = bareName(m[2]!);
      const end = top.indexOf(';', m.index!);
      views.set(name, {
        name, schema: schemaOf(m[2]!), materialized: !!m[1], filePath: file.path,
        line: lineAt(src, m.index!), endLine: statementEndLine(top, src, m.index!),
        query: top.slice(m.index! + m[0].length, end < 0 ? top.length : end),
      });
    }
    for (const m of top.matchAll(new RegExp(String.raw`\bDROP\s+(?:MATERIALIZED\s+)?VIEW\s+(?:IF\s+EXISTS\s+)?${QNAME}`, 'gi'))) {
      // a view dropped here and created again later in this file stands; one only dropped is gone
      const name = bareName(m[1]!);
      const again = new RegExp(String.raw`\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:MATERIALIZED\s+)?VIEW\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:${IDENT}\s*\.\s*)?"?${name}"?\b`, 'i');
      if (!again.test(top.slice(m.index! + m[0].length))) views.delete(name);
    }
    for (const m of top.matchAll(new RegExp(String.raw`\bCREATE\s+POLICY\s+(${IDENT})\s+ON\s+${QNAME}`, 'gi'))) {
      const name = m[1]!.replace(/^"|"$/g, '').replace(/""/g, '"');
      const table = bareName(m[2]!);
      const end = top.indexOf(';', m.index!);
      policies.set(`${table}\0${name}`, {
        name, table, filePath: file.path,
        line: lineAt(src, m.index!), endLine: statementEndLine(top, src, m.index!),
        query: top.slice(m.index! + m[0].length, end < 0 ? top.length : end),
      });
    }
    for (const m of top.matchAll(new RegExp(String.raw`\bDROP\s+POLICY\s+(?:IF\s+EXISTS\s+)?(${IDENT})\s+ON\s+${QNAME}`, 'gi'))) {
      const key = `${bareName(m[2]!)}\0${m[1]!.replace(/^"|"$/g, '').replace(/""/g, '"')}`;
      const kept = policies.get(key);
      // the CREATE that usually follows in the same file wins; a DROP after it removes it
      if (kept && (kept.filePath !== file.path || kept.line < lineAt(src, m.index!))) policies.delete(key);
    }
    for (const m of top.matchAll(new RegExp(String.raw`\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:CONSTRAINT\s+)?TRIGGER\s+(${IDENT})[\s\S]*?\bON\s+${QNAME}[\s\S]*?\bEXECUTE\s+(?:FUNCTION|PROCEDURE)\s+${QNAME}`, 'gi'))) {
      const name = cleanName(m[1]!);
      const onTable = EXTERNAL_SCHEMAS.has(schemaOf(m[2]!)) ? cleanName(m[2]!) : bareName(m[2]!);
      triggers.set(name, { name, table: onTable, function: bareName(m[3]!), filePath: file.path, line: lineAt(src, m.index!), endLine: statementEndLine(top, src, m.index!) });
    }
  }

  const known = new Set([...tables.keys(), ...views.keys()]);
  const functionNames = new Set(functions.keys());
  const external = new Set<string>();
  for (const t of triggers.values()) if (t.table.includes('.')) external.add(t.table);

  const result: SqlFunction[] = [];
  for (const overloads of functions.values()) {
    // one node per name: the newest overload still standing
    const { fn, body } = [...overloads.values()].sort((a, b) => b.seq - a.seq)[0]!;
    result.push({ ...fn, ...refsIn(mask(body).text, fn.name, known, functionNames, external) });
  }
  const viewsOut: SqlView[] = [...views.values()].map(({ query, ...v }) => {
    const r = refsIn(query, v.name, known, functionNames, external);
    return { ...v, reads: r.reads, calls: r.calls };
  });
  // the query starts after `ON <table>`, so the table a policy guards is a read
  // only when an expression queries it again
  const policiesOut: SqlPolicy[] = [...policies.values()].map(({ query, ...p }) => {
    const r = refsIn(query, null, known, functionNames, external);
    return { ...p, reads: r.reads, calls: r.calls };
  });

  const byName = <T extends { name: string }>(a: T, b: T) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  return {
    functions: result.sort(byName),
    tables: [...tables.values()].sort(byName),
    views: viewsOut.sort(byName),
    policies: policiesOut.sort((a, b) => (a.table + a.name < b.table + b.name ? -1 : 1)),
    triggers: [...triggers.values()].sort(byName),
    externalTables: [...external].sort(),
  };
}
