import type { Node as SyntaxNode } from 'web-tree-sitter';
import { getNodeText, getChildByField } from '../tree-sitter-helpers';
import type { LanguageExtractor } from '../tree-sitter-types';

/**
 * Fortran extractor (modern free-form F90/2003/2008+, with legacy fixed-form
 * extensions mapped in grammars.ts). Grammar: tree-sitter-fortran (ABI 15).
 *
 * Fortran's AST is irregular relative to the declarative LanguageExtractor
 * model, so every program-unit / type construct is handled in `visitNode`:
 *   - a definition node (`module`, `program`, `subroutine`, `function`,
 *     `derived_type_definition`) carries no `name` field — the name lives on a
 *     nested header *_statement child;
 *   - definition nodes have no `body` field, and the wrapper node IS its own
 *     body, so the generic functionTypes path would re-extract itself forever.
 * Handling them in the hook lets us create the right node kind, scope children
 * underneath, recurse cleanly into CONTAINS-block procedures, and skip
 * local-variable noise. `use` statements and call sites still use the
 * declarative import/call paths.
 */

// Declarator node types that appear in the `declarator` position of a
// variable_declaration (`integer :: a, b(10), c => null()`).
const DECLARATOR_TYPES = new Set([
  'identifier',
  'init_declarator',
  'sized_declarator',
  'data_declarator',
  'pointer_init_declarator',
  'coarray_declarator',
]);

// Header / terminator statements that should not be walked as body content.
const NON_BODY_STATEMENTS = new Set([
  'subroutine_statement',
  'function_statement',
  'module_statement',
  'submodule_statement',
  'program_statement',
  'derived_type_statement',
  'end_subroutine_statement',
  'end_function_statement',
  'end_module_statement',
  'end_submodule_statement',
  'end_program_statement',
  'end_type_statement',
]);

/** Read the symbol name from a header *_statement node. */
function readStatementName(stmt: SyntaxNode | null, source: string): string | undefined {
  if (!stmt) return undefined;
  // subroutine_statement / function_statement expose `name` as a field…
  const field = getChildByField(stmt, 'name');
  if (field) return getNodeText(field, source);
  // …module/program/interface statements carry it as a child of type `name`.
  const child = stmt.namedChildren.find((c: SyntaxNode) => c.type === 'name');
  return child ? getNodeText(child, source) : undefined;
}

/** Find the header statement child of a program-unit node. */
function headerStatement(node: SyntaxNode, type: string): SyntaxNode | null {
  return node.namedChildren.find((c: SyntaxNode) => c.type === type) ?? null;
}

/** Resolve the declared name of a single declarator node. */
function declaratorName(decl: SyntaxNode, source: string): string | undefined {
  if (decl.type === 'identifier') return getNodeText(decl, source);
  const left = getChildByField(decl, 'left'); // init_declarator `x = ...`
  if (left) return declaratorName(left, source);
  const id = decl.namedChildren.find((c: SyntaxNode) => c.type === 'identifier');
  return id ? getNodeText(id, source) : undefined;
}

/** All names declared by a variable_declaration (handles `integer :: a, b`). */
function declaredNames(varDecl: SyntaxNode, source: string): string[] {
  return varDecl.namedChildren
    .filter((c: SyntaxNode) => DECLARATOR_TYPES.has(c.type))
    .map((c: SyntaxNode) => declaratorName(c, source))
    .filter((n): n is string => !!n);
}

/** True when a variable_declaration carries the PARAMETER attribute (a constant). */
function isParameterDecl(varDecl: SyntaxNode, source: string): boolean {
  return varDecl.namedChildren.some(
    (c: SyntaxNode) =>
      c.type === 'type_qualifier' &&
      getNodeText(c, source).trim().toLowerCase() === 'parameter'
  );
}

/** True when a procedure_statement carries the given attribute (DEFERRED, PASS…). */
function hasProcAttribute(stmt: SyntaxNode, source: string, attr: string): boolean {
  return stmt.namedChildren.some(
    (c: SyntaxNode) =>
      c.type === 'procedure_attribute' &&
      getNodeText(c, source).trim().toUpperCase() === attr
  );
}


