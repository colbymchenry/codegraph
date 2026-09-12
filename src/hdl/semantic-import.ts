import * as path from 'node:path';

export interface HdlMacroPoint { file: string; line: number; column: number; byteOffset: number }
export interface HdlMacroFrame { name: string | null; argument: boolean; spelling?: HdlMacroPoint; invocation?: { start: HdlMacroPoint; end: HdlMacroPoint } }

export type HdlExpressionRole = 'initializer' | 'declared-initializer' | 'type';
export interface HdlExpressionOrigin {
  role: HdlExpressionRole;
  sourceOrigin: 'macro';
  source?: { file: string; line: number; column: number | null };
  macroExpansion: HdlMacroFrame[];
  macroExpansionComplete: boolean;
}
export interface HdlExpressionCoverage {
  initializer: 'checked' | 'not-applicable' | 'unavailable' | 'command-line';
  declaredInitializer: 'checked' | 'not-applicable' | 'unavailable';
  type: 'checked' | 'not-applicable' | 'unavailable';
  truncated: boolean;
}

export interface HdlSemanticFact {
  kind: 'parameter' | 'port' | 'type';
  name: string;
  instancePath: string;
  value?: string;
  type?: string;
  width?: number;
  direction?: string;
  source?: { file: string; line: number; column: number | null };
  sourceOrigin?: 'direct' | 'macro';
  macroExpansion?: HdlMacroFrame[];
  macroExpansionComplete?: boolean;
  expressionOrigins?: HdlExpressionOrigin[];
  expressionOriginCoverage?: HdlExpressionCoverage;
}

type AstObject = Record<string, unknown>;
const object = (value: unknown): value is AstObject => typeof value === 'object' && value !== null && !Array.isArray(value);
function fail(message: string): never { throw new Error(`Invalid or unsupported slang AST: ${message}`); }
const MAX_DEPTH = 128;
const MAX_NODES = 1_000_000;
const MAX_FACTS = 100_000;
const MAX_TEXT = 64 * 1024 * 1024;
const INTEGER_WIDTHS = new Map<string, number>(Object.entries({ bit: 1, logic: 1, reg: 1, byte: 8, shortint: 16, int: 32, integer: 32, longint: 64, time: 64 }));

/** Import facts from successful frontend output; the caller must check compiler
 * exit/diagnostics first (slang can emit JSON even when compilation failed).
 * Addresses are temporary reference keys only, never public identities. */
