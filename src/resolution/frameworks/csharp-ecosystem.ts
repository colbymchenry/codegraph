/**
 * C# ecosystem resolver — the parts of a modern .NET project that are NOT ASP.NET
 * controllers/minimal-API routes, but are first-class entities an indexer must see
 * (issue #1181):
 *
 *   - NuGet package dependencies (`.csproj` `<PackageReference>`) → `module` nodes
 *     with references to the files that `using` them.
 *   - DI container registrations (`services.AddScoped<IService, Service>()` etc.)
 *     → a registration node bridging the interface and its implementation with an
 *     `implements` edge to the interface and a `references` edge to the impl.
 *   - EF Core schema — `OnModelCreating` `ToTable`/`HasColumnName` plus migration
 *     `CreateTable` — synthesized as table (module) + column (field) nodes.
 *
 * All synthetic nodes carry a `docstring` provenance marker
 * (`[codegraph synthesized: ...]`) so consumers can tell generated/derived graph
 * entries apart from hand-written source — and real code is never dropped.
 */

import * as fs from 'fs';
import * as path from 'path';
import { Node } from '../../types';
import {
  FrameworkResolver,
  UnresolvedRef,
  ResolvedRef,
  ResolutionContext,
  CrossFileNodes,
} from '../types';
import { stripCommentsForRegex } from '../strip-comments';

export const csharpEcosystemResolver: FrameworkResolver = {
  name: 'csharp-ecosystem',
  languages: ['csharp'],

  detect(context: ResolutionContext): boolean {
    for (const file of context.getAllFiles()) {
      if (file.endsWith('.cs') || file.endsWith('.csproj')) return true;
    }
    return false;
  },

  // The ecosystem features are extracted (nodes/refs) and synthesized
  // (cross-file nodes) rather than resolved by name — no reference strategy here.
  resolve(): ResolvedRef | null {
    return null;
  },

  extract(filePath, content) {
    if (!filePath.endsWith('.cs')) return { nodes: [], references: [] };
    const nodes: Node[] = [];
    const references: UnresolvedRef[] = [];
    const now = Date.now();
    const safe = blankCsharpConditionalDirectives(stripCommentsForRegex(content, 'csharp'));

    extractDiRegistrations(filePath, safe, nodes, references, now);
    extractEfSchema(filePath, safe, nodes, references, now);
    extractLambdaHandlers(filePath, safe, nodes, references, now);

    return { nodes, references };
  },

  crossFileNodes(context: ResolutionContext): CrossFileNodes {
    return extractNuGetPackages(context);
  },
};

/** A C# type name used as a generic argument/entity/registration target. */
const CSHARP_TYPE_NAME = /^[A-Za-z_][A-Za-z0-9_.]*$/;

function isTypeName(s: string): boolean {
  return CSHARP_TYPE_NAME.test(s);
}

/**
 * DI registration scanning — `services.Add<Lifetime><TInterface, TImpl>()` (and
 * the single-typearg form). Each registration becomes a `module` node located in
 * the file that declares it, emitting an `implements` reference to the interface
 * and a `references` reference to the implementation, so a graph query can trace
 * `IService` → registration → `Service`.
 */
function extractDiRegistrations(
  filePath: string,
  safe: string,
  nodes: Node[],
  references: UnresolvedRef[],
  now: number,
): void {
  const twoArg = /\.Add(Scoped|Transient|Singleton|HttpClient|HostedService)<([^,>]+?),\s*([^>]+?)>\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = twoArg.exec(safe)) !== null) {
    const iface = m[2]!.trim();
    const impl = m[3]!.trim();
    if (!isTypeName(iface) || !isTypeName(impl)) continue;
    const line = safe.slice(0, m.index).split('\n').length;
    const id = `di:${filePath}:${line}:${impl}:${iface}`;
    nodes.push({
      id,
      kind: 'module',
      // Deliberately NOT the impl's bare name, so `referenceName: impl` resolves to
      // the real implementation class rather than to this synthetic registration node.
      name: `DI (${iface} -> ${impl})`,
      qualifiedName: `di:${impl}->${iface}`,
      filePath,
      startLine: line,
      endLine: line,
      startColumn: 0,
      endColumn: 0,
      language: 'csharp',
      updatedAt: now,
      docstring: '[codegraph synthesized: DI registration]',
    });
    references.push({
      fromNodeId: id, referenceName: iface, referenceKind: 'implements', line, column: 0, filePath, language: 'csharp',
    });
    references.push({
      fromNodeId: id, referenceName: impl, referenceKind: 'references', line, column: 0, filePath, language: 'csharp',
    });
  }

  const oneArg = /\.Add(Scoped|Transient|Singleton|HttpClient|HostedService)<([A-Za-z_][A-Za-z0-9_.]*)>\s*\(/g;
  while ((m = oneArg.exec(safe)) !== null) {
    const impl = m[2]!.trim();
    if (!isTypeName(impl)) continue;
    const line = safe.slice(0, m.index).split('\n').length;
    const id = `di:${filePath}:${line}:${impl}:SINGLE`;
    nodes.push({
      id,
      kind: 'module',
      name: `DI (${impl})`,
      qualifiedName: `di:${impl}`,
      filePath,
      startLine: line,
      endLine: line,
      startColumn: 0,
      endColumn: 0,
      language: 'csharp',
      updatedAt: now,
      docstring: '[codegraph synthesized: DI registration]',
    });
    references.push({
      fromNodeId: id, referenceName: impl, referenceKind: 'references', line, column: 0, filePath, language: 'csharp',
    });
  }
}

