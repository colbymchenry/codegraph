/**
 * What a name written in C# or Razor means among the project's .NET
 * declarations, by C#'s own lookup — and whether that is an F# declaration.
 *
 * The name is read from the syntax tree (./csharp-syntax), as it is written:
 * `System.Drawing.Color` is a path from a namespace, `Shape<int>.Empty` a
 * member of a type taking one type argument, `repo.Load(1).Confirm` a member
 * of what `Load` returns. It is looked up as the C# compiler does:
 *
 * - a simple name is a local or a parameter around it, a type parameter, a
 *   member or nested type of a type around it or of one that type inherits,
 *   then — for each namespace around the code, innermost first, ending at the
 *   global one — a type of that namespace, a namespace inside it, an alias of
 *   that namespace declaration, or a type (a static member, under
 *   `using static`) one of its `using`s imports;
 * - `A.B` is `B` looked up in what `A` means: a type or namespace of a
 *   namespace, a nested type or static member of a type, an instance member
 *   of a value's type or of a type that one inherits.
 *
 * The declarations looked through are the project's own, C#'s and F#'s
 * together — F#'s as .NET sees them (`fsharpDotnetDeclaration`), and only
 * those of the F# projects the code's project references (./dotnet-projects)
 * — so a C# declaration nearer the code is what the name means, as it is to
 * the compiler, and a path the project declares no part of (`System.Drawing`)
 * names nothing in it.
 *
 * Code that compiles is taken as given: where C#'s rules would reject what a
 * lookup found (a static class as a field's type, an interface constructed),
 * the name means something the project does not declare.
 */

import type { Node } from '../types';
import type { ResolutionContext, ResolvedRef, UnresolvedRef } from './types';
import {
  clearCsharpUnits,
  csharpUnitOf,
  fieldOf,
  hasToken,
  loadCsharpGrammar,
  namedChildrenOf,
  releaseCsharpUnits,
  samePosition,
  type CsharpUnit,
  type SyntaxNode,
} from './csharp-syntax';
import { clearDotnetProjects, dotnetProjectOf, isFsharpFileVisibleFrom } from './dotnet-projects';
import {
  fsharpDeclarationsNamed,
  fsharpDotnetDeclaration,
  fsharpNamespaceFiles,
  fsharpNamespaceNodes,
  fsharpNamespaces,
  fsharpResultTypes,
  hasFsharpFiles,
  isFsharpDotnetName,
} from './fsharp-scope';

/** The languages whose names are looked up as C# looks them up. */
const CSHARP_LANGUAGES: ReadonlySet<string> = new Set(['csharp', 'razor']);

/** C# declarations that are types. */
const CSHARP_TYPE_KINDS: ReadonlySet<string> = new Set(['class', 'struct', 'interface', 'enum', 'component']);

/** Syntax that declares a C# type. */
const TYPE_DECLARATIONS: ReadonlySet<string> = new Set([
  'class_declaration', 'struct_declaration', 'interface_declaration', 'record_declaration', 'enum_declaration',
]);

/** Syntax whose names are not in scope after it: a search for what is declared before a name does not enter it. */
const CLOSED_SCOPES: ReadonlySet<string> = new Set([
  'block', 'lambda_expression', 'anonymous_method_expression', 'local_function_statement', 'for_statement', 'foreach_statement',
  'using_statement', 'fixed_statement', 'catch_clause', 'switch_section', 'switch_expression_arm', 'query_expression',
  ...TYPE_DECLARATIONS,
]);

/** Syntax that binds a local name and states its type in its `type` field. */
const TYPED_BINDERS: ReadonlySet<string> = new Set([
  'parameter', 'declaration_pattern', 'recursive_pattern', 'declaration_expression', 'catch_declaration',
]);

/** How far a lookup follows what other declarations say: a value's type through an initializer, a member's through its declaration. */
const MAX_DEPTH = 12;

/**
 * What a piece of C# syntax denotes among the project's declarations. Null,
 * wherever one is expected, is "nothing the project declares, or nothing the
 * source states": a library type, a value the tree gives no type for.
 */
type Meaning =
  | { is: 'namespace'; path: string }
  /** A type named as such: its nested types and static members are reached through it. */
  | { is: 'type'; type: Node }
  /** A value of a project type; `type` is null where the tree does not say what it holds. */
  | { is: 'value'; type: Node | null }
  /**
   * A member. `member` is the F# declaration when it is one, null for C#'s;
   * `yields` is the project type a read of it (a field, a property) or a call
   * of it (a method) gives, null where there is none; `onValue` says it was
   * reached through a value rather than a name.
   */
  | { is: 'member'; member: Node | null; yields: Node | null; invocable: boolean; onValue: boolean };

/** How a name is used where it is written, which decides what it may be. */
type Use = 'using' | 'qualifier' | 'creation' | 'base' | 'type' | 'expression';

interface Occurrence {
  node: SyntaxNode;
  use: Use;
}

function joinPath(prefix: string, rest: string): string {
  return prefix === '' ? rest : `${prefix}.${rest}`;
}

function dottedPath(qualifiedName: string): string {
  return qualifiedName.split('::').join('.');
}

/** `A.B.C` → ['A', 'A.B', 'A.B.C']. */
function pathPrefixes(path: string): string[] {
  const parts = path === '' ? [] : path.split('.');
  return parts.map((_, i) => parts.slice(0, i + 1).join('.'));
}

/** Whether a type written with `written` type arguments (null: not written, as a Razor tag) can be one declaring `declared` (null: not known). */
function arityFits(declared: number | null, written: number | null): boolean {
  return declared === null || written === null || declared === written;
}

/** The name and the type-argument count of an `identifier` or a `generic_name`. */
function simpleNameOf(node: SyntaxNode): { name: string; typeArguments: number } | null {
  if (node.type === 'identifier') return { name: node.text, typeArguments: 0 };
  if (node.type !== 'generic_name') return null;
  const identifier = namedChildrenOf(node).find((c) => c.type === 'identifier');
  const list = namedChildrenOf(node).find((c) => c.type === 'type_argument_list');
  return identifier ? { name: identifier.text, typeArguments: list ? list.namedChildCount : 0 } : null;
}

/** The last name of what a name-like node writes: `Color` of `System.Drawing.Color`, `Confirm` of `o.Confirm`. */
function finalNameOf(node: SyntaxNode): string | null {
  switch (node.type) {
    case 'identifier':
    case 'generic_name':
      return simpleNameOf(node)?.name ?? null;
    case 'qualified_name':
    case 'alias_qualified_name':
    case 'member_access_expression':
    case 'member_binding_expression': {
      const name = fieldOf(node, 'name');
      return name ? finalNameOf(name) : null;
    }
    case 'conditional_access_expression': {
      const binding = namedChildrenOf(node).find((c) => c.type === 'member_binding_expression');
      return binding ? finalNameOf(binding) : null;
    }
    default:
      return null;
  }
}

const OPENERS = '([{<';
const CLOSERS = ')]}>';

/**
 * The names a reference name chains, as the extractor writes it, outside what
 * it brackets — arguments, type arguments, an index, an initializer:
 * `A`, `ImmutableList` of `A.ImmutableList<B.Image>`; `Order`, `Create`,
 * `Confirm` of `Order.Create(x.Id).Confirm`. The last is the name referred to.
 */
