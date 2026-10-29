/**
 * A Ruby constant written with its namespace — `Billing::ChargeCard`, or from
 * the top level, `::Foo` and `::Billing::ChargeCard` — is the class, module
 * or constant Ruby's lookup finds from where it is written (#2503): the
 * nearest namespace around the reference that declares it, then the top
 * level; one written from the top level is looked up there only. The
 * extractor records such a call receiver as a `references` ref beside the
 * call, as it does a bare one (`ChargeCard.call`), and the call itself as
 * `Billing::ChargeCard.call`: a method of that class or module, its own or
 * one its ancestry declares.
 *
 * Both resolve here alone. A path the project doesn't declare is a library's
 * (`ActiveRecord::Base.transaction`), where the strategies past this one
 * would take a project class or method sharing its last name; and a class
 * the path names without the method (`Billing::ChargeCard.where`) has it from
 * somewhere the index can't see, never from another class that declares one.
 * Production code never names a class a test declares. A bare constant
 * (`ChargeCard`) is left to the name strategies, as before.
 *
 * A call on what `.new` made (`ChargeCard.new(card).charge!`, recorded as
 * `new ChargeCard().charge!`) resolves here too, bare constant or path: an
 * instance method of the class the lookup finds, or nothing (#684).
 */
import type { Node } from '../types';
import type { ResolutionContext, ResolvedRef, UnresolvedRef } from './types';
import { isTestPath } from '../search/query-utils';
import { rubyAncestry, rubyMethodsOfKindFirst, type RubyMethodKind } from './name-matcher';

/** `A::B`, `::A`, `::A::B`: a constant path. Group 1 is a leading `::`. */
const CONSTANT_PATH = /^(::)?([A-Z]\w*(?:::[A-Z]\w*)*)$/;
/** `A::B.m`, `::A.m`: a call on one. Group 3 is the method. */
const CONSTANT_PATH_CALL = /^(::)?([A-Z]\w*(?:::[A-Z]\w*)*)\.([A-Za-z_]\w*[?!=]?)$/;
/**
 * `new Foo().m`, `new A::B().m!`: a call on what `Foo.new(…)` or `A::B.new`
 * made, as the extractor records it (#684). Group 3 is the method.
 */
const CONSTRUCTED_CALL = /^new (::)?([A-Z]\w*(?:::[A-Z]\w*)*)\(\)\.([A-Za-z_]\w*[?!=]?)$/;

/** What a Ruby constant is in the index: a class, a module, or a value (`RATES = {…}` is a `variable`). */
const NAMESPACE_KINDS: ReadonlySet<string> = new Set(['class', 'module']);
const VALUE_KINDS: ReadonlySet<string> = new Set(['variable', 'constant']);
const CONSTANT_KINDS: ReadonlySet<string> = new Set([...NAMESPACE_KINDS, ...VALUE_KINDS]);

/**
 * What a Ruby `references` ref written as a constant path names, or the
 * method a call on one reaches (see the file comment). Undefined for any
 * other ref, which the other strategies resolve; null when the project
 * declares no such constant, or the class or module it names has no method
 * of the name.
 */
