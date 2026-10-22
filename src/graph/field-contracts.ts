import { createHash } from 'node:crypto';
import type { Language, Node } from '../types';
import { attributesBefore, visitSyntax, withSourceTree, type SyntaxNode } from './source-syntax';

export interface FieldContract {
  nodeId: string;
  ownerId: string;
  owner: string;
  fieldName: string;
  externalName: string;
  fieldType: string | null;
  direction: 'serialize' | 'deserialize';
  filePath: string;
  language: Language;
  line: number;
  column: number;
  declaration: string;
}

export const FIELD_CONTRACT_LANGUAGES: Language[] = ['rust', 'go'];
const OWNER_KINDS = new Set(['class', 'struct', 'interface']);

function renamed(name: string, rule: string | null): string | null {
  if (!rule) return name;
  const pascal = () => name.split('_').map(word => word ? word[0]!.toUpperCase() + word.slice(1) : '').join('');
  switch (rule) {
    case 'lowercase': return name.toLowerCase();
    case 'UPPERCASE': return name.toUpperCase();
    case 'snake_case': return name;
    case 'SCREAMING_SNAKE_CASE': return name.toUpperCase();
    case 'kebab-case': return name.replaceAll('_', '-');
    case 'SCREAMING-KEBAB-CASE': return name.toUpperCase().replaceAll('_', '-');
    case 'PascalCase': return pascal();
    case 'camelCase': { const value = pascal(); return value[0]!.toLowerCase() + value.slice(1); }
    default: return null;
  }
}

function serdeOption(attributes: string, key: string, direction: FieldContract['direction']): string | null {
  const serde = attributes.match(/#\s*\[\s*serde\s*\([\s\S]*?\)\s*\]/g)?.join('\n') ?? '';
  const specific = new RegExp(`\\b${key}\\s*\\(\\s*(?:[^)]*?\\b)?${direction}\\s*=\\s*"([^"\\\\]*)"`).exec(serde);
  return specific?.[1] ?? new RegExp(`\\b${key}\\s*=\\s*"([^"\\\\]*)"`).exec(serde)?.[1] ?? null;
}

function ownerFor(field: SyntaxNode, nodes: readonly Node[]): Node | undefined {
  const line = field.startPosition.row + 1;
  let declaration = field.parent;
  while (declaration && !['struct_item', 'type_spec', 'class_definition', 'class_declaration', 'interface_declaration', 'record_declaration'].includes(declaration.type)) declaration = declaration.parent;
  const name = declaration?.childForFieldName('name')?.text;
  return nodes.filter(node => OWNER_KINDS.has(node.kind) && (!name || node.name === name)
    && node.startLine <= line && node.endLine >= line)
    .sort((a, b) => a.endLine - a.startLine - (b.endLine - b.startLine))[0];
}

/** Extract only explicit serialization contracts, including fields under serde rename_all. */
export function extractFieldContracts(filePath: string, source: string, language: Language, nodes: readonly Node[]): {
  contracts: FieldContract[]; nodes: Node[];
} | null {
  return withSourceTree(source, language, root => {
    const contracts: FieldContract[] = [];
    const added: Node[] = [];
    visitSyntax(root, field => {
      if (!FIELD_CONTRACT_LANGUAGES.includes(language) || field.type !== 'field_declaration') return;
      const owner = ownerFor(field, nodes);
      if (!owner) return;
      const attrs = language === 'rust' ? attributesBefore(field) : field.text;
      const names = field.childrenForFieldName('name');
      const type = field.childForFieldName('type')?.text ?? null;
      for (const name of names) {
        const external: Array<{ name: string; direction: FieldContract['direction'] }> = [];
        if (language === 'rust') {
          let structure = field.parent;
          while (structure && structure.type !== 'struct_item') structure = structure.parent;
          const container = structure ? attributesBefore(structure) : '';
          if (!/serde\s*\(/.test(attrs + container)) continue;
          const serdeAttrs = attrs.match(/#\s*\[\s*serde\s*\([\s\S]*?\)\s*\]/g)?.join('\n') ?? '';
          const skipped = (direction: FieldContract['direction']) => new RegExp(`(?:\\(|,)\\s*(?:skip|skip_${direction === 'serialize' ? 'serializing' : 'deserializing'})\\s*(?:,|\\))`).test(serdeAttrs);
          for (const direction of ['serialize', 'deserialize'] as const) {
            if (skipped(direction)) continue;
            const value = serdeOption(attrs, 'rename', direction)
              ?? renamed(name.text, serdeOption(container, 'rename_all', direction));
            if (value !== null) external.push({ name: value, direction });
          }
          if (!skipped('deserialize')) for (const alias of serdeAttrs.matchAll(/\balias\s*=\s*"([^"\\]*)"/g)) external.push({ name: alias[1]!, direction: 'deserialize' });
        } else if (language === 'go') {
          if (!/^\p{Lu}/u.test(name.text)) continue;
          const tag = field.childForFieldName('tag')?.text ?? '';
          const json = /\bjson:"([^"\\]*)"/.exec(tag)?.[1]?.split(',')[0];
          if (json === undefined || json === '-') continue;
          external.push({ name: json || name.text, direction: 'serialize' }, { name: json || name.text, direction: 'deserialize' });
        }
        if (!external.length) continue;
        const line = name.startPosition.row + 1;
        let node = nodes.find(node => ['field', 'property', 'variable'].includes(node.kind)
          && node.name === name.text && node.startLine <= line && node.endLine >= line
          && node.startLine >= owner.startLine && node.endLine <= owner.endLine);
        if (!node) {
          const qualifiedName = `${owner.qualifiedName}::${name.text}`;
          node = {
            id: `contract-field:${createHash('sha256').update(`${filePath}\0${qualifiedName}`).digest('hex').slice(0, 24)}`,
            kind: 'field', name: name.text, qualifiedName, language, filePath,
            startLine: field.startPosition.row + 1, endLine: field.endPosition.row + 1,
            startColumn: field.startPosition.column, endColumn: field.endPosition.column,
            signature: `${name.text}: ${type ?? 'unknown'}`, updatedAt: Date.now(),
          };
          added.push(node);
        }
        for (const alias of external) contracts.push({
          nodeId: node.id, ownerId: owner.id, owner: owner.qualifiedName,
          fieldName: name.text, externalName: alias.name, fieldType: type,
          direction: alias.direction, filePath, language, line, column: name.startPosition.column,
          declaration: attrs || field.text,
        });
      }
    });
    return { contracts, nodes: added };
  });
}
