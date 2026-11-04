/**
 * What the F# extractor reads from the syntax tree that codegraph's own
 * database has no place for — the parameters a declaration has, and what the
 * tree shows where a reference is written — kept in a database of F#'s own,
 * `fsharp.db`, beside `codegraph.db`. The extractor replaces a file's rows each
 * time it reads the file for the index; the resolver reads them.
 *
 * It follows `codegraph.db`: built for one database file, it empties itself
 * when that file is a new one — a full re-index — so it never holds what a
 * file no longer says.
 */
import * as fs from 'fs';
import * as path from 'path';
import { createDatabase, type SqliteDatabase } from '../../db/sqlite-adapter';
import { getCodeGraphDir } from '../../directory';

/** Where the grammar places a name. */
export type FsharpPosition =
  /** Applied: `f x`, `b.Add(1)`, `x |> f`, `Tag "a"`. */
  | 'call'
  /** Used as a value: `List.map f`, `Calc.Limit`, `Done`. */
  | 'value'
  /** Where a type is written: an annotation, a field's or case's type, a type argument, `:?`, `:>`. */
  | 'type'
  /** A pattern's head: `| Circle r ->`. */
  | 'pattern'
  /** A record expression: `{ Name = n; Email = e }`. */
  | 'record';

/** A type as a declaration writes it, as far as overloads are told apart by it. */
export type WrittenType =
  /** `int`, `Repo`, `Map<string, int>` (its arguments left out), as a dotted path. */
  | { kind: 'name'; name: string }
  /** `'T`: any type. */
  | { kind: 'variable' }
  /** `int[]`, `int -> int`, `int * string`: no single named type. */
  | { kind: 'compound' };

/** What an argument's type is, as far as the tree shows it. */
export type ArgumentType =
  /** A literal's type, or a type an annotation writes. */
  | { kind: 'written'; type: WrittenType }
  /** What a path evaluates to, read by F#'s scope rules: a type, or a value or function whose declaration states its type. */
  | { kind: 'of'; path: string }
  /** Field `index` of the union case written `casePath`, which a pattern binds. */
  | { kind: 'field'; casePath: string; index: number };

export interface FsharpArgument {
  /** Absent when the tree does not show it. */
  type?: ArgumentType;
  /** `size = 2`: the parameter or property named `size`, or an equality when the callee has none. */
  named?: string;
}

/** A declared parameter, as a call's arguments are matched against it. */
export interface FsharpParameter {
  name?: string;
  /** Absent when no type is written. */
  type?: WrittenType;
  /** A call may leave it out: `?b`, `[<Optional>]`. */
  optional: boolean;
  /** It takes any number of trailing arguments: `[<ParamArray>]`. */
  paramArray: boolean;
}

/** What the tree shows where an F# reference is written. */
export interface FsharpSite {
  /** The name path as written: `['Calc', 'helper']`, `['_', 'Add']` for a member on an expression. */
  path: string[];
  position: FsharpPosition;
  /** Written on a local value; `receiverType` is that value's type when the source states it. */
  onValue: boolean;
  receiverType?: string;
  /** A call's arguments, in order: `[]` for `f ()`. */
  args?: FsharpArgument[];
  /** A record expression's labels, each a path (`Dom.Customer.Name`). */
  labels?: string[][];
  /** `{ c with … }`: what is copied, and its type when stated. */
  copy?: { type?: string };
  /** `size` of `M(size = 2)`: where the call it may be a named argument of is written. */
  labelOf?: { line: number; column: number; name: string };
}

/** Where a reference is written in its file, and what it is: the key a site is read back by. Two can start at one place (`f x >=. y`). */
export interface SiteKey {
  line: number;
  column: number;
  kind: string;
  name: string;
}

