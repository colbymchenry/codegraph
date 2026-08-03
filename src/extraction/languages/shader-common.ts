import type { Node as SyntaxNode } from 'web-tree-sitter';
import type { Language } from '../../types';
import type { ExtractorContext } from '../tree-sitter-types';
import { getChildByField, getNodeText } from '../tree-sitter-helpers';

const SHADER_STAGES: Record<string, string> = {
  '.vert': 'vertex',
  '.frag': 'fragment',
  '.comp': 'compute',
  '.geom': 'geometry',
  '.tesc': 'tess-control',
  '.tese': 'tess-evaluation',
  '.rgen': 'ray-generation',
  '.rmiss': 'ray-miss',
  '.rchit': 'closest-hit',
  '.rahit': 'any-hit',
  '.rint': 'intersection',
  '.rcall': 'callable',
  '.mesh': 'mesh',
  '.task': 'task',
};

const BUILTIN_CALLS = new Set([
  'abs', 'acos', 'all', 'any', 'asfloat', 'asint', 'asuint', 'atan', 'atan2',
  'barrier', 'bitCount', 'ceil', 'clamp', 'cos', 'cross', 'ddx', 'ddy',
  'determinant', 'discard', 'distance', 'dot', 'dFdx', 'dFdy', 'exp', 'exp2',
  'faceforward', 'floor', 'fma', 'frac', 'fract', 'frexp', 'fwidth', 'InterlockedAdd',
  'InterlockedAnd', 'InterlockedCompareExchange', 'InterlockedExchange', 'InterlockedMax',
  'InterlockedMin', 'InterlockedOr', 'InterlockedXor', 'isinf', 'isnan', 'ldexp',
  'length', 'lerp', 'lit', 'log', 'log2', 'mad', 'max', 'min', 'mix', 'mod',
  'modf', 'mul', 'normalize', 'pow', 'printf', 'reflect', 'refract', 'round',
  'rsqrt', 'saturate', 'sign', 'sin', 'sincos', 'smoothstep', 'sqrt', 'step',
  'tan', 'texelFetch', 'texture', 'textureGrad', 'textureLod', 'textureSize',
  'transpose', 'trunc', 'WaveActiveAllTrue', 'WaveActiveAnyTrue', 'WaveActiveBallot',
  'WaveActiveCountBits', 'WaveActiveMax', 'WaveActiveMin', 'WaveActiveProduct',
  'WaveActiveSum', 'WaveGetLaneCount', 'WaveGetLaneIndex', 'WaveReadLaneAt',
  'WaveReadLaneFirst', 'GroupMemoryBarrier', 'GroupMemoryBarrierWithGroupSync',
  'DeviceMemoryBarrier', 'DeviceMemoryBarrierWithGroupSync', 'AllMemoryBarrier',
  'AllMemoryBarrierWithGroupSync', 'Sample', 'SampleBias', 'SampleCmp', 'SampleCmpLevelZero',
  'SampleGrad', 'SampleLevel', 'Gather', 'GatherRed', 'GatherGreen', 'GatherBlue',
  'GatherAlpha', 'Load', 'Store', 'GetDimensions', 'CalculateLevelOfDetail',
  'traceRayEXT', 'executeCallableEXT', 'rayQueryInitializeEXT', 'rayQueryProceedEXT',
]);

export function shaderStageForPath(filePath: string): string | undefined {
  const lower = filePath.toLowerCase();
  for (const [ext, stage] of Object.entries(SHADER_STAGES)) {
    if (lower.endsWith(ext)) return stage;
  }
  const hlslStage = lower.match(/\.([a-z]{2,4})\.hlsl$/)?.[1];
  if (!hlslStage) return undefined;
  return ({ vs: 'vertex', ps: 'fragment', fs: 'fragment', cs: 'compute', gs: 'geometry',
    hs: 'tess-control', ds: 'tess-evaluation', ms: 'mesh', as: 'task',
    rgen: 'ray-generation', rmiss: 'ray-miss', rchit: 'closest-hit',
    rahit: 'any-hit', rint: 'intersection', rcall: 'callable' } as Record<string, string>)[hlslStage];
}

