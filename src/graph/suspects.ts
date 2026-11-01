/**
 * Suspect call edges: the `calls` edges the resolver bound by NAME ONLY, ranked by how
 * likely each one is wrong. Read-only over an existing index; nothing here writes.
 * Shared by the CLI `codegraph suspects` and the MCP tool `codegraph_suspects`.
 *
 * CANDIDATE EDGE. kind = 'calls', `metadata.resolvedBy` present, and name-only:
 *   resolvedBy = 'fuzzy'
 *   OR (resolvedBy = 'exact-match' AND the caller and target are not in the same file)
 *   OR (resolvedBy = 'instance-method' AND confidence < 0.9).
 * Import, qualified-name and declared-receiver bindings are not name guesses. Framework
 * edges are pattern matches, not name guesses; file-path and function-ref edges bind by path
 * or by a function value, not by name. An instance-method edge below 0.9
 * is one the resolver bound with less than a declared receiver type: an inferred or
 * inherited type, a single trait or impl in scope, or a single owner of the name (0.85 or
 * 0.8), or a weaker guess (0.7 or 0.65). Every such edge is a candidate. Synthesized edges carry no
 * resolvedBy and are excluded. A missing confidence counts as 1.
 * Same-file exception: an exact-match edge whose caller and target lie in one file is
 * certain, not a candidate. Within one file the extractor and resolver see the definition the
 * name binds to in the caller's own scope, so a same-file exact name match is the local
 * definition, not a guess. Every ordinary local TypeScript call resolves as exact-match, so
 * counting same-file matches as candidates would mark most correct local calls questionable,
 * and a strict mode that drops questionable edges would drop real ones ("silent beats wrong").
 * A fuzzy edge stays a candidate even within one file. An unknown file (missing node, null
 * path) on either end is not the same file, so the edge stays a candidate.
 * The predicate has two forms, `candidateEdgeSql` (SQL over an `edges` row) and
 * `isCandidateEdge` (JS over its fields), which agree edge for edge. findSuspectsInDb uses the
 * SQL form. Both are exported so reports can share one questionable-edge rule.
 *
 * FLAGS (on each edge; a target's flags are the union, in SuspectFlag order):
 *   std-collision        the target's name is a standard-library method name in its language
 *                        (`options.isStdMethod`, default `stdCollision`): a call like
 *                        `items.sorted()` on a stdlib value was bound to a project method.
 *                        The default `stdCollision` knows Rust (name-matcher's list) and
 *                        Swift (`isSwiftStdMethodName` from resolution/swift-builtins.ts).
 *   missing-import       the caller and target sit in different known modules and the caller's
 *                        file does not import the target's module (see below).
 *   several-definitions  more than one function/method node of the target's name and language
 *                        exists, so a name match had more than one place to land.
 *   low-confidence       the edge's confidence is below 0.8.
 *
 * SCORE. An edge scores std-collision 4 + missing-import 3 + several-definitions 2 +
 * low-confidence 1; 0 means name-only and nothing else (still listed). A target's score is
 * the max over its edges. Targets rank by score desc, then edgeCount desc, then
 * targetQualifiedName asc, then targetId asc; a target's edges rank by score desc, then
 * callerFile asc, then line asc (no line last), then callerId asc. Every comparison is a
 * plain code-unit comparison, so the order is deterministic across locales.
 *
 * MISSING-IMPORT abstains (does not flag) whenever a module is unknown, and when caller and
 * target are in different languages.
 *   Swift module: `swiftModule` derives the SwiftPM module from the path segment after the last
 *     `Sources` or `Tests` directory, when a further directory follows it (SwiftPM layout);
 *     otherwise unknown, so Xcode-style layouts abstain. That directory's name decides
 *     sameness here; the name an import must use is the directory's c99name
 *     (`swiftModuleName`, SwiftPM's own rule: each Unicode scalar outside its C99 Annex D
 *     allowed-range table becomes `_`, and a leading digit is replaced by `_`;
 *     `Sources/mcp-benchmarker` is imported as `mcp_benchmarker`). An `import` node in the
 *     caller's file whose name before its first '.' equals that name counts (`import X`,
 *     `@testable import X`, `import struct X.Y`).
 *     Known limitation: Package.swift is not read, so a target whose `path:` gives it a
 *     name different from its directory is still named by the directory.
 *   Rust crate: from the Cargo workspace. The root `Cargo.toml`'s `[workspace] members`
 *     (globs expanded) and each member's `[package] name` are read by
 *     `getCargoWorkspaceCrateMap`, not parsed here. A file's crate is the member directory that
 *     is the longest `member + '/'` prefix of its path (a member `.` is the root and matches
 *     every file, at the lowest priority); its name is the package name with '-' -> '_'. Two
 *     files are in the same crate when their member directories are equal. A project with no
 *     root workspace, or a file under no member, has an unknown crate, so it abstains. An
 *     `import` node in the caller's file named the crate (the first segment of
 *     `use crate_name::…`), or a refName starting with `<crate>::`, counts. `use crate::…` /
 *     `self::` / `super::` never name another crate.
 *     Known limitation: glob imports (`use b::*`), renames (`use b::X as Y`, `use b as c`),
 *     `extern crate` and `mod` produce no import node, so a caller that reaches another
 *     crate only through them is flagged.
 *   Other languages: unknown (abstain).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { DatabaseConnection, getDatabasePath } from '../db';
import type { SqliteDatabase } from '../db/sqlite-adapter';
import { getCargoWorkspaceCrateMap } from '../resolution/frameworks/cargo-workspace';
import { isStdMethodName } from '../resolution/name-matcher';
import { isSwiftStdMethodName } from '../resolution/swift-builtins';
import { swiftModule, type ModuleOf } from './swift-module';
import type { ResolutionContext } from '../resolution/types';

export type SuspectFlag = 'std-collision' | 'missing-import' | 'several-definitions' | 'low-confidence';

/** The fixed flag order, used for every flag list this module emits. */
const FLAG_ORDER: readonly SuspectFlag[] = ['std-collision', 'missing-import', 'several-definitions', 'low-confidence'];