export function matchRubyConstantPathRef(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null | undefined {
  if (ref.language !== 'ruby') return undefined;
  if (ref.referenceKind === 'references') {
    const m = CONSTANT_PATH.exec(ref.referenceName);
    if (!m || !isNamespaced(m)) return undefined;
    const target = constantsNamed(m[2]!, m[1] !== undefined, ref, context)[0];
    return target ? { original: ref, targetNodeId: target.id, confidence: 0.9, resolvedBy: 'qualified-name' } : null;
  }
  if (ref.referenceKind === 'calls') {
    // A call on an instance `Foo.new(…)` made, bare or namespaced: an instance
    // method of the class Ruby's lookup finds for `Foo` there, its own or one
    // its ancestry declares — never a namesake's by the method name alone. A
    // class the project doesn't declare (rack-protection's `Request.new(env)`
    // is rack's) has no method here.
    const made = CONSTRUCTED_CALL.exec(ref.referenceName);
    if (made) {
      const cls = constantsNamed(made[2]!, made[1] !== undefined, ref, context)[0];
      const method = cls?.kind === 'class' ? methodOf(cls.qualifiedName, made[3]!, ref, context, 'instance') : null;
      return method ? { original: ref, targetNodeId: method.node.id, confidence: method.own ? 0.9 : 0.85, resolvedBy: 'instance-method' } : null;
    }
    const m = CONSTANT_PATH_CALL.exec(ref.referenceName);
    if (!m || !isNamespaced(m)) return undefined;
    const owner = constantsNamed(m[2]!, m[1] !== undefined, ref, context)[0];
    const method = owner && NAMESPACE_KINDS.has(owner.kind) ? methodOf(owner.qualifiedName, m[3]!, ref, context) : null;
    return method ? { original: ref, targetNodeId: method.node.id, confidence: method.own ? 0.85 : 0.8, resolvedBy: 'qualified-name' } : null;
  }
  return undefined;
}

/** Whether a matched path is written with a `::`, which a bare `Foo` is not. */
function isNamespaced(m: RegExpExecArray): boolean {
  return m[1] !== undefined || m[2]!.includes('::');
}

/**
 * The declarations of the constant `path` names where `ref` is written: those
 * of the first of `<scope>::<path>`, `<outer scope>::<path>`, … `<path>` the
 * project declares, the scope being the class or module around the
 * reference — only `<path>` itself when it is written from the top level.
 * A class or module comes before a value of the name, then the reference's
 * own file, then production code.
 */
function constantsNamed(path: string, absolute: boolean, ref: UnresolvedRef, context: ResolutionContext): Node[] {
  const production = !isTestPath(ref.filePath);
  let prefix = absolute ? '' : lexicalScope(ref, context);
  for (;;) {
    const qn = prefix ? `${prefix}::${path}` : path;
    const found = context.getNodesByQualifiedName(qn).filter((n) =>
      n.language === 'ruby' && CONSTANT_KINDS.has(n.kind) && !(production && isTestPath(n.filePath)));
    if (found.length > 0) return ordered(found, ref);
    if (!prefix) return [];
    const cut = prefix.lastIndexOf('::');
    prefix = cut >= 0 ? prefix.slice(0, cut) : '';
  }
}

/** The qualified name of the innermost class or module around `ref`, or '' at the top level of its file. */
function lexicalScope(ref: UnresolvedRef, context: ResolutionContext): string {
  let inner: Node | undefined;
  for (const n of context.getNodesInFile(ref.filePath)) {
    if (!NAMESPACE_KINDS.has(n.kind) || n.language !== 'ruby' || n.startLine > ref.line || n.endLine < ref.line) continue;
    // Of the ranges around a point, the innermost starts last.
    if (!inner || n.startLine > inner.startLine || (n.startLine === inner.startLine && n.startColumn > inner.startColumn)) inner = n;
  }
  return inner?.qualifiedName ?? '';
}

/**
 * The method `name` of the class or module `owner`: its own, else the first
 * of its superclasses and mixed-in modules that declares one (rubyAncestry).
 * Of a class's `def self.m` and `def m`, which share one qualified name, a
 * call on the class reaches the class method, and a call on an instance
 * (`kind` 'instance') the instance method. Production code never reaches one
 * a test declares.
 */
function methodOf(
  owner: string,
  name: string,
  ref: UnresolvedRef,
  context: ResolutionContext,
  kind: RubyMethodKind = 'class',
): { node: Node; own: boolean } | null {
  const production = !isTestPath(ref.filePath);
  for (const qn of rubyAncestry(owner, context)) {
    const methods = context.getNodesByQualifiedName(`${qn}::${name}`).filter((n) =>
      n.kind === 'method' && n.language === 'ruby' && !(production && isTestPath(n.filePath)));
    if (methods.length > 0) return { node: rubyMethodsOfKindFirst(ordered(methods, ref), kind)[0]!, own: qn === owner };
  }
  return null;
}

/** Anything before a value, then the reference's own file, then production code; the index's order within each. */
function ordered(nodes: Node[], ref: UnresolvedRef): Node[] {
  const rank = (n: Node): number =>
    (VALUE_KINDS.has(n.kind) ? 4 : 0) + (n.filePath === ref.filePath ? 0 : 2) + (isTestPath(n.filePath) ? 1 : 0);
  return nodes.length < 2 ? nodes : [...nodes].sort((a, b) => rank(a) - rank(b));
}
