/**
 * Supabase: the SQL a project's migrations define, and the calls its
 * TypeScript makes into it by name.
 *
 * Two halves.
 *
 * **The SQL side** reads `supabase/migrations/*.sql` (see `supabase-sql.ts`
 * for why without a grammar) into functions, tables, views, policies and
 * triggers. A function is redefined across migrations — a search function
 * can be redefined a dozen times as a product grows — and only the last
 * definition is the one the database runs, so these are nodes no single file can decide on:
 * `crossFileNodes()` returns the complete set on every index and sync, and the
 * orchestrator adds, removes and renames to match. That method returns nodes
 * of one kind, so there is a resolver per kind: functions (`function`),
 * tables and views (`struct`), policies and triggers (`property`).
 *
 * **The bridge** needs no extraction of its own. The TypeScript extractor
 * already records `supabase.rpc('search_products', …)` as a `calls` reference
 * named `supabase.rpc` from the function it is written in, with its line and
 * column; it only cannot know the target, which is the string. `resolve()`
 * reads that string at the call and binds the reference to the SQL function
 * (`rpc`) or table (`from`) of that name — and only when one exists, which is
 * what keeps `Array.from('abc')` and a project's own `.from()` out of it.
 * `supabase.storage.from('invoices')` names a storage bucket, not a table, and
 * is never bound: binding it to a same-named table would be worse than nothing.
 *
 * References inside the SQL (a body reads a table, writes one, calls another
 * function; a policy guards a table; a trigger fires on one and runs a
 * function) carry their meaning in a prefix — `sql-read:products` — the way
 * React's route references carry `lazy-import:`. The prefix survives the
 * database round trip that a side table would not.
 */

import type { Node, Language } from '../../types';
import type {
  CrossFileNodes,
  FrameworkResolver,
  ResolutionContext,
  ResolvedRef,
  UnresolvedRef,
} from '../types';
import { scanMigrations, type SqlModel } from './supabase-sql';

const MIGRATION = /(?:^|\/)supabase\/migrations\/[^/]+\.sql$/;
const TS_LANGUAGES: Language[] = ['typescript', 'tsx', 'javascript', 'jsx'];

const PREFIX = {
  read: 'sql-read:',
  write: 'sql-write:',
  call: 'sql-call:',
  table: 'sql-table:',
} as const;

const toPosix = (p: string) => p.replace(/\\/g, '/');

// ---------------------------------------------------------------- the model

/**
 * One Supabase project per `supabase/migrations` folder. A monorepo of examples
 * has several, and the same names recur in each (`profiles`,
 * `handle_new_user`): each folder is its own database, so its migrations are
 * replayed apart from the others' and its names bind only within it. The root
 * is what precedes `supabase/migrations/` (`examples/chat/`, or `''` for the
 * repository's own).
 */
interface Project { root: string; model: SqlModel }

const MIGRATIONS_DIR = 'supabase/migrations/';

function rootOfMigration(filePath: string): string {
  const p = toPosix(filePath);
  return p.slice(0, p.lastIndexOf(MIGRATIONS_DIR));
}

/**
 * The migrations, read once per set of files. Three resolvers ask for the same
 * projects in one pass; the key is every path with its length, so an edit to
 * any migration reads them again.
 */
let cached: { key: string; projects: Project[] } | null = null;

function projectsOf(context: ResolutionContext): Project[] {
  const paths = context.getAllFiles().filter((f) => MIGRATION.test(toPosix(f))).sort();
  const files = paths.map((path) => ({ path, content: context.readFile(path) ?? '' }));
  const key = files.map((f) => `${f.path}\0${f.content.length}`).join('\n');
  if (cached?.key !== key) {
    const byRoot = new Map<string, typeof files>();
    for (const f of files) {
      const root = rootOfMigration(f.path);
      (byRoot.get(root) ?? byRoot.set(root, []).get(root)!).push(f);
    }
    cached = { key, projects: [...byRoot].map(([root, own]) => ({ root, model: scanMigrations(own) })) };
  }
  return cached.projects;
}