function chainNames(referenceName: string): string[] {
  const names: string[] = [];
  let depth = 0;
  let start = -1;
  for (let i = 0; i <= referenceName.length; i++) {
    const c = i < referenceName.length ? referenceName[i]! : '';
    if (c !== '' && /[\p{L}\p{N}_]/u.test(c)) {
      if (start < 0) start = i;
      continue;
    }
    if (start >= 0) {
      if (depth === 0) names.push(referenceName.slice(start, i));
      start = -1;
    }
    // `=>` is a lambda's arrow, not a closing bracket.
    if (c === '>' && referenceName[i - 1] === '=') continue;
    if (c !== '' && OPENERS.includes(c)) depth++;
    else if (c !== '' && CLOSERS.includes(c) && depth > 0) depth--;
  }
  return names;
}

/** Whether a node stands where C# reads a type rather than an expression. */
function isTypePosition(node: SyntaxNode): boolean {
  const parent = node.parent;
  if (!parent) return false;
  if (fieldOf(parent, 'type')?.id === node.id || fieldOf(parent, 'returns')?.id === node.id) return true;
  switch (parent.type) {
    case 'type_argument_list':
    case 'base_list':
    case 'qualified_name':
    case 'alias_qualified_name':
    case 'using_directive':
    case 'nullable_type':
    case 'array_type':
    case 'type_parameter_constraint':
    case 'type_pattern':
    case 'attribute':
      return true;
    case 'as_expression':
    case 'is_expression':
      return fieldOf(parent, 'right')?.id === node.id;
    default:
      return false;
  }
}

/** How the name written at `node` is used (see `Use`). */
function useOf(node: SyntaxNode): Use {
  const parent = node.parent;
  if (!parent) return 'expression';
  for (let n: SyntaxNode | null = parent; n; n = n.parent) {
    if (n.type === 'using_directive') return 'using';
    if (n.type !== 'qualified_name' && n.type !== 'generic_name' && n.type !== 'type_argument_list' && n.type !== 'alias_qualified_name') break;
  }
  if (parent.type === 'base_list' || parent.type === 'primary_constructor_base_type') return 'base';
  if (parent.type === 'object_creation_expression' && fieldOf(parent, 'type')?.id === node.id) return 'creation';
  if (parent.type === 'member_access_expression' && fieldOf(parent, 'expression')?.id === node.id) return 'qualifier';
  if (parent.type === 'typeof_expression') return 'qualifier';
  return isTypePosition(node) ? 'type' : 'expression';
}

/** A `using` directive as written. */
interface UsingDirective {
  node: SyntaxNode;
  /** The name it introduces: `Proto` of `using Proto = Grpc.Proto;`. */
  alias: string | null;
  isStatic: boolean;
  target: SyntaxNode;
}

function readUsing(node: SyntaxNode): UsingDirective | null {
  const alias = fieldOf(node, 'name');
  const target = namedChildrenOf(node).filter((c) => c.id !== alias?.id).pop();
  return target ? { node, alias: alias?.text ?? null, isStatic: hasToken(node, 'static'), target } : null;
}

/** A namespace around a name, with the `using` directives that apply to names looked up at it. */
interface NamespaceLevel {
  path: string;
  usings: UsingDirective[];
}

/** What a project's `global using`s and `<Using>` items bring into every one of its files. */
interface ProjectUsings {
  aliases: Map<string, Meaning | null>;
  namespaces: string[];
  statics: Node[];
}

const CSHARP_NAMESPACES = new WeakMap<ResolutionContext, Set<string>>();
const CSHARP_DECLARED_NAMESPACES = new WeakMap<ResolutionContext, Set<string>>();
const PROJECT_USINGS = new WeakMap<ResolutionContext, Map<string, ProjectUsings>>();
const FILE_ALIASES = new WeakMap<ResolutionContext, Map<string, ReadonlySet<string>>>();
const TYPES_IN = new WeakMap<ResolutionContext, Map<string, Meaning[]>>();

/**
 * What is read from one syntax tree, by the id of the node it was read at:
 * none of it changes while the tree lives, and a tree is read for many names.
 */
interface TreeMemo {
  top: SyntaxNode[];
  fileScoped: SyntaxNode | null;
  levels: Map<string, NamespaceLevel[]>;
  typeParameters: Map<number, string[]>;
  /** Null while being read: a base list that names its own type through itself reads as none. */
  baseTypes: Map<number, Node[] | null>;
}

const TREE_MEMOS = new WeakMap<object, TreeMemo>();

function treeMemoOf(node: SyntaxNode): TreeMemo {
  let memo = TREE_MEMOS.get(node.tree);
  if (!memo) {
    const top = namedChildrenOf(node.tree.rootNode);
    memo = {
      top,
      fileScoped: top.find((c) => c.type === 'file_scoped_namespace_declaration') ?? null,
      levels: new Map(),
      typeParameters: new Map(),
      baseTypes: new Map(),
    };
    TREE_MEMOS.set(node.tree, memo);
  }
  return memo;
}
const NO_ALIASES: ReadonlySet<string> = new Set();

/** The namespaces C# code declares, and those around them, by dotted path. */
function csharpNamespaces(context: ResolutionContext): Set<string> {
  let paths = CSHARP_NAMESPACES.get(context);
  if (paths) return paths;
  paths = new Set();
  for (const n of context.getNodesByKind('namespace')) {
    if (n.language === 'csharp') for (const prefix of pathPrefixes(dottedPath(n.qualifiedName))) paths.add(prefix);
  }
  CSHARP_NAMESPACES.set(context, paths);
  return paths;
}

/**
 * The namespaces a C# namespace declaration names, by dotted path: those
 * C#'s own resolution links a `using` to. `A` of `namespace A.B` is not one.
 */
function csharpDeclaredNamespaces(context: ResolutionContext): Set<string> {
  let paths = CSHARP_DECLARED_NAMESPACES.get(context);
  if (paths) return paths;
  paths = new Set();
  for (const n of context.getNodesByKind('namespace')) if (n.language === 'csharp') paths.add(dottedPath(n.qualifiedName));
  CSHARP_DECLARED_NAMESPACES.set(context, paths);
  return paths;
}

/** Forget what was read from C# files and projects; called when the resolver drops its caches. */
export function clearDotnetLookupCaches(context: ResolutionContext): void {
  CSHARP_NAMESPACES.delete(context);
  CSHARP_DECLARED_NAMESPACES.delete(context);
  PROJECT_USINGS.delete(context);
  FILE_ALIASES.delete(context);
  TYPES_IN.delete(context);
  clearCsharpUnits(context);
  clearDotnetProjects(context);
}

/**
 * Loads what looking a C# or Razor name up in F# needs before resolution
 * starts, which is synchronous: the C# grammar, in a project that has F#
 * beside C# or Razor.
 */
export async function prepareDotnetLookup(context: ResolutionContext): Promise<void> {
  const has = (language: 'fsharp' | 'csharp' | 'razor'): boolean => (context.getFilePathsOfLanguage?.(language).length ?? 0) > 0;
  if (has('fsharp') && (has('csharp') || has('razor'))) await loadCsharpGrammar();
}

class Lookup {
  constructor(private readonly context: ResolutionContext) {}

  // ---------------------------------------------------------------- declarations