/**
 * EF Core schema — DbContext `OnModelCreating` (`Entity<X>().ToTable("T")`,
 * `Property(x => x.C).HasColumnName("c")`, `HasIndex(...)`) and migration files
 * (`CreateTable(name: "T", table => new { ... })`). Tables become `module` nodes,
 * columns `field` nodes; each table links to the entity class and its columns.
 */
function extractEfSchema(
  filePath: string,
  safe: string,
  nodes: Node[],
  references: UnresolvedRef[],
  now: number,
): void {
  const isDbContextFile = /OnModelCreating|DbContext/.test(safe);
  const isMigrationFile = /CreateTable\s*\(|Migrations/.test(`${filePath} ${safe}`);
  if (!isDbContextFile && !isMigrationFile) return;

  // --- Tables: OnModelCreating `ToTable`, paired with the entity type written
  // before it; and migration `CreateTable(name: ...)`.
  const tables = new Map<string, { name: string; entity: string; line: number }>();

  if (isDbContextFile) {
    // Both the fluent `Entity<X>().ToTable("T")` and the block
    // `Entity<X>(e => { e.ToTable("T"); ... })` shapes.
    const entityTable = /\.Entity<([^>]+)>\([\s\S]{0,400}?\.ToTable\s*\(\s*"([^"]+)"\s*\)/g;
    let em: RegExpExecArray | null;
    while ((em = entityTable.exec(safe)) !== null) {
      const entity = em[1]!.trim();
      const name = em[2]!.trim();
      if (!tables.has(name)) {
        tables.set(name, { name, entity, line: safe.slice(0, em.index).split('\n').length });
      }
    }
  }

  if (isMigrationFile) {
    // MigrationBuilder.CreateTable(name: "X", columns: table => new { ... }, ...)
    const migrationTable = /CreateTable\s*\(\s*name:\s*"([^"]+)"[\s\S]*?\btable\s*=>\s*new\s*\{([\s\S]*?)\}\s*\)/g;
    let mm: RegExpExecArray | null;
    while ((mm = migrationTable.exec(safe)) !== null) {
      const name = mm[1]!.trim();
      const body = mm[2]!;
      if (!tables.has(name)) {
        tables.set(name, { name, entity: '', line: safe.slice(0, mm.index).split('\n').length });
      }
      // Columns from `Col = table.Column<int>(...)` / `Col = c.Column(...)`.
      const colRe = /(?:^|,|\n)\s*(\w+)\s*=\s*(?:table|c)\.Column/g;
      let cm: RegExpExecArray | null;
      while ((cm = colRe.exec(body)) !== null) {
        pushColumn(nodes, references, filePath, now, name, cm[1]!);
      }
    }
  }

  // --- Columns for DbContext config: `Property(x => x.C).HasColumnName("c")`,
  // plus standalone `.HasColumnName("c")`.
  const colPairs: Array<{ col: string; line: number }> = [];
  const propCol = /\.Property\s*\(\s*(?:[A-Za-z_]\w*)\s*=>\s*(?:[A-Za-z_]\w*)\.(\w+)\s*\)[\s\S]{0,200}?\.HasColumnName\s*\(\s*"([^"]+)"[\s\S]*?\)/g;
  let pm: RegExpExecArray | null;
  while ((pm = propCol.exec(safe)) !== null) {
    colPairs.push({ col: pm[2]!.trim(), line: safe.slice(0, pm.index).split('\n').length });
  }
  const bareCol = /\.HasColumnName\s*\(\s*"([^"]+)"\s*\)/g;
  while ((pm = bareCol.exec(safe)) !== null) {
    colPairs.push({ col: pm[1]!.trim(), line: safe.slice(0, pm.index).split('\n').length });
  }

  // --- Emit table + column nodes. Table nodes link to their entity class; each
  // column belongs to the nearest table declared before it in source order (or is
  // file-local when no table precedes it).
  const tableOrder = [...tables.values()].sort((a, b) => a.line - b.line);
  for (const table of tables.values()) {
    const tId = `ef:table:${filePath}:${table.line}:${table.name}`;
    nodes.push({
      id: tId,
      kind: 'module',
      name: table.name,
      qualifiedName: `ef:table:${table.name}`,
      filePath,
      startLine: table.line,
      endLine: table.line,
      startColumn: 0,
      endColumn: 0,
      language: 'csharp',
      updatedAt: now,
      docstring: '[codegraph synthesized: EF Core table]',
    });
    if (table.entity && isTypeName(table.entity)) {
      references.push({
        fromNodeId: tId, referenceName: table.entity, referenceKind: 'references', line: table.line, column: 0, filePath, language: 'csharp',
      });
    }
  }

  for (const { col, line } of colPairs) {
    if (!col) continue;
    let owner: string | undefined;
    for (const t of tableOrder) {
      if (t.line <= line) owner = t.name;
      else break;
    }
    pushColumn(nodes, references, filePath, now, owner, col);
  }
}