/** The project a file belongs to: the deepest one whose root contains it. */
function projectRootFor(filePath: string, context: ResolutionContext): string | null {
  const p = toPosix(filePath);
  let best: string | null = null;
  for (const { root } of projectsOf(context)) {
    if (p.startsWith(root) && (best === null || root.length > best.length)) best = root;
  }
  return best;
}

function detect(context: ResolutionContext): boolean {
  return context.getAllFiles().some((f) => MIGRATION.test(toPosix(f)));
}

// ---------------------------------------------------------------- node builders

const now = () => Date.now();

function sqlNode(
  id: string,
  kind: Node['kind'],
  name: string,
  qualifiedName: string,
  filePath: string,
  startLine: number,
  endLine: number,
  signature?: string
): Node {
  return {
    id,
    kind,
    name,
    qualifiedName,
    filePath,
    language: 'sql',
    startLine,
    endLine,
    startColumn: 0,
    endColumn: 0,
    ...(signature ? { signature } : {}),
    updatedAt: now(),
  };
}

function ref(from: Node, name: string, kind: UnresolvedRef['referenceKind'], line: number): UnresolvedRef {
  return {
    fromNodeId: from.id,
    referenceName: name,
    referenceKind: kind,
    line,
    column: 0,
    filePath: from.filePath,
    language: 'sql',
  };
}

/**
 * Ids carry the file the definition stands in. A function redefined in a later
 * migration is then a new node and the old one goes, with its edges: calls into
 * it are put back as unresolved and bind again, to the new one, and the body's
 * references are the new body's. An id without the file would keep the node
 * and leave the old body's edges on it.
 */
const isSqlNodeOf = (prefix: string) => (n: Node) => n.language === 'sql' && n.id.startsWith(prefix);

function functionNodes(context: ResolutionContext): CrossFileNodes {
  const nodes: Node[] = [];
  const references: UnresolvedRef[] = [];
  for (const f of projectsOf(context).flatMap((p) => p.model.functions)) {
    const node = sqlNode(`sql:function:${f.filePath}:${f.name}`, 'function', f.name, `${f.schema}.${f.name}`, f.filePath, f.line, f.endLine, f.signature);
    nodes.push(node);
    for (const t of f.reads) references.push(ref(node, PREFIX.read + t, 'references', f.line));
    for (const t of f.writes) references.push(ref(node, PREFIX.write + t, 'references', f.line));
    for (const c of f.calls) references.push(ref(node, PREFIX.call + c, 'calls', f.line));
  }
  return { kind: 'function', owns: isSqlNodeOf('sql:function:'), nodes, references };
}

function tableNodes(context: ResolutionContext): CrossFileNodes {
  const nodes: Node[] = [];
  const references: UnresolvedRef[] = [];
  for (const { root, model } of projectsOf(context)) {
    for (const t of model.tables) {
      nodes.push(sqlNode(`sql:table:${t.filePath}:${t.name}`, 'struct', t.name, `${t.schema}.${t.name}`, t.filePath, t.line, t.endLine, 'TABLE'));
    }
    for (const v of model.views) {
      const sig = v.materialized ? 'MATERIALIZED VIEW' : 'VIEW';
      const node = sqlNode(`sql:table:${v.filePath}:${v.name}`, 'struct', v.name, `${v.schema}.${v.name}`, v.filePath, v.line, v.endLine, sig);
      nodes.push(node);
      // what the view selects from, so a chain through it holds: a function that
      // reads a materialized view depends on the tables the view is built from
      for (const t of v.reads) references.push(ref(node, PREFIX.read + t, 'references', v.line));
      for (const c of v.calls) references.push(ref(node, PREFIX.call + c, 'calls', v.line));
    }
    // A table Supabase creates (`auth.users`) is in no migration. It gets a
    // stand-in where the first thing touching it is written, so what depends on
    // it shows up; its name is qualified so it never shadows a project table.
    for (const q of model.externalTables) {
      const at = firstUseOf(q, model);
      if (!at) continue;
      nodes.push(sqlNode(`sql:table:external:${root}${q}`, 'struct', q, q, at.filePath, at.line, at.line, 'TABLE (Supabase)'));
    }
  }
  return { kind: 'struct', owns: isSqlNodeOf('sql:table:'), nodes, references };
}