  /** Whether code in file `from` sees a namespace `path`: one C# declares, or one an F# file it sees declares something in. */
  private hasNamespace(path: string, from: string): boolean {
    if (path === '' || csharpNamespaces(this.context).has(path)) return true;
    if (!fsharpNamespaces(this.context).has(path)) return false;
    for (const file of fsharpNamespaceFiles(path, this.context)) if (isFsharpFileVisibleFrom(file, from, this.context)) return true;
    return false;
  }

  /** The namespace or type that holds C# declaration `node`, as a dotted path, and whether that is a namespace. */
  private csharpHolder(node: Node): { path: string; isNamespace: boolean } {
    const segments = node.qualifiedName.split('::');
    const path = segments.slice(0, -1).join('.');
    return { path, isNamespace: path === '' || csharpNamespaces(this.context).has(path) };
  }

  /** The declaration syntax of C# node `node` in its file's tree. */
  private csharpDeclarationOf(node: Node): { declaration: SyntaxNode; unit: CsharpUnit } | null {
    const unit = csharpUnitOf(node.filePath, this.context);
    if (!unit) return null;
    if (node.language === 'razor') {
      const declaration = this.razorClassOf(unit);
      return declaration ? { declaration, unit } : null;
    }
    const start = unit.root.descendantForPosition({ row: node.startLine - 1, column: node.startColumn });
    for (let n: SyntaxNode | null = start; n; n = n.parent) {
      if (n.startPosition.row !== node.startLine - 1) break;
      const name = fieldOf(n, 'name');
      if (name?.text === node.name && n.type !== 'member_access_expression' && n.type !== 'qualified_name') return { declaration: n, unit };
    }
    return null;
  }

  /** The class a Razor file compiles to, in its unit. */
  private razorClassOf(unit: CsharpUnit): SyntaxNode | null {
    const find = (node: SyntaxNode): SyntaxNode | null => {
      if (node.type === 'class_declaration') return node;
      for (const child of namedChildrenOf(node)) {
        if (child.type !== 'namespace_declaration' && child.type !== 'declaration_list' && child.type !== 'class_declaration') continue;
        const found = find(child);
        if (found) return found;
      }
      return null;
    };
    return find(unit.root);
  }

  private typeParameterCount(declaration: SyntaxNode): number {
    return namedChildrenOf(declaration).find((c) => c.type === 'type_parameter_list')?.namedChildCount ?? 0;
  }

  /** How many type parameters a C# type declares; null where its declaration cannot be read. */
  private csharpTypeParameters(type: Node): number | null {
    const found = this.csharpDeclarationOf(type);
    return found ? this.typeParameterCount(found.declaration) : null;
  }

  /** The namespace of the class a Razor file compiles to. */
  private razorNamespace(component: Node): string {
    const found = this.csharpDeclarationOf(component);
    return found ? this.levelsAt(found.declaration)[0]!.path : '';
  }

  /** The project's types named `name`, written with `typeArguments`, declared directly in namespace `namespace`, that code in file `from` sees. */
  private typesIn(namespace: string, name: string, typeArguments: number | null, from: string): Meaning[] {
    let perContext = TYPES_IN.get(this.context);
    if (!perContext) TYPES_IN.set(this.context, (perContext = new Map()));
    // What `from` sees is what its project sees.
    const project = dotnetProjectOf(from.includes('/') ? from.slice(0, from.lastIndexOf('/')) : '', this.context).file ?? '';
    const key = `${namespace}\0${name}\0${typeArguments}\0${project}`;
    const cached = perContext.get(key);
    if (cached) return cached;
    const found = this.readTypesIn(namespace, name, typeArguments, from);
    perContext.set(key, found);
    return found;
  }

  private readTypesIn(namespace: string, name: string, typeArguments: number | null, from: string): Meaning[] {
    const found: Meaning[] = [];
    for (const n of this.context.getNodesByName(name)) {
      if (!CSHARP_LANGUAGES.has(n.language) || !CSHARP_TYPE_KINDS.has(n.kind)) continue;
      if (n.language === 'razor') {
        if (n.kind === 'component' && this.razorNamespace(n) === namespace && arityFits(this.csharpTypeParameters(n), typeArguments)) found.push({ is: 'type', type: n });
        continue;
      }
      const holder = this.csharpHolder(n);
      if (holder.isNamespace && holder.path === namespace && arityFits(this.csharpTypeParameters(n), typeArguments)) found.push({ is: 'type', type: n });
    }
    for (const n of fsharpDeclarationsNamed(name, this.context)) {
      const declaration = fsharpDotnetDeclaration(n, this.context)!;
      if (declaration.isType && declaration.owner === null && declaration.namespace === namespace && arityFits(declaration.typeParameters, typeArguments) &&
        isFsharpFileVisibleFrom(n.filePath, from, this.context)) {
        found.push({ is: 'type', type: n });
      }
    }
    return found;
  }

  /** The declarations sharing a type's qualified name: the parts of a partial C# type. */
  private partsOf(type: Node): Node[] {
    if (type.language !== 'csharp') return [type];
    const parts = this.context.getNodesByQualifiedName(type.qualifiedName).filter((n) => n.language === 'csharp' && CSHARP_TYPE_KINDS.has(n.kind));
    return parts.some((p) => p.id === type.id) ? parts : [type, ...parts];
  }

  private supertypesOf(type: Node): Node[] {
    return this.partsOf(type).flatMap((part) => this.context.getSupertypeNodes?.(part.id) ?? []);
  }

  private typeOf(meaning: Meaning | null): Node | null {
    return meaning?.is === 'type' ? meaning.type : null;
  }

  /** The type of the value an expression of this meaning gives. */
  private valueTypeOf(meaning: Meaning | null): Node | null {
    if (meaning?.is === 'value') return meaning.type;
    if (meaning?.is === 'member' && !meaning.invocable) return meaning.yields;
    return null;
  }

  /** What a member declaration in a C# tree means: what it yields is its declared type, read where it is declared. */
  private csharpMemberSyntax(declaration: SyntaxNode, unit: CsharpUnit, onValue: boolean, depth: number): Meaning {
    const typed = (type: SyntaxNode | null, invocable: boolean): Meaning => ({
      is: 'member',
      member: null,
      yields: type ? this.typeOf(this.meaningOf(type, unit, depth + 1)) : null,
      invocable,
      onValue,
    });
    switch (declaration.type) {
      case 'method_declaration':
        return typed(fieldOf(declaration, 'returns'), true);
      case 'local_function_statement':
      case 'delegate_declaration':
        return typed(fieldOf(declaration, 'type'), true);
      case 'variable_declarator':
        return typed(declaration.parent ? fieldOf(declaration.parent, 'type') : null, false);
      case 'property_declaration':
      case 'indexer_declaration':
      case 'event_declaration':
      case 'parameter':
        return typed(fieldOf(declaration, 'type'), false);
      default:
        return { is: 'member', member: null, yields: null, invocable: declaration.type === 'constructor_declaration', onValue };
    }
  }

  private csharpMember(member: Node, owner: Node, onValue: boolean, depth: number): Meaning {
    if (member.kind === 'enum_member') return { is: 'member', member: null, yields: owner, invocable: false, onValue };
    const found = this.csharpDeclarationOf(member);
    return found
      ? this.csharpMemberSyntax(found.declaration, found.unit, onValue, depth)
      : { is: 'member', member: null, yields: null, invocable: member.kind === 'method', onValue };
  }