/**
 * Per-flag edge score weights: how strongly each flag suggests a wrong binding, std-collision
 * highest. Scores add, so missing-import + several-definitions (5) outrank std-collision
 * alone (4).
 */
const FLAG_WEIGHT: Readonly<Record<SuspectFlag, number>> = {
  'std-collision': 4,
  'missing-import': 3,
  'several-definitions': 2,
  'low-confidence': 1,
};

/** Below this an instance-method edge was bound without a declared receiver type; at or above it the type was declared. */
export const DECLARED_INSTANCE_CONFIDENCE = 0.9;
/** Below this a candidate edge is flagged low-confidence. */
const LOW_CONFIDENCE = 0.8;
const DEFAULT_MAX_EDGES_PER_TARGET = 5;

export interface SuspectEdge {
  callerId: string;
  callerName: string;
  callerFile: string;
  line: number | null;
  refName: string | null;
  resolvedBy: string;
  confidence: number;
  flags: SuspectFlag[];
}

export interface Suspect {
  targetId: string;
  targetName: string;
  targetQualifiedName: string;
  targetKind: string;
  targetFile: string;
  targetLine: number;
  language: string;
  /** Union over its edges, in SuspectFlag order. */
  flags: SuspectFlag[];
  /** Function/method nodes of the target's name in the same language. */
  definitions: number;
  /** The max edge score. */
  score: number;
  /** All suspect call edges to this target (before maxEdgesPerTarget). */
  edgeCount: number;
  /** Score desc, then callerFile, then line (none last), then callerId; at most maxEdgesPerTarget. */
  edges: SuspectEdge[];
}

export interface SuspectOptions {
  /** Maximum number of targets returned; default no limit. */
  limit?: number;
  /** Maximum edges listed per target; default 5. edgeCount still counts all of them. */
  maxEdgesPerTarget?: number;
  /** Standard-library method-name predicate; default `stdCollision`. */
  isStdMethod?: (language: string, name: string) => boolean;
}

/** Whether `name` is a standard-library method name in `language` (Rust and Swift; false for any other language). */
export function stdCollision(language: string, name: string): boolean {
  switch (language) {
    case 'rust':
      return isStdMethodName('rust', name);
    case 'swift':
      // The one Swift list lives in swift-builtins.ts (SWIFT_STD_METHODS); do not copy it here.
      return isSwiftStdMethodName(name);
    default:
      return false;
  }
}

