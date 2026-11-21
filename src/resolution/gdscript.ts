/** GDScript uses exact script paths and class ownership, never global method-name guesses. */
import * as path from 'path';
import type { QueryBuilder } from '../db/queries';
import type { Node, ReferenceKind } from '../types';
import type { ResolutionContext, ResolvedRef, UnresolvedRef } from './types';

const SCENE_PATH_PREFIX = '$::';

export const GODOT_PROJECT_FILE = 'project.godot';

/** The module-config snapshot's key for what a project's scripts and scenes are. */
export const GODOT_STRUCTURE_KEY = 'godot:structure';

function projectDir(fromFile: string, ctx: ResolutionContext): string {
  let dir = path.posix.dirname(fromFile);
  while (dir !== '.' && !ctx.fileExists(path.posix.join(dir, GODOT_PROJECT_FILE))) dir = path.posix.dirname(dir);
  return dir;
}

/** The `[autoload]` section of a project.godot: all a resolver reads from it. */
export function godotAutoloadSection(config: string): string {
  return /^\[autoload\][ \t]*\r?\n([\s\S]*?)(?=^\[|$(?![\s\S]))/m.exec(config)?.[1] ?? '';
}

/**
 * What a script's references read besides its own text and the names they bind
 * to: which Godot files exist, what runs on each scene node, and what each script
 * class is called and extends, its signals, and its typed bindings. `extends
 * "res://base.gd"` waits for a file, `$Panel` and an autoload scene for what is
 * attached where, `Types.save()` for a class_name, and `Bus.fired.connect` for a
 * signal. Null without Godot files.
 */
export function godotStructureText(queries: Pick<QueryBuilder, 'getFilePathsByLanguages' | 'getNodesByKindAndLanguage'>): string | null {
  const files = queries.getFilePathsByLanguages(['gdscript', 'godot_resource']);
  if (files.length === 0) return null;
  const attached = queries.getNodesByKindAndLanguage('component', 'godot_resource')
    .filter((n) => n.returnType).map((n) => `${n.qualifiedName}=${n.returnType}`);
  const classes = queries.getNodesByKindAndLanguage('class', 'gdscript')
    .map((n) => `${n.filePath}|${n.qualifiedName}|${n.isExported ? 'global' : ''}|${n.signature ?? ''}`);
  // A signal's use is filed under `emit` or `connect`, so a signal coming or
  // going wakes nothing by its name; a binding's type is read by what inherits it.
  const members = (['field', 'property', 'constant'] as const)
    .flatMap((kind) => queries.getNodesByKindAndLanguage(kind, 'gdscript'))
    .filter((n) => n.returnType || n.decorators?.includes('signal'))
    .map((n) => `${n.qualifiedName}:${n.returnType ?? 'signal'}`);
  return [...files.sort(), ...attached.sort(), ...classes.sort(), ...members.sort()].join('\n');
}

/** Godot's scene nodes, read once per generation of the node list. */
interface SceneIndex {
  /** Script file -> the scene files it is attached to a node of. */
  scenesOfScript: Map<string, string[]>;
  /** Scene file -> what runs on its root node, as written. */
  rootOfScene: Map<string, string>;
  /** Scene file -> a node's path, or any tail of it -> the nodes there. */
  atPathInScene: Map<string, Map<string, Node[]>>;
  /** Project directory -> the same, keeping two: one more says only that it isn't the one there is. */
  atPathInProject: Map<string, Map<string, Node[]>>;
}

const sceneIndexes = new WeakMap<readonly Node[], SceneIndex>();

function scenePathOf(node: Node): string | undefined {
  return node.qualifiedName.split('::node:')[1];
}

function addAtPath(index: Map<string, Map<string, Node[]>>, where: string, at: string, node: Node, keep = Infinity): void {
  let paths = index.get(where);
  if (!paths) index.set(where, paths = new Map());
  const nodes = paths.get(at);
  if (!nodes) paths.set(at, [node]);
  else if (nodes.length < keep) nodes.push(node);
}

function sceneIndexOf(ctx: ResolutionContext): SceneIndex {
  const components = ctx.getNodesByKind('component');
  let index = sceneIndexes.get(components);
  if (index) return index;
  index = { scenesOfScript: new Map(), rootOfScene: new Map(), atPathInScene: new Map(), atPathInProject: new Map() };
  const projectOfScene = new Map<string, string>();
  for (const node of components) {
    if (node.language !== 'godot_resource') continue;
    const scenePath = scenePathOf(node);
    if (scenePath === undefined) continue;
    let project = projectOfScene.get(node.filePath);
    if (project === undefined) projectOfScene.set(node.filePath, project = projectDir(node.filePath, ctx));
    for (let at = scenePath, slash = 0; slash >= 0; slash = at.indexOf('/'), at = at.slice(slash + 1)) {
      addAtPath(index.atPathInScene, node.filePath, at, node);
      addAtPath(index.atPathInProject, project, at, node, 2);
    }
    if (!node.returnType) continue;
    if (!scenePath.includes('/')) index.rootOfScene.set(node.filePath, node.returnType);
    if (!node.returnType.endsWith('.gd')) continue;
    const script = gdscriptPath(node.returnType, node.filePath, ctx);
    if (!script) continue;
    const scenes = index.scenesOfScript.get(script);
    if (!scenes) index.scenesOfScript.set(script, [node.filePath]);
    else if (!scenes.includes(node.filePath)) scenes.push(node.filePath);
  }
  sceneIndexes.set(components, index);
  return index;
}

/** The script file `specifier` runs: itself, or the script on the root of a scene, through any scene that instances another. */
function scriptAt(specifier: string, fromFile: string, ctx: ResolutionContext): string | null {
  let written = specifier;
  let from = fromFile;
  const roots = sceneIndexOf(ctx).rootOfScene;
  for (let depth = 0; depth < 8; depth++) {
    const file = gdscriptPath(written, from, ctx);
    if (!file || written.endsWith('.gd')) return file;
    const root = written.endsWith('.tscn') ? roots.get(file) : undefined;
    if (!root) return null;
    written = root;
    from = file;
  }
  return null;
}

/**
 * The script an autoload value runs: `*res://a.gd`, or the script on the root
 * of `*res://a.tscn`. A value without `*` isn't a global name, and a `uid://`
 * value would need the project's uid table, which isn't indexed.
 */
function autoloadScript(value: string, ref: UnresolvedRef, ctx: ResolutionContext): string | null {
  const written = /^"\*(res:\/\/[^"\r\n]+)"[ \t]*$/.exec(value)?.[1];
  return written ? scriptAt(written, ref.filePath, ctx) : null;
}

