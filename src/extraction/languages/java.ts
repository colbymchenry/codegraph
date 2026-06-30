import type { Node as SyntaxNode } from 'web-tree-sitter';
import { getNodeText, getChildByField } from '../tree-sitter-helpers';
import type { ExtractorContext, LanguageExtractor } from '../tree-sitter-types';

/**
 * Tree-sitter-java node types for a method's `type` (return) field that can
 * never be a method receiver — there's no class to chain a `.method()` on, so we
 * store no `returnType` for them.
 */
const JAVA_NON_CLASS_RETURN_NODES = new Set([
  'void_type',
  'integral_type', // int, long, short, byte, char
  'floating_point_type', // float, double
  'boolean_type',
]);

/**
 * Normalize a Java type node to the bare class name a chained
 * `foo.getThing().bar()` could be called on (the #645/#608 mechanism):
 * primitives/void/arrays yield undefined (no class to chain on), `List<Foo>`
 * is unwrapped to its base `List`, and a dotted package/outer-class qualifier
 * (`java.util.List`) is stripped to the simple name.
 */
function normalizeJavaType(typeNode: SyntaxNode | null, source: string): string | undefined {
  if (!typeNode) return undefined;
  if (JAVA_NON_CLASS_RETURN_NODES.has(typeNode.type)) return undefined;
  // An array (`Foo[]`) isn't a receiver you call instance methods on.
  if (typeNode.type === 'array_type') return undefined;
  // Strip type arguments (`List<Foo>` → `List`) — the chain resolves on the base.
  const raw = getNodeText(typeNode, source).trim().replace(/<[^>]*>/g, '');
  // Strip a dotted package / outer-class qualifier (`java.util.List` → `List`).
  const last = raw.split('.').pop()?.trim();
  if (!last || !/^[A-Za-z_]\w*$/.test(last)) return undefined;
  return last;
}

/**
 * A Java method's declared return type. Reads the `type` field; constructors
 * (no `type` field) → undefined.
 */
function extractJavaReturnType(node: SyntaxNode, source: string): string | undefined {
  return normalizeJavaType(getChildByField(node, 'type'), source);
}

// ---------------------------------------------------------------------------
// Lombok-generated member synthesis (#912)
// ---------------------------------------------------------------------------
// Lombok generates methods at compile time, so they never appear in the source
// AST and static extraction misses them — `bean.getX()`, `bean.setX()`,
// `Bean.builder()`, and `log.info(...)` calls then resolve to nothing and call
// chains break silently. We synthesize the mechanical, well-documented ones.

/** Lombok logging annotations — all generate a field named `log` by default. */
const LOMBOK_LOG_ANNOTATIONS = new Set([
  'Slf4j', 'Log4j', 'Log4j2', 'Log', 'CommonsLog', 'JBossLog', 'Flogger', 'XSlf4j', 'CustomLog',
]);

/** Simple names of every annotation in a node's `modifiers` child (`@lombok.Getter` → `Getter`). */
function lombokAnnotationNames(node: SyntaxNode): Set<string> {
  const names = new Set<string>();
  const modifiers = node.namedChildren.find((c: SyntaxNode) => c.type === 'modifiers');
  if (!modifiers) return names;
  for (const child of modifiers.namedChildren) {
    if (child.type === 'marker_annotation' || child.type === 'annotation') {
      const nameNode = getChildByField(child, 'name');
      const simple = nameNode ? nameNode.text.trim().split('.').pop() : undefined;
      if (simple) names.add(simple);
    }
  }
  return names;
}

/** Text of a declaration's `modifiers` child (keyword modifiers are anonymous, so match on text). */
function modifierTextOf(node: SyntaxNode): string {
  const modifiers = node.namedChildren.find((c: SyntaxNode) => c.type === 'modifiers');
  return modifiers ? modifiers.text : '';
}

function capitalizeJava(name: string): string {
  return name ? name.charAt(0).toUpperCase() + name.slice(1) : name;
}

/** Lombok getter name: `getX`, or `isX` for a primitive boolean (keeping an existing `isFoo` field name). */
function lombokGetterName(fieldName: string, isBooleanPrimitive: boolean): string {
  if (isBooleanPrimitive) {
    return /^is[A-Z]/.test(fieldName) ? fieldName : 'is' + capitalizeJava(fieldName);
  }
  return 'get' + capitalizeJava(fieldName);
}

/** Lombok setter name: `setX` (a primitive boolean field `isFoo` sets via `setFoo`). */
function lombokSetterName(fieldName: string, isBooleanPrimitive: boolean): string {
  const base = isBooleanPrimitive && /^is[A-Z]/.test(fieldName) ? fieldName.slice(2) : fieldName;
  return 'set' + capitalizeJava(base);
}