function pushColumn(
  nodes: Node[],
  references: UnresolvedRef[],
  filePath: string,
  now: number,
  table: string | undefined,
  col: string,
): void {
  const qn = table ? `ef:column:${table}.${col}` : `ef:column:${filePath}:${col}`;
  const id = `ef:column:${filePath}:${table ?? 'file'}:${col}`;
  if (nodes.some((n) => n.id === id)) return;
  nodes.push({
    id,
    kind: 'field',
    name: col,
    qualifiedName: qn,
    filePath,
    startLine: 0,
    endLine: 0,
    startColumn: 0,
    endColumn: 0,
    language: 'csharp',
    updatedAt: now,
    docstring: '[codegraph synthesized: EF Core column]',
  });
  if (table) {
    const tNode = nodes.find((n) => n.kind === 'module' && n.qualifiedName === `ef:table:${table}`);
    if (tNode) {
      references.push({
        fromNodeId: tNode.id, referenceName: col, referenceKind: 'references', line: 0, column: 0, filePath, language: 'csharp',
      });
    }
  }
}

/**
 * AWS Lambda handler entry points — a method carrying a `[LambdaSerializer]`
 * attribute, or a `FunctionHandler` in a file that uses Amazon.Lambda.Core /
 * ILambdaContext, is a serverless entry point. Surface it like a route so
 * explore/context treat it as one (the way [ApiController]/[Route] classes
 * become entry points).
 */