  private fsharpMember(member: Node, onValue: boolean): Meaning {
    const invocable = member.kind === 'function' || member.kind === 'method' || (member.kind === 'enum_member' && Boolean(member.signature));
    const yields = fsharpResultTypes(member, this.context);
    return { is: 'member', member, yields: yields.length === 1 ? yields[0]! : null, invocable, onValue };
  }

  /**
   * The member or nested type `name` of `type`, then of what it inherits.
   * `through` says how it is reached: through the type's name (a nested type,
   * a static member), through a value (an instance member), or from inside
   * the type (either).
   */
  private memberOfType(
    type: Node,
    name: string,
    typeArguments: number | null,
    through: 'name' | 'value' | 'inside',
    typesOnly: boolean,
    depth: number,
    seen = new Set<string>(),
  ): Meaning | null {
    if (seen.has(type.id) || depth > MAX_DEPTH) return null;
    seen.add(type.id);
    const onValue = through === 'value';
    const found: Meaning[] = [];
    if (type.language === 'fsharp') {
      for (const n of fsharpDeclarationsNamed(name, this.context)) {
        const declaration = fsharpDotnetDeclaration(n, this.context)!;
        if (declaration.owner?.id !== type.id) continue;
        if (declaration.isType) {
          if (through !== 'value' && arityFits(declaration.typeParameters, typeArguments)) found.push({ is: 'type', type: n });
        } else if (!typesOnly && (through === 'inside' || declaration.isStatic === (through === 'name'))) {
          found.push(this.fsharpMember(n, onValue));
        }
      }
    } else if (type.language === 'razor') {
      const declared = this.csharpDeclarationOf(type);
      const own = declared ? this.memberInSyntax(declared.declaration, declared.unit, name, typeArguments, through, typesOnly, depth) : undefined;
      if (own !== undefined) return own;
    } else {
      for (const part of this.partsOf(type)) {
        for (const n of this.context.getNodesByQualifiedName(`${part.qualifiedName}::${name}`)) {
          if (n.language !== 'csharp' || n.name !== name) continue;
          if (CSHARP_TYPE_KINDS.has(n.kind)) {
            if (through !== 'value' && arityFits(this.csharpTypeParameters(n), typeArguments)) found.push({ is: 'type', type: n });
          } else if (!typesOnly) {
            const isStatic = n.isStatic === true || n.kind === 'enum_member' || n.kind === 'constant';
            if (through === 'inside' || isStatic === (through === 'name')) found.push(this.csharpMember(n, type, onValue, depth));
          }
        }
        if (found.length > 0) break;
      }
    }
    if (found.length > 0) return this.pick(found);
    for (const parent of this.supertypesOf(type)) {
      const inherited = this.memberOfType(parent, name, typeArguments, through, typesOnly, depth + 1, seen);
      if (inherited) return inherited;
    }
    return null;
  }

  /**
   * Of the declarations one lookup step finds, the one the name means. Two
   * that differ are an ambiguity no compiling code has: one of them is in an
   * assembly the code's project does not reference, which no project file
   * says (code no project compiles, an F# file no project lists), and a C#
   * declaration is the one a C# name is taken to mean.
   */
  private pick(found: Meaning[]): Meaning | null {
    if (found.length === 0) return null;
    const fsharp = (m: Meaning): Node | null =>
      m.is === 'type' ? (m.type.language === 'fsharp' ? m.type : null) : m.is === 'member' ? m.member : null;
    const csharp = found.find((m) => fsharp(m) === null);
    if (csharp) return csharp;
    const names = new Set(found.map((m) => fsharp(m)!.qualifiedName));
    return names.size === 1 ? found[0]! : null;
  }

  // ---------------------------------------------------------------- scopes

  /** The namespaces around `at`, innermost first, the global one last, each with the `using`s of its declaration. */
  private levelsAt(at: SyntaxNode): NamespaceLevel[] {
    const memo = treeMemoOf(at);
    const declarations: SyntaxNode[] = [];
    for (let n: SyntaxNode | null = at; n; n = n.parent) if (n.type === 'namespace_declaration') declarations.unshift(n);
    const fileScoped = memo.fileScoped && memo.fileScoped.startIndex <= at.startIndex ? memo.fileScoped : undefined;
    const key = `${declarations[declarations.length - 1]?.id ?? 0}:${fileScoped ? 1 : 0}`;
    const cached = memo.levels.get(key);
    if (cached) return cached;
    const levels = this.readLevels(memo.top, declarations, fileScoped);
    memo.levels.set(key, levels);
    return levels;
  }

  private readLevels(top: SyntaxNode[], declarations: SyntaxNode[], fileScoped: SyntaxNode | undefined): NamespaceLevel[] {
    const directives = (nodes: SyntaxNode[]): UsingDirective[] =>
      nodes.filter((c) => c.type === 'using_directive').map(readUsing).filter((u): u is UsingDirective => u !== null);
    const levels: NamespaceLevel[] = [
      { path: '', usings: directives(top.filter((c) => !fileScoped || c.startIndex < fileScoped.startIndex)) },
    ];
    let path = '';
    const enter = (declaration: SyntaxNode, usings: UsingDirective[]): void => {
      const parts = (fieldOf(declaration, 'name')?.text ?? '').split('.').map((p) => p.trim()).filter((p) => p !== '');
      parts.forEach((part, i) => {
        path = joinPath(path, part);
        levels.push({ path, usings: i === parts.length - 1 ? usings : [] });
      });
    };
    if (fileScoped) enter(fileScoped, directives([...top.filter((c) => c.startIndex > fileScoped.startIndex), ...namedChildrenOf(fileScoped)]));
    for (const declaration of declarations) {
      const body = fieldOf(declaration, 'body');
      enter(declaration, body ? directives(namedChildrenOf(body)) : []);
    }
    return levels.reverse();
  }

  /** What the `global using`s of a file's project, and its `<Using>` items, bring into the file. */
  private projectUsings(file: string): ProjectUsings {
    let perContext = PROJECT_USINGS.get(this.context);
    if (!perContext) PROJECT_USINGS.set(this.context, (perContext = new Map()));
    const dir = file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : '';
    const project = dotnetProjectOf(dir, this.context);
    const key = project.dir ?? `:${dir}`;
    const cached = perContext.get(key);
    if (cached) return cached;
    const usings: ProjectUsings = { aliases: new Map(), namespaces: [], statics: [] };
    // Set before it is filled: a global using is looked up with none of its project's in scope.
    perContext.set(key, usings);
    const take = (directive: UsingDirective, unit: CsharpUnit): void => {
      const meaning = this.meaningOf(directive.target, unit, 0);
      if (directive.alias !== null) usings.aliases.set(directive.alias, meaning);
      else if (directive.isStatic) {
        if (meaning?.is === 'type') usings.statics.push(meaning.type);
      } else if (meaning?.is === 'namespace') usings.namespaces.push(meaning.path);
    };
    // A project's own files, or every file of a repository that has no project file.
    const prefix = project.dir === null || project.dir === '' ? '' : `${project.dir}/`;
    for (const f of this.context.getAllFiles()) {
      if (!f.endsWith('.cs') || !f.startsWith(prefix) || !(this.context.fileContains?.(f, 'global using') ?? true)) continue;
      const unit = csharpUnitOf(f, this.context);
      if (!unit) continue;
      for (const child of namedChildrenOf(unit.root)) {
        if (child.type !== 'using_directive' || !hasToken(child, 'global')) continue;
        const directive = readUsing(child);
        if (directive) take(directive, unit);
      }
    }
    for (const item of project.usings) {
      // An item names a namespace or a type by its full path.
      const meaning = this.meaningOfPath(item.path.split('.'), file);
      if (item.alias !== null) usings.aliases.set(item.alias, meaning);
      else if (item.isStatic) {
        if (meaning?.is === 'type') usings.statics.push(meaning.type);
      } else if (meaning?.is === 'namespace') usings.namespaces.push(meaning.path);
    }
    return usings;
  }

