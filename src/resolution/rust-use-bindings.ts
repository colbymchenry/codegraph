/** Exact named Rust `use` bindings at a source location; globs stay unsupported. */
export interface RustUseBindings {
  /**
   * The path the nearest `use` binds `name` to. 1-based line, 0-based UTF-16
   * column, as in CodeGraph nodes and references. Undefined when nothing imports
   * the name there; null when one scope imports it twice, or an inline module
   * imports it through a relative path the file-based module walk cannot anchor.
   */
  get(name: string, line: number, column: number): string | null | undefined;
  /** Whether a declaration lies within the nearest binding's lexical scope. */
  isInBindingScope(name: string, line: number, column: number, declarationLine: number, declarationColumn: number): boolean;
  /** Only rooted module-level inline declarations, never function/block-local modules. */
  hasInlineModule(path: readonly string[]): boolean;
  /** Simple standalone `let NAME = ...` values, visible after their declaration. */
  isShadowedByLocalValue(name: string, line: number, column: number): boolean;
  /** Source proof for a direct file-module item, excluding inline modules/blocks/macros. */
  isModuleLevelDeclaration(line: number, column: number): boolean;
  /** An item of a module declared inline (`mod imp { … }`), never of a fn, impl or trait body. */
  isInlineModuleDeclaration(line: number, column: number): boolean;
}

interface Scope {
  start: number;
  end: number;
  parent: Scope | null;
  module: boolean;
  inlineModule: boolean;
  modulePath: string[] | null;
  /** Created on first write: most scopes (fn bodies, match arms, struct bodies) bind nothing. */
  bindings?: Map<string, string | null>;
  values?: Map<string, number[]>;
}