export function gdscriptPath(specifier: string, fromFile: string, ctx: ResolutionContext): string | null {
  let target: string;
  if (specifier.startsWith('res://')) {
    // res:// is relative to the nearest Godot project, including in monorepos.
    const dir = projectDir(fromFile, ctx);
    const relative = path.posix.normalize(specifier.slice(6));
    if (relative === '..' || relative.startsWith('../') || path.posix.isAbsolute(relative)) return null;
    target = path.posix.join(dir, relative);
  } else if (!specifier.includes('://') && !path.posix.isAbsolute(specifier)) {
    target = path.posix.join(path.posix.dirname(fromFile), specifier);
  } else return null;
  target = path.posix.normalize(target);
  if (target === '..' || target.startsWith('../') || path.posix.isAbsolute(target)) return null;
  return ctx.getNodesInFile(target).some((n) => n.kind === 'file') ? target : null;
}

function ownerOf(ref: UnresolvedRef, ctx: ResolutionContext): Node | undefined {
  const caller = ctx.getNodeById?.(ref.fromNodeId);
  return ctx.getNodesInFile(ref.filePath)
    .filter((n) => n.kind === 'class' && n.language === 'gdscript' &&
      (caller ? caller.id === n.id || caller.qualifiedName.startsWith(`${n.qualifiedName}::`)
        : n.startLine <= ref.line && n.endLine >= ref.line))
    .sort((a, b) => b.qualifiedName.length - a.qualifiedName.length)[0];
}

function scriptClass(file: string, ctx: ResolutionContext): Node | undefined {
  return ctx.getNodesInFile(file).filter((n) => n.kind === 'class' && n.language === 'gdscript')
    .sort((a, b) => a.qualifiedName.length - b.qualifiedName.length)[0];
}

const isBinding = (n: Node): boolean => n.kind === 'constant' || n.kind === 'field' || n.kind === 'property';

/** The class a binding's type says: a script path, or a name as seen from the binding's own file. */
function bindingClass(binding: Node, ref: UnresolvedRef, ctx: ResolutionContext): Node | undefined {
  const type = binding.returnType;
  if (!type) return undefined;
  const from = { ...ref, fromNodeId: binding.id, filePath: binding.filePath };
  return classNamed(type, from, ctx, false);
}