  /** The names the `using` directives of a file, and of its project, introduce for something else: `Proto` of `using Proto = Grpc.Proto;`. */
  aliasesIn(file: string): ReadonlySet<string> {
    let perContext = FILE_ALIASES.get(this.context);
    if (!perContext) FILE_ALIASES.set(this.context, (perContext = new Map()));
    const cached = perContext.get(file);
    if (cached) return cached;
    const names = new Set<string>(this.projectUsings(file).aliases.keys());
    const unit = csharpUnitOf(file, this.context);
    // A `using` directive stands in a compilation unit or a namespace, never deeper.
    const visit = (node: SyntaxNode): void => {
      for (const child of namedChildrenOf(node)) {
        if (child.type === 'using_directive') {
          const alias = fieldOf(child, 'name');
          if (alias) names.add(alias.text);
        } else if (child.type === 'namespace_declaration' || child.type === 'file_scoped_namespace_declaration' || child.type === 'declaration_list') {
          if (child.type !== 'declaration_list' || node.type === 'namespace_declaration') visit(child);
        }
      }
    };
    if (unit) visit(unit.root);
    const aliases = names.size > 0 ? names : NO_ALIASES;
    perContext.set(file, aliases);
    return aliases;
  }

  /** What a full path from the global namespace names to code in file `from`: `Shop.Domain.Pricing`. */
  private meaningOfPath(parts: string[], from: string): Meaning | null {
    let meaning: Meaning | null = { is: 'namespace', path: '' };
    for (const part of parts) {
      if (!meaning) return null;
      meaning = this.memberOf(meaning, part, 0, true, 0, from);
    }
    return meaning;
  }

  /** The names a declaration's type parameter list gives. */
  private typeParameterNames(declaration: SyntaxNode): string[] {
    const memo = treeMemoOf(declaration).typeParameters;
    let names = memo.get(declaration.id);
    if (!names) {
      const list = namedChildrenOf(declaration).find((c) => c.type === 'type_parameter_list');
      names = list ? namedChildrenOf(list).map((p) => fieldOf(p, 'name')?.text ?? p.text) : [];
      memo.set(declaration.id, names);
    }
    return names;
  }

  /** What a node that binds the local name `name` says the name is. */
  private bindingMeaning(binder: SyntaxNode, unit: CsharpUnit, depth: number): Meaning {
    const stated = (type: SyntaxNode | null, initializer: SyntaxNode | null): Meaning => {
      if (type && type.type !== 'implicit_type') return { is: 'value', type: this.typeOf(this.meaningOf(type, unit, depth + 1)) };
      return { is: 'value', type: initializer ? this.valueTypeOf(this.meaningOf(initializer, unit, depth + 1)) : null };
    };
    if (binder.type === 'local_function_statement') return this.csharpMemberSyntax(binder, unit, false, depth);
    if (binder.type === 'variable_declarator') {
      // What follows `=`: a named expression, or the `this` token.
      let initializer: SyntaxNode | null = null;
      for (let i = 0; i < binder.childCount - 1; i++) if (binder.child(i)?.type === '=') initializer = binder.child(i + 1);
      return stated(binder.parent ? fieldOf(binder.parent, 'type') : null, initializer);
    }
    if (TYPED_BINDERS.has(binder.type) || binder.type === 'foreach_statement') return stated(fieldOf(binder, 'type'), null);
    return { is: 'value', type: null };
  }

  /** Whether `node` binds the local name `name`. */
  private binds(node: SyntaxNode, name: string): boolean {
    switch (node.type) {
      case 'variable_declarator':
        // A field's declarator is a member, found as one.
        return fieldOf(node, 'name')?.text === name && node.parent?.parent?.type !== 'field_declaration' && node.parent?.parent?.type !== 'event_field_declaration';
      case 'parameter':
      case 'declaration_pattern':
      case 'recursive_pattern':
      case 'declaration_expression':
      case 'catch_declaration':
      case 'local_function_statement':
      case 'from_clause':
        return fieldOf(node, 'name')?.text === name;
      case 'foreach_statement':
        return fieldOf(node, 'left')?.text === name;
      case 'implicit_parameter':
        return node.text === name;
      case 'var_pattern':
      case 'tuple_pattern':
      case 'parenthesized_variable_designation':
        return node.childrenForFieldName('name').some((c) => c?.text === name);
      case 'let_clause':
      case 'join_clause':
      case 'join_into_clause': {
        // The range variable is the first name the clause writes.
        const first = namedChildrenOf(node)[0];
        return first?.type === 'identifier' && first.text === name;
      }
      default:
        return false;
    }
  }

  /** The node that binds `name` in `node` for code written after it: nothing inside what closes its own scope. */
  private binderIn(node: SyntaxNode, name: string): SyntaxNode | null {
    // A local function is named in the scope around it; what it declares stays inside.
    if (CLOSED_SCOPES.has(node.type)) return node.type === 'local_function_statement' && this.binds(node, name) ? node : null;
    if (this.binds(node, name)) return node;
    for (const child of namedChildrenOf(node)) {
      const found = this.binderIn(child, name);
      if (found) return found;
    }
    return null;
  }

  /**
   * The node that binds local name `name` for code at `at`, looking from
   * `scope` (an ancestor of `at`) at what it declares itself and at what its
   * children written before `below` (its child towards `at`) declare.
   */
  private localBinder(scope: SyntaxNode, below: SyntaxNode, name: string, at: SyntaxNode): SyntaxNode | null {
    // A type's members are found as members, in any order.
    if (scope.type === 'declaration_list') return null;
    if (this.binds(scope, name)) return scope;
    for (const child of namedChildrenOf(scope)) {
      if (child.startIndex > at.startIndex) break;
      if (child.id === below.id) continue;
      const found = this.binderIn(child, name);
      if (found) return found;
    }
    return null;
  }

  private enclosingType(at: SyntaxNode): SyntaxNode | null {
    for (let n: SyntaxNode | null = at.parent; n; n = n.parent) if (TYPE_DECLARATIONS.has(n.type)) return n;
    return null;
  }

  /** The index's node for a type a tree declares. */
  private graphTypeOf(declaration: SyntaxNode, unit: CsharpUnit): Node | null {
    const nodes = this.context.getNodesInFile(unit.file);
    if (/\.(razor|cshtml)$/i.test(unit.file)) return nodes.find((n) => n.kind === 'component') ?? null;
    const name = fieldOf(declaration, 'name')?.text;
    const line = declaration.startPosition.row + 1;
    return nodes.find((n) => CSHARP_TYPE_KINDS.has(n.kind) && n.name === name && n.startLine === line) ?? null;
  }