interface CandidateRow {
  callerId: string;
  callerName: string;
  callerFile: string;
  callerLanguage: string;
  line: number | null;
  refName: string | null;
  resolvedBy: string;
  confidence: number;
  targetId: string;
  targetName: string;
  targetQualifiedName: string;
  targetKind: string;
  targetFile: string;
  targetLine: number;
  targetLanguage: string;
}

/**
 * The CANDIDATE EDGE predicate (see the header) as an SQL boolean expression over the `edges`
 * row named `alias` (a table name or alias with `kind`, `metadata`, `source` and `target`
 * columns). Self-contained: the caller and target files come from correlated subqueries on
 * `nodes` by primary key, so the caller needs no join and can use it in a WHERE or inside
 * `SUM(CASE WHEN ... END)`. A missing node or null file_path makes the comparison NULL, which
 * COALESCE turns into "not the same file", so such an edge stays a candidate.
 * Evaluates to 1 or 0 (never NULL). `alias` is interpolated into the SQL: pass only a literal
 * identifier, never input.
 */
export function candidateEdgeSql(alias: string): string {
  const by = `json_extract(${alias}.metadata, '$.resolvedBy')`;
  const sameFile =
    `COALESCE((SELECT file_path FROM nodes WHERE id = ${alias}.source)` +
    ` = (SELECT file_path FROM nodes WHERE id = ${alias}.target), 0)`;
  return (
    `(${alias}.kind = 'calls' AND ${by} IS NOT NULL AND (${by} = 'fuzzy'` +
    ` OR (${by} = 'exact-match' AND NOT ${sameFile})` +
    ` OR (${by} = 'instance-method'` +
    ` AND COALESCE(json_extract(${alias}.metadata, '$.confidence'), 1) < ${DECLARED_INSTANCE_CONFIDENCE})))`
  );
}

/**
 * The CANDIDATE EDGE predicate over an edge's kind, parsed metadata (null when the edge has
 * none) and its caller's and target's file paths. Same file only when both paths are strings
 * and equal, as in the SQL form. The confidence is read as the SQL form's
 * `COALESCE(json_extract(...), 1) < 0.9` reads it, so the two never disagree: a number is
 * itself; a JSON boolean is 1 (true) or 0 (false), as json_extract returns it; anything else
 * (null, absent, a string, an object) counts as 1. A string is not parsed: json_extract keeps
 * it TEXT, and SQLite orders TEXT above every number, so '0.5' is not below 0.9.
 */
export function isCandidateEdge(
  kind: string,
  metadata: Record<string, unknown> | null | undefined,
  sourceFile: string | null | undefined,
  targetFile: string | null | undefined,
): boolean {
  if (kind !== 'calls' || !metadata) return false;
  const by = metadata.resolvedBy;
  if (by === 'fuzzy') return true;
  if (by === 'exact-match') {
    const sameFile = typeof sourceFile === 'string' && typeof targetFile === 'string' && sourceFile === targetFile;
    return !sameFile;
  }
  if (by !== 'instance-method') return false;
  const c = metadata.confidence;
  const confidence = typeof c === 'number' ? c : typeof c === 'boolean' ? (c ? 1 : 0) : 1;
  return confidence < DECLARED_INSTANCE_CONFIDENCE;
}

/** The candidate rows: every edge `candidateEdgeSql('e')` accepts, with its caller and target. */
const CANDIDATE_SQL = `
  SELECT s.id AS callerId, s.name AS callerName, s.file_path AS callerFile, s.language AS callerLanguage,
         e.line AS line,
         json_extract(e.metadata, '$.refName') AS refName,
         json_extract(e.metadata, '$.resolvedBy') AS resolvedBy,
         COALESCE(json_extract(e.metadata, '$.confidence'), 1) AS confidence,
         t.id AS targetId, t.name AS targetName, t.qualified_name AS targetQualifiedName,
         t.kind AS targetKind, t.file_path AS targetFile, t.start_line AS targetLine,
         t.language AS targetLanguage
    FROM edges e
    JOIN nodes s ON s.id = e.source
    JOIN nodes t ON t.id = e.target
   WHERE ${candidateEdgeSql('e')}`;

/** A workspace member: its directory (no trailing '/', '' for the root) and its crate name. */
interface CargoMember {
  dir: string;
  name: string;
}

/**
 * The Cargo workspace members of the project at `projectRoot`, longest directory first, so
 * the first member whose `dir + '/'` prefixes a path is that file's crate. Empty when the
 * project has no root workspace.
 */
