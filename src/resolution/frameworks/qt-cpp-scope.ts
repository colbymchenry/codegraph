/**
 * Lexical helpers shared by the Qt framework resolver and the signal-channel
 * synthesizer. Every function here works on source that has already been run
 * through `maskCppNonCode`, so comments and literals cannot fake a brace,
 * a class header, or a `using namespace`.
 */

export interface QtCppScope {
  offset: number;
  namespaceName: string;
  className: string | null;
}

export function normalizeQtOwner(owner: string): string {
  return owner.replace(/\s*::\s*/g, '::');
}

export function qualifyQtType(type: string, namespaceName: string): string {
  const normalized = normalizeQtOwner(type);
  return namespaceName && !normalized.includes('::') ? `${namespaceName}::${normalized}` : normalized;
}

/** Scope table: the namespace and class in force from each token's end offset. */
export function getQtCppScopes(source: string): QtCppScope[] {
  const scopes: QtCppScope[] = [{ offset: 0, namespaceName: '', className: null }];
  const stack: Array<{ namespaceName: string; className: string | null }> = [];
  const tokens = /\b(?:inline\s+)?namespace\s+((?:[A-Za-z_]\w*\s*::\s*)*[A-Za-z_]\w*)\s*\{|\b(?:class|struct)\s+(?:[A-Z][A-Z0-9_]+\s+)?([A-Za-z_]\w*)\s*(?:final\s*)?(?::\s*[^;{}]+)?\{|[{}]/g;
  let namespaceName = '';
  let className: string | null = null;
  let match: RegExpExecArray | null;
  while ((match = tokens.exec(source)) !== null) {
    if (match[0] === '}') {
      const parent = stack.pop();
      namespaceName = parent?.namespaceName ?? '';
      className = parent?.className ?? null;
    } else {
      stack.push({ namespaceName, className });
      if (match[1]) {
        namespaceName = [namespaceName, normalizeQtOwner(match[1])].filter(Boolean).join('::');
      } else if (match[2]) {
        className = [className ?? namespaceName, match[2]].filter(Boolean).join('::');
      }
    }
    scopes.push({ offset: match.index + match[0].length, namespaceName, className });
  }
  return scopes;
}

export function qtScopeAt(scopes: QtCppScope[], offset: number): QtCppScope {
  let lower = 0;
  let upper = scopes.length;
  while (lower + 1 < upper) {
    const middle = Math.floor((lower + upper) / 2);
    if (scopes[middle]!.offset <= offset) lower = middle;
    else upper = middle;
  }
  return scopes[lower]!;
}

/** `using namespace a::b;` directives anywhere in the file. */
export function collectQtUsingNamespaces(source: string): string[] {
  const usings: string[] = [];
  const directive = /\busing\s+namespace\s+((?:[A-Za-z_]\w*\s*::\s*)*[A-Za-z_]\w*)\s*;/g;
  let match: RegExpExecArray | null;
  while ((match = directive.exec(source)) !== null) usings.push(normalizeQtOwner(match[1]!));
  return usings;
}

/** `a::b::C` → `['a::b', 'a']`: the scopes an unqualified name could be looked up in. */
export function qtParentScopes(owner: string): string[] {
  const parents: string[] = [];
  for (let end = owner.lastIndexOf('::'); end > 0; end = owner.lastIndexOf('::', end - 1)) {
    parents.push(owner.slice(0, end));
  }
  return parents;
}

/**
 * Lookup levels for an unqualified type written in `namespaceName`, innermost
 * first — the order C++ name lookup itself uses — then the parents of the class
 * an out-of-line member is defined on. The last level is the global scope
 * together with every `using namespace` directive: they are visible at the
 * same depth, so a name found in two of them is ambiguous, not "first wins".
 * `''` is the global scope.
 */
export function qtOwnerPrefixes(
  namespaceName: string,
  functionOwner: string | null,
  usings: readonly string[],
): string[][] {
  const levels: string[][] = [];
  for (let ns = namespaceName; ns; ns = ns.includes('::') ? ns.slice(0, ns.lastIndexOf('::')) : '') levels.push([ns]);
  if (functionOwner) for (const parent of qtParentScopes(functionOwner)) levels.push([parent]);
  levels.push(['', ...new Set(usings)]);
  return levels;
}

// ---------------------------------------------------------------------------
// Function bodies
// ---------------------------------------------------------------------------

export interface QtFunctionBody {
  /** Offset of the `{` that opens the body. */
  open: number;
  /** Offset of the matching `}`, or `Infinity` when the file ends first. */
  close: number;
  /** Offset where the function header (`Owner::name(args) const`) begins. */
  headerStart: number;
}

const CONTROL_HEADER = /^(?:else\s+)?(?:if|for|while|switch|catch|foreach|Q_FOREACH)\b/;
const FUNCTION_HEADER = /\([^;{}]*\)\s*(?:(?:const|noexcept|override|final)\s*)*$/;

/**
 * Every `{ … }` whose header looks like a function (or lambda) signature, found
 * in one pass. A `connect()` call needs its enclosing function's parameters and
 * locals to know what type a receiver variable has; walking back from the call
 * for every match made a file with many connects quadratic.
 */
export function buildQtFunctionIndex(source: string): QtFunctionBody[] {
  const bodies: QtFunctionBody[] = [];
  const open: Array<QtFunctionBody | null> = [];
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (char === '{') {
      const delimiter = Math.max(
        source.lastIndexOf(';', index - 1),
        source.lastIndexOf('}', index - 1),
        source.lastIndexOf('{', index - 1),
      );
      const headerStart = delimiter + 1;
      const header = source.slice(headerStart, index).trim();
      if (FUNCTION_HEADER.test(header) && !CONTROL_HEADER.test(header)) {
        const body: QtFunctionBody = { open: index, close: Infinity, headerStart };
        bodies.push(body);
        open.push(body);
      } else {
        open.push(null);
      }
    } else if (char === '}') {
      const body = open.pop();
      if (body) body.close = index;
    }
  }
  return bodies;
}

/**
 * The outermost function body that contains `offset`. A lambda inside a
 * function still sees that function's parameters and locals, so the outer
 * header is the one whose declarations matter.
 */
export function qtEnclosingFunction(bodies: readonly QtFunctionBody[], offset: number): QtFunctionBody | null {
  for (const body of bodies) {
    if (body.open >= offset) break;
    if (offset < body.close) return body;
  }
  return null;
}

/** Source from the enclosing function's header down to `offset`: its parameters and locals so far. */
export function qtEnclosingFunctionPrefix(
  bodies: readonly QtFunctionBody[],
  source: string,
  offset: number,
): string | null {
  const body = qtEnclosingFunction(bodies, offset);
  return body ? source.slice(body.headerStart, offset) : null;
}

/** `Owner::name(` at the head of a function header → `Owner`; null for a free function. */
export function qtFunctionHeaderOwner(header: string): string | null {
  const paren = header.indexOf('(');
  if (paren < 0) return null;
  const match = header.slice(0, paren).match(/((?:[A-Za-z_]\w*\s*::\s*)+)~?[A-Za-z_]\w*\s*$/);
  return match ? normalizeQtOwner(match[1]!).replace(/::$/, '') : null;
}