  /** The types a declaration's base list names. */
  private baseTypesOf(declaration: SyntaxNode, unit: CsharpUnit): Node[] {
    const memo = treeMemoOf(declaration).baseTypes;
    if (memo.has(declaration.id)) return memo.get(declaration.id) ?? [];
    memo.set(declaration.id, null);
    const list = namedChildrenOf(declaration).find((c) => c.type === 'base_list');
    const types = !list ? [] : namedChildrenOf(list)
      .map((entry) => (entry.type === 'primary_constructor_base_type' ? fieldOf(entry, 'type') : entry))
      .map((type) => (type ? this.typeOf(this.meaningOf(type, unit, 0)) : null))
      .filter((t): t is Node => t !== null);
    memo.set(declaration.id, types);
    return types;
  }

  /**
   * The member or nested type `name` a type declaration's own syntax holds;
   * undefined when it holds none of that name.
   */
  private memberInSyntax(
    declaration: SyntaxNode,
    unit: CsharpUnit,
    name: string,
    typeArguments: number | null,
    through: 'name' | 'value' | 'inside',
    typesOnly: boolean,
    depth: number,
  ): Meaning | null | undefined {
    const onValue = through === 'value';
    const body = fieldOf(declaration, 'body');
    for (const member of body ? namedChildrenOf(body) : []) {
      if (TYPE_DECLARATIONS.has(member.type)) {
        if (fieldOf(member, 'name')?.text !== name || through === 'value' || !arityFits(this.typeParameterCount(member), typeArguments)) continue;
        const type = this.graphTypeOf(member, unit);
        return type ? { is: 'type', type } : null;
      }
      if (typesOnly) continue;
      // An enum's members and a `const` are static without saying so.
      const isStatic = member.type === 'enum_member_declaration' ||
        namedChildrenOf(member).some((c) => c.type === 'modifier' && (c.text === 'static' || c.text === 'const'));
      if (through !== 'inside' && isStatic !== (through === 'name')) continue;
      if (member.type === 'field_declaration' || member.type === 'event_field_declaration') {
        const variable = namedChildrenOf(member).find((c) => c.type === 'variable_declaration');
        const declarator = variable ? namedChildrenOf(variable).find((c) => c.type === 'variable_declarator' && fieldOf(c, 'name')?.text === name) : undefined;
        if (declarator) return this.csharpMemberSyntax(declarator, unit, onValue, depth);
      } else if (member.type === 'enum_member_declaration') {
        if (fieldOf(member, 'name')?.text === name) return { is: 'member', member: null, yields: this.graphTypeOf(declaration, unit), invocable: false, onValue };
      } else if (fieldOf(member, 'name')?.text === name) {
        return this.csharpMemberSyntax(member, unit, onValue, depth);
      }
    }
    if (typesOnly || through === 'name') return undefined;
    // A primary constructor's parameters are in scope through the type's body.
    const parameters = namedChildrenOf(declaration).find((c) => c.type === 'parameter_list');
    const parameter = parameters ? namedChildrenOf(parameters).find((p) => fieldOf(p, 'name')?.text === name) : undefined;
    return parameter ? this.csharpMemberSyntax(parameter, unit, onValue, depth) : undefined;
  }

  /**
   * The member or nested type `name` of the type declared by `declaration`,
   * as code inside it sees it: its own, a part's in another file, or one it
   * inherits. Undefined when there is none.
   */
  private memberOfEnclosing(
    declaration: SyntaxNode,
    unit: CsharpUnit,
    name: string,
    typeArguments: number | null,
    typesOnly: boolean,
    depth: number,
    inheritedOnly = false,
  ): Meaning | null | undefined {
    if (!inheritedOnly) {
      const own = this.memberInSyntax(declaration, unit, name, typeArguments, 'inside', typesOnly, depth);
      if (own !== undefined) return own;
    }
    const type = this.graphTypeOf(declaration, unit);
    const seen = new Set<string>();
    if (type && type.language === 'csharp' && !inheritedOnly) {
      // Its other parts and what the index says they inherit.
      const found = this.memberOfType(type, name, typeArguments, 'inside', typesOnly, depth, seen);
      if (found) return found;
    }
    for (const base of this.baseTypesOf(declaration, unit)) {
      const found = this.memberOfType(base, name, typeArguments, 'inside', typesOnly, depth + 1, seen);
      if (found) return found;
    }
    if (type && inheritedOnly) {
      for (const base of this.supertypesOf(type)) {
        const found = this.memberOfType(base, name, typeArguments, 'inside', typesOnly, depth + 1, seen);
        if (found) return found;
      }
    }
    return undefined;
  }

  // ---------------------------------------------------------------- lookup

  /** What a simple name written at `at` means (see the file's head). */
  private simpleName(name: string, typeArguments: number | null, at: SyntaxNode, unit: CsharpUnit, depth: number): Meaning | null {
    if (depth > MAX_DEPTH) return null;
    const typesOnly = isTypePosition(at);
    let below = at;
    for (let scope = at.parent; scope; below = scope, scope = scope.parent) {
      if (typeArguments === 0 && this.typeParameterNames(scope).includes(name)) return null;
      if (!typesOnly && typeArguments === 0) {
        const binder = this.localBinder(scope, below, name, at);
        if (binder) return this.bindingMeaning(binder, unit, depth);
      }
      if (TYPE_DECLARATIONS.has(scope.type)) {
        // Inside a base list the type's own members are not in scope yet.
        if (below.type === 'base_list') continue;
        const member = this.memberOfEnclosing(scope, unit, name, typeArguments, typesOnly, depth);
        if (member !== undefined) return member;
      }
    }

    // The directive a name is written in sees none of the `using`s beside it.
    let within: SyntaxNode | null = null;
    for (let n: SyntaxNode | null = at; n; n = n.parent) if (n.type === 'using_directive') within = n;
    const levels = this.levelsAt(at);
    for (const level of levels) {
      const types = this.pick(this.typesIn(level.path, name, typeArguments, unit.file));
      if (types) return types;
      if (!typeArguments && this.hasNamespace(joinPath(level.path, name), unit.file)) return { is: 'namespace', path: joinPath(level.path, name) };
      if (within && level.usings.some((u) => u.node.id === within!.id)) continue;
      const project = level.path === '' && !within ? this.projectUsings(unit.file) : null;

      if (!typeArguments) {
        const alias = level.usings.find((u) => u.alias === name);
        if (alias) return this.meaningOf(alias.target, unit, depth + 1);
        if (project?.aliases.has(name)) return project.aliases.get(name) ?? null;
      }
      const found: Meaning[] = [];
      const fromType = (type: Node): void => {
        const member = this.memberOfType(type, name, typeArguments, 'name', typesOnly, depth + 1);
        if (member) found.push(member);
      };
      for (const using of level.usings) {
        if (using.alias !== null) continue;
        const imported = this.meaningOf(using.target, unit, depth + 1);
        if (using.isStatic) {
          if (imported?.is === 'type') fromType(imported.type);
        } else if (imported?.is === 'namespace') found.push(...this.typesIn(imported.path, name, typeArguments, unit.file));
      }
      for (const namespace of project?.namespaces ?? []) found.push(...this.typesIn(namespace, name, typeArguments, unit.file));
      for (const type of project?.statics ?? []) fromType(type);
      if (found.length > 0) return this.pick(found);
    }
    return null;
  }

