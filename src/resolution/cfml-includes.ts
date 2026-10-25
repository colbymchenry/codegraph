/**
 * CFML include resolution — the file a template path names, and the templates
 * a component's body pulls in.
 *
 * A CFML include (`include "x.cfm";`, `<cfinclude template="x.cfm">`,
 * `cfinclude("x.cfm")`) names a template relative to the including file, or
 * from the web root when it starts with `/`, never by symbol name (#2651).
 * Both the `imports` edge the resolver builds and the scope a component's
 * calls are judged in read the same path, so both go through
 * {@link cfmlIncludeFile}.
 */
import type { Node } from '../types';
import type { ResolutionContext } from './types';

/** Minimal context the path lookup needs — the name → node index. */
type FileLookup = Pick<ResolutionContext, 'getNodesByLowerName'>;

/**
 * Whether a CFML `imports` reference names a template path (`x.cfm`,
 * `../shared/helpers.cfm`, `/views/page.cfm`) rather than a component or
 * module import (`com.foo.Bar`, `java:…`), which no file path can name.
 */
export function isCfmlTemplatePath(name: string): boolean {
  return !name.includes(':') && (name.includes('/') || name.includes('\\') || /\.(?:cfml?|cfc|cfs)$/i.test(name.trim()));
}

export interface CfmlIncludeFile {
  /** The indexed `file` node the template path names. */
  file: Node;
  /** Written from the web root (`/x.cfm`), so the project root is assumed to be it. */
  fromRoot: boolean;
  /** Matched only when ignoring case, as a case-blind CFML file system would. */
  caseFolded: boolean;
}

/**
 * The indexed file a CFML include path names, or null when no file is there.
 *
 * `written` is the path as written (`formlistshared.cfm`,
 * `../shared/helpers.cfm`, `/views/page.cfm`); `fromFile` is the including
 * file. A path that starts with `/` is resolved from the web root — the
 * project root, when the project is the web root (an assumption, hence the
 * returned flag). CFML code written on a case-blind file system often spells
 * a path in another case, so a single file matching ignoring case counts too.
 */
export function cfmlIncludeFile(written: string, fromFile: string, context: FileLookup): CfmlIncludeFile | null {
  const path = written.trim().replace(/\\/g, '/');
  const fromRoot = path.startsWith('/');
  const parts = fromRoot ? [] : fromFile.replace(/\\/g, '/').split('/').slice(0, -1);
  for (const seg of path.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null; // above the project root
      parts.pop();
    } else {
      parts.push(seg);
    }
  }
  const fileName = parts[parts.length - 1];
  if (!fileName) return null;
  const wanted = parts.join('/');
  const files = context.getNodesByLowerName(fileName.toLowerCase()).filter((n) => n.kind === 'file');
  const exact = files.find((n) => n.filePath === wanted);
  if (exact) return { file: exact, fromRoot, caseFolded: false };
  const folded = files.filter((n) => n.filePath.toLowerCase() === wanted.toLowerCase());
  return folded.length === 1 ? { file: folded[0]!, fromRoot, caseFolded: true } : null;
}

/**
 * Every template a component's body includes, directly or through another
 * included template — the mixin files whose functions become the component's
 * members (#2651).
 *
 * An include written at component scope is qualified under the component's
 * own name (`baseform::formlistshared.cfm`) by both extraction paths, while
 * one written inside a function carries that function's scope
 * (`baseform::handle::formlistshared.cfm`) — a function-local include mixes
 * nothing into the component, so only the former counts. A `.cfm` template
 * has no component name, so a file-scope include there is qualified by its
 * path alone (`formlistshared.cfm`); those are followed too, since an
 * included template may itself include the file whose functions it wants.
 */
export function cfmlComponentIncludes(componentFile: string, context: ResolutionContext): string[] {
  const nodes = context.getNodesInFile(componentFile);
  const component = nodes.find((n) => (n.kind === 'class' || n.kind === 'interface') && /\.cfc$/i.test(n.filePath));
  return component ? cfmlScopeIncludes(componentFile, component.name, context) : [];
}

/**
 * The templates a declaration scope includes — a component's body when
 * `scopeQualifiedName` is its name, a function's body when it is the
 * function's qualified name. Includes nested inside another scope
 * (`baseform::handle::x.cfm` under the component scope) belong to that
 * scope, not this one, and are skipped. A template's own file-scope includes
 * are followed, since an included template may pull in the file it needs.
 */
export function cfmlScopeIncludes(file: string, scopeQualifiedName: string, context: ResolutionContext): string[] {
  const prefix = `${scopeQualifiedName}::`.toLowerCase();
  const written = context.getNodesInFile(file)
    .filter((n) => n.kind === 'import' && isCfmlTemplatePath(n.name) &&
      n.qualifiedName.toLowerCase().startsWith(prefix) &&
      !n.qualifiedName.slice(prefix.length).includes('::'))
    .map((n) => n.name);
  return cfmlIncludeClosure(written, file, context);
}

/** The templates a `.cfm`/`.cfc` includes at file scope, which it then mixes in itself. */
function cfmlTemplateIncludes(file: string, context: ResolutionContext): string[] {
  return context.getNodesInFile(file)
    .filter((n) => n.kind === 'import' && isCfmlTemplatePath(n.name) && !n.qualifiedName.includes('::'))
    .map((n) => n.name);
}

/** Resolve `written` include paths (relative to `fromFile`) and everything they include, cycle-guarded. */
function cfmlIncludeClosure(written: string[], fromFile: string, context: ResolutionContext): string[] {
  const out: string[] = [];
  const seen = new Set<string>([fromFile]);
  let queue = written.map((path) => ({ path, from: fromFile }));
  while (queue.length > 0 && out.length < 30) {
    const next: { path: string; from: string }[] = [];
    for (const { path, from } of queue) {
      const target = cfmlIncludeFile(path, from, context);
      if (!target || seen.has(target.file.filePath)) continue;
      seen.add(target.file.filePath);
      out.push(target.file.filePath);
      next.push(...cfmlTemplateIncludes(target.file.filePath, context).map((p) => ({ path: p, from: target.file.filePath })));
    }
    queue = next;
  }
  return out;
}