/** What the extractor records for one file. */
export interface FileFacts {
  sites: Array<{ key: SiteKey; site: FsharpSite }>;
  parameters: Array<{ nodeId: string; parameters: FsharpParameter[] }>;
  /** How many type parameters each type of the file has as .NET compiles it (`Box<'T>` 1), where the tree shows it. */
  typeParameters: Array<{ nodeId: string; count: number }>;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS parameters (
  file TEXT NOT NULL, node_id TEXT NOT NULL, idx INTEGER NOT NULL, name TEXT,
  type_kind TEXT, type_name TEXT, optional INTEGER NOT NULL, param_array INTEGER NOT NULL,
  PRIMARY KEY (node_id, idx)
);
CREATE INDEX IF NOT EXISTS parameters_file ON parameters(file);
CREATE TABLE IF NOT EXISTS sites (
  id INTEGER PRIMARY KEY, file TEXT NOT NULL, line INTEGER NOT NULL, col INTEGER NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL,
  path TEXT NOT NULL, position TEXT NOT NULL, on_value INTEGER NOT NULL, receiver_type TEXT, has_args INTEGER NOT NULL,
  is_copy INTEGER NOT NULL, copy_type TEXT, label_line INTEGER, label_col INTEGER, label_name TEXT,
  UNIQUE (file, line, col, kind, name)
);
CREATE TABLE IF NOT EXISTS site_labels (site INTEGER NOT NULL, idx INTEGER NOT NULL, path TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS site_labels_site ON site_labels(site);
CREATE TABLE IF NOT EXISTS site_args (
  site INTEGER NOT NULL, idx INTEGER NOT NULL, named TEXT,
  type_kind TEXT, written_kind TEXT, type_text TEXT, field_index INTEGER
);
CREATE INDEX IF NOT EXISTS site_args_site ON site_args(site);
CREATE TABLE IF NOT EXISTS type_parameters (file TEXT NOT NULL, node_id TEXT PRIMARY KEY, count INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS type_parameters_file ON type_parameters(file);
`;

/**
 * Which `codegraph.db` of `root` is there: the file itself, by its number and
 * when it was created. A full re-index removes the file and builds a new one;
 * a sync or a migration writes into the same file.
 */
function codegraphGeneration(root: string): string | null {
  const stat = fs.statSync(path.join(getCodeGraphDir(root), 'codegraph.db'), { throwIfNoEntry: false, bigint: true });
  return stat ? `${stat.ino}:${stat.birthtimeNs}` : null;
}

/**
 * Keep `facts` as what `file` of the project at `root` holds now, replacing
 * what the store held for it. The store is opened for this one write and
 * closed after it: whichever thread read the file writes its facts before it
 * hands the file's result on, so a resolver never reads a file ahead of them,
 * and no connection outlives the write to hold the directory. Being in step
 * with `codegraph.db` is settled in the same transaction as the write, which
 * takes the write lock first: of the threads that find a new `codegraph.db`
 * together, one empties the store, and the others see that it has.
 */
export function keepFileFacts(root: string, file: string, facts: FileFacts): void {
  const dir = getCodeGraphDir(root);
  fs.mkdirSync(dir, { recursive: true });
  const { db } = createDatabase(path.join(dir, 'fsharp.db'));
  try {
    db.pragma('busy_timeout = 10000');
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.exec(SCHEMA);
    db.transaction(() => {
      const generation = codegraphGeneration(root);
      const stored = db.prepare("SELECT value FROM meta WHERE key = 'generation'").get() as { value: string } | undefined;
      if (generation !== null && stored?.value !== generation) {
        db.exec('DELETE FROM parameters; DELETE FROM sites; DELETE FROM site_labels; DELETE FROM site_args; DELETE FROM type_parameters;');
        db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('generation', ?)").run(generation);
      }
      replaceFileFacts(db, file, facts);
    }, { immediate: true })();
  } finally {
    db.close();
  }
}

function replaceFileFacts(db: SqliteDatabase, file: string, facts: FileFacts): void {
  {
    const old = db.prepare('SELECT id FROM sites WHERE file = ?').all(file) as Array<{ id: number }>;
    const dropLabels = db.prepare('DELETE FROM site_labels WHERE site = ?');
    const dropArgs = db.prepare('DELETE FROM site_args WHERE site = ?');
    for (const { id } of old) {
      dropLabels.run(id);
      dropArgs.run(id);
    }
    db.prepare('DELETE FROM sites WHERE file = ?').run(file);
    db.prepare('DELETE FROM parameters WHERE file = ?').run(file);
    db.prepare('DELETE FROM type_parameters WHERE file = ?').run(file);

    const addTypeParameters = db.prepare('INSERT OR REPLACE INTO type_parameters (file, node_id, count) VALUES (?, ?, ?)');
    for (const { nodeId, count } of facts.typeParameters) addTypeParameters.run(file, nodeId, count);

    const addParameter = db.prepare(
      'INSERT OR REPLACE INTO parameters (file, node_id, idx, name, type_kind, type_name, optional, param_array) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    for (const { nodeId, parameters } of facts.parameters) {
      parameters.forEach((p, idx) => addParameter.run(file, nodeId, idx, p.name ?? null, p.type?.kind ?? null,
        p.type?.kind === 'name' ? p.type.name : null, p.optional ? 1 : 0, p.paramArray ? 1 : 0));
    }

    const addSite = db.prepare(`INSERT OR IGNORE INTO sites (file, line, col, kind, name, path, position, on_value, receiver_type, has_args,
      is_copy, copy_type, label_line, label_col, label_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const addLabel = db.prepare('INSERT INTO site_labels (site, idx, path) VALUES (?, ?, ?)');
    const addArg = db.prepare(
      'INSERT INTO site_args (site, idx, named, type_kind, written_kind, type_text, field_index) VALUES (?, ?, ?, ?, ?, ?, ?)');
    for (const { key, site } of facts.sites) {
      const inserted = addSite.run(file, key.line, key.column, key.kind, key.name, joinPath(site.path), site.position, site.onValue ? 1 : 0, site.receiverType ?? null,
        site.args ? 1 : 0, site.copy ? 1 : 0, site.copy?.type ?? null, site.labelOf?.line ?? null, site.labelOf?.column ?? null, site.labelOf?.name ?? null);
      if (inserted.changes === 0) continue;
      const id = Number(inserted.lastInsertRowid);
      (site.labels ?? []).forEach((label, idx) => addLabel.run(id, idx, joinPath(label)));
      (site.args ?? []).forEach((arg, idx) => {
        const t = arg.type;
        addArg.run(id, idx, arg.named ?? null, t?.kind ?? null,
          t?.kind === 'written' ? t.type.kind : null,
          t?.kind === 'written' ? (t.type.kind === 'name' ? t.type.name : null) : t?.kind === 'of' ? t.path : t?.kind === 'field' ? t.casePath : null,
          t?.kind === 'field' ? t.index : null);
      });
    }
  }
}

/**
 * Run `read` on the store of `root`, opened only for reading, when it is in
 * step with `codegraph.db`; otherwise nothing it holds is trusted, and `read`
 * is not run. Readers never wait for a write: the store is in WAL mode.
 */
function readStore(root: string, read: (db: SqliteDatabase) => void): void {
  const file = path.join(getCodeGraphDir(root), 'fsharp.db');
  if (!fs.existsSync(file)) return;
  const generation = codegraphGeneration(root);
  const { db } = createDatabase(file, { readOnly: true });
  try {
    db.pragma('busy_timeout = 10000');
    const stored = db.prepare("SELECT value FROM meta WHERE key = 'generation'").get() as { value: string } | undefined;
    if (stored !== undefined && stored.value === generation) read(db);
  } finally {
    db.close();
  }
}

const writtenType = (kind: string | null, name: string | null): WrittenType | undefined =>
  kind === 'name' && name !== null ? { kind: 'name', name } : kind === 'variable' ? { kind: 'variable' } : kind === 'compound' ? { kind: 'compound' } : undefined;

/**
 * A name path as one column: its names one per line. No F# name holds a line
 * break, not even one written in double backticks, so the path reads back whole.
 */
const joinPath = (path: readonly string[]): string => path.join('\n');
const splitPath = (stored: string): string[] => stored.split('\n');

/** How a site is looked up in what `readFileFacts` returns. */
export function siteKeyOf(line: number, column: number, kind: string, name: string): string {
  return `${line}:${column}:${kind}:${name}`;
}

/** What the store holds for `file`. */
export interface StoredFacts {
  /** Its sites, by `siteKeyOf`. */
  sites: Map<string, FsharpSite>;
  /** The parameters of its declarations, by node id. */
  parameters: Map<string, FsharpParameter[]>;
  /** The type parameter count of its types, by node id. */
  typeParameters: Map<string, number>;
}

/** What the store holds for `file` (see `StoredFacts`). */
export function readFileFacts(root: string, file: string): StoredFacts {
  const sites = new Map<string, FsharpSite>();
  const parameters = new Map<string, FsharpParameter[]>();
  const typeParameters = new Map<string, number>();
  readStore(root, (db) => {
    readSites(db, file, sites);
    readParameters(db, file, parameters);
    for (const r of db.prepare('SELECT node_id, count FROM type_parameters WHERE file = ?').all(file) as Array<{ node_id: string; count: number }>) {
      typeParameters.set(r.node_id, r.count);
    }
  });
  return { sites, parameters, typeParameters };
}

function readSites(db: SqliteDatabase, file: string, out: Map<string, FsharpSite>): void {
  type SiteRow = { id: number; line: number; col: number; kind: string; name: string; path: string; position: FsharpPosition; on_value: number; receiver_type: string | null;
    has_args: number; is_copy: number; copy_type: string | null; label_line: number | null; label_col: number | null; label_name: string | null };
  const rows = db.prepare('SELECT * FROM sites WHERE file = ?').all(file) as SiteRow[];
  if (rows.length === 0) return;
  const labels = db.prepare(`SELECT l.site, l.idx, l.path FROM site_labels l JOIN sites s ON s.id = l.site
    WHERE s.file = ? ORDER BY l.site, l.idx`).all(file) as Array<{ site: number; idx: number; path: string }>;
  const args = db.prepare(`SELECT a.* FROM site_args a JOIN sites s ON s.id = a.site WHERE s.file = ? ORDER BY a.site, a.idx`).all(file) as Array<{
    site: number; idx: number; named: string | null; type_kind: string | null; written_kind: string | null; type_text: string | null; field_index: number | null }>;
  const byId = new Map<number, FsharpSite>();
  for (const r of rows) {
    const site: FsharpSite = {
      path: splitPath(r.path),
      position: r.position,
      onValue: r.on_value === 1,
      ...(r.receiver_type !== null ? { receiverType: r.receiver_type } : {}),
      ...(r.has_args === 1 ? { args: [] } : {}),
      ...(r.is_copy === 1 ? { copy: r.copy_type !== null ? { type: r.copy_type } : {} } : {}),
      ...(r.label_line !== null && r.label_col !== null && r.label_name !== null ? { labelOf: { line: r.label_line, column: r.label_col, name: r.label_name } } : {}),
    };
    byId.set(r.id, site);
    out.set(siteKeyOf(r.line, r.col, r.kind, r.name), site);
  }
  for (const l of labels) {
    const site = byId.get(l.site);
    if (site) (site.labels ??= []).push(splitPath(l.path));
  }
  for (const a of args) {
    const site = byId.get(a.site);
    if (!site?.args) continue;
    const written = writtenType(a.written_kind, a.type_text);
    const type: ArgumentType | undefined =
      a.type_kind === 'written' && written ? { kind: 'written', type: written }
        : a.type_kind === 'of' && a.type_text !== null ? { kind: 'of', path: a.type_text }
          : a.type_kind === 'field' && a.type_text !== null && a.field_index !== null ? { kind: 'field', casePath: a.type_text, index: a.field_index }
            : undefined;
    site.args.push({ ...(type ? { type } : {}), ...(a.named !== null ? { named: a.named } : {}) });
  }
}

/** The parameters of the declarations of `file` the store holds, by node id. */
function readParameters(db: SqliteDatabase, file: string, out: Map<string, FsharpParameter[]>): void {
  const rows = db.prepare('SELECT * FROM parameters WHERE file = ? ORDER BY node_id, idx').all(file) as Array<{
    node_id: string; name: string | null; type_kind: string | null; type_name: string | null; optional: number; param_array: number }>;
  for (const r of rows) {
    const type = writtenType(r.type_kind, r.type_name);
    const list = out.get(r.node_id) ?? [];
    list.push({ ...(r.name !== null ? { name: r.name } : {}), ...(type ? { type } : {}), optional: r.optional === 1, paramArray: r.param_array === 1 });
    out.set(r.node_id, list);
  }
}