function firstUseOf(q: string, model: SqlModel): { filePath: string; line: number } | null {
  const uses = [
    ...model.triggers.filter((t) => t.table === q),
    ...model.functions.filter((f) => f.reads.includes(q) || f.writes.includes(q)),
  ].sort((a, b) => (a.filePath < b.filePath ? -1 : a.filePath > b.filePath ? 1 : a.line - b.line));
  return uses[0] ? { filePath: uses[0].filePath, line: uses[0].line } : null;
}

function ruleNodes(context: ResolutionContext): CrossFileNodes {
  const nodes: Node[] = [];
  const references: UnresolvedRef[] = [];
  for (const { model } of projectsOf(context)) {
    for (const p of model.policies) {
      const node = sqlNode(`sql:policy:${p.filePath}:${p.table}:${p.name}`, 'property', p.name, `${p.table}.policy.${p.name}`, p.filePath, p.line, p.endLine, 'POLICY');
      nodes.push(node);
      references.push(ref(node, PREFIX.table + p.table, 'references', p.line));
      // what its USING / WITH CHECK expressions call and query: a change to
      // `is_admin()` reaches every policy written with it
      for (const t of p.reads) references.push(ref(node, PREFIX.read + t, 'references', p.line));
      for (const c of p.calls) references.push(ref(node, PREFIX.call + c, 'calls', p.line));
    }
    for (const t of model.triggers) {
      const node = sqlNode(`sql:trigger:${t.filePath}:${t.name}`, 'property', t.name, `${t.table}.trigger.${t.name}`, t.filePath, t.line, t.endLine, 'TRIGGER');
      nodes.push(node);
      references.push(ref(node, PREFIX.table + t.table, 'references', t.line));
      references.push(ref(node, PREFIX.call + t.function, 'calls', t.line));
    }
  }
  return { kind: 'property', owns: (n) => isSqlNodeOf('sql:policy:')(n) || isSqlNodeOf('sql:trigger:')(n), nodes, references };
}

// ---------------------------------------------------------------- resolving

/** SQL nodes of one project (`root`) by name and kind. */
const sqlNodesNamed = (name: string, kind: Node['kind'], root: string, context: ResolutionContext) =>
  context.getNodesByName(name).filter(
    (n) => n.language === 'sql' && n.kind === kind && toPosix(n.filePath).startsWith(root + MIGRATIONS_DIR)
  );

/**
 * `supabase.rpc` / `admin.from` / `createAdminClient().from`. Not
 * `supabase.storage.from` (a bucket), and not a `from` on a capitalised
 * receiver: `Array.from`, `Buffer.from`, `Uint8Array.from` and a project's own
 * `DateRange.from` are classes, a Supabase client is always an instance. A
 * string argument alone would not tell them apart — `Array.from('products')`
 * names a table that exists.
 */
function bridgeTail(name: string): 'rpc' | 'from' | null {
  const m = /^(.*?)\.(rpc|from)$/.exec(name);
  if (!m) return null;
  const receiver = m[1]!;
  if (m[2] === 'from') {
    if (/(?:^|\.)storage$/.test(receiver)) return null;
    const last = receiver.replace(/\(\)$/, '').split('.').pop() ?? '';
    if (/^[A-Z]/.test(last)) return null;
  }
  return m[2] as 'rpc' | 'from';
}

/**
 * The first string argument of the `rpc`/`from` call at the reference's line,
 * read from the source — the call may break its argument onto the next line.
 */
