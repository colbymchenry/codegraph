import type { Node as SyntaxNode } from 'web-tree-sitter';
import type { ExtractorContext } from '../tree-sitter-types';

export const VERILOG_CALL_ARGUMENT_PREFIX = 'hdl:call-arg:';
export interface VerilogCallArgument {
  callee: string;
  callableId: string;
  scope: string;
  argument: number | string;
  slots: Array<{ key: number | string; omitted: boolean }>;
  role: 'value' | 'index';
  writeTarget: boolean;
  referenceTarget: boolean;
}

function assignable(node: SyntaxNode, allowConcat = true): boolean {
  if (node.type === 'expression') return node.namedChildCount === 1 && !!node.firstNamedChild && assignable(node.firstNamedChild, allowConcat);
  if (node.type === 'primary') {
    const first = node.firstNamedChild;
    return !!first && assignable(first, allowConcat) && node.namedChildren.slice(1).every(n => n.type === 'select'
      && !n.namedChildren.some(c => ['simple_identifier', 'escaped_identifier'].includes(c.type)));
  }
  if (node.type === 'hierarchical_identifier') return node.namedChildCount === 1
    && ['simple_identifier', 'escaped_identifier'].includes(node.firstNamedChild?.type ?? '');
  if (node.type === 'concatenation') return allowConcat && node.namedChildren.length > 0 && node.namedChildren.every(n => assignable(n, allowConcat));
  return false;
}

/** Annotate an already discovered local signal occurrence; never emit a second edge. */
export function getVerilogCallArgumentCandidates(id: SyntaxNode, ctx: ExtractorContext): string[] {
  let argument: SyntaxNode = id;
  let role: VerilogCallArgument['role'] = 'value';
  while (argument.parent && argument.parent.type !== 'list_of_arguments') {
    argument = argument.parent;
    if (['select', 'constant_select', 'bit_select', 'constant_bit_select', 'part_select_range'].includes(argument.type)) role = 'index';
    if (['function_declaration', 'task_declaration', 'module_declaration'].includes(argument.type)) return [];
  }
  const list = argument.parent;
  if (!list || list.hasError || argument.type !== 'expression') return [];
  const call = list.parent?.type === 'method_call_body' ? list.parent.parent : list.parent;
  if (!call || call.hasError) return [];
  let callee: string | undefined;
  if (call.type === 'tf_call') callee = call.namedChildren.find(n => n.type === 'hierarchical_identifier')?.text.trim();
  if (call.type === 'method_call') {
    const receiver = call.namedChildren.find(n => n.type === 'primary');
    const name = list.parent?.childForFieldName('name');
    if (receiver && name && /^\s*::\s*$/.test(ctx.source.slice(receiver.endIndex, name.startIndex))) callee = `${receiver.text.trim()}::${name.text.trim()}`;
  }
  if (!callee) return [];
  const segments: SyntaxNode[][] = [[]];
  for (const child of list.children) {
    if (child.type === ',') segments.push([]);
    else if (!['comment', 'block_comment', 'one_line_comment'].includes(child.type)) segments[segments.length - 1]!.push(child);
  }
  const slots: VerilogCallArgument['slots'] = [];
  let selected: number | string | undefined;
  let namedSeen = false;
  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index]!;
    const named = segment[0]?.type === '.';
    const expression = segment.find(n => n.type === 'expression');
    let key: number | string = index;
    if (named) {
      namedSeen = true;
      const name = segment.find(n => ['simple_identifier', 'escaped_identifier'].includes(n.type));
      if (!name) return [];
      key = name.text.trim();
    } else if (namedSeen) return []; // A positional actual cannot follow named ones.
    slots.push({ key, omitted: !expression });
    if (expression?.id === argument.id) selected = key;
  }
  if (selected === undefined) return [];
  const lexical = ctx.nodes.find(n => n.id === ctx.nodeStack[ctx.nodeStack.length - 1]);
  const owner = [...ctx.nodeStack].reverse().map(nodeId => ctx.nodes.find(n => n.id === nodeId))
    .find(n => n?.kind === 'function' || n?.kind === 'method') ?? lexical;
  if (!owner || !lexical) return [];
  const metadata: VerilogCallArgument = { callee, callableId: owner.id, scope: lexical.qualifiedName,
    argument: selected, slots, role, writeTarget: assignable(argument), referenceTarget: assignable(argument, false) };
  return [`${VERILOG_CALL_ARGUMENT_PREFIX}${JSON.stringify(metadata)}`];
}