export function importSlangSemantics(ast: unknown, sourceRoot: string): HdlSemanticFact[] {
  if (!object(ast) || !object(ast.design) || ast.design.kind !== 'Root' || !Array.isArray(ast.design.members)) fail('expected design Root with members');
  const design = ast.design as AstObject;
  const root = path.resolve(sourceRoot);
  const catalog = new Map<string, AstObject>();
  const active = new Set<object>();
  const seen = new Set<object>();
  const pending: Array<{ value: unknown; depth: number; exit?: boolean }> = [{ value: ast, depth: 0 }];
  let nodeCount = 0, textSize = 0;
  while (pending.length) {
    const { value, depth, exit } = pending.pop()!;
    if (exit) { active.delete(value as object); continue; }
    if (++nodeCount > MAX_NODES || depth > MAX_DEPTH) fail('input size/depth limit exceeded');
    if (typeof value === 'string') { textSize += value.length; if (textSize > MAX_TEXT) fail('input text limit exceeded'); }
    if (!object(value) && !Array.isArray(value)) continue;
    if (active.has(value)) fail('cyclic input object');
    if (seen.has(value)) continue;
    seen.add(value); active.add(value);
    pending.push({ value, depth, exit: true });
    if (object(value) && value.addr !== undefined) {
      const addr = typeof value.addr === 'number' && Number.isSafeInteger(value.addr) && value.addr >= 0
        ? String(value.addr) : typeof value.addr === 'string' && /^\d+$/.test(value.addr) ? value.addr : fail('malformed address');
      const existing = catalog.get(addr);
      if (existing && (existing.kind !== value.kind || existing.name !== value.name)) fail('conflicting address definitions');
      if (!existing || Object.keys(value).length > Object.keys(existing).length) catalog.set(addr, value);
    }
    const values = Array.isArray(value) ? value : Object.values(value);
    if (values.length > MAX_NODES - nodeCount - pending.length) fail('input node limit exceeded');
    for (let i = values.length - 1; i >= 0; i--) pending.push({ value: values[i], depth: depth + 1 });
  }
  const resolve = (value: unknown): AstObject => {
    if (object(value)) return value;
    if (typeof value === 'string') {
      const match = /^(\d+)\s/.exec(value);
      if (match && catalog.has(match[1]!)) return catalog.get(match[1]!)!;
    }
    return fail('unresolved symbol/body reference');
  };
  const members = (scope: AstObject): unknown[] => {
    if (scope.members === undefined) return [];
    if (!Array.isArray(scope.members)) return fail('members must be an array');
    return scope.members;
  };
  const nameOf = (node: AstObject): string => {
    if (typeof node.name !== 'string' || !node.name || node.name.length > 4096) return fail('missing or oversized symbol name');
    return node.name;
  };
  const segment = (name: string): string => /^[A-Za-z_][A-Za-z0-9_$]*$/.test(name) ? name : `\\${name} `;
  const join = (parent: string, name: string): string => parent ? `${parent}.${segment(name)}` : segment(name);
  const range = (value: unknown): [number, number] => {
    const match = typeof value === 'string' && /^\[\s*(-?\d+)\s*:\s*(-?\d+)\s*\]$/.exec(value);
    if (!match) return fail('expected a constant numeric range');
    const left = Number(match[1]), right = Number(match[2]);
    if (!Number.isSafeInteger(left) || !Number.isSafeInteger(right) || !Number.isSafeInteger(Math.abs(left - right) + 1)) return fail('range exceeds exact numeric bounds');
    return [left, right];
  };
  const stripAddresses = (text: string): string | undefined => {
    let unknown = false;
    const cleaned = text.replace(/\b(\d+)\s+(?=[A-Za-z_$\\])/g, (match, addr: string) => {
      if (catalog.has(addr)) return '';
      unknown = true; return match;
    });
    return unknown ? undefined : cleaned;
  };
  const typeInfo = (value: unknown, ancestors = new Set<AstObject>()): { type?: string; width?: number } => {
    if (typeof value === 'string') {
      const ref = /^(\d+)\s/.exec(value);
      if (ref) {
        const target = catalog.get(ref[1]!);
        if (!target) return {};
        return { ...typeInfo(target, ancestors), type: stripAddresses(value) };
      }
      // Composite pretty-printed strings do not prove packed vs unpacked shape.
      const base = value.replace(/\s+(signed|unsigned)$/, '');
      return { type: stripAddresses(value), ...(INTEGER_WIDTHS.has(base) ? { width: INTEGER_WIDTHS.get(base)! } : {}) };
    }
    if (!object(value)) return {};
    if (ancestors.size >= MAX_DEPTH || ancestors.has(value)) return fail('cyclic or overly deep type');
    const next = new Set(ancestors); next.add(value);
    const name = typeof value.name === 'string' && value.name ? stripAddresses(value.name) : undefined;
    if (value.kind === 'TypeAlias') return { ...typeInfo(value.target, next), ...(name ? { type: name } : {}) };
    if (value.kind === 'ScalarType' || value.kind === 'PredefinedIntegerType') {
      const base = name?.replace(/\s+(signed|unsigned)$/, '') ?? '';
      return { type: name, ...(INTEGER_WIDTHS.has(base) ? { width: INTEGER_WIDTHS.get(base)! } : {}) };
    }
    if (value.kind === 'PackedArrayType') {
      const [left, right] = range(value.range);
      const element = typeInfo(value.elementType, next);
      const width = element.width === undefined ? undefined : element.width * (Math.abs(left - right) + 1);
      if (width !== undefined && !Number.isSafeInteger(width)) fail('packed width exceeds exact numeric bounds');
      return { ...(element.type ? { type: `${element.type}[${left}:${right}]` } : {}), ...(width !== undefined ? { width } : {}) };
    }
    return name ? { type: name } : {};
  };
  const sourceOf = (node: AstObject): HdlSemanticFact['source'] => {
    const file = node.source_file;
    if (file === undefined) return undefined;
    if (typeof file !== 'string') return fail('invalid source filename');
    if (!file || file.startsWith('<') || (!path.isAbsolute(file) && path.win32.isAbsolute(file))) return undefined;
    const full = path.resolve(root, file.replace(/\\/g, '/'));
    const relative = path.relative(root, full);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return undefined;
    const line = node.source_line, column = node.source_column;
    if (!Number.isSafeInteger(line) || (line as number) < 0 || (column !== undefined && (!Number.isSafeInteger(column) || (column as number) < 0))) return fail('invalid source coordinates');
    if (line === 0) return undefined;
    return { file: relative.split(path.sep).join('/'), line: line as number, column: column === undefined || column === 0 ? null : column as number };
  };
  const indexValue = (value: unknown): string => {
    if (typeof value !== 'string' || !/^-?\d+$/.test(value) || !Number.isSafeInteger(Number(value))) return fail('generate index is not a known decimal integer');
    return String(Number(value));
  };

  const facts: HdlSemanticFact[] = [];
  const keys = new Set<string>();
  let visits = 0, factText = 0;
  const visit = (node: AstObject, scopePath: string, ancestry: Set<AstObject>, depth: number): void => {
    if (++visits > MAX_FACTS || depth > MAX_DEPTH || scopePath.length > 16384) fail('reachable hierarchy size/depth limit exceeded');
    if (ancestry.has(node)) fail('cyclic instance hierarchy');
    const chain = new Set(ancestry); chain.add(node);
    if (node.kind === 'Parameter' || node.kind === 'Port') {
      const name = nameOf(node);
      const fact: HdlSemanticFact = { kind: node.kind === 'Parameter' ? 'parameter' : 'port', name, instancePath: scopePath, ...typeInfo(node.type) };
      if (node.kind === 'Parameter' && ['string', 'number', 'boolean'].includes(typeof node.value)) fact.value = String(node.value);
      if (node.kind === 'Port' && typeof node.direction === 'string') fact.direction = node.direction;
      const source = sourceOf(node); if (source) fact.source = source;
      const key = JSON.stringify([fact.kind, scopePath, name]);
      if (keys.has(key)) fail('duplicate fact identity');
      keys.add(key); factText += JSON.stringify(fact).length;
      if (facts.length >= MAX_FACTS || factText > MAX_TEXT) fail('fact output size limit exceeded');
      facts.push(fact); return;
    }
    if (node.kind === 'Instance') {
      const body = resolve(node.body);
      if (body.kind !== 'InstanceBody') fail('instance body has wrong kind');
      visit(body, scopePath, chain, depth + 1); return;
    }
    if (node.kind === 'GenerateBlock' && node.isUninstantiated === true) return;
    if (node.kind === 'GenerateBlockArray') {
      // Slang's loopVariable can refer to an evaluator-only symbol absent
      // from the serialized catalog. Its explicit name still identifies the
      // matching implicit local Parameter in every materialized iteration.
      const variableName = object(node.loopVariable) ? nameOf(node.loopVariable)
        : typeof node.loopVariable === 'string' ? /^\d+ (.+)$/.exec(node.loopVariable)?.[1] : undefined;
      if (!variableName) fail('missing generate loop variable name');
      const indices = new Set<string>();
      for (const entry of members(node)) {
        const block = resolve(entry);
        if (block.kind === 'Genvar') continue;
        if (block.kind !== 'GenerateBlock') fail('invalid generate array member');
        if (block.isUninstantiated === true) continue;
        const parameters = members(block).map(resolve).filter(n => n.kind === 'Parameter' && n.name === variableName);
        if (parameters.length !== 1) fail('missing or ambiguous generate index parameter');
        const index = indexValue(parameters[0]!.value);
        if (indices.has(index)) fail('duplicate generate index');
        indices.add(index); visit(block, `${scopePath}[${index}]`, chain, depth + 1);
      }
      return;
    }
    if (node.kind === 'InstanceArray') {
      const [left, right] = range(node.range);
      const entries = members(node);
      if (entries.length !== Math.abs(left - right) + 1) fail('instance array length disagrees with range');
      // Slang serializes elements in ascending numeric index order, including
      // descending declarations; verified with distinct per-index defparams.
      for (let i = 0; i < entries.length; i++) {
        const child = resolve(entries[i]);
        if (!['Instance', 'InstanceArray'].includes(String(child.kind))) fail('invalid instance array member');
        visit(child, `${scopePath}[${Math.min(left, right) + i}]`, chain, depth + 1);
      }
      return;
    }
    if (!['InstanceBody', 'GenerateBlock', 'Root'].includes(String(node.kind))) return;
    for (const entry of members(node)) {
      const child = resolve(entry);
      if (['Instance', 'InstanceArray', 'GenerateBlockArray', 'GenerateBlock'].includes(String(child.kind))) {
        if (child.kind === 'GenerateBlock' && child.isUninstantiated === true) continue;
        visit(child, join(scopePath, nameOf(child)), chain, depth + 1);
      } else if (child.kind === 'Parameter' || child.kind === 'Port') visit(child, scopePath, chain, depth + 1);
    }
  };
  for (const entry of members(design)) {
    const node = resolve(entry);
    if (node.kind === 'Instance' || node.kind === 'InstanceArray') visit(node, segment(nameOf(node)), new Set(), 0);
  }
  return facts;
}
