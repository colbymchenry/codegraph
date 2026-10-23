/**
 * Static source guard: every member of LanguageExtractor
 * (src/extraction/tree-sitter-types.ts) is read by the extraction core.
 *
 * A hook the core never calls is a trap. A language author finds it, writes
 * it, and gets nothing back: no error, no warning, no node. That happened with
 * `extractVariables`, declared and documented but never called (#2465).
 *
 * "Read" means a property access through an `extractor` receiver
 * (`this.extractor.x`, `this.extractor?.x`, `this.extractor!.x`,
 * `extractor.x`, `extractor?.x`) or a destructuring of one, anywhere under
 * src/extraction except the type file itself and the per-language extractors
 * in languages/, which define these members rather than read them. The guard
 * fails closed: a member read some other way shows up as unread.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import ts from 'typescript';

const EXTRACTION_DIR = path.join(__dirname, '..', 'src', 'extraction');
const TYPES_FILE = path.join(EXTRACTION_DIR, 'tree-sitter-types.ts');

function parse(file: string): ts.SourceFile {
  return ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
}

function declaredMembers(): string[] {
  const source = parse(TYPES_FILE);
  const iface = source.statements.find(
    (s): s is ts.InterfaceDeclaration => ts.isInterfaceDeclaration(s) && s.name.text === 'LanguageExtractor'
  );
  if (!iface) throw new Error('LanguageExtractor not found in tree-sitter-types.ts');
  return iface.members.flatMap((m) => (m.name && ts.isIdentifier(m.name) ? [m.name.text] : []));
}

function coreFiles(dir = EXTRACTION_DIR): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'languages') out.push(...coreFiles(p));
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts') && p !== TYPES_FILE) {
      out.push(p);
    }
  }
  return out;
}

/** `extractor`, `this.extractor`, either one behind `!` or parentheses. */
function isExtractorReceiver(node: ts.Expression): boolean {
  while (ts.isNonNullExpression(node) || ts.isParenthesizedExpression(node)) node = node.expression;
  if (ts.isIdentifier(node)) return node.text === 'extractor';
  return ts.isPropertyAccessExpression(node) &&
    node.expression.kind === ts.SyntaxKind.ThisKeyword &&
    node.name.text === 'extractor';
}

function membersRead(): Set<string> {
  const read = new Set<string>();
  for (const file of coreFiles()) {
    const visit = (node: ts.Node): void => {
      if (ts.isPropertyAccessExpression(node) && isExtractorReceiver(node.expression)) {
        read.add(node.name.text);
      } else if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name) &&
        node.initializer && isExtractorReceiver(node.initializer)) {
        for (const element of node.name.elements) {
          const key = element.propertyName ?? element.name;
          if (ts.isIdentifier(key)) read.add(key.text);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(parse(file));
  }
  return read;
}

describe('LanguageExtractor hooks (#2465)', () => {
  it('declares only members the extraction core reads', () => {
    const read = membersRead();
    const unread = declaredMembers().filter((name) => !read.has(name));
    expect(unread, 'LanguageExtractor members the extraction core never reads: call each one, or remove it').toEqual([]);
  });

  it('sees the members the core does read', () => {
    // Guards the guard: if the receiver matching broke, every member would
    // look unread, or none would be checked at all.
    const read = membersRead();
    for (const name of ['functionTypes', 'variableTypes', 'extractImport', 'preParse', 'extractBareCall']) {
      expect(read.has(name), name).toBe(true);
    }
    expect(declaredMembers().length).toBeGreaterThan(40);
  });
});