  /** What `name` means written after a dot on something of meaning `left`, in file `from`. */
  private memberOf(left: Meaning, name: string, typeArguments: number | null, typesOnly: boolean, depth: number, from: string): Meaning | null {
    switch (left.is) {
      case 'namespace': {
        const type = this.pick(this.typesIn(left.path, name, typeArguments, from));
        if (type) return type;
        const path = joinPath(left.path, name);
        return !typeArguments && this.hasNamespace(path, from) ? { is: 'namespace', path } : null;
      }
      case 'type':
        return this.memberOfType(left.type, name, typeArguments, 'name', typesOnly, depth);
      case 'value':
      case 'member': {
        const type = this.valueTypeOf(left);
        return type && !typesOnly ? this.memberOfType(type, name, null, 'value', false, depth) : null;
      }
    }
  }

  /** What `left.name` means, where `left` is the syntax before the dot. */
  private memberAccess(left: SyntaxNode | null, nameNode: SyntaxNode | null, at: SyntaxNode, unit: CsharpUnit, depth: number): Meaning | null {
    const written = nameNode ? simpleNameOf(nameNode) : null;
    if (!left || !written) return null;
    const typesOnly = at.type === 'qualified_name' || at.type === 'alias_qualified_name';
    if (left.type === 'this' || left.type === 'base') {
      const enclosing = this.enclosingType(at);
      const member = enclosing ? this.memberOfEnclosing(enclosing, unit, written.name, null, false, depth, left.type === 'base') : undefined;
      return member ?? null;
    }
    const meaning = this.meaningOf(left, unit, depth + 1);
    if (!meaning) return null;
    const member = this.memberOf(meaning, written.name, written.typeArguments, typesOnly, depth, unit.file);
    if (member) return member;
    // `Color Color`: a member named like its type gives the type's static members too.
    const type = this.valueTypeOf(meaning);
    if (type && left.type === 'identifier' && (fsharpDotnetDeclaration(type, this.context)?.name ?? type.name) === left.text) {
      return this.memberOfType(type, written.name, written.typeArguments, 'name', typesOnly, depth);
    }
    return null;
  }

  /** What the syntax at `node` denotes. */
  meaningOf(node: SyntaxNode, unit: CsharpUnit, depth: number): Meaning | null {
    if (depth > MAX_DEPTH) return null;
    switch (node.type) {
      case 'identifier':
      case 'generic_name': {
        const written = simpleNameOf(node);
        if (!written) return null;
        return this.simpleName(written.name, unit.typeArgumentsUnwritten(node) ? null : written.typeArguments, node, unit, depth);
      }
      case 'qualified_name':
        return this.memberAccess(fieldOf(node, 'qualifier'), fieldOf(node, 'name'), node, unit, depth);
      case 'alias_qualified_name': {
        const alias = fieldOf(node, 'alias');
        const name = fieldOf(node, 'name');
        const written = name ? simpleNameOf(name) : null;
        if (!alias || !written) return null;
        // `global::A` starts at the global namespace; any other alias is one the file declares, or an extern one.
        const left: Meaning | null = alias.text === 'global' ? { is: 'namespace', path: '' } : this.aliasMeaning(alias, unit, depth);
        return left ? this.memberOf(left, written.name, written.typeArguments, true, depth, unit.file) : null;
      }
      case 'member_access_expression':
        return this.memberAccess(fieldOf(node, 'expression'), fieldOf(node, 'name'), node, unit, depth);
      case 'conditional_access_expression': {
        const binding = namedChildrenOf(node).find((c) => c.type === 'member_binding_expression');
        return this.memberAccess(fieldOf(node, 'condition'), binding ? fieldOf(binding, 'name') : null, node, unit, depth);
      }
      case 'invocation_expression': {
        const callee = fieldOf(node, 'function');
        const meaning = callee ? this.meaningOf(callee, unit, depth + 1) : null;
        return meaning?.is === 'member' && meaning.invocable ? { is: 'value', type: meaning.yields } : null;
      }
      case 'object_creation_expression': {
        const type = fieldOf(node, 'type');
        return { is: 'value', type: type ? this.typeOf(this.meaningOf(type, unit, depth + 1)) : null };
      }
      case 'implicit_object_creation_expression': {
        // `Order o = new();` builds the type its declaration states.
        const holder = node.parent?.type === 'variable_declarator' ? node.parent.parent : node.parent;
        const type = holder && (holder.type === 'variable_declaration' || holder.type === 'property_declaration') ? fieldOf(holder, 'type') : null;
        return { is: 'value', type: type ? this.typeOf(this.meaningOf(type, unit, depth + 1)) : null };
      }
      case 'cast_expression': {
        const type = fieldOf(node, 'type');
        return { is: 'value', type: type ? this.typeOf(this.meaningOf(type, unit, depth + 1)) : null };
      }
      case 'as_expression': {
        const type = fieldOf(node, 'right');
        return { is: 'value', type: type ? this.typeOf(this.meaningOf(type, unit, depth + 1)) : null };
      }
      case 'parenthesized_expression':
      case 'postfix_unary_expression':
      case 'nullable_type':
      case 'ref_type':
      case 'scoped_type': {
        const inner = fieldOf(node, 'type') ?? namedChildrenOf(node)[0] ?? null;
        return inner ? this.meaningOf(inner, unit, depth + 1) : null;
      }
      case 'this': {
        const enclosing = this.enclosingType(node);
        return { is: 'value', type: enclosing ? this.graphTypeOf(enclosing, unit) : null };
      }
      default:
        return null;
    }
  }

  /** What the alias before `::` stands for. */
  private aliasMeaning(alias: SyntaxNode, unit: CsharpUnit, depth: number): Meaning | null {
    for (const level of this.levelsAt(alias)) {
      const using = level.usings.find((u) => u.alias === alias.text);
      if (using) return this.meaningOf(using.target, unit, depth + 1);
    }
    return this.projectUsings(unit.file).aliases.get(alias.text) ?? null;
  }

  // ---------------------------------------------------------------- references

  /**
   * The `using` directive, the call or the name a reference the extractor
   * placed at `start` is written as; `chained` is how many names of the
   * reference's chain are `name`. More than one where the reference does not
   * say which of the calls of a chain it is.
   */
  private occurrencesAt(start: SyntaxNode, ref: UnresolvedRef, name: string, chained: number): Occurrence[] {
    const chain: SyntaxNode[] = [];
    for (let n: SyntaxNode | null = start; n && samePosition(n, start); n = n.parent) chain.push(n);

    if (ref.referenceKind === 'imports') {
      const directive = chain.find((n) => n.type === 'using_directive');
      const using = directive ? readUsing(directive) : null;
      return using ? [{ node: using.target, use: 'using' }] : [];
    }
    if (ref.referenceKind === 'calls') {
      // `a.Then(x).Then(y)` starts two calls of `Then` where it starts: the reference chains as many `Then` as its own callee.
      const callees = chain
        .filter((n) => n.type === 'invocation_expression')
        .map((call) => fieldOf(call, 'function'))
        .filter((callee): callee is SyntaxNode => callee !== null && finalNameOf(callee) === name);
      const written = callees.length > 1 ? callees.filter((callee) => this.chained(callee, name) === chained) : callees;
      return (written.length > 0 ? written : callees).map((node) => ({ node, use: 'expression' as const }));
    }
    if (ref.referenceKind === 'instantiates') {
      const creation = chain.find((n) => n.type === 'object_creation_expression' || n.type === 'implicit_object_creation_expression');
      if (creation?.type === 'implicit_object_creation_expression') return [{ node: creation, use: 'creation' }];
      const type = creation ? fieldOf(creation, 'type') : null;
      if (type) return finalNameOf(type) === name ? [{ node: type, use: 'creation' }] : [];
    }
    // A name: the whole path it ends, where the reference starts at the path (`System.Drawing.Color`).
    let found: SyntaxNode | null = null;
    for (const n of chain) {
      if (n.type !== 'identifier' && n.type !== 'generic_name' && n.type !== 'qualified_name' && n.type !== 'alias_qualified_name') {
        if (n.isNamed) break;
        continue;
      }
      if (finalNameOf(n) === name) found = n;
    }
    return found ? [{ node: found, use: useOf(found) }] : [];
  }