function extractLambdaHandlers(
  filePath: string,
  safe: string,
  nodes: Node[],
  references: UnresolvedRef[],
  now: number,
): void {
  const entries: Array<{ name: string; line: number }> = [];
  const serializerAttr = /\[LambdaSerializer[\s\S]*?\]/g;
  let lm: RegExpExecArray | null;
  while ((lm = serializerAttr.exec(safe)) !== null) {
    const tail = safe.slice(lm.index + lm[0].length, lm.index + lm[0].length + 400);
    const nm = tail.match(/\b(?:public|private|protected|internal)\s+(?:[\s\S]*?)\b(\w+)\s*\(/);
    if (nm) entries.push({ name: nm[1]!, line: safe.slice(0, lm.index).split('\n').length });
  }
  if (/Amazon\.Lambda\.Core|ILambdaContext/.test(safe)) {
    const fnPattern = /\bFunctionHandler\s*\(/g;
    while ((lm = fnPattern.exec(safe)) !== null) {
      entries.push({ name: 'FunctionHandler', line: safe.slice(0, lm.index).split('\n').length });
    }
  }

  const seen = new Set<string>();
  for (const entry of entries) {
    const id = `route:${filePath}:${entry.line}:lambda:${entry.name}`;
    if (seen.has(id)) continue;
    seen.add(id);
    nodes.push({
      id,
      kind: 'route',
      name: `Lambda ${entry.name}`,
      qualifiedName: `${filePath}::lambda:${entry.name}`,
      filePath,
      startLine: entry.line,
      endLine: entry.line,
      startColumn: 0,
      endColumn: 0,
      language: 'csharp',
      updatedAt: now,
      docstring: '[codegraph synthesized: AWS Lambda entry point]',
    });
    references.push({
      fromNodeId: id,
      referenceName: entry.name,
      referenceKind: 'references',
      line: entry.line,
      column: 0,
      filePath,
      language: 'csharp',
    });
  }
}

/**
 * NuGet package dependencies — read every `.csproj` in the repo, one `module`
 * node per `<PackageReference Include="...">`, plus references from the package
 * to each `.cs` file that `using`s the package's root namespace.
 *
 * `.csproj` manifests are build metadata, not indexed source, so they are found
 * with a contained filesystem walk (see {@link discoverCsprojFiles}); consumers
 * come from the indexed `.cs` file set.
 */
function extractNuGetPackages(context: ResolutionContext): CrossFileNodes {
  const nodes: Node[] = [];
  const references: UnresolvedRef[] = [];
  const now = Date.now();
  const seen = new Set<string>();

  const csprojFiles = discoverCsprojFiles(context);
  const indexed = context.getAllFiles();
  for (const file of csprojFiles) {
    const content = context.readFile(file);
    if (!content) continue;
    const pkgRe = /<PackageReference[^>]*\sInclude\s*=\s*"([^"]+)"[^>]*>/g;
    let m: RegExpExecArray | null;
    while ((m = pkgRe.exec(content)) !== null) {
      const name = m[1]!.trim();
      if (!isTypeName(name) || seen.has(name)) continue;
      seen.add(name);
      const id = `package:${name}`;
      nodes.push({
        id,
        kind: 'module',
        name,
        qualifiedName: `package:${name}`,
        filePath: file,
        startLine: 0,
        endLine: 0,
        startColumn: 0,
        endColumn: 0,
        language: 'csharp',
        updatedAt: now,
        docstring: '[codegraph synthesized: NuGet package]',
      });
      const usingRe = new RegExp(`\\busing\\s+${escapeRegExp(name)}\\b`);
      for (const cs of indexed) {
        if (!cs.endsWith('.cs')) continue;
        const c = context.readFile(cs);
        if (c && usingRe.test(c)) {
          references.push({
            fromNodeId: id, referenceName: cs, referenceKind: 'references', line: 1, column: 0, filePath: file, language: 'csharp',
          });
        }
      }
    }
  }

  return { nodes, references, kind: 'module', owns: (n) => n.id.startsWith('package:') };
}

/**
 * The `*.csproj` files under the project root, discovered with a contained
 * filesystem walk. Security: every visited directory is `realpath`-resolved and
 * required to stay inside the project root's own `realpath`, so a symlink that
 * escapes the root (or a `..` path) is never followed; default build/dependency
 * directories are skipped so the walk stays bounded.
 */
function discoverCsprojFiles(context: ResolutionContext): string[] {
  const root = context.getProjectRoot();
  let realRoot: string;
  try {
    realRoot = fs.realpathSync(root);
  } catch {
    return [];
  }
  const out: string[] = [];
  const seenDirs = new Set<string>();
  const walk = (dirAbs: string, rel: string): void => {
    let realDir: string;
    try {
      realDir = fs.realpathSync(dirAbs);
    } catch {
      return;
    }
    if (seenDirs.has(realDir)) return;
    seenDirs.add(realDir);
    // Containment: a resolved dir must live inside the real project root.
    if (realDir !== realRoot && !realDir.startsWith(realRoot + path.sep)) return;
    const first = rel.split('/')[0] ?? '';
    if (rel !== '' && SKIP_CSHARP_DIRS.has(first)) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(realDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        walk(path.join(realDir, entry.name), rel ? `${rel}/${entry.name}` : entry.name);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.csproj')) {
        out.push(rel ? `${rel}/${entry.name}` : entry.name);
      }
      // Symlinks are deliberately not descended into: the containment check on a
      // symlinked dir resolves it away from the root and drops it; a symlinked
      // file is not a build manifest we should own.
    }
  };
  walk(realRoot, '');
  return out;
}

/** Directories never walked when discovering `.csproj` files. */
const SKIP_CSHARP_DIRS = new Set([
  'node_modules', 'bin', 'obj', 'dist', 'build', 'target', 'out', 'vendor',
  '.git', '.vs', '.idea', '.codegraph', 'coverage', 'Pods', 'packages',
]);

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function blankCsharpConditionalDirectives(source: string): string {
  return source.replace(/^([ \t]*)#[ \t]*(if|elif|else|endif)\b[^\n]*/gm, (m, indent) =>
    indent + ' '.repeat(m.length - (indent as string).length),
  );
}