/**
 * Synthesize the members Lombok generates at compile time. Covers the common,
 * mechanical annotations:
 *
 *   @Getter / @Setter (class- or field-level)  → getX()/isX(), setX()
 *   @Data                                       → getters + setters (non-final)
 *                                                 + equals/hashCode/toString
 *   @Value                                      → getters + equals/hashCode/toString (immutable, no setters)
 *   @Builder / @SuperBuilder                    → static builder()
 *   @ToString / @EqualsAndHashCode              → those methods
 *   @Slf4j and the other @Log* annotations      → the `log` field
 *
 * Each node is anchored on the field's (or class's) name token — a leaf, so it
 * pulls in no spurious value-reference scope — carries a `lombok` decorator and
 * a docstring naming the generating annotation, so it reads as generated rather
 * than hand-written. Deliberately NOT synthesized: constructors (`new X()`
 * already links to the class via `instantiates`, and overloaded
 * @NoArgs/@AllArgs/@RequiredArgs ctors share a name → would collide on a
 * synthetic node id), the fluent builder setters, and `@Accessors(fluent=true)`
 * naming. A member the source already declares is never overridden.
 */
function synthesizeLombokMembers(classNode: SyntaxNode, ctx: ExtractorContext): void {
  const classAnns = lombokAnnotationNames(classNode);
  const classGetter = classAnns.has('Getter');
  const classSetter = classAnns.has('Setter');
  const isData = classAnns.has('Data');
  const isValue = classAnns.has('Value');
  const hasBuilder = classAnns.has('Builder') || classAnns.has('SuperBuilder');
  const hasToString = isData || isValue || classAnns.has('ToString');
  const hasEquals = isData || isValue || classAnns.has('EqualsAndHashCode');
  const logAnn = [...classAnns].find((a) => LOMBOK_LOG_ANNOTATIONS.has(a));

  const body = getChildByField(classNode, 'body');
  if (!body) return;
  const fields = body.namedChildren.filter((c: SyntaxNode) => c.type === 'field_declaration');

  // Leave immediately when nothing Lombok is present, so a non-Lombok class
  // pays nothing beyond one scan of its direct field declarations (and an
  // annotated class skips even that — this hook runs for every Java class).
  const classHasLombok =
    classGetter || classSetter || isData || isValue || hasBuilder || hasToString || hasEquals || !!logAnn;
  if (!classHasLombok && !fields.some((f: SyntaxNode) => lombokAnnotationNames(f).size > 0)) {
    return;
  }

  // Members already declared directly in this class. Lombok never overrides an
  // explicit member, so we skip a name the source already has. Methods and
  // fields are tracked separately: they're distinct namespaces in Java (a
  // boolean field `isRunning` and its generated getter `isRunning()` coexist),
  // and the node id is keyed by kind so they never actually collide.
  const classId = ctx.nodeStack[ctx.nodeStack.length - 1];
  const classRec = ctx.nodes.find((n) => n.id === classId);
  const classQN = classRec?.qualifiedName;
  const takenMethods = new Set<string>();
  const takenFields = new Set<string>();
  if (classQN) {
    for (const n of ctx.nodes) {
      if (n.filePath === ctx.filePath && n.qualifiedName === `${classQN}::${n.name}`) {
        if (n.kind === 'method' || n.kind === 'function') takenMethods.add(n.name);
        else if (n.kind === 'field' || n.kind === 'variable' || n.kind === 'constant' || n.kind === 'property') {
          takenFields.add(n.name);
        }
      }
    }
  }

  const classNameNode = getChildByField(classNode, 'name') ?? classNode;
  const className = classRec?.name ?? getNodeText(classNameNode, ctx.source).trim();

  const emitMethod = (
    name: string,
    anchor: SyntaxNode,
    signature: string,
    fromAnnotation: string,
    extra: { returnType?: string; isStatic?: boolean } = {}
  ): void => {
    if (!name || takenMethods.has(name)) return;
    takenMethods.add(name);
    ctx.createNode('method', name, anchor, {
      visibility: 'public',
      signature,
      docstring: `Lombok-generated (${fromAnnotation})`,
      decorators: ['lombok'],
      isStatic: extra.isStatic,
      returnType: extra.returnType,
    });
  };

  // Per-field getters/setters.
  for (const fd of fields) {
    const mods = modifierTextOf(fd);
    if (/\bstatic\b/.test(mods)) continue; // Lombok skips static fields.
    const isFinal = /\bfinal\b/.test(mods);
    const fieldAnns = lombokAnnotationNames(fd);
    const fieldGetter = fieldAnns.has('Getter');
    const fieldSetter = fieldAnns.has('Setter');

    const wantGetter = classGetter || isData || isValue || fieldGetter;
    const wantSetter = (classSetter || isData || fieldSetter) && !isFinal;
    if (!wantGetter && !wantSetter) continue;

    const typeNode = getChildByField(fd, 'type');
    const typeText = typeNode ? getNodeText(typeNode, ctx.source).trim() : 'Object';
    const isBooleanPrimitive = typeNode?.type === 'boolean_type';
    const returnType = normalizeJavaType(typeNode, ctx.source);

    for (const vd of fd.namedChildren) {
      if (vd.type !== 'variable_declarator') continue;
      const nameNode = getChildByField(vd, 'name');
      if (!nameNode) continue;
      const fieldName = getNodeText(nameNode, ctx.source).trim();
      if (!fieldName) continue;

      if (wantGetter) {
        const g = lombokGetterName(fieldName, isBooleanPrimitive);
        emitMethod(g, nameNode, `${typeText} ${g}()`,
          fieldGetter ? '@Getter' : isData ? '@Data' : isValue ? '@Value' : '@Getter',
          { returnType });
      }
      if (wantSetter) {
        const s = lombokSetterName(fieldName, isBooleanPrimitive);
        emitMethod(s, nameNode, `void ${s}(${typeText} ${fieldName})`,
          fieldSetter ? '@Setter' : isData ? '@Data' : '@Setter');
      }
    }
  }

  // Class-level synthesized methods.
  if (hasBuilder) {
    emitMethod('builder', classNameNode, `static ${className}.${className}Builder builder()`,
      classAnns.has('SuperBuilder') ? '@SuperBuilder' : '@Builder',
      { isStatic: true, returnType: `${className}Builder` });
  }
  if (hasToString) {
    emitMethod('toString', classNameNode, 'String toString()',
      isData ? '@Data' : isValue ? '@Value' : '@ToString');
  }
  if (hasEquals) {
    const from = isData ? '@Data' : isValue ? '@Value' : '@EqualsAndHashCode';
    emitMethod('equals', classNameNode, 'boolean equals(Object o)', from);
    emitMethod('hashCode', classNameNode, 'int hashCode()', from);
  }

  // Logger field (@Slf4j and friends).
  if (logAnn && !takenFields.has('log')) {
    takenFields.add('log');
    ctx.createNode('field', 'log', classNameNode, {
      visibility: 'private',
      isStatic: true,
      signature: 'Logger log',
      docstring: `Lombok-generated (@${logAnn})`,
      decorators: ['lombok'],
    });
  }
}

