import { parse as parseSfc } from '@vue/compiler-sfc';
import type { SFCDescriptor } from '@vue/compiler-sfc';
import { parse as babelParse } from '@babel/parser';
import * as fs from 'fs';
import * as path from 'path';
import { Node, Edge, ExtractionResult, ExtractionError, UnresolvedReference, Language } from '../types';
import { generateNodeId } from './tree-sitter-helpers';
import { TreeSitterExtractor } from './tree-sitter';
import { isLanguageSupported } from './grammars';
import { applyAliases, loadProjectAliases } from '../resolution/path-aliases';
import type { AliasMap } from '../resolution/path-aliases';

/**
 * Project root (absolute) hint, set by the parse pool / orchestrator so
 * VueExtractor can resolve a project-relative filePath against the real
 * filesystem when a component's props/emits type comes from a SIBLING file
 * (`import type { Props } from './types'`). Null → cross-file type expansion
 * is silently skipped; same-file extraction is unaffected.
 */
let extractionRootHint: string | null = null;

export function setExtractionRootHint(root: string | null): void {
  extractionRootHint = root;
}

/** Extensions tried, in order, when resolving an import source to a file. */
const TYPE_FILE_EXTENSIONS = ['', '.ts', '.tsx', '.d.ts', '.js', '/index.ts', '/index.js'];

/** tsconfig/jsconfig `paths` per project root — loaded at most once per root. */
const aliasCache = new Map<string, AliasMap | null>();

function rootAliases(root: string): AliasMap | null {
  const cached = aliasCache.get(root);
  if (cached !== undefined) return cached;
  const map = loadProjectAliases(root);
  aliasCache.set(root, map);
  return map;
}

/**
 * Absolute module bases to try for an import source, in priority order; each
 * gets every extension in {@link TYPE_FILE_EXTENSIONS} appended. A relative (or
 * absolute) source resolves against the importing file's directory; anything
 * else goes through the project's tsconfig `paths` aliases (`@/types/modal`) —
 * the same map the import resolver uses, so an aliased type behaves exactly
 * like a relative one. Empty when nothing can be tried: a bare package name has
 * no file on disk, and guessing at one would invent members that don't exist.
 */
function importBaseCandidates(source: string, fromDir: string, root: string | null): string[] {
  if (source.startsWith('.') || source.startsWith('/')) return [path.resolve(fromDir, source)];
  if (!root) return [];
  const aliases = rootAliases(root);
  if (!aliases) return [];
  return applyAliases(source, aliases, root).map((rel) => path.join(root, rel));
}

/** Parsed sibling type file, cached by absolute path + mtime. */
interface TypeFile {
  absPath: string;
  content: string;
  statements: any[];
  comments: DocComments;
}

/** Cap on the sibling-file cache; the oldest entry is evicted past it. */
const MAX_TYPE_FILE_CACHE = 512;

const typeFileCache = new Map<string, { mtimeMs: number; data: TypeFile }>();

/**
 * Parse a sibling .ts/.js file for type declarations; null when unreadable.
 * A file that does not exist is NOT cached: one unresolved import probes every
 * extension in `TYPE_FILE_EXTENSIONS`, and `throwIfNoEntry` keeps each probe a
 * plain stat instead of a thrown ENOENT — while still letting a file that
 * appears later (a `sync` after it was created) resolve on the next run.
 */
function loadTypeFile(absPath: string): TypeFile | null {
  const stat = fs.statSync(absPath, { throwIfNoEntry: false });
  if (!stat) return null;
  const cached = typeFileCache.get(absPath);
  if (cached?.mtimeMs === stat.mtimeMs) return cached.data;
  try {
    const content = fs.readFileSync(absPath, 'utf8');
    const plugins = /\.tsx?$/.test(absPath) ? ['typescript', 'jsx'] : ['jsx'];
    const ast = babelParse(content, { sourceType: 'module', plugins, errorRecovery: true } as any);
    const data: TypeFile = {
      absPath,
      content,
      statements: ast.program.body as any[],
      comments: docComments(ast, content),
    };
    if (typeFileCache.size >= MAX_TYPE_FILE_CACHE) {
      typeFileCache.delete(typeFileCache.keys().next().value as string);
    }
    typeFileCache.set(absPath, { mtimeMs: stat.mtimeMs, data });
    return data;
  } catch {
    return null; // unreadable or unparseable: no members, never a wrong one
  }
}

/** The interface/type-alias declaration a statement declares, unwrapping
 *  `export interface X {}` / `export type X = …` to the declaration itself. */
function declStatement(statement: any): any {
  const d = statement?.type === 'ExportNamedDeclaration' ? statement.declaration : statement;
  return d?.type === 'TSInterfaceDeclaration' || d?.type === 'TSTypeAliasDeclaration' ? d : null;
}

// One resolver instance per parsed file — declarations are file-static, and
// sharing the instance means every extends branch resolving through the same
// file shares one cycle-guard/lookup cache instead of rebuilding it per ref.
const fileResolvers = new WeakMap<TypeFile, (name: string) => TypeDeclRef | null>();

/** Find a named interface/type-alias in a parsed file, unwrapping
 *  `export interface X {}` (ExportNamedDeclaration) to the declaration. */
function findDeclInFile(file: TypeFile, name: string): TypeDeclRef | null {
  for (const statement of file.statements) {
    const d = declStatement(statement);
    if (d?.id?.type === 'Identifier' && d.id.name === name) {
      let resolve = fileResolvers.get(file);
      if (!resolve) {
        resolve = fileScopedResolver(file);
        fileResolvers.set(file, resolve);
      }
      return { node: d, content: file.content, comments: file.comments, resolve };
    }
  }
  return null;
}

/** Resolver bound to one sibling file: its own declarations first, then the
 *  relative import that DECLARES the name. One hop — a bare re-export
 *  (`export { X } from './c'`) has no declaration to return and is skipped
 *  rather than followed. */
function fileScopedResolver(file: TypeFile): (name: string) => TypeDeclRef | null {
  const cache = new Map<string, TypeDeclRef | null>();
  return (name: string): TypeDeclRef | null => {
    if (cache.has(name)) return cache.get(name)!;
    cache.set(name, null); // cycle guard: replaced on success below
    const own = findDeclInFile(file, name);
    if (own) {
      cache.set(name, own);
      return own;
    }
    const imports = importSources(file.statements);
    const entry = imports.get(name);
    if (!entry) return null;
    const { source, importedName } = entry;
    // The declaration is named by its EXPORTED name in the target module,
    // not by the alias this file imported it as. Default imports are
    // skipped: the declaration's own name may differ from the binding.
    if (importedName === 'default') return null;
    for (const base of importBaseCandidates(source, path.dirname(file.absPath), extractionRootHint)) {
      for (const ext of TYPE_FILE_EXTENSIONS) {
        const next = loadTypeFile(base + ext);
        if (!next) continue;
        const ref = findDeclInFile(next, importedName);
        if (ref) {
          cache.set(name, ref);
          return ref;
        }
      }
    }
    return null;
  };
}