function normalizeToken(value: string): string {
  return value.trim().replace(/\s+/g, '');
}

let cachedConditionSource = '';
let cachedConditions: string[][] = [];
let cachedFunctionSource = '';
let cachedFunctionNames = new Set<string>();

function buildConditionCache(source: string): string[][] {
  if (source === cachedConditionSource) return cachedConditions;
  const lines = source.split(/\r?\n/);
  const result: string[][] = Array.from({ length: lines.length + 1 }, () => []);
  const stack: Array<{ alternatives: string[]; active: string }> = [];
  for (let index = 0; index < lines.length; index++) {
    result[index + 1] = stack.map((frame) => `pp:${frame.active}`);
    const line = lines[index]!;
    let match = line.match(/^\s*#\s*if\s+(.+)$/);
    if (match) {
      const condition = normalizeToken(match[1]!);
      stack.push({ alternatives: [condition], active: condition });
      continue;
    }
    match = line.match(/^\s*#\s*ifdef\s+([A-Za-z_]\w*)/);
    if (match) {
      const condition = `defined(${match[1]})`;
      stack.push({ alternatives: [condition], active: condition });
      continue;
    }
    match = line.match(/^\s*#\s*ifndef\s+([A-Za-z_]\w*)/);
    if (match) {
      const condition = `!defined(${match[1]})`;
      stack.push({ alternatives: [condition], active: condition });
      continue;
    }
    match = line.match(/^\s*#\s*elif\s+(.+)$/);
    if (match && stack.length > 0) {
      const frame = stack[stack.length - 1]!;
      const condition = normalizeToken(match[1]!);
      frame.active = `!(${frame.alternatives.join('||')})&&(${condition})`;
      frame.alternatives.push(condition);
      continue;
    }
    if (/^\s*#\s*else\b/.test(line) && stack.length > 0) {
      const frame = stack[stack.length - 1]!;
      frame.active = `!(${frame.alternatives.join('||')})`;
      continue;
    }
    if (/^\s*#\s*endif\b/.test(line)) stack.pop();
  }
  cachedConditionSource = source;
  cachedConditions = result;
  return result;
}

function conditionDecorators(node: SyntaxNode, source: string): string[] {
  return buildConditionCache(source)[node.startPosition.row + 1] ?? [];
}

export function shaderDecorators(
  node: SyntaxNode,
  source: string,
  filePath: string,
  language: Extract<Language, 'glsl' | 'hlsl'>,
  extraText = '',
): string[] | undefined {
  const text = `${extraText}\n${getNodeText(node, source)}`;
  const out = new Set<string>(conditionDecorators(node, source));
  const stage = shaderStageForPath(filePath);
  if (stage) out.add(`shader:${stage}`);

  for (const match of text.matchAll(/layout\s*\(([^)]*)\)/g)) {
    for (const raw of match[1]!.split(',')) {
      const part = raw.trim();
      if (!part) continue;
      const kv = part.match(/^([A-Za-z_]\w*)\s*=\s*([^,]+)$/);
      if (kv) out.add(`${kv[1]}:${normalizeToken(kv[2]!)}`);
      else out.add(`layout:${normalizeToken(part)}`);
    }
  }

  for (const match of text.matchAll(/register\s*\(\s*([tsub]\d+)\s*(?:,\s*space(\d+))?\s*\)/gi)) {
    out.add(`register:${match[1]!.toLowerCase()}`);
    if (match[2]) out.add(`space:${match[2]}`);
  }
  for (const match of text.matchAll(/vk::binding\s*\(\s*(\d+)\s*,\s*(\d+)\s*\)/g)) {
    out.add(`binding:${match[1]}`);
    out.add(`set:${match[2]}`);
  }
  for (const match of text.matchAll(/vk::constant_id\s*\(\s*(\d+)\s*\)/g)) out.add(`constant_id:${match[1]}`);
  for (const match of text.matchAll(/vk::([A-Za-z_]\w*)\s*(?:\(([^)]*)\))?/g)) {
    out.add(`vk:${match[1]}${match[2] ? ':' + normalizeToken(match[2]) : ''}`);
  }
  if (language === 'hlsl') {
    for (const match of text.matchAll(/:\s*([A-Za-z_]\w*)\b/g)) {
      if (!/^(?:register|packoffset)$/i.test(match[1]!)) out.add(`semantic:${match[1]}`);
    }
    for (const match of text.matchAll(/(?<!\[)\[\s*([A-Za-z_]\w*)\s*(?:\(([^\]]*)\))?\s*\](?!\])/g)) {
      out.add(`attribute:${match[1]!.toLowerCase()}${match[2] ? ':' + normalizeToken(match[2]) : ''}`);
    }
  }

  const threads = text.match(/numthreads\s*\(([^)]*)\)/);
  if (threads) {
    out.add('shader:compute');
    out.add(`numthreads:${normalizeToken(threads[1]!)}`);
  }
  const shaderAttr = text.match(/shader\s*\(\s*"([^"]+)"\s*\)/);
  if (shaderAttr) out.add(`shader:${shaderAttr[1]!.toLowerCase()}`);

  const declarationLike = node.type !== 'function_definition' &&
    node.type !== 'function_declaration' &&
    node.type !== 'function_declarator';
  if (declarationLike) {
    if (/\bpush_constant\b|vk::push_constant/.test(text)) out.add('push_constant');
    if (/\bconstant_id\b/.test(text) && ![...out].some((d) => d.startsWith('constant_id:'))) out.add('specialization_constant');
    if (/\buniform\b/.test(text)) out.add('storage:uniform');
    if (/\bbuffer\b/.test(text)) out.add('storage:buffer');
    if (/\b(groupshared|shared)\b/.test(text)) out.add('storage:shared');
    if (/\bin\b/.test(text)) out.add('interface:in');
    if (/\bout\b/.test(text)) out.add('interface:out');
    if (/\b(rayPayload|rayPayloadEXT)\b/.test(text)) out.add('resource:ray-payload');
    if (/\b(hitAttribute|hitAttributeEXT)\b/.test(text)) out.add('resource:hit-attribute');
    if (/\b(callableData|callableDataEXT)\b/.test(text)) out.add('resource:callable-data');
    if (/\b(accelerationStructureEXT|RaytracingAccelerationStructure)\b/.test(text)) out.add('resource:acceleration-structure');
    if (/\bRW(?:Texture|Buffer)|\bimage\w*\b/.test(text)) out.add('resource:storage');
    else if (/\bTexture\w*\b|\btexture\w*\b/.test(text)) out.add('resource:texture');
    if (/\bSampler\w*\b|\bsampler\w*\b/.test(text)) out.add('resource:sampler');
    if (/\b(?:StructuredBuffer|ByteAddressBuffer|buffer_reference)\b/.test(text)) out.add('resource:buffer');
    if (language === 'hlsl' && /\bcbuffer\b/.test(text)) out.add('resource:constant-buffer');
    if (language === 'hlsl' && /\btbuffer\b/.test(text)) out.add('resource:texture-buffer');
  }

  return out.size > 0 ? [...out] : undefined;
}

export function shaderFunctionName(node: SyntaxNode, source: string): string | undefined {
  const declarator = getChildByField(node, 'declarator') || node.namedChildren.find((c) => c.type === 'function_declarator');
  const name = declarator ? getChildByField(declarator, 'name') || getChildByField(declarator, 'declarator') : getChildByField(node, 'name');
  if (name) return getNodeText(name, source).replace(/\s*\(.*/, '').trim();
  const id = declarator?.descendantsOfType('identifier')[0] || node.descendantsOfType('identifier')[0];
  return id ? getNodeText(id, source) : undefined;
}

function unwrapDeclarator(node: SyntaxNode | null): SyntaxNode | null {
  let current = node;
  for (let i = 0; current && i < 10; i++) {
    if (current.type === 'identifier' || current.type === 'field_identifier') return current;
    current = getChildByField(current, 'name') || getChildByField(current, 'declarator') || current.namedChild(0);
  }
  return null;
}

export function shaderDeclarationNames(node: SyntaxNode, source: string): Array<{ name: string; node: SyntaxNode }> {
  const out: Array<{ name: string; node: SyntaxNode }> = [];
  const seen = new Set<string>();
  const add = (candidate: SyntaxNode | null): void => {
    const id = unwrapDeclarator(candidate);
    if (!id) return;
    const name = getNodeText(id, source).trim();
    if (!name || seen.has(name)) return;
    seen.add(name);
    out.push({ name, node: id });
  };

  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (!child) continue;
    const field = node.fieldNameForNamedChild(i);
    if (field === 'declarator' && child.type !== 'semantics') add(child);
  }
  for (const decl of node.descendantsOfType(['declarator', 'field_declarator'])) add(getChildByField(decl, 'name') || decl);
  return out;
}

export function shaderSignature(node: SyntaxNode, source: string, max = 400): string {
  return getNodeText(node, source).trim().replace(/\s+/g, ' ').slice(0, max);
}

export function shaderImport(node: SyntaxNode, source: string): { moduleName: string; signature: string } | null {
  const text = getNodeText(node, source).trim();
  const match = text.match(/^#\s*(?:include|import)\s*[<"]([^>"]+)[>"]/m);
  return match ? { moduleName: match[1]!, signature: text } : null;
}

export function shaderMacroName(node: SyntaxNode, source: string): string | undefined {
  const name = getChildByField(node, 'name') || node.namedChildren.find((c) => c.type === 'identifier');
  return name ? getNodeText(name, source) : undefined;
}

export function previousShaderPrefix(node: SyntaxNode, source: string): string {
  const previous = node.previousNamedSibling;
  if (!previous) return '';
  const text = getNodeText(previous, source).trim();
  return /^(?:\[\[|[A-Z][A-Z0-9_]*\s*\()/.test(text) ? text : '';
}

export function isShaderBuiltinCall(name: string, node: SyntaxNode): boolean {
  const simple = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : name;
  let root = node;
  while (root.parent) root = root.parent;
  const rootSource = root.text;
  if (rootSource !== cachedFunctionSource) {
    cachedFunctionSource = rootSource;
    cachedFunctionNames = new Set(root.descendantsOfType(['function_definition', 'function_declaration', 'function_declarator'])
      .map((candidate) => shaderFunctionName(candidate, rootSource)).filter((value): value is string => !!value));
  }
  if (cachedFunctionNames.has(simple)) return false;
  const fn = getChildByField(node, 'function') || node.namedChild(0);
  if (fn && (fn.type === 'type_specifier' || fn.type === 'type_identifier' || fn.type === 'primitive_type' || fn.type === 'template_type')) return true;
  if (/^(?:[biud]?vec[234]|d?mat[234](?:x[234])?|bool|int|uint|float|double|half)(?:[1-4](?:x[1-4])?)?$/.test(simple)) return true;
  return BUILTIN_CALLS.has(simple);
}

function isShaderBuiltinName(name: string): boolean {
  return BUILTIN_CALLS.has(name) || /^(?:[biud]?vec[234]|d?mat[234](?:x[234])?|bool|int|uint|float|double|half)(?:[1-4](?:x[1-4])?)?$/.test(name);
}

interface ShaderMacro {
  name: string;
  params: string[] | null;
  body: string;
}

function shaderMacros(source: string): Map<string, ShaderMacro> {
  const macros = new Map<string, ShaderMacro>();
  const lines = source.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    let logical = lines[index]!;
    while (/\\\s*$/.test(logical) && index + 1 < lines.length) {
      logical = logical.replace(/\\\s*$/, '') + '\n' + lines[++index]!;
    }
    const match = logical.match(/^\s*#\s*define\s+([A-Za-z_]\w*)(?:\s*\(([^)]*)\))?\s*([\s\S]*)$/);
    if (!match) continue;
    macros.set(match[1]!, {
      name: match[1]!,
      params: match[2] === undefined ? null : match[2].split(',').map((value) => value.trim()).filter(Boolean),
      body: match[3] ?? '',
    });
  }
  return macros;
}

function invocationAt(text: string, open: number): { args: string[]; end: number } | null {
  let depth = 0;
  for (let index = open; index < text.length; index++) {
    const char = text[index]!;
    if (char === '(') depth++;
    else if (char === ')' && --depth === 0) {
      return { args: splitMacroArgs(text.slice(open, index + 1)), end: index + 1 };
    }
  }
  return null;
}

function expandShaderMacros(text: string, macros: Map<string, ShaderMacro>, depth = 0): string {
  if (depth >= 8) return text;
  let output = text;
  let changed = false;
  for (const macro of macros.values()) {
    if (macro.params) {
      const regex = new RegExp(`\\b${macro.name}\\s*\\(`, 'g');
      let match: RegExpExecArray | null;
      while ((match = regex.exec(output))) {
        const open = output.indexOf('(', match.index);
        const invocation = invocationAt(output, open);
        if (!invocation) break;
        let replacement = macro.body;
        macro.params.forEach((param, index) => {
          replacement = replacement.replace(new RegExp(`\\b${param}\\b`, 'g'), invocation.args[index] ?? '');
        });
        replacement = replacement.replace(/\s*##\s*/g, '');
        output = output.slice(0, match.index) + replacement + output.slice(invocation.end);
        regex.lastIndex = match.index + replacement.length;
        changed = true;
      }
    } else {
      const next = output.replace(new RegExp(`\\b${macro.name}\\b`, 'g'), macro.body);
      if (next !== output) {
        output = next;
        changed = true;
      }
    }
  }
  return changed ? expandShaderMacros(output, macros, depth + 1) : output;
}

function addTextReferences(ownerId: string, text: string, line: number, ctx: ExtractorContext, params: string[] = []): void {
  const ignored = new Set([...params, 'if', 'for', 'while', 'switch', 'return', 'sizeof']);
  const calls = new Set<string>();
  for (const match of text.matchAll(/\b([A-Za-z_]\w*)\s*\(/g)) {
    const name = match[1]!;
    if (ignored.has(name) || isShaderBuiltinName(name)) continue;
    calls.add(name);
    ctx.addUnresolvedReference({ fromNodeId: ownerId, referenceName: name, referenceKind: 'calls',
      filePath: ctx.filePath, language: ctx.nodes.find((node) => node.id === ownerId)?.language ?? 'glsl', line, column: match.index });
  }
  for (const match of text.matchAll(/\b[A-Z][A-Z0-9_]{2,}\b/g)) {
    const name = match[0];
    if (ignored.has(name) || calls.has(name)) continue;
    ctx.addUnresolvedReference({ fromNodeId: ownerId, referenceName: name, referenceKind: 'references',
      filePath: ctx.filePath, language: ctx.nodes.find((node) => node.id === ownerId)?.language ?? 'glsl', line, column: match.index });
  }
}

export function recoverShaderMacroBodyReferences(node: SyntaxNode, createdId: string, ctx: ExtractorContext): void {
  if (node.descendantsOfType(['function_call', 'call_expression', 'macro_invocation']).length > 0) return;
  const text = getNodeText(node, ctx.source);
  const body = text.replace(/^\s*#\s*define\s+[A-Za-z_]\w*(?:\s*\(([^)]*)\))?\s*/, '');
  const params = text.match(/^\s*#\s*define\s+[A-Za-z_]\w*\s*\(([^)]*)\)/)?.[1]
    ?.split(',').map((value) => value.trim()).filter(Boolean) ?? [];
  addTextReferences(createdId, body, node.startPosition.row + 1, ctx, params);
}

export function recoverShaderMacroDeclarations(
  root: SyntaxNode,
  ctx: ExtractorContext,
  language: Extract<Language, 'glsl' | 'hlsl'>,
): void {
  const macros = shaderMacros(ctx.source);
  const lines = ctx.source.split(/\r?\n/);
  for (let row = 0; row < lines.length; row++) {
    const first = lines[row]!.match(/^\s*([A-Z][A-Z0-9_]*)\s*\(/);
    if (!first || !macros.get(first[1]!)?.params || /^NRD_/.test(first[1]!)) continue;
    let invocation = lines[row]!;
    let balance = (invocation.match(/\(/g) || []).length - (invocation.match(/\)/g) || []).length;
    let endRow = row;
    while (balance > 0 && endRow + 1 < lines.length && endRow - row < 16) {
      invocation += '\n' + lines[++endRow]!;
      balance += (lines[endRow]!.match(/\(/g) || []).length - (lines[endRow]!.match(/\)/g) || []).length;
    }
    const expanded = expandShaderMacros(invocation, macros).trim();
    if (!expanded || expanded === invocation.trim()) continue;
    const column = Math.max(0, lines[row]!.search(/\S/));
    const positionNode = root.namedDescendantForPosition({ row, column });
    if (!positionNode) continue;
    let insideFunction = false;
    for (let parent: SyntaxNode | null = positionNode; parent; parent = parent.parent) {
      if (parent.type === 'function_definition') { insideFunction = true; break; }
    }
    if (insideFunction) continue;

    let kind: 'function' | 'struct' | 'type_alias' | 'variable' | 'constant' | null = null;
    let name = '';
    let match = expanded.match(/\b(?:struct|class)\s+([A-Za-z_]\w*)/);
    if (match) { kind = 'struct'; name = match[1]!; }
    if (!kind && (match = expanded.match(/\b(?:cbuffer|tbuffer|uniform|buffer)\s+([A-Za-z_]\w*)\s*\{/))) {
      kind = 'struct'; name = match[1]!;
    }
    if (!kind && (match = expanded.match(/\b([A-Za-z_]\w*)\s*\([^;{}]*\)\s*\{/))) {
      kind = 'function'; name = match[1]!;
    }
    if (!kind && (match = expanded.match(/\btypedef\b[\s\S]*?\b([A-Za-z_]\w*)\s*;/))) {
      kind = 'type_alias'; name = match[1]!;
    }
    if (!kind && (match = expanded.match(/(?:^|[;}])\s*(?:layout\s*\([^)]*\)\s*)?(?:\[\[[^\]]+\]\]\s*)*(?:static\s+|const\s+|uniform\s+|groupshared\s+|in\s+|out\s+)*[A-Za-z_]\w*(?:\s*<[^;{}]+>)?(?:\s*[*&])?\s+([A-Za-z_]\w*)\b[^;{}]*;/))) {
      kind = /\bconst\b/.test(expanded) ? 'constant' : 'variable';
      name = match[1]!;
    }
    if (!kind || !name || ctx.nodes.some((node) => node.kind === kind && node.name === name && node.startLine === row + 1)) continue;
    const created = ctx.createNode(kind, name, positionNode, {
      signature: `${invocation.trim()} => ${expanded.replace(/\s+/g, ' ').slice(0, 300)}`,
      decorators: shaderDecorators(positionNode, ctx.source, ctx.filePath, language, expanded),
    });
    if (created && kind === 'function') addTextReferences(created.id, expanded, row + 1, ctx);
    row = endRow;
  }
}

export function splitMacroArgs(text: string): string[] {
  const open = text.indexOf('(');
  const close = text.lastIndexOf(')');
  if (open < 0 || close <= open) return [];
  const out: string[] = [];
  let depth = 0;
  let start = open + 1;
  for (let i = open + 1; i < close; i++) {
    const ch = text[i]!;
    if (ch === '(' || ch === '<' || ch === '[') depth++;
    else if (ch === ')' || ch === '>' || ch === ']') depth--;
    else if (ch === ',' && depth === 0) {
      out.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  out.push(text.slice(start, close).trim());
  return out;
}