/** `name`, seen from `ref`. Only `inherited` looks in base classes, which finding a base class itself must not. */
function classNamed(name: string, ref: UnresolvedRef, ctx: ResolutionContext, inherited = true): Node | undefined {
  // `res://a.gd`, and `res://a.gd.Inner` for `extends "res://a.gd".Inner`.
  const scriptPath = /^(.*\.gd)((?:\.\w+)*)$/.exec(name);
  if (scriptPath || name.includes('/')) {
    const file = gdscriptPath(scriptPath?.[1] ?? name, ref.filePath, ctx);
    return innerClass(file ? scriptClass(file, ctx) : undefined, scriptPath?.[2]?.slice(1), ctx);
  }
  // `Types.Foo`: an inner class of what the first name is.
  const dot = name.indexOf('.');
  if (dot > 0) return innerClass(classNamed(name.slice(0, dot), ref, ctx, inherited), name.slice(dot + 1), ctx);
  // A class sees its own bindings and inner classes, then each outer class's
  // constants and inner classes: never an outer class's instance fields.
  const inFile = ctx.getNodesInFile(ref.filePath);
  const inFileClasses = new Map(inFile.filter((n) => n.kind === 'class').map((n) => [n.qualifiedName, n]));
  const own = ownerOf(ref, ctx);
  const script = scriptClass(ref.filePath, ctx);
  for (let scope = own; scope; scope = inFileClasses.get(scope.qualifiedName.slice(0, scope.qualifiedName.lastIndexOf('::')))) {
    const inner = inFileClasses.get(`${scope.qualifiedName}::${name}`);
    if (inner) return inner;
    // A script without class_name has no name: its node's is only its file's.
    if (scope.name === name && (scope !== script || scope.isExported)) return scope;
    const binding = inFile.find((n) => n.qualifiedName === `${scope!.qualifiedName}::${name}` &&
      (n.kind === 'constant' || (isBinding(n) && scope === own)));
    if (binding) return bindingClass(binding, ref, ctx);
  }
  const config = ctx.readFile(path.posix.join(projectDir(ref.filePath, ctx), GODOT_PROJECT_FILE));
  for (const line of config ? godotAutoloadSection(config).split(/\r?\n/) : []) {
    const eq = line.indexOf('=');
    if (eq > 0 && line.slice(0, eq).trim() === name) {
      const file = autoloadScript(line.slice(eq + 1).trim(), ref, ctx);
      return file ? scriptClass(file, ctx) : undefined;
    }
  }
  const classes = ctx.getNodesByName(name).filter((n) => n.language === 'gdscript' && n.kind === 'class' && n.isExported &&
    projectDir(n.filePath, ctx) === projectDir(ref.filePath, ctx));
  if (classes.length === 1) return classes[0];
  if (!inherited || classes.length > 1) return undefined;
  // What a base class declares, after the global names so that finding a base can't come back here.
  const seen = new Set<string>();
  for (let base = own && parentOf(own, ref, ctx); base && !seen.has(base.id); base = parentOf(base, ref, ctx)) {
    seen.add(base.id);
    const qualified = `${base.qualifiedName}::${name}`;
    const binding = ctx.getNodesInFile(base.filePath).find((n) => n.qualifiedName === qualified && isBinding(n));
    if (binding) return bindingClass(binding, ref, ctx);
  }
  return undefined;
}

function innerClass(outermost: Node | undefined, parts: string | undefined, ctx: ResolutionContext): Node | undefined {
  let cls = outermost;
  for (const part of parts ? parts.split('.') : []) {
    const outer: Node | undefined = cls;
    cls = outer && ctx.getNodesInFile(outer.filePath).find((n) => n.kind === 'class' && n.qualifiedName === `${outer.qualifiedName}::${part}`);
  }
  return cls;
}