/**
 * One import binding: `source` is the module specifier, `importedName` is the
 * name as EXPORTED by that module (what the declaration is called THERE), and
 * the map KEY is the name used LOCALLY (what type references in this file
 * resolve against). Without an alias the two names coincide, but
 * `import { ModalProps as LocalProps } from './types'` defines a type used as
 * `LocalProps` while the declaration in ./types is named `ModalProps` — both
 * names are needed or the resolution silently misses.
 */
interface ImportBinding {
  source: string;
  importedName: string;
}

function importSources(statements: any[]): Map<string, ImportBinding> {
  const map = new Map<string, ImportBinding>();
  for (const statement of statements) {
    if (statement.type !== 'ImportDeclaration' || typeof statement.source?.value !== 'string') continue;
    for (const spec of statement.specifiers ?? []) {
      if (spec.type === 'ImportSpecifier') {
        const local = spec.local?.name;
        const imported = spec.imported?.type === 'Identifier' ? spec.imported.name : spec.imported?.value;
        if (typeof local === 'string' && typeof imported === 'string' && !map.has(local)) {
          map.set(local, { source: statement.source.value, importedName: imported });
        }
      } else if (spec.type === 'ImportDefaultSpecifier' && typeof spec.local?.name === 'string') {
        // Default imports bind the module's default export; the declaration's
        // own name may differ from the local binding. Tracked with the
        // 'default' marker — callers decide whether to follow it.
        if (!map.has(spec.local.name)) {
          map.set(spec.local.name, { source: statement.source.value, importedName: 'default' });
        }
      }
      // Namespace imports (`import * as X`) bind many names — not resolvable
      // to one declaration, deliberately left out of the map.
    }
  }
  return map;
}

/**
 * Structured Vue component API extracted from an SFC, stored on the component
 * node as `metadata.componentApi` and surfaced by the MCP tools. All fields
 * optional — only keys with data are set.
 */
export interface VuePropInfo {
  name: string;
  /** Type text as written in the SFC (e.g. `'sm' | 'md' | 'lg'`). */
  type?: string;
  required?: boolean;
  /** Default value text as written (withDefaults fallback / runtime default). */
  default?: string;
  /** Leading JSDoc/comment text, whitespace-collapsed. */
  doc?: string;
}

export interface VueEmitInfo {
  name: string;
  /** Payload signature text, e.g. `(v: string)`. */
  type?: string;
  doc?: string;
}

export interface VueComponentApi {
  props?: VuePropInfo[];
  emits?: VueEmitInfo[];
  /** Slot names declared by `<slot>` tags / defineSlots (order of appearance). */
  slots?: string[];
  /** Property/function names passed to defineExpose. */
  exposed?: string[];
}

/** An `@event="handler"` binding on a component tag in the parent's template. */
interface TemplateBinding {
  event: string;
  handler: string;
  /** The tag the binding sits on (PascalCase component name). */
  component: string;
  line: number;
}

/**
 * Handler identifiers referenced by a v-on expression. Covers the forms that
 * name a real function — a bare identifier (`@change="onChange"`), a call
 * (`@change="onChange($event)"`), and statement lists (`@click="a(); b()"`).
 * Inline arrows and member chains contribute nothing resolvable and are
 * ignored; a candidate that matches no local node creates no edge.
 */
