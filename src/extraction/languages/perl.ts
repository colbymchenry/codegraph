import type { Node as SyntaxNode } from 'web-tree-sitter';
import { getNodeText, getChildByField } from '../tree-sitter-helpers';
import type {
  LanguageExtractor,
  ExtractorContext,
  ImportInfo,
  VariableInfo,
} from '../tree-sitter-types';

// Node names follow tree-sitter-perl v2.0.0 (ABI 15), the grammar published by
// the tree-sitter-perl org.
//
// Two shapes of Perl don't fit the generic extractor and are handled by the
// visitNode hook below:
//
//   - `package Foo;` (the STATEMENT form, and by far the dominant idiom) scopes
//     every following sibling until the next package statement or EOF — the subs
//     it owns are SIBLINGS of the package node, not children. The generic
//     parent/child walk would therefore attach every sub to the file instead of
//     its package, losing both the contains edges and the `Foo::bar` qualified
//     name that cross-file `use`/call resolution rides on. So `source_file` is
//     walked here, opening a namespace scope at each package statement and
//     closing it at the next one. The BLOCK form (`package Foo { ... }`) nests
//     normally and is scoped to its own block.
//
//   - `use` is Perl's one keyword for several unrelated things. Pragmas
//     (`use strict`) are noise and are dropped; `use constant` DECLARES symbols
//     and becomes constant nodes; `use parent`/`use base` declare INHERITANCE
//     and emit `extends` references. Everything else is a genuine module import
//     and falls through to the core's import handling.
//
// Method calls (`$obj->method`, `Class->new`) use `invocant`/`method` fields
// rather than the `function` field the generic path expects, so they get a perl
// branch in extractCall — mirroring the ruby one, and for the same reason.

/** Pragmas and compiler directives — these import no symbols worth indexing. */
const PRAGMAS = new Set([
  'strict', 'warnings', 'utf8', 'feature', 'lib', 'vars', 'integer', 'bytes',
  'overload', 'open', 'locale', 'sort', 'subs', 'less', 'filetest', 'sigtrap',
  're', 'if', 'mro', 'diagnostics', 'bignum', 'bigint', 'bigrat', 'encoding',
  'fields', 'attributes', 'autouse', 'blib', 'charnames', 'deprecate',
  'experimental', 'version',
]);

/** `use parent`/`use base` declare inheritance, not an import. */
const INHERITANCE_PRAGMAS = new Set(['parent', 'base']);

/** Sigil for a declared-variable node type. */
const SIGILS: Record<string, string> = { scalar: '$', array: '@', hash: '%', glob: '*' };

/**
 * The variables a `my`/`our`/`local` declaration introduces. The grammar nests
 * the name under a sigil node (`scalar > varname`), and a list declaration
 * (`my ($class, %args) = @_`) repeats that shape under the `variables` field.
 * Punctuation globals (`$_`, `$|`) are language builtins, not declarations.
 */
function declaredVariables(node: SyntaxNode, source: string): VariableInfo[] {
  const out: VariableInfo[] = [];
  const declarator = getNodeText(node, source).trimStart().split(/\s/)[0] ?? 'my';
  const walk = (n: SyntaxNode): void => {
    const sigil = SIGILS[n.type];
    if (sigil) {
      const varNode = n.namedChild(0);
      if (varNode?.type === 'varname') {
        const bare = getNodeText(varNode, source).trim();
        if (bare && /^[A-Za-z_]\w*$/.test(bare)) {
          out.push({
            name: `${sigil}${bare}`,
            kind: 'variable',
            signature: `${declarator} ${sigil}${bare}`,
            positionNode: n,
          });
        }
      }
      return;
    }
    for (let i = 0; i < n.namedChildCount; i++) {
      const child = n.namedChild(i);
      if (child) walk(child);
    }
  };
  walk(node);
  return out;
}

/** The `package` node under a package_statement carries the name. */
function packageName(node: SyntaxNode, source: string): string | null {
  const nameNode = getChildByField(node, 'name');
  if (!nameNode) return null;
  const text = getNodeText(nameNode, source).trim();
  return text.length > 0 ? text : null;
}