function parentOf(cls: Node, ref: UnresolvedRef, ctx: ResolutionContext): Node | undefined {
  const written = cls.signature?.replace(/^extends\s+/, '').trim();
  if (!written) return undefined;
  const literal = /^(["'])(.*?)\1(.*)$/.exec(written);
  return classNamed(literal ? literal[2]! + literal[3]!.trim() : written, { ...ref, fromNodeId: cls.id, filePath: cls.filePath }, ctx, false);
}

function memberOf(cls: Node | undefined, name: string, ref: UnresolvedRef, ctx: ResolutionContext, seen = new Set<string>()): Node | undefined {
  if (!cls || seen.has(cls.id) || seen.size >= 32) return undefined;
  seen.add(cls.id);
  const members = ctx.getNodesInFile(cls.filePath).filter((n) => n.name === name && n.qualifiedName === `${cls.qualifiedName}::${name}` &&
    (ref.referenceKind === 'calls' || ref.referenceKind === 'function_ref'
      ? n.kind === 'method' || n.kind === 'function'
      : n.kind === 'field' && n.decorators?.includes('signal')));
  if (members.length === 1) return members[0];
  if (members.length > 1) return undefined;
  return memberOf(parentOf(cls, ref, ctx), name, ref, ctx, seen);
}

/** What a signal reference does with its signal, from the name the extractor filed it under. */
export function signalUseOf(referenceName: unknown): 'emit' | 'connect' | null {
  if (typeof referenceName !== 'string') return null;
  return referenceName.endsWith('.emit') ? 'emit' : referenceName.endsWith('.connect') ? 'connect' : null;
}

/**
 * The scene nodes a `$::Panel::Label` reference names, at that path below any
 * node. The scenes the script is attached to know the path; any other scene only
 * has a node of that name, so it answers only when it is the one there is.
 */
function nodesAtScenePath(ref: UnresolvedRef, ctx: ResolutionContext): Node[] {
  const wanted = ref.referenceName.slice(SCENE_PATH_PREFIX.length).split('::').join('/');
  const index = sceneIndexOf(ctx);
  const attached = (index.scenesOfScript.get(ref.filePath) ?? [])
    .flatMap((scene) => index.atPathInScene.get(scene)?.get(wanted) ?? []);
  if (attached.length > 0) return attached.sort((a, b) => a.filePath.localeCompare(b.filePath));
  const elsewhere = index.atPathInProject.get(projectDir(ref.filePath, ctx))?.get(wanted) ?? [];
  return elsewhere.length === 1 ? elsewhere : [];
}

function resolved(ref: UnresolvedRef, targets: Node[]): ResolvedRef | null {
  const [first, ...rest] = targets;
  if (!first) return null;
  return {
    original: ref, targetNodeId: first.id, confidence: 1, resolvedBy: 'exact-match',
    ...(rest.length > 0 ? { alsoTargets: rest.map((n) => ({ targetNodeId: n.id })) } : {}),
  };
}

function fileNodeAt(specifier: string, ref: UnresolvedRef, ctx: ResolutionContext): ResolvedRef | null {
  const file = gdscriptPath(specifier, ref.filePath, ctx);
  return resolved(ref, file ? ctx.getNodesInFile(file).filter((n) => n.kind === 'file') : []);
}

function matchScopedReference(ref: UnresolvedRef, ctx: ResolutionContext): ResolvedRef | null {
  if (ref.referenceKind === 'imports') return fileNodeAt(ref.referenceName, ref, ctx);
  if (ref.referenceKind === 'extends' || ref.referenceKind === 'instantiates') {
    const cls = classNamed(ref.referenceName, ref, ctx);
    return resolved(ref, cls ? [cls] : []);
  }
  if (ref.referenceKind === 'references' && ref.referenceName.startsWith(SCENE_PATH_PREFIX)) {
    return resolved(ref, nodesAtScenePath(ref, ctx));
  }
  const use = ref.referenceKind === 'references' ? signalUseOf(ref.referenceName) : null;
  // No other `references` is filed from a script.
  if (ref.referenceKind === 'references' && !use) return null;
  const written = use ? ref.referenceName.slice(0, -(use.length + 1)) : ref.referenceName;
  const dot = written.lastIndexOf('.');
  const receiver = dot < 0 ? 'self' : written.slice(0, dot);
  const name = written.slice(dot + 1);
  const own = ownerOf(ref, ctx);
  const cls = receiver === 'self' ? own : receiver === 'super' ? own && parentOf(own, ref, ctx) : classNamed(receiver, ref, ctx);
  const target = memberOf(cls, name, ref, ctx);
  return resolved(ref, target ? [target] : []);
}

/** A scene's `[connection]` handler, a `res://` path, or a resource's `script_class`. */
function matchSceneReference(ref: UnresolvedRef, ctx: ResolutionContext): ResolvedRef | null | undefined {
  if (ref.referenceKind === 'calls') {
    const at = ref.referenceName.lastIndexOf('::');
    const script = at > 0 ? scriptAt(ref.referenceName.slice(0, at), ref.filePath, ctx) : null;
    const target = script ? memberOf(scriptClass(script, ctx), ref.referenceName.slice(at + 2), ref, ctx) : undefined;
    return resolved(ref, target ? [target] : []);
  }
  if (ref.referenceKind !== 'references') return undefined;
  if (ref.referenceName.startsWith('res://')) return fileNodeAt(ref.referenceName, ref, ctx);
  const cls = classNamed(ref.referenceName, ref, ctx);
  return resolved(ref, cls ? [cls] : []);
}

/** The reference kinds a script's own scope answers. */
const GDSCRIPT_SCOPED_KINDS: ReadonlySet<ReferenceKind> = new Set<ReferenceKind>([
  'calls', 'references', 'function_ref', 'imports', 'extends', 'instantiates',
]);

/**
 * What a Godot reference resolves to, null for nothing, undefined when it isn't
 * one this file answers and the shared strategies should look at it.
 */
export function matchGodotReference(ref: UnresolvedRef, ctx: ResolutionContext): ResolvedRef | null | undefined {
  if (ref.language === 'godot_resource') return matchSceneReference(ref, ctx);
  if (ref.language !== 'gdscript') return undefined;
  // `@abstract`, `@export`, `@onready`: GDScript has no annotations of a
  // project's own, so a method called `abstract` is never what one means.
  if (ref.referenceKind === 'decorates') return null;
  return GDSCRIPT_SCOPED_KINDS.has(ref.referenceKind) ? matchScopedReference(ref, ctx) : undefined;
}