  /** How many of the names `callee` chains are `name`: 2 for `a.Then(x).Then`. */
  private chained(callee: SyntaxNode, name: string): number {
    let count = 0;
    for (let n: SyntaxNode | null = callee; n; ) {
      switch (n.type) {
        case 'identifier':
        case 'generic_name':
          return count + (simpleNameOf(n)?.name === name ? 1 : 0);
        case 'member_access_expression': {
          const member = fieldOf(n, 'name');
          if (member && simpleNameOf(member)?.name === name) count++;
          n = fieldOf(n, 'expression');
          break;
        }
        case 'conditional_access_expression': {
          const binding = namedChildrenOf(n).find((c) => c.type === 'member_binding_expression');
          const member = binding ? fieldOf(binding, 'name') : null;
          if (member && simpleNameOf(member)?.name === name) count++;
          n = fieldOf(n, 'condition');
          break;
        }
        case 'invocation_expression':
          n = fieldOf(n, 'function');
          break;
        case 'element_access_expression':
          n = fieldOf(n, 'expression');
          break;
        case 'postfix_unary_expression':
          n = namedChildrenOf(n)[0] ?? null;
          break;
        default:
          return count;
      }
    }
    return count;
  }

  /** The whole path an identifier ends: `Acme.IService<T>` for its `IService`. */
  private pathEndingAt(identifier: SyntaxNode): SyntaxNode {
    let node = identifier;
    for (let parent = node.parent; parent; parent = node.parent) {
      const ends = parent.type === 'generic_name' || ((parent.type === 'qualified_name' || parent.type === 'alias_qualified_name') && fieldOf(parent, 'name')?.id === node.id);
      if (!ends) break;
      node = parent;
    }
    return node;
  }

  /** Where the reference `ref` is written in `unit`. */
  occurrencesOf(ref: UnresolvedRef, unit: CsharpUnit): Occurrence[] {
    const names = chainNames(ref.referenceName);
    const name = names[names.length - 1];
    if (name === undefined) return [];
    const chained = names.filter((n) => n === name).length;
    const placed = unit.nodesAt(ref.line, ref.column).flatMap((start) => this.occurrencesAt(start, ref, name, chained));
    if (placed.length > 0) return placed;
    // A Razor directive or tag: the extractor gives its line and the name's last part.
    return unit.identifiersOn(ref.line, name).map((identifier) => {
      const node = this.pathEndingAt(identifier);
      return { node, use: useOf(node) };
    });
  }

  /** Whether C# lets a name used as `use` mean type `type`: what it would reject, the name does not mean. */
  private fitsUse(type: Node, use: Use): boolean {
    if (type.language !== 'fsharp') return true;
    const declaration = fsharpDotnetDeclaration(type, this.context);
    if (!declaration) return false;
    switch (use) {
      case 'using':
      case 'qualifier':
      case 'expression':
        return true;
      case 'type':
        return !declaration.isStatic;
      case 'creation':
        return !declaration.isStatic && type.kind !== 'interface' && type.kind !== 'enum';
      case 'base':
        return type.kind === 'class' || type.kind === 'interface';
    }
  }

  /** The F# declaration the reference written at `occurrence` means, with how it was found; null when it means none. */
  targetOf(occurrence: Occurrence, ref: UnresolvedRef, unit: CsharpUnit): { node: Node; resolvedBy: ResolvedRef['resolvedBy'] } | null {
    const meaning = this.meaningOf(occurrence.node, unit, 0);
    if (!meaning) return null;
    switch (meaning.is) {
      case 'namespace': {
        // A namespace a C# declaration names too is, to a C# `using`, the one C# declares.
        if (ref.referenceKind !== 'imports' || csharpDeclaredNamespaces(this.context).has(meaning.path)) return null;
        const declared = fsharpNamespaceNodes(meaning.path, this.context).find((n) => isFsharpFileVisibleFrom(n.filePath, unit.file, this.context));
        return declared ? { node: declared, resolvedBy: 'import' } : null;
      }
      case 'type':
        if (meaning.type.language !== 'fsharp' || ref.referenceKind === 'calls' || !this.fitsUse(meaning.type, occurrence.use)) return null;
        return { node: meaning.type, resolvedBy: ref.referenceKind === 'imports' ? 'import' : 'qualified-name' };
      case 'member':
        if (!meaning.member || ref.referenceKind === 'imports' || ref.referenceKind === 'instantiates') return null;
        return { node: meaning.member, resolvedBy: meaning.onValue ? 'instance-method' : 'qualified-name' };
      case 'value':
        // `Order o = new();` builds the type its declaration states.
        if (ref.referenceKind !== 'instantiates' || meaning.type?.language !== 'fsharp' || !this.fitsUse(meaning.type, 'creation')) return null;
        return { node: meaning.type, resolvedBy: 'qualified-name' };
    }
  }
}

/**
 * The F# declaration a C# or Razor reference means, by C#'s lookup; null when
 * it means none — a C# declaration, which C#'s own resolution finds, or
 * nothing the project declares.
 */
export function matchDotnetReferenceInFsharp(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
  if (!CSHARP_LANGUAGES.has(ref.language) || !hasFsharpFiles(context)) return null;
  // No tree read for an earlier reference is in use now.
  releaseCsharpUnits(context);
  const lookup = new Lookup(context);
  // What a reference means is named by the last name it chains: a name .NET gives an F# declaration
  // or namespace, or an alias that stands for one.
  const names = chainNames(ref.referenceName);
  const last = names[names.length - 1];
  if (last === undefined) return null;
  if (!isFsharpDotnetName(last, context) && !lookup.aliasesIn(ref.filePath).has(last)) return null;
  const unit = csharpUnitOf(ref.filePath, context);
  if (!unit) return null;
  const targets = lookup.occurrencesOf(ref, unit).map((occurrence) => lookup.targetOf(occurrence, ref, unit));
  const first = targets[0];
  // Several places the reference may be written at: all of them mean the same declaration, or the reference is not decided.
  if (!first || targets.some((t) => t === null || t.node.qualifiedName !== first.node.qualifiedName)) return null;
  return { original: ref, targetNodeId: first.node.id, confidence: 0.9, resolvedBy: first.resolvedBy };
}