/** The block of a `package Foo { ... }`; null for the statement form. */
function packageBlock(node: SyntaxNode): SyntaxNode | null {
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child?.type === 'block') return child;
  }
  return null;
}

/**
 * Every bareword/string a `use` statement lists after the module name — the
 * class list of `use parent -norequire, 'A', 'B'` or `use base qw(A B)`.
 * `-norequire` is a flag, not a class, so leading-dash entries are dropped.
 */
function usedNames(node: SyntaxNode, source: string): string[] {
  const names: string[] = [];
  const push = (text: string): void => {
    const trimmed = text.trim();
    if (trimmed && !trimmed.startsWith('-')) names.push(trimmed);
  };
  const walk = (n: SyntaxNode): void => {
    // `qw(A B)` is ONE string_content node holding "A B" — the words are not
    // separate nodes, so it must be split or the whole list becomes a single
    // unresolvable parent literally named "A B".
    if (n.type === 'quoted_word_list') {
      for (const word of getNodeText(n, source).replace(/^qw.|.$/g, ' ').split(/\s+/)) push(word);
      return;
    }
    if (n.type === 'string_content' || n.type === 'autoquoted_bareword' || n.type === 'bareword') {
      push(getNodeText(n, source));
      return;
    }
    // Only descend through plain list structure. A concatenation or a call
    // (`use parent 'A' . '::B'`) has no complete static name to take, and
    // harvesting its string fragments invents parents that never existed.
    if (n.type !== 'list_expression' && n.type !== 'string_literal') return;
    for (let i = 0; i < n.namedChildCount; i++) {
      const child = n.namedChild(i);
      if (child) walk(child);
    }
  };
  const moduleNode = getChildByField(node, 'module');
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child && child.id !== moduleNode?.id) walk(child);
  }
  return names;
}

/**
 * Constant names declared by `use constant`. Two shapes, which pair their
 * names differently:
 *   use constant PI => 3.14;                  — the FIRST entry is the only
 *   use constant COLORS => 'a', 'b', 'c';       name; the rest are its value.
 *   use constant { A => 1, B => 2 };          — alternating key/value pairs.
 */