function handlerIdentifiers(expression: string): string[] {
  const trimmed = expression.trim();
  if (!trimmed) return [];
  const out = new Set<string>();
  if (/^[A-Za-z_$][\w$]*$/.test(trimmed)) {
    out.add(trimmed);
  } else {
    const callRe = /(?<![.\w$])([A-Za-z_$][\w$]*)\s*\(/g;
    let m;
    while ((m = callRe.exec(trimmed)) !== null) out.add(m[1]!);
  }
  return [...out];
}

/**
 * Vue built-in components — skipped so a `<Transition>` / `<KeepAlive>` in the
 * template doesn't become a phantom reference to a user component. Checked
 * AFTER kebab→Pascal conversion, so `<keep-alive>` is caught here too.
 */
const VUE_BUILTIN_COMPONENTS = new Set([
  'Transition',
  'TransitionGroup',
  'KeepAlive',
  'Suspense',
  'Teleport',
  'Component',
  'Slot',
]);

/** `my-component` → `MyComponent` (Vue allows either form in templates). */
function kebabToPascal(name: string): string {
  return name
    .split('-')
    .map((part) => (part ? part[0]!.toUpperCase() + part.slice(1) : ''))
    .join('');
}

// =============================================================================
// Babel AST helpers — compiler-sfc hands back @babel/parser trees whose nodes
// carry `start`/`end` offsets into the BLOCK's content (not the whole file),
// so type text is recovered by slicing that content.
// =============================================================================

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Depth-first walk over a babel tree, visiting every node with a `type`. */
function walkBabel(node: any, visit: (n: any) => void): void {
  if (!node || typeof node !== 'object') return;
  if (typeof node.type === 'string') visit(node);
  for (const key of Object.keys(node)) {
    if (key === 'loc' || key === 'leadingComments' || key === 'trailingComments') continue;
    const value = node[key];
    if (Array.isArray(value)) {
      for (const item of value) walkBabel(item, visit);
    } else if (value && typeof value === 'object' && typeof value.type === 'string') {
      walkBabel(value, visit);
    }
  }
}

/** Source text of a babel node, sliced from the block content it was parsed from. */
function nodeText(content: string, node: any): string {
  return typeof node.start === 'number' && typeof node.end === 'number'
    ? content.slice(node.start, node.end)
    : '';
}

/** A leading-comment candidate: `line` is the 0-based line the comment ENDS
 *  on, `end` its offset (a trailing comment sits AFTER the member it belongs
 *  to), `ownLine` is true when the comment is the first non-whitespace thing
 *  on its line. */
interface DocComment {
  text: string;
  line: number;
  end: number;
  ownLine: boolean;
}

/** Comment candidates plus what their offsets were resolved against. */
interface DocComments {
  content: string;
  lineStarts: number[];
  items: DocComment[];
}

/** Line-start offsets for `content`, so offset→line is a binary search over
 *  this array rather than a rescan of the whole content. */
function buildLineStarts(content: string): number[] {
  const starts = [0];
  for (let i = 0; i < content.length; i++) {
    if (content.charCodeAt(i) === 10) starts.push(i + 1);
  }
  return starts;
}

/** 0-based line containing `offset`. */
function lineOfOffset(lineStarts: number[], offset: number): number {
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lineStarts[mid]! <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** Leading-comment candidates for members. Comments come from the babel
 *  parse's `ast.comments` (offsets into the block content). Both JSDoc blocks
 *  and the common single-line `//` annotation count. */
function docComments(ast: any, content: string): DocComments {
  const lineStarts = buildLineStarts(content);
  const items: DocComment[] = [];
  for (const c of ast?.comments ?? []) {
    const raw = String(c.value ?? '');
    const text =
      c.type === 'CommentBlock'
        ? raw
            .split('\n')
            .map((l: string) => l.replace(/^\s*\*\s?/, '').trim())
            .filter(Boolean)
            .join(' ')
            .trim()
        : raw.trim();
    if (!text || typeof c.end !== 'number' || typeof c.start !== 'number') continue;
    const line = lineOfOffset(lineStarts, c.end);
    items.push({
      text,
      line,
      end: c.end,
      ownLine: content.slice(lineStarts[line]!, c.start).trim() === '',
    });
  }
  return { content, lineStarts, items };
}

/**
 * The leading comment of the member starting at `memberStart` — nearest first:
 *   - a one-line block comment on the member's OWN line, directly before it, or
 *   - a comment sitting alone on the line directly above (`ownLine`).
 * A TRAILING comment (`size: string // note`) is neither: it ends after the
 * member it annotates, so it must not be handed to the member below it.
 *
 * Complexity: O(members × comments) — each member scans all comment items
 * linearly (only the offset→line lookup is binary). Real interfaces are tens
 * of members against a handful of comments, so this is noise; if it ever
 * matters, `docs.items` is position-sorted and can be bisected instead.
 */
function docFor(docs: DocComments, memberStart: number): string | undefined {
  const memberLine = lineOfOffset(docs.lineStarts, memberStart);
  let best: string | undefined;
  let bestDist = Infinity;
  for (const doc of docs.items) {
    if (doc.end > memberStart) continue; // trailing comment of an earlier member
    const dist = memberLine - doc.line;
    const inline = dist === 0 && docs.content.slice(doc.end, memberStart).trim() === '';
    if (!inline && !(dist === 1 && doc.ownLine)) continue;
    if (dist < bestDist) {
      best = doc.text;
      bestDist = dist;
    }
  }
  return best;
}

/** Primitive-ish label for a runtime prop type value (`String` → `string`). */
function runtimeTypeLabel(node: any): string {
  const name = node?.name;
  switch (name) {
    case 'String': return 'string';
    case 'Number': return 'number';
    case 'Boolean': return 'boolean';
    case 'Array': return 'unknown[]';
    case 'Object': return 'Record<string, any>';
    case 'Function': return '(...args: any[]) => any';
    case 'Symbol': return 'symbol';
    case 'Date': return 'Date';
    case 'Promise': return 'Promise<any>';
    default: return name ? String(name) : 'any';
  }
}

/** A named type declaration (interface/type alias) plus the file text it was
 *  parsed from — offsets only make sense against that text. `resolve` (set for
 *  declarations pulled from sibling files) resolves further names in THAT
 *  file's scope — an `extends Base` inside the sibling must not require the
 *  .vue to import Base too. */
interface TypeDeclRef {
  node: any;
  content: string;
  comments: DocComments;
  resolve?: (name: string) => TypeDeclRef | null;
}

/** Resolution scope for macro type arguments: same-file declarations plus an
 *  optional sibling-file resolver (needs the project-root hint). */
interface TypeResolveCtx {
  localTypes: Map<string, TypeDeclRef>;
  external: ((name: string) => TypeDeclRef | null) | null;
}

function resolveTypeDecl(name: string, ctx: TypeResolveCtx): TypeDeclRef | null {
  return ctx.localTypes.get(name) ?? ctx.external?.(name) ?? null;
}

function propsFromMembers(members: any[], content: string, docs: DocComments): VuePropInfo[] {
  const props: VuePropInfo[] = [];
  for (const member of members ?? []) {
    if (member.type !== 'TSPropertySignature') continue;
    const name = member.key?.type === 'Identifier' ? member.key.name : member.key?.value;
    if (typeof name !== 'string') continue;
    props.push({
      name,
      type: member.typeAnnotation ? nodeText(content, member.typeAnnotation.typeAnnotation) : 'any',
      required: !member.optional,
      doc: docFor(docs, member.start ?? 0),
    });
  }
  return props;
}

/** Runtime props object (`defineProps({ ... })` / options `props: { ... }`). */
function propsFromRuntimeObject(objNode: any, content: string, docs: DocComments): VuePropInfo[] {
  const props: VuePropInfo[] = [];
  for (const prop of objNode.properties ?? []) {
    if (prop.type !== 'ObjectProperty' || prop.computed) continue;
    const name = prop.key?.type === 'Identifier' ? prop.key.name : prop.key?.value;
    if (typeof name !== 'string') continue;
    const value = prop.value;
    const info: VuePropInfo = { name, required: false, doc: docFor(docs, prop.start ?? 0) };
    if (value?.type === 'Identifier') {
      info.type = runtimeTypeLabel(value);
    } else if (value?.type === 'ObjectExpression') {
      for (const field of value.properties ?? []) {
        if (field.type !== 'ObjectProperty') continue;
        const fieldName = field.key?.type === 'Identifier' ? field.key.name : field.key?.value;
        if (fieldName === 'type') {
          info.type = Array.isArray(field.value?.elements)
            ? field.value.elements.filter(Boolean).map(runtimeTypeLabel).join(' | ')
            : runtimeTypeLabel(field.value);
        } else if (fieldName === 'required') {
          info.required = field.value?.value === true;
        } else if (fieldName === 'default') {
          info.default = nodeText(content, field.value) || undefined;
        }
      }
      if (!info.type) info.type = 'any';
    } else if (value?.type === 'NullLiteral') {
      info.type = 'any';
    } else {
      info.type = nodeText(content, value) || 'any';
    }
    props.push(info);
  }
  return props;
}

/** Event signatures from a defineEmits type-literal's members (both 3.0 and
 *  3.3 syntax). */
function emitsFromMembers(members: any[], content: string, docs: DocComments): VueEmitInfo[] {
  const emits: VueEmitInfo[] = [];
  for (const member of members ?? []) {
    const name = member.key?.type === 'Identifier' ? member.key.name : member.key?.value;
    const doc = docFor(docs, member.start ?? 0);

    // Call-signature form: `{ (e: 'change', value: string): void }` — the
    // event name rides the first parameter's literal type.
    if (member.type === 'TSCallSignatureDeclaration' || member.type === 'TSFunctionType') {
      const params: any[] = member.parameters ?? [];
      const lit = params[0]?.typeAnnotation?.typeAnnotation;
      const eventName =
        lit?.type === 'TSLiteralType' && lit.literal?.value != null
          ? String(lit.literal.value)
          : typeof name === 'string' ? name : undefined;
      if (typeof eventName !== 'string') continue;
      const rest = member.type === 'TSCallSignatureDeclaration' ? params.slice(1) : params;
      emits.push({
        name: eventName,
        type: `(${rest.map((p: any) => nodeText(content, p)).join(', ')})`,
        doc,
      });
    } else if (typeof name !== 'string') {
      continue;
    } else if (member.type === 'TSMethodSignature') {
      const params = (member.parameters ?? []).filter(
        (p: any) => !(p.type === 'Identifier' && p.typeAnnotation?.typeAnnotation?.type === 'TSLiteralType')
      );
      emits.push({
        name,
        type: `(${params.map((p: any) => nodeText(content, p)).join(', ')})`,
        doc,
      });
    } else if (member.type === 'TSPropertySignature') {
      // 3.3 tuple syntax: `change: [v: string]`
      const el = member.typeAnnotation?.typeAnnotation;
      const type = el?.type === 'TSTupleType' ? `(${(el.elementTypes ?? []).map((t: any) => nodeText(content, t)).join(', ')})` : '()';
      emits.push({ name, type, doc });
    }
  }
  return emits;
}

/**
 * A recursive reader pair over a macro's type argument: props and emits differ
 * ONLY in how a type literal's members become items, which type-node kind is
 * flattened (props: intersection, a union emits events; emits: union, an
 * intersection of event maps), and how deep a reference chain may go. Members
 * are read from the file that DECLARES them (`ref.content`/`ref.comments`), so
 * a type pulled from a sibling keeps its own docs.
 */
interface ApiReader<T> {
  members(members: any[], content: string, docs: DocComments): T[];
  flattenType: 'TSIntersectionType' | 'TSUnionType';
  maxDepth: number;
}

function itemsFromTypeNode<T>(
  reader: ApiReader<T>,
  typeNode: any,
  ctx: TypeResolveCtx,
  content: string,
  docs: DocComments,
  depth = 0
): T[] {
  if (!typeNode || depth > reader.maxDepth) return [];
  if (typeNode.type === 'TSTypeLiteral' || typeNode.type === 'TSInterfaceBody') {
    return reader.members(typeNode.members ?? typeNode.body ?? [], content, docs);
  }
  if (typeNode.type === 'TSTypeReference' && typeNode.typeName?.type === 'Identifier') {
    const ref = resolveTypeDecl(typeNode.typeName.name, ctx);
    return ref ? itemsFromDecl(reader, ref, ctx, depth + 1) : [];
  }
  if (typeNode.type === reader.flattenType) {
    const out: T[] = [];
    for (const part of typeNode.types ?? []) {
      out.push(...itemsFromTypeNode(reader, part, ctx, content, docs, depth + 1));
    }
    return out;
  }
  return [];
}

/** Items of an interface/type-alias DECLARATION, following `extends` chains
 *  (each heritage clause resolved again, locally or cross-file). Base members
 *  come first in declaration order, own members after — a derived member
 *  re-declaring a base name wins by the later-wins dedup upstream. */
function itemsFromDecl<T>(reader: ApiReader<T>, ref: TypeDeclRef, ctx: TypeResolveCtx, depth: number): T[] {
  if (!ref?.node || depth > reader.maxDepth) return [];
  const decl = ref.node;
  if (decl.type === 'TSInterfaceDeclaration') {
    let out: T[] = [];
    for (const heritage of decl.extends ?? []) {
      const name = heritage.expression?.name ?? heritage.expression?.value;
      if (typeof name !== 'string') continue;
      const base = ref.resolve?.(name) ?? resolveTypeDecl(name, ctx);
      if (base) out.push(...itemsFromDecl(reader, base, ctx, depth + 1));
    }
    out.push(...reader.members(decl.body?.body ?? [], ref.content, ref.comments));
    return out;
  }
  if (decl.type === 'TSTypeAliasDeclaration') {
    return itemsFromTypeNode(reader, decl.typeAnnotation, ctx, ref.content, ref.comments, depth + 1);
  }
  return [];
}

const PROPS_READER: ApiReader<VuePropInfo> = {
  members: propsFromMembers,
  flattenType: 'TSIntersectionType',
  maxDepth: 4,
};

const EMITS_READER: ApiReader<VueEmitInfo> = {
  members: emitsFromMembers,
  flattenType: 'TSUnionType',
  maxDepth: 2,
};

/** The type argument of a macro call: `defineProps<Props>()`'s params[0] is
 *  the type node DIRECTLY in @babel/parser (TSTypeParameter wrapping appears
 *  only on declarations), but accept both shapes. */
function macroTypeArg(node: any): any {
  const first = node.typeParameters?.params?.[0];
  if (!first) return undefined;
  return first.type === 'TSTypeParameter' ? first.typeAnnotation : first;
}

interface AstPair {
  statements: any[];
  content: string;
  comments: DocComments;
}

/** Same-file interface/type-alias declarations, keyed by name. The
 *  ExportNamedDeclaration wrapper is unwrapped, so `export interface Props`
 *  resolves exactly like a local one — the shape a shared `<script lang="ts">`
 *  block uses. */
function localTypeDecls(pairs: AstPair[]): Map<string, TypeDeclRef> {
  const map = new Map<string, TypeDeclRef>();
  for (const { statements, content, comments } of pairs) {
    for (const statement of statements) {
      const d = declStatement(statement);
      if (d?.id?.type === 'Identifier') map.set(d.id.name, { node: d, content, comments });
    }
  }
  return map;
}

/**
 * Extract the component API from a compiled script pair. Handles script-setup
 * macros (defineProps/withDefaults/defineEmits/defineSlots/defineExpose, both
 * type and runtime forms) and Options-API `export default { props, emits }`.
 */
function collectScriptApi(pairs: AstPair[], external: ((name: string) => TypeDeclRef | null) | null): { props: VuePropInfo[]; emits: VueEmitInfo[]; slots: string[]; exposed: string[] } {
  const props: VuePropInfo[] = [];
  const emits: VueEmitInfo[] = [];
  const slots: string[] = [];
  const exposed: string[] = [];
  const ctx: TypeResolveCtx = { localTypes: localTypeDecls(pairs), external };

  // Dedupe DURING iteration, not from a snapshot of the committed arrays:
  // diamond / cyclic `extends` repeats a name WITHIN one incoming batch
  // (each branch re-resolves the shared base), and a snapshot-built seen-set
  // lets that duplicate straight onto the agent-facing output.
  const seenPropNames = new Set<string>();
  const takeProps = (incoming: VuePropInfo[]) => {
    for (const p of incoming) {
      if (seenPropNames.has(p.name)) continue;
      seenPropNames.add(p.name);
      props.push(p);
    }
  };
  const seenEmitNames = new Set<string>();
  const takeEmits = (incoming: VueEmitInfo[]) => {
    for (const e of incoming) {
      if (seenEmitNames.has(e.name)) continue;
      seenEmitNames.add(e.name);
      emits.push(e);
    }
  };

  for (const { statements, content, comments: docs } of pairs) {
    walkBabel({ type: 'Block', body: statements }, (node: any) => {
      if (node.type !== 'CallExpression') return;
      const calleeName = node.callee?.type === 'Identifier' ? node.callee.name : node.callee?.property?.name;

      if (calleeName === 'defineProps') {
        const typeNode = macroTypeArg(node);
        if (typeNode) {
          takeProps(itemsFromTypeNode(PROPS_READER, typeNode, ctx, content, docs));
        } else if (node.arguments?.[0]?.type === 'ObjectExpression') {
          takeProps(propsFromRuntimeObject(node.arguments[0], content, docs));
        }
      } else if (calleeName === 'withDefaults' && node.arguments?.length >= 2) {
        // Extract the wrapped defineProps' props here (NOT relying on the
        // inner call's own visit): preorder walks visit withDefaults BEFORE
        // its children, so defaults must apply to props extracted inline.
        const inner = node.arguments[0];
        let incoming: VuePropInfo[] = [];
        if (inner?.type === 'CallExpression' && inner.callee?.name === 'defineProps') {
          const typeNode = macroTypeArg(inner);
          if (typeNode) {
            incoming = itemsFromTypeNode(PROPS_READER, typeNode, ctx, content, docs);
          } else if (inner.arguments?.[0]?.type === 'ObjectExpression') {
            incoming = propsFromRuntimeObject(inner.arguments[0], content, docs);
          }
        }
        const defaults = node.arguments[1];
        if (defaults?.type === 'ObjectExpression') {
          const byName = new Map(incoming.map((p) => [p.name, p]));
          for (const field of defaults.properties ?? []) {
            if (field.type !== 'ObjectProperty') continue;
            const name = field.key?.type === 'Identifier' ? field.key.name : field.key?.value;
            const existing = typeof name === 'string' ? byName.get(name) : undefined;
            if (existing) existing.default = nodeText(content, field.value) || existing.default;
          }
        }
        takeProps(incoming);
      } else if (calleeName === 'defineEmits') {
        const typeNode = macroTypeArg(node);
        if (typeNode) {
          takeEmits(itemsFromTypeNode(EMITS_READER, typeNode, ctx, content, docs));
        } else if (node.arguments?.[0]?.type === 'ArrayExpression') {
          takeEmits(
            node.arguments[0].elements
              .filter((el: any) => el?.type === 'StringLiteral')
              .map((el: any) => ({ name: el.value }))
          );
        } else if (node.arguments?.[0]?.type === 'ObjectExpression') {
          takeEmits(
            node.arguments[0].properties
              .map((p: any) => p.key?.type === 'Identifier' ? p.key.name : p.key?.value)
              .filter((n: any): n is string => typeof n === 'string')
              .map((name: string) => ({ name }))
          );
        }
      } else if (calleeName === 'defineExpose' && node.arguments?.[0]?.type === 'ObjectExpression') {
        for (const prop of node.arguments[0].properties ?? []) {
          if (prop.type !== 'ObjectProperty' && prop.type !== 'ObjectMethod') continue;
          const name = prop.key?.type === 'Identifier' ? prop.key.name : prop.key?.value;
          if (typeof name === 'string') exposed.push(name);
        }
      } else if (calleeName === 'defineSlots') {
        const typeNode = macroTypeArg(node);
        if (typeNode?.type === 'TSTypeLiteral') {
          for (const member of typeNode.members ?? []) {
            const name = member.key?.type === 'Identifier' ? member.key.name : member.key?.value;
            if (typeof name === 'string' && !slots.includes(name)) slots.push(name);
          }
        }
      }
    });

    // Options API: export default { props, emits }
    for (const statement of statements) {
      if (statement.type !== 'ExportDefaultDeclaration') continue;
      const obj = statement.declaration;
      if (obj?.type !== 'ObjectExpression') continue;
      for (const prop of obj.properties ?? []) {
        if (prop.type !== 'ObjectProperty') continue;
        const key = prop.key?.type === 'Identifier' ? prop.key.name : prop.key?.value;
        if (key === 'props') {
          if (prop.value?.type === 'ObjectExpression') {
            takeProps(propsFromRuntimeObject(prop.value, content, docs));
          } else if (prop.value?.type === 'ArrayExpression') {
            takeProps(
              prop.value.elements
                .filter((el: any) => el?.type === 'StringLiteral')
                .map((el: any) => ({ name: el.value }))
            );
          }
        } else if (key === 'emits') {
          if (prop.value?.type === 'ArrayExpression') {
            takeEmits(
              prop.value.elements
                .filter((el: any) => el?.type === 'StringLiteral')
                .map((el: any) => ({ name: el.value }))
            );
          } else if (prop.value?.type === 'ObjectExpression') {
            takeEmits(
              prop.value.properties
                .map((p: any) => p.key?.type === 'Identifier' ? p.key.name : p.key?.value)
                .filter((n: any): n is string => typeof n === 'string')
                .map((name: string) => ({ name }))
            );
          }
        }
      }
    }
  }

  return { props, emits, slots, exposed };
}

// =============================================================================
// Template AST helpers — compiler-sfc parse() produces the template AST with
// FILE-ABSOLUTE locs (verified: an element on file line 3 reports line 3), so
// template references need no offset math.
// =============================================================================

/** Walk every element node in the template in SOURCE ORDER — pre-order DFS
 *  (parent before its children, siblings left to right). BFS breaks it: a
 *  later sibling at depth 2 dequeues before an earlier sibling's child at
 *  depth 3, scrambling slot order. v-if/v-for branches are walked like
 *  children (branch itself rarely an element; its children are). */
function walkTemplateElements(node: any, visit: (el: any) => void): void {
  if (!node || typeof node !== 'object') return;
  if (node.type === 1) visit(node); // NodeTypes.ELEMENT
  if (Array.isArray(node.children)) {
    for (const child of node.children) walkTemplateElements(child, visit);
  }
  if (Array.isArray(node.branches)) {
    for (const branch of node.branches) walkTemplateElements(branch, visit);
  }
}

/**
 * VueExtractor - Extracts code relationships from Vue Single-File Component files
 *
 * Vue SFCs are multi-language (script + template + style). The SFC is parsed
 * with @vue/compiler-sfc (the official parser): <script> block contents are
 * delegated to the TypeScript/JavaScript TreeSitterExtractor, template element
 * tags become component references, and the component's public API (props,
 * emits, slots, exposed) is extracted into the component node's metadata as
 * `componentApi`. If the official parser rejects the file (malformed SFC),
 * extraction falls back to the pre-compiler regex path so the file still
 * contributes nodes and references.
 *
 * Every .vue file produces a component node (Vue components are always importable).
 */
export class VueExtractor {
  private filePath: string;
  private source: string;
  private nodes: Node[] = [];
  private edges: Edge[] = [];
  private unresolvedReferences: UnresolvedReference[] = [];
  private errors: ExtractionError[] = [];

  constructor(filePath: string, source: string) {
    this.filePath = filePath;
    this.source = source;
  }

  /**
   * Extract from Vue source
   */
  extract(): ExtractionResult {
    const startTime = Date.now();

    try {
      // Create component node for the .vue file itself
      const componentNode = this.createComponentNode();

      let descriptor: SFCDescriptor | null = null;
      try {
        descriptor = parseSfc(this.source, { filename: this.filePath }).descriptor;
      } catch {
        descriptor = null;
      }

      if (descriptor && (descriptor.script || descriptor.scriptSetup || descriptor.template)) {
        // Extract and process script blocks
        for (const block of this.extractScriptBlocksFromDescriptor(descriptor)) {
          this.processScriptBlock(block, componentNode.id);
        }

        // Template: component usages (<Modal>, <my-button>), <slot> declarations,
        // and @event="handler" bindings on component tags
        const { slots, bindings } = this.extractTemplateComponentsFromDescriptor(descriptor, componentNode.id);

        // Component public API → metadata.componentApi. Template `<slot>` names
        // UNION the defineSlots ones: a template may declare a slot the type
        // omits (and vice versa), and both are part of the contract.
        const api = this.collectComponentApi(descriptor);
        if (slots.length) api.slots = [...new Set([...(api.slots ?? []), ...slots])];
        const hasApi = api.props?.length || api.emits?.length || api.slots?.length || api.exposed?.length;
        if (hasApi) componentNode.metadata = { componentApi: api };

        // @event="handler" → component→function edges (metadata.vueEvent /
        // .vueComponent). Handlers live in THIS file's script, whose nodes the
        // delegation above already extracted — match by name, no unresolved
        // refs, no resolver involvement.
        this.createEventBindingEdges(bindings, componentNode);
      } else {
        // Fallback: pre-compiler regex path for files the official parser rejects
        for (const block of this.extractScriptBlocks()) {
          this.processScriptBlock(block, componentNode.id);
        }
        this.extractTemplateComponents(componentNode.id);
      }
    } catch (error) {
      this.errors.push({
        message: `Vue extraction error: ${error instanceof Error ? error.message : String(error)}`,
        severity: 'error',
      });
    }

    return {
      nodes: this.nodes,
      edges: this.edges,
      unresolvedReferences: this.unresolvedReferences,
      errors: this.errors,
      durationMs: Date.now() - startTime,
    };
  }

  /**
   * Create a component node for the .vue file
   */
  private createComponentNode(): Node {
    const lines = this.source.split('\n');
    const fileName = this.filePath.split(/[/\\]/).pop() || this.filePath;
    const componentName = fileName.replace(/\.vue$/, '');
    const id = generateNodeId(this.filePath, 'component', componentName, 1);

    const node: Node = {
      id,
      kind: 'component',
      name: componentName,
      qualifiedName: `${this.filePath}::${componentName}`,
      filePath: this.filePath,
      language: 'vue',
      startLine: 1,
      endLine: lines.length,
      startColumn: 0,
      endColumn: lines[lines.length - 1]?.length || 0,
      isExported: true, // Vue components are always importable
      updatedAt: Date.now(),
    };

    this.nodes.push(node);
    return node;
  }

  /** Descriptor-based script blocks — same shape the legacy path produces.
   *  Block `loc.start` points at the CONTENT start (the byte right after the
   *  opening tag's `>`, verified against the official parser): `loc.source`
   *  excludes the tags, so no indexOf('>') is needed — searching it would
   *  land on the first '>' inside the script body and shift every symbol. */
  private extractScriptBlocksFromDescriptor(
    descriptor: SFCDescriptor
  ): Array<{ content: string; startLine: number; isSetup: boolean; isTypeScript: boolean }> {
    const blocks: Array<{ content: string; startLine: number; isSetup: boolean; isTypeScript: boolean }> = [];
    for (const block of [descriptor.script, descriptor.scriptSetup]) {
      if (!block) continue;
      const startLine = (this.source.substring(0, block.loc.start.offset).match(/\n/g) || []).length;
      const isTypeScript = block.lang === 'ts' || block.lang === 'typescript';
      blocks.push({ content: block.content, startLine, isSetup: block === descriptor.scriptSetup, isTypeScript });
    }
    return blocks;
  }

  /** Component refs + slot names + @event bindings from the official template AST. */
  private extractTemplateComponentsFromDescriptor(
    descriptor: SFCDescriptor,
    componentNodeId: string
  ): { slots: string[]; bindings: TemplateBinding[] } {
    const slots: string[] = [];
    const bindings: TemplateBinding[] = [];
    const template = descriptor.template;
    if (!template?.ast) return { slots, bindings };

    walkTemplateElements(template.ast, (el) => {
      // tagType: 1 = component, 2 = slot (compiler-core NodeTypes)
      if (el.tagType === 2 || el.tag === 'slot') {
        // `<slot name="x"/>` → x; `<slot/>` → default; `:name="expr"` → (dynamic).
        const staticName = (el.props ?? []).find((p: any) => p.type === 6 && p.name === 'name'); // 6 = ATTRIBUTE
        const dynamicName = (el.props ?? []).find(
          (p: any) => p.type === 7 && p.name === 'bind' && p.arg?.content === 'name' // 7 = DIRECTIVE
        );
        const name = staticName?.value?.content ?? (dynamicName ? '(dynamic)' : 'default');
        if (!slots.includes(name)) slots.push(name);
        return;
      }

      let componentName: string | null = null;
      if (el.tagType === 1) {
        // The compiler classifies BOTH PascalCase imports and hyphenated tags
        // (custom elements / auto-imported components) as tagType 1 — convert
        // kebab so `<my-button>` matches the MyButton component node (#629).
        if (!VUE_BUILTIN_COMPONENTS.has(el.tag)) {
          componentName = el.tag.includes('-') ? kebabToPascal(el.tag) : el.tag;
        }
      }
      // lowercase, no hyphen → native HTML element: no reference

      if (componentName) {
        this.unresolvedReferences.push({
          fromNodeId: componentNodeId,
          referenceName: componentName,
          referenceKind: 'references',
          line: el.loc?.start?.line ?? 1,
          column: el.loc?.start?.column ?? 1,
          filePath: this.filePath,
          language: 'vue',
        });

        // @event="handler" (v-on) on a COMPONENT tag — the emit→handler pair
        // impact queries need. Native elements are excluded: a @click on
        // <div> references no child component's emit. The handler expression
        // rides `exp` (compiler-core); `value` is the static-attribute field.
        for (const directive of el.props ?? []) {
          if (directive.type !== 7 || directive.name !== 'on') continue; // 7 = DIRECTIVE
          const event = directive.arg?.content;
          const expression = directive.exp?.content;
          if (typeof event !== 'string' || !event || typeof expression !== 'string') continue;
          for (const handler of handlerIdentifiers(expression)) {
            bindings.push({
              event,
              handler,
              component: componentName,
              line: el.loc?.start?.line ?? 1,
            });
          }
        }
      }
    });

    return { slots, bindings };
  }

  /**
   * Wire @event bindings to this file's own handler nodes as direct
   * `references` edges carrying `metadata.vueEvent` (+ `.vueComponent`).
   * The handler usually lives in the same SFC's script (setup function or
   * options method), whose nodes the script delegation already extracted —
   * match by name, prefer function/method over variable/constant. Bindings
   * whose handler isn't defined here (inline statements, imported handlers)
   * produce no edge rather than a wrong one.
   */
  private createEventBindingEdges(bindings: TemplateBinding[], componentNode: Node): void {
    if (!bindings.length) return;
    const byName = new Map<string, Node>();
    for (const node of this.nodes) {
      if (node.kind !== 'function' && node.kind !== 'method' && node.kind !== 'variable' && node.kind !== 'constant') {
        continue;
      }
      const existing = byName.get(node.name);
      const preferred = (n: Node) => (n.kind === 'function' || n.kind === 'method' ? 0 : 1);
      if (!existing || preferred(node) < preferred(existing)) byName.set(node.name, node);
    }

    // One edge per (child component, event, handler): a v-if/v-else pair of
    // identical usages binds the same handler twice, and the graph has no
    // reason to carry the duplicate (the first occurrence's line wins).
    const seen = new Set<string>();
    for (const binding of bindings) {
      const handlerNode = byName.get(binding.handler);
      if (!handlerNode) continue;
      const key = `${binding.component}\u0000${binding.event}\u0000${handlerNode.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      this.edges.push({
        source: componentNode.id,
        target: handlerNode.id,
        kind: 'references',
        line: binding.line,
        metadata: { vueEvent: binding.event, vueComponent: binding.component },
      });
    }
  }

  /** Props/emits/exposed/slots from the compiled scripts; undefined if nothing found. */
  private collectComponentApi(descriptor: SFCDescriptor): VueComponentApi {
    const empty: VueComponentApi = {};
    if (!descriptor.script && !descriptor.scriptSetup) return empty;

    // Parse each script block with @babel/parser DIRECTLY rather than using
    // compileScript's scriptSetupAst: compileScript MUTATES the AST while
    // processing macros (withDefaults(defineProps<Props>()) loses its type
    // parameter), which is exactly the info this extractor needs. A fresh
    // parse also yields ast.comments for JSDoc extraction.
    const pairs: AstPair[] = [];
    for (const block of [descriptor.script, descriptor.scriptSetup]) {
      if (!block) continue;
      const plugins: any[] = [];
      if (block.lang === 'ts' || block.lang === 'typescript') plugins.push('typescript');
      if (block.lang === 'ts' || block.lang === 'typescript' || block.lang === 'tsx' || block.lang === 'jsx') {
        plugins.push('jsx');
      }
      try {
        const ast = babelParse(block.content, {
          sourceType: 'module',
          plugins,
          errorRecovery: true,
        } as any);
        pairs.push({
          statements: ast.program.body as any[],
          content: block.content,
          comments: docComments(ast, block.content),
        });
      } catch {
        // Unparseable script costs the API payload, not the index — the
        // tree-sitter delegation above still extracts symbols from it.
      }
    }
    if (!pairs.length) return empty;

    // Cross-file type expansion: `import type { Props } from './types'` —
    // resolve the import to a sibling file and pull the declaration out of it.
    // Relative imports and tsconfig `paths` aliases (`@/types/props`) both
    // resolve; a bare package has no file to read, so it yields no members
    // rather than a wrong one.
    const importMaps = pairs.map((p) => importSources(p.statements));
    const external = (name: string): TypeDeclRef | null => {
      const root = extractionRootHint;
      if (!root) return null;
      // filePath is project-relative in the pipeline but may be absolute for
      // library callers — path.join would concatenate rather than replace.
      const dir = path.isAbsolute(this.filePath)
        ? path.dirname(this.filePath)
        : path.dirname(path.join(root, this.filePath));
      for (let i = 0; i < pairs.length; i++) {
        const entry = importMaps[i]?.get(name);
        if (!entry) continue;
        const { source, importedName } = entry;
        // The declaration is named by its EXPORTED name in the target module,
        // not by the alias this file imported it as. Default imports are
        // skipped: the declaration's own name may differ from any binding.
        if (importedName === 'default') return null;
        for (const base of importBaseCandidates(source, dir, root)) {
          for (const ext of TYPE_FILE_EXTENSIONS) {
            const file = loadTypeFile(base + ext);
            if (!file) continue;
            const ref = findDeclInFile(file, importedName);
            if (ref) return ref;
          }
        }
      }
      return null;
    };

    const { props, emits, slots, exposed } = collectScriptApi(pairs, external);
    const api: VueComponentApi = {};
    if (props.length) api.props = props;
    if (emits.length) api.emits = emits;
    if (slots.length) api.slots = slots;
    if (exposed.length) api.exposed = exposed;
    return api;
  }

  /**
   * Process a script block by delegating to TreeSitterExtractor
   */
  private processScriptBlock(
    block: { content: string; startLine: number; isSetup: boolean; isTypeScript: boolean },
    componentNodeId: string
  ): void {
    const scriptLanguage: Language = block.isTypeScript ? 'typescript' : 'javascript';

    // Check if the script language parser is available
    if (!isLanguageSupported(scriptLanguage)) {
      this.errors.push({
        message: `Parser for ${scriptLanguage} not available, cannot parse Vue script block`,
        severity: 'warning',
      });
      return;
    }

    // Delegate to TreeSitterExtractor
    const extractor = new TreeSitterExtractor(this.filePath, block.content, scriptLanguage);
    const result = extractor.extract();

    // Offset line numbers from script block back to .vue file positions
    for (const node of result.nodes) {
      node.startLine += block.startLine;
      node.endLine += block.startLine;
      node.language = 'vue'; // Mark as vue, not TS/JS

      this.nodes.push(node);

      // Add containment edge from component to this node
      this.edges.push({
        source: componentNodeId,
        target: node.id,
        kind: 'contains',
      });
    }

    // Offset edges (they reference line numbers)
    for (const edge of result.edges) {
      if (edge.line) {
        edge.line += block.startLine;
      }
      this.edges.push(edge);
    }

    // Offset unresolved references
    for (const ref of result.unresolvedReferences) {
      ref.line += block.startLine;
      ref.filePath = this.filePath;
      ref.language = 'vue';
      this.unresolvedReferences.push(ref);
    }

    // Carry over errors
    for (const error of result.errors) {
      if (error.line) {
        error.line += block.startLine;
      }
      this.errors.push(error);
    }
  }

  // ==========================================================================
  // Legacy regex fallback — used only when the official parser rejects the
  // file. Line-based, so it mis-bounds multi-line tags and can't see slots,
  // but it keeps a malformed SFC contributing its script symbols and rough
  // template references.
  // ==========================================================================

  /**
   * Extract <script> and <script setup> blocks from the Vue source
   */
  private extractScriptBlocks(): Array<{
    content: string;
    startLine: number;
    isSetup: boolean;
    isTypeScript: boolean;
  }> {
    const blocks: Array<{
      content: string;
      startLine: number;
      isSetup: boolean;
      isTypeScript: boolean;
    }> = [];

    const scriptRegex = /<script(\s[^>]*)?>(?<content>[\s\S]*?)<\/script>/g;
    let match;

    while ((match = scriptRegex.exec(this.source)) !== null) {
      const attrs = match[1] || '';
      const content = match.groups?.content || match[2] || '';

      // Detect TypeScript from lang attribute
      const isTypeScript = /lang\s*=\s*["'](ts|typescript)["']/.test(attrs);

      // Detect <script setup>
      const isSetup = /\bsetup\b/.test(attrs);

      // Calculate the 0-indexed line where the content begins. The content
      // starts right after the opening tag's `>` — its leading `\n` is part
      // of the content, so relative line 1 sits ON the tag's closing line
      // (adding 1 here double-counted the embedded newline and shifted every
      // script-block symbol down a line).
      const beforeScript = this.source.substring(0, match.index);
      const scriptTagLine = (beforeScript.match(/\n/g) || []).length;
      const openingTag = match[0].substring(0, match[0].indexOf('>') + 1);
      const openingTagLines = (openingTag.match(/\n/g) || []).length;
      const contentStartLine = scriptTagLine + openingTagLines; // 0-indexed line

      blocks.push({
        content,
        startLine: contentStartLine,
        isSetup,
        isTypeScript,
      });
    }

    return blocks;
  }

  /**
   * Extract component usages from the Vue `<template>`.
   *
   * PascalCase tags (`<Modal>`, `<Button />`) and kebab-case tags
   * (`<my-button>`) both represent component instantiations — analogous to
   * function calls in imperative code. Capturing them creates parent→child
   * component edges and lets `callers` / `impact` see a component that is
   * only ever used in markup. Vue's extractor previously parsed only the
   * `<script>` block, so these usages produced no edge at all (#629).
   *
   * HTML elements (lowercase, no hyphen) and Vue built-ins are skipped.
   * Unmatched names create no edge during resolution, so converting
   * kebab-case is safe even for native custom elements.
   */
  private extractTemplateComponents(componentNodeId: string): void {
    // Ranges covered by <script> / <style> blocks — skip them so script
    // identifiers and CSS selectors aren't mistaken for template tags. This
    // also correctly handles nested <template> tags (v-if / slots), which a
    // single non-greedy <template>…</template> match would mis-bound.
    const coveredRanges: Array<[number, number]> = [];
    const blockRegex = /<(script|style)(\s[^>]*)?>[\s\S]*?<\/\1>/g;
    let blockMatch;
    while ((blockMatch = blockRegex.exec(this.source)) !== null) {
      const startLine = (this.source.substring(0, blockMatch.index).match(/\n/g) || []).length;
      const endLine = startLine + (blockMatch[0].match(/\n/g) || []).length;
      coveredRanges.push([startLine, endLine]);
    }

    const lines = this.source.split('\n');
    // Opening / self-closing tags (closing `</Foo>` starts with `</`, so the
    // leading `<` followed by a name letter won't match it).
    const tagRegex = /<([A-Za-z][A-Za-z0-9_-]*)\b/g;

    for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
      if (coveredRanges.some(([start, end]) => lineIdx >= start && lineIdx <= end)) continue;

      const line = lines[lineIdx]!;
      let match;
      while ((match = tagRegex.exec(line)) !== null) {
        const raw = match[1]!;
        let componentName: string;
        if (/^[A-Z]/.test(raw)) {
          componentName = raw; // PascalCase component
        } else if (raw.includes('-')) {
          componentName = kebabToPascal(raw); // kebab-case component
        } else {
          continue; // lowercase, no hyphen → native HTML element
        }
        if (VUE_BUILTIN_COMPONENTS.has(componentName)) continue;

        this.unresolvedReferences.push({
          fromNodeId: componentNodeId,
          referenceName: componentName,
          referenceKind: 'references',
          line: lineIdx + 1, // 1-indexed
          column: match.index + 1,
          filePath: this.filePath,
          language: 'vue',
        });
      }
    }
  }
}