export const fortranExtractor: LanguageExtractor = {
  // All structural extraction happens in visitNode; the declarative type lists
  // stay empty so the core never re-dispatches a Fortran definition node.
  functionTypes: [],
  classTypes: [],
  methodTypes: [],
  interfaceTypes: [],
  structTypes: [],
  enumTypes: [],
  typeAliasTypes: [],
  importTypes: ['use_statement'],
  callTypes: ['subroutine_call', 'call_expression'],
  variableTypes: ['variable_declaration'],

  nameField: 'name',
  bodyField: 'body',
  paramsField: 'parameters',

  // `use module_name [, only: ...]` → an import node + an `imports` edge.
  extractImport: (node, source) => {
    const moduleName = node.namedChildren.find((c: SyntaxNode) => c.type === 'module_name');
    if (!moduleName) return null;
    return {
      moduleName: getNodeText(moduleName, source).trim(),
      signature: getNodeText(node, source).replace(/\s+/g, ' ').trim(),
    };
  },

  visitNode: (node, ctx) => {
    const source = ctx.source;

    // --- Program units: module, submodule, program → module-kind container ---
    if (node.type === 'module' || node.type === 'submodule' || node.type === 'program') {
      const name = readStatementName(headerStatement(node, `${node.type}_statement`), source);
      const created = name ? ctx.createNode('module', name, node) : null;
      if (created) ctx.pushScope(created.id);
      for (const child of node.namedChildren) {
        if (child.type === 'variable_declaration') {
          // Module/program-level constants & variables.
          const kind = isParameterDecl(child, source) ? 'constant' : 'variable';
          for (const vname of declaredNames(child, source)) ctx.createNode(kind, vname, child);
        } else if (!NON_BODY_STATEMENTS.has(child.type)) {
          ctx.visitNode(child); // procedures (CONTAINS), derived types, interfaces, use
        }
      }
      if (created) ctx.popScope();
      return true;
    }

    // --- Subroutines & functions → function-kind symbols ---
    if (node.type === 'subroutine' || node.type === 'function') {
      const stmt = headerStatement(node, `${node.type}_statement`);
      const name = readStatementName(stmt, source);
      const signature = stmt ? getNodeText(stmt, source).replace(/\s+/g, ' ').trim() : undefined;
      const created = name ? ctx.createNode('function', name, node, { signature }) : null;
      if (created) ctx.pushScope(created.id);
      for (const child of node.namedChildren) {
        // Skip local variable declarations (noise) and the header/end lines;
        // walk statements (for calls) and internal_procedures (nested defs).
        if (child.type === 'variable_declaration' || NON_BODY_STATEMENTS.has(child.type)) continue;
        ctx.visitNode(child);
      }
      if (created) ctx.popScope();
      return true;
    }

    // --- Derived types (F90+): TYPE :: name ... END TYPE → struct ---
    if (node.type === 'derived_type_definition') {
      const stmt = headerStatement(node, 'derived_type_statement');
      const typeName = stmt?.namedChildren.find((c: SyntaxNode) => c.type === 'type_name');
      const name = typeName ? getNodeText(typeName, source) : undefined;
      const created = name ? ctx.createNode('struct', name, node) : null;
      if (!created) return true;
      // `type, extends(parent) :: name` → extends edge to the parent type.
      const base = stmt ? getChildByField(stmt, 'base') : null;
      const baseId = base?.namedChildren.find((c: SyntaxNode) => c.type === 'identifier');
      if (baseId) {
        ctx.addUnresolvedReference({
          fromNodeId: created.id,
          referenceName: getNodeText(baseId, source),
          referenceKind: 'extends',
          line: baseId.startPosition.row + 1,
          column: baseId.startPosition.column,
        });
      }
      ctx.pushScope(created.id);
      for (const child of node.namedChildren) {
        if (child.type === 'variable_declaration') {
          for (const fname of declaredNames(child, source)) ctx.createNode('field', fname, child);
        } else if (child.type === 'derived_type_procedures') {
          // Type-bound procedures: `PROCEDURE, PASS :: Integrate => CpgIntegrate`
          // becomes a method node — auto-scoped under the struct, so it gets a
          // contains edge and a `module::type_t::Integrate` qualifiedName,
          // which is exactly what the resolver's receiver-typed method match
          // consumes for `CALL obj%Integrate()` sites — plus a calls ref from
          // the method to its implementation subroutine so flow traversal
          // continues into the impl. DEFERRED bindings get the method node
          // only; dispatch to overrides is bridged by the fortran-override
          // synthesizer along extends edges.
          for (const stmt of child.namedChildren) {
            if (stmt.type === 'procedure_statement') {
              const deferred = hasProcAttribute(stmt, source, 'DEFERRED');
              for (const d of stmt.namedChildren) {
                if (d.type === 'binding') {
                  // `Integrate => CpgIntegrate`: binding_name is the callable
                  // name, method_name the implementation.
                  const bn = d.namedChildren.find((c: SyntaxNode) => c.type === 'binding_name');
                  const impl = d.namedChildren.find((c: SyntaxNode) => c.type === 'method_name');
                  const bname = bn ? getNodeText(bn, source) : undefined;
                  if (!bname) continue;
                  const m = ctx.createNode('method', bname, stmt);
                  if (m && impl && !deferred) {
                    ctx.addUnresolvedReference({
                      fromNodeId: m.id,
                      referenceName: getNodeText(impl, source),
                      referenceKind: 'calls',
                      line: d.startPosition.row + 1,
                      column: d.startPosition.column,
                    });
                  }
                } else if (d.type === 'method_name') {
                  // Bare binding `PROCEDURE :: GetName`: implementation
                  // shares the binding name.
                  const bname = getNodeText(d, source);
                  const m = ctx.createNode('method', bname, stmt);
                  if (m && !deferred) {
                    ctx.addUnresolvedReference({
                      fromNodeId: m.id,
                      referenceName: bname,
                      referenceKind: 'calls',
                      line: d.startPosition.row + 1,
                      column: d.startPosition.column,
                    });
                  }
                }
              }
            } else if (stmt.type === 'generic_statement') {
              // `GENERIC :: Run => Integrate, IntegrateEx` — a dispatch alias.
              // operator(+)/assignment(=) generics carry no plain identifier
              // and are skipped.
              const bl = stmt.namedChildren.find((c: SyntaxNode) => c.type === 'binding_list');
              if (!bl) continue;
              const bn = bl.namedChildren.find((c: SyntaxNode) => c.type === 'binding_name');
              const gname = bn ? getNodeText(bn, source) : undefined;
              if (!gname || !/^[A-Za-z_]\w*$/.test(gname)) continue;
              const m = ctx.createNode('method', gname, stmt);
              if (m) {
                for (const spec of bl.namedChildren.filter((c: SyntaxNode) => c.type === 'method_name')) {
                  ctx.addUnresolvedReference({
                    fromNodeId: m.id,
                    referenceName: getNodeText(spec, source),
                    referenceKind: 'calls',
                    line: spec.startPosition.row + 1,
                    column: spec.startPosition.column,
                  });
                }
              }
            }
            // final_statement (destructors) intentionally skipped — not
            // callable as obj%name().
          }
        } else if (!NON_BODY_STATEMENTS.has(child.type)) {
          ctx.visitNode(child);
        }
      }
      ctx.popScope();
      return true;
    }

    // --- Interface blocks. Only named (generic/operator) interfaces become
    // nodes; anonymous explicit-interface blocks are signature-only noise. ---
    if (node.type === 'interface') {
      const name = readStatementName(headerStatement(node, 'interface_statement'), source);
      if (name) ctx.createNode('interface', name, node);
      return true; // do not descend into declaration signatures
    }

    return false;
  },
};