function constantNames(node: SyntaxNode, source: string): { name: string; node: SyntaxNode }[] {
  const out: { name: string; node: SyntaxNode }[] = [];
  const nameOf = (n: SyntaxNode): string => {
    // Take a literal's CONTENT node rather than stripping quote characters, so
    // `q(ANSWER)` yields ANSWER instead of the raw `q(ANSWER)` text.
    const content = getChildByField(n, 'content') ?? (n.type === 'string_literal' ? n.namedChild(0) : null);
    return getNodeText(content ?? n, source).replace(/^['"]|['"]$/g, '').trim();
  };
  const isNameNode = (n: SyntaxNode): boolean =>
    n.type === 'autoquoted_bareword' || n.type === 'string_literal' || n.type === 'bareword';
  // Comments are extras that can appear anywhere in the list; counting them
  // shifts every following key/value pair and turns values into "constants".
  const entries = (list: SyntaxNode): SyntaxNode[] => {
    const kept: SyntaxNode[] = [];
    for (let i = 0; i < list.namedChildCount; i++) {
      const child = list.namedChild(i);
      if (child && child.type !== 'comment') kept.push(child);
    }
    return kept;
  };
  const moduleNode = getChildByField(node, 'module');
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (!child || child.id === moduleNode?.id) continue;
    if (child.type === 'anonymous_hash_expression') {
      for (let j = 0; j < child.namedChildCount; j++) {
        const inner = child.namedChild(j);
        if (inner?.type !== 'list_expression') continue;
        const items = entries(inner);
        for (let k = 0; k < items.length; k += 2) {
          if (!isNameNode(items[k])) continue;
          const text = nameOf(items[k]);
          if (text) out.push({ name: text, node: items[k] });
        }
      }
    } else if (child.type === 'list_expression') {
      // Single-declaration form: only the leading entry is a name, however many
      // values follow it.
      const items = entries(child);
      if (items.length && isNameNode(items[0])) {
        const text = nameOf(items[0]);
        if (text) out.push({ name: text, node: items[0] });
      }
    }
  }
  return out;
}

/** True when `node` sits anywhere inside a named or anonymous subroutine body. */
function insideSubroutine(node: SyntaxNode): boolean {
  for (let p = node.parent; p; p = p.parent) {
    if (p.type === 'subroutine_declaration_statement' || p.type === 'anonymous_subroutine_expression') {
      return true;
    }
  }
  return false;
}

/** True when a container directly holds a `package Foo;`/`package Foo { }`. */
function opensPackage(container: SyntaxNode): boolean {
  for (let i = 0; i < container.namedChildCount; i++) {
    if (container.namedChild(i)?.type === 'package_statement') return true;
  }
  return false;
}

/**
 * Walk a statement container, tracking the Perl package in effect.
 *
 * Perl scoping has two properties that generic parent/child containment gets
 * wrong, so the walk is done by hand:
 *
 *  - `package Foo;` (the dominant idiom) scopes every FOLLOWING SIBLING, not
 *    its children — the subs are siblings of the package node, so containment
 *    would attach them to the file and lose the `Foo::bar` qualified name.
 *  - A package name is ALWAYS absolute: `package Inner { }` written inside a
 *    `package Outer;` declares `Inner`, never `Outer::Inner`. At most ONE
 *    package scope is therefore open at a time — a new package always replaces
 *    the current one rather than nesting under it. `pkg` is the single shared
 *    cell holding it, so nested containers stay consistent with their parents.
 *
 * A package opened inside a block ends with that block, and the enclosing
 * package resumes — which is why the entry scope is restored on exit.
 */
function walkPackageScoped(
  container: SyntaxNode,
  ctx: ExtractorContext,
  pkg: { open: string | null },
): void {
  const entryScope = pkg.open;
  const close = (): void => {
    if (pkg.open) {
      ctx.popScope();
      pkg.open = null;
    }
  };
  const openPackage = (name: string, at: SyntaxNode): void => {
    close();
    const ns = ctx.createNode('namespace', name, at);
    if (ns) {
      ctx.pushScope(ns.id);
      pkg.open = ns.id;
    }
  };

  for (let i = 0; i < container.namedChildCount; i++) {
    const child = container.namedChild(i);
    if (!child) continue;
    // A bare block that opens a package (`{ package Inner; ... }`) needs the
    // same package-aware walk; handing it to the generic visitor would let its
    // declarations inherit the enclosing package's name.
    if ((child.type === 'block' || child.type === 'block_statement') && opensPackage(child)) {
      walkPackageScoped(child, ctx, pkg);
      continue;
    }
    if (child.type !== 'package_statement') {
      ctx.visitNode(child);
      continue;
    }
    const name = packageName(child, ctx.source);
    if (!name) continue;
    const block = packageBlock(child);
    if (!block) {
      openPackage(name, child);
      continue;
    }
    const outer = pkg.open;
    openPackage(name, child);
    walkPackageScoped(block, ctx, pkg);
    close();
    if (outer) {
      ctx.pushScope(outer);
      pkg.open = outer;
    }
  }

  // A package opened inside this container does not outlive it.
  if (pkg.open !== entryScope) {
    close();
    if (entryScope) {
      ctx.pushScope(entryScope);
      pkg.open = entryScope;
    }
  }
}

export const perlExtractor: LanguageExtractor = {
  functionTypes: ['subroutine_declaration_statement'],
  classTypes: [],
  methodTypes: [],
  interfaceTypes: [],
  structTypes: [],
  enumTypes: [],
  typeAliasTypes: [],
  importTypes: ['use_statement', 'require_expression'],
  // `coderef_call_expression` ($code->(...)) and the func0op/func1op builtin
  // calls (shift, wantarray, ...) carry no statically resolvable callee, so
  // they're deliberately excluded — a ref to `$code` or `shift` is pure noise.
  callTypes: ['function_call_expression', 'method_call_expression', 'ambiguous_function_call_expression'],
  // Package-level variables are created by the visitNode hook below, which is
  // scope-aware. The generic path is deliberately left empty: a `my $self =
  // shift;` lives in EVERY sub of every Perl file, and indexing each one would
  // multiply the node count for symbols no cross-file query can ever use.
  variableTypes: [],

  nameField: 'name',
  bodyField: 'body',
  paramsField: 'parameters',

  getSignature: (node: SyntaxNode, source: string): string | undefined => {
    if (node.type !== 'subroutine_declaration_statement') return undefined;
    const nameNode = getChildByField(node, 'name');
    if (!nameNode) return undefined;
    const name = getNodeText(nameNode, source);
    // A modern signature/prototype sits between the name and the body.
    const body = getChildByField(node, 'body');
    if (body) {
      const between = source.slice(nameNode.endIndex, body.startIndex).trim();
      if (between.startsWith('(')) return `sub ${name}${between}`;
    }
    return `sub ${name}`;
  },

  // `our` publishes a package global; `my` is lexically file/block private.
  isExported: (node: SyntaxNode, source: string): boolean => {
    if (node.type !== 'variable_declaration') return true;
    return getNodeText(node, source).trimStart().startsWith('our');
  },

  extractImport: (node: SyntaxNode, source: string): ImportInfo | null => {
    if (node.type === 'require_expression') {
      // `require Foo::Bar` (a bareword) is a module load; `require "file.pl"`
      // and `require 5.010` are not module references worth an edge.
      const target = node.namedChild(0);
      if (!target || target.type !== 'bareword') return null;
      const moduleName = getNodeText(target, source).trim();
      if (!moduleName) return null;
      return { moduleName, signature: `require ${moduleName}` };
    }
    const moduleNode = getChildByField(node, 'module');
    if (!moduleNode) return null;
    const moduleName = getNodeText(moduleNode, source).trim();
    if (!moduleName || PRAGMAS.has(moduleName)) return null;
    return { moduleName, signature: getNodeText(node, source).split('\n')[0]!.trim() };
  },

  extractVariables: (node: SyntaxNode, source: string): VariableInfo[] => {
    return declaredVariables(node, source);
  },

  visitNode: (node: SyntaxNode, ctx: ExtractorContext): boolean => {
    // --- Package scoping (see header comment) ---
    if (node.type === 'source_file') {
      walkPackageScoped(node, ctx, { open: null });
      return true;
    }

    // --- Package-level variables ---
    // `our $VERSION` / a file-scope `my %CACHE` are real package symbols another
    // file can reach. A `my $self = shift;` inside a sub is not: it exists in
    // every sub of every Perl file, so indexing lexicals would multiply the node
    // count for symbols no cross-file query can use. Scope decides which is which.
    if (node.type === 'variable_declaration') {
      // Ancestry, not the scope stack: an ANONYMOUS sub (`my $cb = sub { ... }`)
      // creates no graph node, so its body pushes nothing and a nodeStack-only
      // check mistook every closure lexical for a package global.
      if (insideSubroutine(node)) return true;
      const scope = ctx.nodeStack[ctx.nodeStack.length - 1];
      if (scope && (scope.startsWith('function:') || scope.startsWith('method:'))) return true;
      const isPackageGlobal = getNodeText(node, ctx.source).trimStart().startsWith('our');
      for (const v of declaredVariables(node, ctx.source)) {
        ctx.createNode(v.kind, v.name, v.positionNode ?? node, {
          signature: v.signature,
          isExported: isPackageGlobal,
        });
      }
      return true;
    }

    // --- `use` triage (see header comment) ---
    if (node.type === 'use_statement') {
      const moduleNode = getChildByField(node, 'module');
      const moduleName = moduleNode ? getNodeText(moduleNode, ctx.source).trim() : '';

      if (moduleName === 'constant') {
        for (const { name, node: at } of constantNames(node, ctx.source)) {
          ctx.createNode('constant', name, at, { signature: `use constant ${name}` });
        }
        return true;
      }

      if (INHERITANCE_PRAGMAS.has(moduleName)) {
        const from = ctx.nodeStack[ctx.nodeStack.length - 1];
        if (from) {
          for (const parent of usedNames(node, ctx.source)) {
            ctx.addUnresolvedReference({
              fromNodeId: from,
              referenceName: parent,
              referenceKind: 'extends',
              line: node.startPosition.row + 1,
              column: node.startPosition.column,
            });
          }
        }
        return true;
      }

      if (PRAGMAS.has(moduleName)) return true;
    }

    return false;
  },
};