export const javaExtractor: LanguageExtractor = {
  functionTypes: [],
  classTypes: ['class_declaration'],
  methodTypes: ['method_declaration', 'constructor_declaration'],
  // `annotation_type_declaration` is `@interface Foo { … }` — an annotation
  // definition. Without it, annotation types (`@SerializedName`, `@GetMapping`,
  // JPA/Spring annotations) aren't nodes, so the `@Foo` usages that DO get
  // extracted can't resolve and the annotation file shows zero dependents.
  interfaceTypes: ['interface_declaration', 'annotation_type_declaration'],
  structTypes: [],
  enumTypes: ['enum_declaration'],
  enumMemberTypes: ['enum_constant'],
  typeAliasTypes: [],
  importTypes: ['import_declaration'],
  callTypes: ['method_invocation'],
  variableTypes: ['local_variable_declaration'],
  fieldTypes: ['field_declaration'],
  nameField: 'name',
  bodyField: 'body',
  paramsField: 'parameters',
  returnField: 'type',
  getReturnType: extractJavaReturnType,
  synthesizeMembers: synthesizeLombokMembers,
  getSignature: (node, source) => {
    const params = getChildByField(node, 'parameters');
    const returnType = getChildByField(node, 'type');
    if (!params) return undefined;
    const paramsText = getNodeText(params, source);
    return returnType ? getNodeText(returnType, source) + ' ' + paramsText : paramsText;
  },
  getVisibility: (node) => {
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child?.type === 'modifiers') {
        const text = child.text;
        if (text.includes('public')) return 'public';
        if (text.includes('private')) return 'private';
        if (text.includes('protected')) return 'protected';
      }
    }
    return undefined;
  },
  isStatic: (node) => {
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child?.type === 'modifiers' && child.text.includes('static')) {
        return true;
      }
    }
    return false;
  },
  // A `static final` field is a Java constant (`MAX_ITEMS`, lookup tables,
  // shared config). Drives `constant` kind so value-reference edges target it;
  // instance / `final`-only / `static`-only fields stay mutable `field`s.
  isConst: (node) => {
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child?.type === 'modifiers') {
        const text = child.text;
        return /\bstatic\b/.test(text) && /\bfinal\b/.test(text);
      }
    }
    return false;
  },
  extractImport: (node, source) => {
    const importText = source.substring(node.startIndex, node.endIndex).trim();
    const scopedId = node.namedChildren.find((c: SyntaxNode) => c.type === 'scoped_identifier');
    if (scopedId) {
      const moduleName = source.substring(scopedId.startIndex, scopedId.endIndex);
      return { moduleName, signature: importText };
    }
    return null;
  },
  packageTypes: ['package_declaration'],
  extractPackage: (node, source) => {
    // package_declaration → scoped_identifier or identifier (single-segment)
    const id = node.namedChildren.find(
      (c: SyntaxNode) => c.type === 'scoped_identifier' || c.type === 'identifier'
    );
    return id ? source.substring(id.startIndex, id.endIndex).trim() : null;
  },
};