function calledName(ref: UnresolvedRef, tail: 'rpc' | 'from', context: ResolutionContext): string | null {
  const lines = context.getFileLines?.(ref.filePath) ?? context.readFile(ref.filePath)?.split('\n');
  if (!lines) return null;
  const at = Math.max(0, ref.line - 1);
  const text = lines.slice(at, at + 4).join('\n');
  const from = at < lines.length ? Math.max(0, Math.min(ref.column, lines[at]!.length)) : 0;
  const m = new RegExp(String.raw`\.${tail}\s*\(\s*(['"\`])([A-Za-z_][A-Za-z_0-9]*)\1`).exec(text.slice(from)) ??
    new RegExp(String.raw`\.${tail}\s*\(\s*(['"\`])([A-Za-z_][A-Za-z_0-9]*)\1`).exec(text);
  return m ? m[2]!.toLowerCase() : null;
}

function bridgeTarget(ref: UnresolvedRef, context: ResolutionContext): Node | null {
  if (!TS_LANGUAGES.includes(ref.language)) return null;
  const tail = bridgeTail(ref.referenceName);
  if (!tail) return null;
  const name = calledName(ref, tail, context);
  if (!name) return null;
  const root = projectRootFor(ref.filePath, context);
  if (root === null) return null;
  return sqlNodesNamed(name, tail === 'rpc' ? 'function' : 'struct', root, context)[0] ?? null;
}

function resolveSql(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
  const name = ref.referenceName;
  // a reference written in a migration binds within that migration's project
  const root = rootOfMigration(ref.filePath);
  const pick = (target: string, kind: Node['kind'], access?: 'read' | 'write'): ResolvedRef | null => {
    const node = sqlNodesNamed(target, kind, root, context)[0];
    if (!node) return null;
    return {
      original: ref,
      targetNodeId: node.id,
      confidence: 1.0,
      resolvedBy: 'framework',
      ...(access ? { metadata: { access } } : {}),
    };
  };
  if (name.startsWith(PREFIX.read)) return pick(name.slice(PREFIX.read.length), 'struct', 'read');
  if (name.startsWith(PREFIX.write)) return pick(name.slice(PREFIX.write.length), 'struct', 'write');
  if (name.startsWith(PREFIX.table)) return pick(name.slice(PREFIX.table.length), 'struct');
  if (name.startsWith(PREFIX.call)) return pick(name.slice(PREFIX.call.length), 'function');
  return null;
}

const isSqlRefName = (name: string) => Object.values(PREFIX).some((p) => name.startsWith(p));

// ---------------------------------------------------------------- resolvers

/** The bridge and the references inside the SQL. Reads nothing per file. */
export const supabaseResolver: FrameworkResolver = {
  name: 'supabase',
  languages: ['sql'],
  resolveLanguages: ['sql', ...TS_LANGUAGES],
  detect,

  claimsReference(name: string): boolean {
    return isSqlRefName(name) || bridgeTail(name) !== null;
  },

  /**
   * A call this binds is the SQL's and no name strategy should guess past it.
   * Only when it does bind, so a project's own `.from()` stays the project's.
   */
  ownsReference(ref: UnresolvedRef, context: ResolutionContext): boolean {
    if (isSqlRefName(ref.referenceName)) return true;
    return bridgeTarget(ref, context) !== null;
  },

  resolve(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
    if (isSqlRefName(ref.referenceName)) return resolveSql(ref, context);
    const target = bridgeTarget(ref, context);
    if (!target) return null;
    return {
      original: ref,
      targetNodeId: target.id,
      confidence: 0.95,
      resolvedBy: 'framework',
      // `.from('t')` is a `calls` reference to a method; the edge is to a table
      edgeKind: target.kind === 'function' ? 'calls' : 'references',
      metadata: { via: bridgeTail(ref.referenceName) },
    };
  },
};

export const supabaseFunctionsResolver: FrameworkResolver = {
  name: 'supabase-functions',
  languages: ['sql'],
  detect,
  resolve: () => null,
  crossFileNodes: functionNodes,
};

export const supabaseTablesResolver: FrameworkResolver = {
  name: 'supabase-tables',
  languages: ['sql'],
  detect,
  resolve: () => null,
  crossFileNodes: tableNodes,
};

export const supabaseRulesResolver: FrameworkResolver = {
  name: 'supabase-rules',
  languages: ['sql'],
  detect,
  resolve: () => null,
  crossFileNodes: ruleNodes,
};