function cargoMembers(projectRoot: string): CargoMember[] {
  const root = path.resolve(projectRoot);
  // getCargoWorkspaceCrateMap reads only `readFile` and `listDirectories` (both relative to
  // the project root); this is a read-only index, so there is no ReferenceResolver and its
  // context to borrow. The cast is safe for exactly those two members and nothing else.
  const context = {
    readFile: (relPath: string): string | null => {
      try {
        return fs.readFileSync(path.join(root, relPath), 'utf8');
      } catch {
        return null;
      }
    },
    listDirectories: (relPath: string): string[] => {
      const target = relPath === '.' || relPath === '' ? root : path.join(root, relPath);
      try {
        return fs.readdirSync(target, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
      } catch {
        return [];
      }
    },
  } as unknown as ResolutionContext;
  // The map holds both the `a-b` and `a_b` alias of each package; both name one directory.
  const byDir = new Map<string, string>();
  for (const [alias, member] of getCargoWorkspaceCrateMap(context)) {
    let dir = member.replace(/^(\.\/)+/, '');
    if (dir === '.') dir = '';
    byDir.set(dir, alias.replace(/-/g, '_'));
  }
  return [...byDir].map(([dir, name]) => ({ dir, name })).sort((a, b) => b.dir.length - a.dir.length);
}

/** Rust crate: the longest workspace member directory containing the file, or unknown. */
function rustCrate(filePath: string, members: readonly CargoMember[]): ModuleOf | null {
  const file = filePath.replace(/\\/g, '/');
  for (const m of members) {
    if (m.dir === '' || file.startsWith(`${m.dir}/`)) return { id: m.dir, name: m.name };
  }
  return null;
}

function moduleOf(language: string, filePath: string, members: readonly CargoMember[]): ModuleOf | null {
  if (language === 'swift') return swiftModule(filePath);
  if (language === 'rust') return rustCrate(filePath, members);
  return null;
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function orderFlags(flags: Set<SuspectFlag>): SuspectFlag[] {
  return FLAG_ORDER.filter((f) => flags.has(f));
}

function scoreOf(flags: readonly SuspectFlag[]): number {
  return flags.reduce((sum, f) => sum + FLAG_WEIGHT[f], 0);
}

/** findSuspects over an already-open database; `projectRoot` is where the Cargo workspace is read. */
export function findSuspectsInDb(db: SqliteDatabase, projectRoot: string, options: SuspectOptions = {}): Suspect[] {
  const isStd = options.isStdMethod ?? stdCollision;
  const maxEdges = options.maxEdgesPerTarget ?? DEFAULT_MAX_EDGES_PER_TARGET;
  const members = cargoMembers(projectRoot);

  const definitionsStmt = db.prepare(
    `SELECT COUNT(*) AS n FROM nodes WHERE name = ? AND language = ? AND kind IN ('function', 'method')`,
  );
  const importsStmt = db.prepare(`SELECT name FROM nodes WHERE kind = 'import' AND file_path = ?`);
  const definitionsCache = new Map<string, number>();
  const importsCache = new Map<string, string[]>();

  const definitionsOf = (name: string, language: string): number => {
    const key = `${language}\0${name}`;
    let n = definitionsCache.get(key);
    if (n === undefined) {
      n = Number((definitionsStmt.get(name, language) as { n: number }).n);
      definitionsCache.set(key, n);
    }
    return n;
  };
  const importsOf = (file: string): string[] => {
    let names = importsCache.get(file);
    if (!names) {
      names = (importsStmt.all(file) as Array<{ name: string }>).map((r) => r.name);
      importsCache.set(file, names);
    }
    return names;
  };

  const missingImport = (row: CandidateRow): boolean => {
    if (row.callerLanguage !== row.targetLanguage) return false;
    const language = row.targetLanguage;
    const from = moduleOf(language, row.callerFile, members);
    const to = moduleOf(language, row.targetFile, members);
    if (!from || !to || from.id === to.id) return false;
    const imports = importsOf(row.callerFile);
    if (language === 'swift') {
      return !imports.some((name) => name.split('.')[0] === to.name);
    }
    // rust
    if (row.refName !== null && row.refName.startsWith(`${to.name}::`)) return false;
    return !imports.includes(to.name);
  };

  interface Group { suspect: Suspect; scored: Array<{ edge: SuspectEdge; score: number }> }
  const groups = new Map<string, Group>();

  for (const row of db.prepare(CANDIDATE_SQL).all() as CandidateRow[]) {
    const confidence = Number(row.confidence);
    let group = groups.get(row.targetId);
    if (!group) {
      group = {
        suspect: {
          targetId: row.targetId,
          targetName: row.targetName,
          targetQualifiedName: row.targetQualifiedName,
          targetKind: row.targetKind,
          targetFile: row.targetFile,
          targetLine: row.targetLine,
          language: row.targetLanguage,
          flags: [],
          definitions: definitionsOf(row.targetName, row.targetLanguage),
          score: 0,
          edgeCount: 0,
          edges: [],
        },
        scored: [],
      };
      groups.set(row.targetId, group);
    }
    const flags = new Set<SuspectFlag>();
    if (isStd(row.targetLanguage, row.targetName)) flags.add('std-collision');
    if (missingImport(row)) flags.add('missing-import');
    if (group.suspect.definitions > 1) flags.add('several-definitions');
    if (confidence < LOW_CONFIDENCE) flags.add('low-confidence');
    const ordered = orderFlags(flags);
    group.scored.push({
      score: scoreOf(ordered),
      edge: {
        callerId: row.callerId,
        callerName: row.callerName,
        callerFile: row.callerFile,
        line: row.line ?? null,
        refName: row.refName ?? null,
        resolvedBy: row.resolvedBy,
        confidence,
        flags: ordered,
      },
    });
  }

  const suspects: Suspect[] = [];
  for (const { suspect, scored } of groups.values()) {
    scored.sort((a, b) =>
      b.score - a.score
      || compareText(a.edge.callerFile, b.edge.callerFile)
      || (a.edge.line ?? Number.MAX_SAFE_INTEGER) - (b.edge.line ?? Number.MAX_SAFE_INTEGER)
      || compareText(a.edge.callerId, b.edge.callerId));
    const union = new Set<SuspectFlag>();
    for (const { edge } of scored) for (const f of edge.flags) union.add(f);
    suspect.flags = orderFlags(union);
    suspect.score = scored.reduce((max, s) => Math.max(max, s.score), 0);
    suspect.edgeCount = scored.length;
    suspect.edges = scored.slice(0, Math.max(0, maxEdges)).map((s) => s.edge);
    suspects.push(suspect);
  }

  suspects.sort((a, b) =>
    b.score - a.score
    || b.edgeCount - a.edgeCount
    || compareText(a.targetQualifiedName, b.targetQualifiedName)
    || compareText(a.targetId, b.targetId));
  return options.limit === undefined ? suspects : suspects.slice(0, Math.max(0, options.limit));
}

/** Suspect call edges of the project at `projectRoot`, read from its index read-only. */
export function findSuspects(projectRoot: string, options: SuspectOptions = {}): Suspect[] {
  const conn = DatabaseConnection.open(getDatabasePath(projectRoot), { readOnly: true });
  try {
    return findSuspectsInDb(conn.getDb(), projectRoot, options);
  } finally {
    conn.close();
  }
}

/**
 * Text report: a header line, one rank line per target, and its listed edges indented.
 * An empty flag list prints as an empty field; a missing line prints `?`, a missing refName `-`.
 */
export function formatSuspects(suspects: Suspect[]): string {
  if (suspects.length === 0) return 'No suspect call edges.';
  const total = suspects.reduce((sum, s) => sum + s.edgeCount, 0);
  const lines = [`${suspects.length} suspect targets (${total} call edges)`];
  suspects.forEach((s, i) => {
    lines.push(
      `${i + 1}. [score ${s.score}] ${s.targetQualifiedName}  ${s.targetFile}:${s.targetLine}  ` +
      `${s.edgeCount} call(s)  ${s.flags.join(', ')}  defs=${s.definitions}`,
    );
    for (const e of s.edges) {
      lines.push(
        `    ${e.callerName}  ${e.callerFile}:${e.line ?? '?'}  ${e.refName ?? '-'}  ${e.resolvedBy} ${String(e.confidence)}`,
      );
    }
  });
  return lines.join('\n');
}

/** The JSON form: `{ version: 1, suspects }`. */
export function suspectsToJson(suspects: Suspect[]): { version: 1; suspects: Suspect[] } {
  return { version: 1, suspects };
}