/** Keep offsets/newlines while hiding comments, strings, chars; lifetimes remain. */
function maskNonCode(source: string): string {
  const out = source.split('');
  const blank = (from: number, to: number) => {
    for (let j = from; j < to; j++) if (source[j] !== '\n' && source[j] !== '\r') out[j] = ' ';
  };
  for (let i = 0; i < source.length;) {
    const start = i;
    if (source.startsWith('//', i)) {
      const end = source.indexOf('\n', i);
      i = end < 0 ? source.length : end;
    } else if (source.startsWith('/*', i)) {
      i += 2;
      let depth = 1;
      while (i < source.length && depth > 0) {
        if (source.startsWith('/*', i)) { depth++; i += 2; }
        else if (source.startsWith('*/', i)) { depth--; i += 2; }
        else i++;
      }
    } else {
      const raw = (i === 0 || !/[\w#]/.test(source[i - 1]!))
        ? /^(?:br|cr|r)(#*)"/.exec(source.slice(i)) : null;
      if (raw) {
        const close = '"' + raw[1]!;
        const end = source.indexOf(close, i + raw[0].length);
        i = end < 0 ? source.length : end + close.length;
      } else if (source[i] === '"') {
        i++;
        while (i < source.length) {
          if (source[i] === '\\') i += 2;
          else if (source[i++] === '"') break;
        }
      } else {
        // Unlike a lifetime ('a / 'static), a char has one scalar or escape + a closing quote.
        const char = source[i] === "'"
          ? /^'(?:\\(?:u\{[0-9a-fA-F_]+\}|x[0-9a-fA-F]{2}|[^\r\n])|[^'\\\r\n])'/u.exec(source.slice(i)) : null;
        if (char) i += char[0].length;
        else { i++; continue; }
      }
    }
    blank(start, Math.min(i, source.length));
  }
  return out.join('');
}

/** Flatten nested groups: `a::{b::{C, D}, E}` → `a::b::C`, `a::b::D`, `a::E`. */
function expandUse(spec: string): string[] {
  const open = spec.indexOf('{');
  if (open < 0) return [spec.trim()];
  let depth = 0;
  let close = -1;
  for (let i = open; i < spec.length; i++) {
    if (spec[i] === '{') depth++;
    else if (spec[i] === '}' && --depth === 0) { close = i; break; }
  }
  if (close < 0) return [];
  const inner = spec.slice(open + 1, close);
  const parts: string[] = [];
  let start = 0;
  depth = 0;
  for (let i = 0; i <= inner.length; i++) {
    if (inner[i] === '{') depth++;
    else if (inner[i] === '}') depth--;
    if (i === inner.length || (inner[i] === ',' && depth === 0)) {
      const part = inner.slice(start, i).trim();
      if (part) parts.push(part);
      start = i + 1;
    }
  }
  return parts.flatMap(part => expandUse(spec.slice(0, open) + part + spec.slice(close + 1)));
}

function addUse(scope: Scope, spec: string): void {
  for (const item of expandUse(spec)) {
    const alias = /^(.*?)\s+as\s+(r#)?([A-Za-z_]\w*)$/.exec(item.trim());
    const raw = (alias ? alias[1]! : item).trim();
    if (!raw || raw.endsWith('*')) continue;
    const absolute = raw.startsWith('::');
    const segments = raw.split('::').map(s => s.trim().replace(/^r#/, '')).filter(Boolean);
    if (!segments.length || segments.some(s => !/^[A-Za-z_]\w*$/.test(s))) continue;
    // `a::{self}` binds `a`; `a::{self as b}` binds `b`, both to the module `a`.
    if (segments.at(-1) === 'self' && segments.length > 1) segments.pop();
    const name = alias ? alias[3]! : segments.at(-1)!;
    if (name === '_' || name === 'self' || name === 'super' || name === 'crate') continue;
    // The file-based module resolver cannot anchor relative paths inside inline modules.
    const path = scope.inlineModule && !absolute && segments[0] !== 'crate'
      ? null : (absolute ? '::' : '') + segments.join('::');
    const bindings = (scope.bindings ??= new Map());
    const previous = bindings.get(name);
    bindings.set(name, previous !== undefined && previous !== path ? null : path);
  }
}

/** A let's initializer may contain blocks/calls/arrays with their own semicolons. */
function statementEnd(code: string, start: number): number | null {
  let depth = 0;
  for (let i = start; i < code.length; i++) {
    if ('{[('.includes(code[i]!)) depth++;
    else if ('}])'.includes(code[i]!)) {
      if (depth === 0) return null;
      depth--;
    } else if (code[i] === ';' && depth === 0) return i + 1;
  }
  return null;
}

/** Parse once per file/context; this view does not read files or resolve graph nodes. */
export function parseRustUseBindings(content: string): RustUseBindings {
  const code = maskNonCode(content);
  const root: Scope = { start: 0, end: content.length, parent: null, module: true, inlineModule: false, modulePath: [] };
  const scopes = [root];
  const inlineModules = new Set<string>();
  let current = root;
  let boundary = 0;
  const tokens = /r#[A-Za-z_]\w*|[A-Za-z_]\w*|[{};]/g;
  for (let token; (token = tokens.exec(code)) !== null;) {
    const word = token[0];
    const at = token.index;
    // `impl Trait + use<'a>` (precise capturing) is a bound, not an import.
    if (word === 'use' && !code.slice(tokens.lastIndex).trimStart().startsWith('<')) {
      const end = code.indexOf(';', tokens.lastIndex);
      if (end < 0) break;
      addUse(current, code.slice(tokens.lastIndex, end));
      tokens.lastIndex = end + 1; // group braces belong to the use tree, not lexical scopes.
      boundary = end + 1;
    } else if (word === 'let' && !current.module && code.slice(boundary, at).trim() === '') {
      // No `if let` / `while let` / destructuring: those need their own pattern scopes.
      const declaration = /^let\s+(?:ref\s+)?(?:mut\s+)?(?:r#)?([A-Za-z_]\w*)\s*(?::[^=;{}]*)?=(?!=)/.exec(code.slice(at));
      if (declaration && declaration[1] !== '_') {
        const end = statementEnd(code, at + declaration[0].length);
        if (end !== null) {
          const values = (current.values ??= new Map());
          const positions = values.get(declaration[1]!) ?? [];
          positions.push(end);
          values.set(declaration[1]!, positions);
        }
      }
    } else if (word === '{') {
      const moduleName = /\bmod\s+(?:r#)?([A-Za-z_]\w*)\s*$/.exec(code.slice(boundary, at))?.[1];
      const module = moduleName !== undefined;
      const modulePath = module && current.module && current.modulePath !== null
        ? [...current.modulePath, moduleName!] : null;
      current = { start: at + 1, end: content.length, parent: current, module,
        inlineModule: module || current.inlineModule, modulePath };
      scopes.push(current);
      boundary = at + 1;
    } else if (word === '}') {
      // A stray `}` never closes the file's own scope.
      if (current !== root) {
        current.end = at;
        if (current.modulePath?.length) inlineModules.add(current.modulePath.join('::'));
        current = current.parent ?? root;
      }
      boundary = at + 1;
    } else if (word === ';') boundary = at + 1;
  }
  const lines = [0];
  for (let i = 0; i < content.length; i++) if (content[i] === '\n') lines.push(i + 1);
  // Line lengths come from the line starts, so the memoized view does not keep the source alive.
  const length = content.length;
  const offsetAt = (line: number, column: number): number | null => {
    if (!Number.isInteger(line) || line < 1 || line > lines.length || !Number.isInteger(column) || column < 0) return null;
    const start = lines[line - 1]!;
    return column <= (lines[line] ?? length + 1) - 1 - start ? start + column : null;
  };
  const scopeAt = (offset: number): Scope | null => {
    let lo = 0;
    let hi = scopes.length;
    while (lo + 1 < hi) {
      const mid = (lo + hi) >>> 1;
      if (scopes[mid]!.start <= offset) lo = mid;
      else hi = mid;
    }
    let scope: Scope | null = scopes[lo]!;
    while (scope && scope.end <= offset) scope = scope.parent;
    return scope;
  };
  const bindingScope = (name: string, line: number, column: number): Scope | null => {
    const offset = offsetAt(line, column);
    if (offset === null) return null;
    let scope = scopeAt(offset);
    while (scope) {
      if (scope.bindings?.has(name)) return scope;
      if (scope.module) break;
      scope = scope.parent;
    }
    return null;
  };
  return {
    get(name, line, column) {
      return bindingScope(name, line, column)?.bindings?.get(name);
    },
    isInBindingScope(name, line, column, declarationLine, declarationColumn) {
      const scope = bindingScope(name, line, column);
      const declaration = offsetAt(declarationLine, declarationColumn);
      return !!scope && declaration !== null && declaration >= scope.start && declaration < scope.end;
    },
    hasInlineModule(path) {
      return path.length > 0 && inlineModules.has(path.join('::'));
    },
    isShadowedByLocalValue(name, line, column) {
      const binding = bindingScope(name, line, column);
      const offset = offsetAt(line, column);
      if (!binding || offset === null) return false;
      let scope = scopeAt(offset);
      while (scope) {
        if (scope.values?.get(name)?.some(start => start <= offset)) return true;
        if (scope === binding || scope.module) break;
        scope = scope.parent;
      }
      return false;
    },
    isModuleLevelDeclaration(line, column) {
      const offset = offsetAt(line, column);
      return offset !== null && scopeAt(offset) === root;
    },
    isInlineModuleDeclaration(line, column) {
      const offset = offsetAt(line, column);
      const scope = offset === null ? null : scopeAt(offset);
      return !!scope && scope !== root && scope.module;
    },
  };
}
