/**
 * Qt Framework Resolver
 *
 * Handles Qt-specific C++ and QML patterns:
 *
 * C++ side (extraction):
 *  - `Q_PROPERTY(...)` → `property` nodes, with `references` to the READ / WRITE /
 *    NOTIFY members
 *  - `signals:` / `slots:` sections and `Q_INVOKABLE` methods → `method` nodes
 *  - `QML_NAMED_ELEMENT(X)` and `qmlRegister*Type<T>("Uri", …, "QmlName")` →
 *    `component` alias nodes whose signature records the owner class and URI
 *  - `setContextProperty("name", &object)` → `variable` nodes
 *
 * Resolution (QML side, through candidate strings the QML extractor attaches):
 *  - handlers (`onFooChanged`) → the C++ or QML signal, or the watched QML property
 *  - calls on an `id` or a context object → the C++ / QML method they reach
 *  - enum members written through a QML type name or alias
 *  - `import` statements → the file they name, or the file that registers
 *    types under that module URI
 *
 * The signal → slot edges of `connect()` and `emit` are synthesized later by
 * `qtSignalChannelEdges` in `callback-synthesizer.ts`.
 */

import * as path from 'path';
import { Node, Language } from '../../types';
import { generateNodeId } from '../../extraction/tree-sitter-helpers';
import { maskCppNonCode } from '../../extraction/languages/c-cpp';
import {
  FrameworkResolver,
  FrameworkExtractionResult,
  UnresolvedRef,
  ResolvedRef,
  ResolutionContext,
} from '../types';
import {
  buildQtFunctionIndex,
  getQtCppScopes,
  qtEnclosingFunctionPrefix,
  qtScopeAt,
  qualifyQtType,
  type QtFunctionBody,
} from './qt-cpp-scope';

// ---------------------------------------------------------------------------
// Detection helpers
// ---------------------------------------------------------------------------

/** Header tokens that strongly indicate a Qt C++ file */
const QT_INCLUDE_PATTERN = /^#include\s+[<"](Q[A-Z]\w+|QtCore|QtGui|QtWidgets|QtQuick|QtQml|QApplication|QObject|QWidget)[>"]/m;

/** Q_OBJECT or Q_GADGET inside a class — the definitive Qt class marker */
const Q_OBJECT_PATTERN = /\bQ_(?:OBJECT|GADGET|NAMESPACE|ENUM|FLAG|ENUMS|FLAGS)\b/;

// ---------------------------------------------------------------------------
// C++ extraction patterns
// ---------------------------------------------------------------------------

/**
 * Matches a signals: or Q_SIGNALS: / slots: / Q_SLOTS: section header.
 * Captures the keyword so we know whether we're in signals or slots.
 * Also handles access-qualified forms: `public slots:`, `private slots:`, etc.
 */
const RE_SECTION = /^\s*(?:public\s+|private\s+|protected\s+)?(?:Q_SIGNALS|signals|Q_SLOTS|slots)\s*:/;

/**
 * Detect the section type from a matching line.
 */
function getSectionType(line: string): 'signals' | 'slots' | null {
  if (/\b(?:Q_SIGNALS|signals)\s*:/.test(line)) return 'signals';
  if (/\b(?:Q_SLOTS|slots)\s*:/.test(line)) return 'slots';
  return null;
}

/**
 * Match a function declaration inside a signals:/slots: section.
 * Captures: returnType, methodName, params
 */
const RE_FUNC_DECL = /^\s*(?:Q_INVOKABLE\s+|virtual\s+|override\s+|final\s+)*(\S[\s\S]*?)\s+(\w+)\s*\(([^)]*)\)\s*(?:const\s*)?;/;

/**
 * Q_PROPERTY(type name READ getter [WRITE setter] [NOTIFY signal] [...])
 * The macro can span multiple lines but usually fits on one.
 */
const RE_Q_PROPERTY = /Q_PROPERTY\s*\(\s*([^)]+)\)/g;



/**
 * QML_NAMED_ELEMENT(QmlTypeName) — registers the C++ class under a custom QML name.
 * Only the first occurrence per class is used.
 */
const RE_QML_NAMED_ELEMENT = /\bQML_NAMED_ELEMENT\s*\(\s*(\w+)\s*\)/g;

/**
 * QML_ELEMENT — registers the C++ class as a QML element with the same name.
 * Presence is checked during detection to confirm a file uses Qt 6 QML patterns.
 */
const QML_ELEMENT_PATTERN = /\bQML_ELEMENT\b/;

function hasQtCppMarkers(content: string, code: string): boolean {
  if (Q_OBJECT_PATTERN.test(code) || QML_ELEMENT_PATTERN.test(code)) return true;
  for (const match of content.matchAll(new RegExp(QT_INCLUDE_PATTERN.source, 'gm'))) {
    if (code.slice(match.index, match.index + '#include'.length) === '#include') return true;
  }
  return false;
}

/**
 * qmlRegister{,Singleton,Uncreatable}Type<CppClass>("uri", major, minor, "QmlName")
 * Captures the registration API, namespaced C++ type, module URI, and QML element name.
 */
const RE_QML_REGISTER_TYPE = /\b(qmlRegister(?:Singleton|Uncreatable)?Type)\s*<\s*((?:[A-Za-z_]\w*\s*::\s*)*[A-Za-z_]\w*)\s*>\s*\(\s*"([^"]*)"\s*,\s*\d+\s*,\s*\d+\s*,\s*"([A-Za-z_]\w*)"/g;

/** A literal context name and pointer, optionally wrapped by QVariant::fromValue. */
const RE_SET_CONTEXT_PROPERTY = /\b((?:(?:[A-Za-z_]\w*)\s*(?:\.|->)\s*)?rootContext\s*\(\s*\)|([A-Za-z_]\w*))\s*->\s*setContextProperty\s*\(\s*"([A-Za-z_$][\w$]*)"\s*,\s*(?:([A-Za-z_]\w*)|QVariant\s*::\s*fromValue\s*\(\s*([A-Za-z_]\w*)\s*\))\s*\)/g;

/**
 * Q_INVOKABLE method declaration outside of signals:/slots: sections.
 * Captures the return type and method name for tagging as invokable.
 */
const RE_Q_INVOKABLE_DECL = /^\s*Q_INVOKABLE\s+(?:(?:virtual|inline|static|explicit|const)\s+)*(\S[^();{}]*?)\s+(\w+)\s*\(/;

function qtClosingParenthesis(source: string, opening: number): number | null {
  if (opening < 0 || source[opening] !== '(') return null;
  let depth = 0;
  for (let index = opening; index < source.length; index++) {
    if (source[index] === '(') depth++;
    else if (source[index] === ')' && --depth === 0) return index;
  }
  return null;
}

function qtCodeOpener(source: string, match: RegExpExecArray): boolean {
  const token = match[0].match(/^[A-Za-z_]\w*/)?.[0];
  return !!token && source.slice(match.index, match.index + token.length) === token;
}

// ---------------------------------------------------------------------------
// Q_PROPERTY parsing
// ---------------------------------------------------------------------------

interface QProp {
  type: string;
  name: string;
  read?: string;
  write?: string;
  notify?: string;
}

function parseQProperty(macroBody: string): QProp | null {
  // First token(s) = type, then name, then keyword pairs
  const tokens = macroBody.trim().split(/\s+/);
  if (tokens.length < 2) return null;

  // The type may be multi-word (e.g. "unsigned int", "QList<int>")
  // We detect the name as the last token before the first keyword
  const keywords = new Set(['READ', 'WRITE', 'NOTIFY', 'RESET', 'REVISION', 'DESIGNABLE', 'SCRIPTABLE', 'STORED', 'USER', 'CONSTANT', 'FINAL', 'REQUIRED', 'BINDABLE', 'MEMBER']);

  let nameIdx = -1;
  for (let i = 1; i < tokens.length; i++) {
    if (keywords.has(tokens[i]!)) { nameIdx = i - 1; break; }
  }
  if (nameIdx < 0) nameIdx = tokens.length - 1;

  const name = tokens[nameIdx]!;
  const type = tokens.slice(0, nameIdx).join(' ');

  const result: QProp = { type, name };

  // Parse keyword-value pairs
  for (let i = nameIdx + 1; i < tokens.length - 1; i++) {
    const kw = tokens[i]!;
    const val = tokens[i + 1]!;
    if (kw === 'READ') result.read = val;
    else if (kw === 'WRITE') result.write = val;
    else if (kw === 'NOTIFY') result.notify = val;
  }
  return result;
}

function getUniquePointerType(content: string, variableName: string): string | null {
  const escapedName = variableName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const declaration = new RegExp(
    `\\b((?:[A-Za-z_]\\w*\\s*::\\s*)*[A-Za-z_]\\w*)\\s*\\*+\\s*${escapedName}\\b`,
    'g',
  );
  const autoNewDeclaration = new RegExp(
    `\\bauto\\s+${escapedName}\\s*=\\s*new\\s+((?:[A-Za-z_]\\w*\\s*::\\s*)*[A-Za-z_]\\w*)\\b`,
    'g',
  );
  const types = new Set<string>();
  let declarations = 0;
  let match: RegExpExecArray | null;
  while ((match = declaration.exec(content)) !== null) {
    declarations++;
    types.add(match[1]!.replace(/\s*::\s*/g, '::'));
  }
  while ((match = autoNewDeclaration.exec(content)) !== null) {
    declarations++;
    types.add(match[1]!.replace(/\s*::\s*/g, '::'));
  }
  return declarations === 1 && types.size === 1 ? [...types][0]! : null;
}

// ---------------------------------------------------------------------------
// Main extractor function
// ---------------------------------------------------------------------------

function extractQtFromCpp(
  filePath: string,
  content: string,
): FrameworkExtractionResult {
  const nodes: Node[] = [];
  const references: UnresolvedRef[] = [];
  const code = maskCppNonCode(content);

  // Quick bail-out: not a Qt file
  if (!hasQtCppMarkers(content, code)) {
    return { nodes, references };
  }

  const lines = code.split('\n');
  const scopes = getQtCppScopes(code);
  let functionIndex: QtFunctionBody[] | null = null;
  let currentSection: 'signals' | 'slots' | null = null;
  let previousClass: string | null = null;
  let lineOffset = 0;

  // ---- pass 1: class + section + member extraction ----
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const lineNum = i + 1;
    const currentClass = qtScopeAt(scopes, lineOffset + Math.max(0, line.search(/\S/))).className;
    lineOffset += line.length + 1;
    if (currentClass !== previousClass) currentSection = null;
    previousClass = currentClass;

    // Detect section change
    if (RE_SECTION.test(line)) {
      currentSection = getSectionType(line);
      continue;
    }

    // Reset section on any access specifier (public:, private:, protected:)
    if (/^\s*(?:public|private|protected)\s*:/.test(line)) {
      currentSection = null;
      continue;
    }

    // Extract methods inside signals: / slots: sections
    if (currentSection && currentClass) {
      const declMatch = line.match(RE_FUNC_DECL);
      if (declMatch) {
        const [, , methodName, params] = declMatch;
        if (!methodName) continue;
        const nodeId = generateNodeId(filePath, 'method', `${currentClass}::${methodName}`, lineNum);
        nodes.push({
          id: nodeId,
          kind: 'method',
          name: methodName,
          qualifiedName: `${currentClass}::${methodName}`,
          filePath,
          language: 'cpp' as Language,
          startLine: lineNum,
          endLine: lineNum,
          startColumn: line.search(/\S/),
          endColumn: line.trimEnd().length,
          signature: `${currentSection === 'signals' ? 'signal' : 'slot'} ${methodName}(${params ?? ''})`,
          updatedAt: Date.now(),
        });
      }
    }

    // Extract Q_INVOKABLE methods in the class body (outside signals/slots)
    // These are callable from QML and should be tagged as invokable.
    if (!currentSection && currentClass) {
      const declarationLines = [line];
      if (line.includes('Q_INVOKABLE') && !line.includes(';')) {
        for (let next = i + 1; next < lines.length; next++) {
          declarationLines.push(lines[next]!);
          if (lines[next]!.includes(';')) break;
        }
      }
      const declaration = declarationLines.join('\n');
      const invokableMatch = declaration.match(RE_Q_INVOKABLE_DECL);
      const opening = invokableMatch ? invokableMatch[0].length - 1 : -1;
      const closing = qtClosingParenthesis(declaration, opening);
      const suffix = closing === null ? null : declaration.slice(closing + 1).match(
        /^\s*(?:const\s*)?(?:override\s*)?(?:final\s*)?(?:noexcept\s*)?;/,
      );
      if (invokableMatch && closing !== null && suffix) {
        const methodName = invokableMatch[2]!;
        const declarationOffset = lineOffset - line.length - 1;
        const params = content.slice(declarationOffset + opening + 1, declarationOffset + closing).replace(/\s+/g, ' ').trim();
        const matchedLines = declaration.slice(0, closing + 1 + suffix[0].length).split('\n');
        const nodeId = generateNodeId(filePath, 'method', `${currentClass}::${methodName}`, lineNum);
        nodes.push({
          id: nodeId,
          kind: 'method',
          name: methodName,
          qualifiedName: `${currentClass}::${methodName}`,
          filePath,
          language: 'cpp' as Language,
          startLine: lineNum,
          endLine: lineNum + matchedLines.length - 1,
          startColumn: line.search(/\S/),
          endColumn: matchedLines.at(-1)!.length,
          signature: `invokable ${methodName}(${params})`,
          updatedAt: Date.now(),
        });
      }
    }
  }

  // ---- pass 2: Q_PROPERTY extraction ----
  // Re-scan with regex over the full source (may span lines but usually one line)
  let propMatch: RegExpExecArray | null;
  RE_Q_PROPERTY.lastIndex = 0;
  while ((propMatch = RE_Q_PROPERTY.exec(code)) !== null) {
    const macroBody = propMatch[1]!;
    const prop = parseQProperty(macroBody);
    if (!prop || !prop.name) continue;

    // Determine line number from the match offset
    const lineNum = content.slice(0, propMatch.index).split('\n').length;
    const ownerName = qtScopeAt(scopes, propMatch.index).className;
    const memberName = ownerName ? `${ownerName}::${prop.name}` : prop.name;
    const nodeId = generateNodeId(filePath, 'property', memberName, lineNum);
    nodes.push({
      id: nodeId,
      kind: 'property',
      name: prop.name,
      qualifiedName: memberName,
      filePath,
      language: 'cpp' as Language,
      startLine: lineNum,
      endLine: lineNum,
      startColumn: 0,
      endColumn: 0,
      signature: `Q_PROPERTY(${prop.type} ${prop.name})`,
      updatedAt: Date.now(),
    });

    // Emit references to getter, setter, notify signal. Each carries its owner so
    // the reference binds to that class's accessor, never back to the property
    // node that shares its name.
    if (!ownerName) continue;
    const propRefs = [
      prop.read && { name: prop.read, kind: 'calls' as const },
      prop.write && { name: prop.write, kind: 'calls' as const },
      prop.notify && { name: prop.notify, kind: 'calls' as const },
    ].filter((r): r is { name: string; kind: 'calls' } => !!r);

    for (const ref of propRefs) {
      references.push({
        fromNodeId: nodeId,
        referenceName: ref.name,
        referenceKind: ref.kind,
        line: lineNum,
        column: 0,
        filePath,
        language: 'cpp' as Language,
        candidates: [`qt.property-accessor|${ownerName}|${ref.name}`],
      });
    }
  }

  // ---- pass 3: connect() call extraction ----
  const RE_CONNECT = /\bconnect\s*\(/g;
  RE_CONNECT.lastIndex = 0;
  let connectMatch: RegExpExecArray | null;
  while ((connectMatch = RE_CONNECT.exec(code)) !== null) {
    const startIndex = connectMatch.index + connectMatch[0].length;
    let depth = 1;
    let inString = false;
    let inChar = false;
    let escape = false;
    let args: string[] = [];
    let currentArg = '';
    
    for (let i = startIndex; i < code.length; i++) {
      const char = code[i];
      if (escape) { escape = false; currentArg += char!; continue; }
      if (char === '\\') { escape = true; currentArg += char; continue; }
      if (char === '"' && !inChar) { inString = !inString; }
      else if (char === "'" && !inString) { inChar = !inChar; }
      
      if (!inString && !inChar) {
        if (char === '(' || char === '{' || char === '[') depth++;
        else if (char === ')' || char === '}' || char === ']') {
          depth--;
          if (depth === 0) { args.push(currentArg.trim()); break; }
        } else if (char === ',' && depth === 1) {
          args.push(currentArg.trim());
          currentArg = '';
          continue;
        }
      }
      currentArg += char!;
    }
    
    if (depth !== 0) continue;
    
    const lineNum = content.slice(0, connectMatch.index).split('\n').length;
    const matchScope = qtScopeAt(scopes, connectMatch.index);
    
    const addRef = (arg: string) => {
      const macroMatch = arg.match(/^(?:SIGNAL|SLOT)\s*\(\s*(\w+)\s*\([^)]*\)\s*\)$/);
      if (macroMatch) {
        references.push({
          fromNodeId: `file:${filePath}`,
          referenceName: macroMatch[1]!,
          referenceKind: 'calls',
          line: lineNum,
          column: 0,
          filePath,
          language: 'cpp' as Language,
        });
        return;
      }
      
      const ptrMatch = arg.match(/^&\s*((?:[A-Za-z_]\w*\s*::\s*)*[A-Za-z_]\w*)\s*::\s*(\w+)$/);
      if (ptrMatch) {
        const cls = qualifyQtType(ptrMatch[1]!, matchScope.namespaceName);
        const name = ptrMatch[2]!;
        references.push({
          fromNodeId: `file:${filePath}`,
          referenceName: name,
          referenceKind: 'calls',
          line: lineNum,
          column: 0,
          filePath,
          language: 'cpp' as Language,
          candidates: [`${cls}::${name}`],
        });
      }
    };

    if (args.length === 4) {
      addRef(args[1]!);
      addRef(args[3]!);
    } else if (args.length === 3) {
      addRef(args[1]!);
      addRef(args[2]!);
    }
  }

  // ---- pass 4: QML_NAMED_ELEMENT extraction ----
  // Creates a `component` alias node so QML `TypeName { }` can resolve to the C++ class.
  RE_QML_NAMED_ELEMENT.lastIndex = 0;
  let qmlNamedMatch: RegExpExecArray | null;
  while ((qmlNamedMatch = RE_QML_NAMED_ELEMENT.exec(code)) !== null) {
    const qmlName = qmlNamedMatch[1]!;
    const lineNum = content.slice(0, qmlNamedMatch.index).split('\n').length;
    const cppClass = qtScopeAt(scopes, qmlNamedMatch.index).className;
    if (!cppClass) continue;
    const nodeId = generateNodeId(filePath, 'component', qmlName, lineNum);
    nodes.push({
      id: nodeId,
      kind: 'component',
      name: qmlName,
      qualifiedName: qmlName,
      filePath,
      language: 'cpp' as Language,
      startLine: lineNum,
      endLine: lineNum,
      startColumn: 0,
      endColumn: 0,
      signature: `QML_NAMED_ELEMENT(${qmlName}) owner ${cppClass}`,
      updatedAt: Date.now(),
    });
    // Emit a reference from this alias component to the C++ class (determined by
    // the closest preceding class header in the file).
    references.push({
      fromNodeId: nodeId,
      referenceName: cppClass,
      referenceKind: 'references',
      line: lineNum,
      column: 0,
      filePath,
      language: 'cpp' as Language,
    });
  }

  // ---- pass 5: qmlRegister*Type<CppClass>(uri, major, minor, "QmlName") ----
  RE_QML_REGISTER_TYPE.lastIndex = 0;
  let qmlRegMatch: RegExpExecArray | null;
  while ((qmlRegMatch = RE_QML_REGISTER_TYPE.exec(content)) !== null) {
    if (!qtCodeOpener(code, qmlRegMatch)) continue;
    const registration = qmlRegMatch[1]!;
    const cppClass = qualifyQtType(qmlRegMatch[2]!, qtScopeAt(scopes, qmlRegMatch.index).namespaceName);
    const moduleUri = qmlRegMatch[3]!;
    const qmlName = qmlRegMatch[4]!;
    const lineNum = content.slice(0, qmlRegMatch.index).split('\n').length;
    const nodeId = generateNodeId(filePath, 'component', qmlName, lineNum);
    nodes.push({
      id: nodeId,
      kind: 'component',
      name: qmlName,
      qualifiedName: qmlName,
      filePath,
      language: 'cpp' as Language,
      startLine: lineNum,
      endLine: lineNum,
      startColumn: 0,
      endColumn: 0,
      signature: `${registration}<${cppClass}>("${qmlName}") from "${moduleUri}"`,
      updatedAt: Date.now(),
    });
    // Always emit a reference from the file to the C++ class being registered
    references.push({
      fromNodeId: `file:${filePath}`,
      referenceName: cppClass,
      referenceKind: 'references',
      line: lineNum,
      column: 0,
      filePath,
      language: 'cpp' as Language,
    });
  }

  // ---- pass 6: QQmlContext::setContextProperty extraction ----
  RE_SET_CONTEXT_PROPERTY.lastIndex = 0;
  let contextPropertyMatch: RegExpExecArray | null;
  while ((contextPropertyMatch = RE_SET_CONTEXT_PROPERTY.exec(content)) !== null) {
    if (!qtCodeOpener(code, contextPropertyMatch)) continue;
    const receiverExpression = contextPropertyMatch[1]!;
    const receiverName = contextPropertyMatch[2];
    const contextName = contextPropertyMatch[3]!;
    const valueName = (contextPropertyMatch[4] ?? contextPropertyMatch[5])!;
    functionIndex ??= buildQtFunctionIndex(code);
    const functionPrefix = qtEnclosingFunctionPrefix(functionIndex, code, contextPropertyMatch.index);
    if (!functionPrefix) continue;
    if (receiverName && getUniquePointerType(functionPrefix, receiverName) !== 'QQmlContext') continue;
    if (!receiverName && !/rootContext\s*\(/.test(receiverExpression)) continue;
    const pointerType = getUniquePointerType(functionPrefix, valueName);
    if (!pointerType) continue;
    const valueType = qualifyQtType(pointerType, qtScopeAt(scopes, contextPropertyMatch.index).namespaceName);
    const lineNum = content.slice(0, contextPropertyMatch.index).split('\n').length;
    nodes.push({
      id: generateNodeId(filePath, 'variable', `qt-context-property:${contextName}`, lineNum),
      kind: 'variable',
      name: contextName,
      qualifiedName: `qt-context-property::${contextName}`,
      filePath,
      language: 'cpp' as Language,
      startLine: lineNum,
      endLine: lineNum,
      startColumn: 0,
      endColumn: 0,
      signature: `qt.context-property|${contextName}|${valueType}`,
      updatedAt: Date.now(),
    });
  }

  return { nodes, references };
}

// ---------------------------------------------------------------------------
// QML signal handler → C++ signal resolution
// ---------------------------------------------------------------------------

export function qtCanonicalName(node: Node): string {
  const filePrefix = `${node.filePath}::`;
  return (node.qualifiedName.startsWith(filePrefix)
    ? node.qualifiedName.slice(filePrefix.length)
    : node.qualifiedName).replace(/\s*::\s*/g, '::');
}

export function qtExecutableTarget(declaration: Node, context: ResolutionContext): Node {
  if (declaration.signature?.startsWith('signal ')) return declaration;
  const canonicalName = qtCanonicalName(declaration);
  const implementations = context.getNodesByName(declaration.name).filter((node) => {
    if (node.id === declaration.id || (node.kind !== 'method' && node.kind !== 'function')) return false;
    if (node.language !== 'cpp' && node.language !== 'c') return false;
    if (qtCanonicalName(node) !== canonicalName || /^(?:signal|slot|invokable) /.test(node.signature ?? '')) return false;
    const content = context.readFile(node.filePath);
    if (!content) return false;
    const source = maskCppNonCode(content.split('\n').slice(node.startLine - 1, node.endLine).join('\n'));
    return /\)\s*(?:const\s*|noexcept\s*|override\s*|final\s*)*\{/.test(source);
  });
  if (implementations.length !== 1) return declaration;
  const parameterSignature = (node: Node): string | null => {
    let header = node.signature ? maskCppNonCode(node.signature) : undefined;
    if (!node.signature) {
      const content = context.readFile(node.filePath);
      if (!content) return null;
      header = maskCppNonCode(content.split('\n').slice(node.startLine - 1, node.endLine).join('\n')).split('{')[0]!;
    }
    if (header === undefined) return null;
    const opening = header.indexOf('(');
    const closing = qtClosingParenthesis(header, opening);
    const suffix = node.signature ? /^\s*;?$/ : /^\s*(?:const\s*|noexcept\s*|override\s*|final\s*)*$/;
    if (closing === null || !suffix.test(header.slice(closing + 1))) return null;
    const parameters = header.slice(opening + 1, closing);
    if (!parameters.trim() || parameters.trim() === 'void') return '';
    const parameterTypes: string[] = [];
    let parameterType = '';
    let depth = 0;
    let hasDefault = false;
    for (const character of `${parameters},`) {
      if (character === ',' && depth === 0) {
        parameterTypes.push(parameterType.trim());
        parameterType = '';
        hasDefault = false;
        continue;
      }
      if (character === '=' && depth === 0) hasDefault = true;
      if (!hasDefault) parameterType += character;
      if ('([{'.includes(character)) depth++;
      else if (')]}'.includes(character)) depth--;
      if (depth < 0) return null;
    }
    if (depth !== 0) return null;
    const types: string[] = [];
    for (const parameter of parameterTypes) {
      let type = parameter;
      if (!/^[A-Za-z_][\w\s:*&]*$/.test(type)) return null;
      type = type.replace(/(.*[\s*&])([A-Za-z_]\w*)$/, (whole, prefix: string, name: string) =>
        /^(?:void|bool|char|short|int|long|float|double|signed|unsigned|const|volatile)$/.test(name)
          || /^(?:const|volatile|struct|class|enum)\s*$/.test(prefix) ? whole : prefix);
      types.push(type.replace(/\s+/g, ' ').replace(/\s*([:*&])\s*/g, '$1').trim());
    }
    return types.join(',');
  };
  const declaredSignature = parameterSignature(declaration);
  return declaredSignature !== null && declaredSignature === parameterSignature(implementations[0]!)
    ? implementations[0]!
    : declaration;
}

function getOwnedQmlSignal(ref: UnresolvedRef): { ownerName: string; signalName: string } | null {
  if (ref.language !== 'qml' || ref.referenceKind !== 'references') return null;
  for (const candidate of ref.candidates ?? []) {
    const separator = candidate.lastIndexOf('::');
    if (separator <= 0) continue;
    const ownerName = candidate.slice(0, separator);
    const signalName = candidate.slice(separator + 2);
    if (signalName === ref.referenceName) return { ownerName, signalName };
  }
  return null;
}

function getQmlIdCall(ref: UnresolvedRef): { ownerName: string; methodName: string } | null {
  if (ref.language !== 'qml' || ref.referenceKind !== 'calls') return null;
  for (const candidate of ref.candidates ?? []) {
    const match = candidate.match(/^qt\.qml-id\|[^|]+\|([^|]+)\|([^|]+)$/);
    if (match) return { ownerName: match[1]!, methodName: match[2]! };
  }
  return null;
}

function getQmlContextPropertyCall(ref: UnresolvedRef): { contextName: string; methodName: string } | null {
  if (ref.language !== 'qml' || ref.referenceKind !== 'calls') return null;
  for (const candidate of ref.candidates ?? []) {
    const match = candidate.match(/^qt\.context-property\|([^|]+)\|([^|]+)$/);
    if (match) return { contextName: match[1]!, methodName: match[2]! };
  }
  return null;
}

function getQmlContextSignal(ref: UnresolvedRef): { contextName: string; methodName: string } | null {
  if (ref.language !== 'qml' || ref.referenceKind !== 'references') return null;
  for (const candidate of ref.candidates ?? []) {
    const match = candidate.match(/^qt\.context-signal\|([^|]+)\|([^|]+)$/);
    if (match && match[2] === ref.referenceName) return { contextName: match[1]!, methodName: match[2]! };
  }
  return null;
}

function getRegisteredOwnerNames(
  context: ResolutionContext,
  qmlName: string,
  singletonOnly = false,
): Set<string> {
  const owners = new Set<string>();
  const registrationPattern = singletonOnly
    ? /^qmlRegisterSingletonType<([^>]+)>\("[^"]+"\)(?: from "[^"]*")?$/
    : /^qmlRegister(?:Singleton|Uncreatable)?Type<([^>]+)>\("[^"]+"\)(?: from "[^"]*")?$/;
  const namedElementPattern = /^QML_NAMED_ELEMENT\([^)]+\) owner (.+)$/;
  for (const node of context.getNodesByName(qmlName)) {
    const owner = node.signature?.match(registrationPattern)?.[1]
      ?? (!singletonOnly ? node.signature?.match(namedElementPattern)?.[1] : undefined);
    if (owner) owners.add(owner.replace(/\s*::\s*/g, '::'));
  }
  return owners;
}

function resolveQmlImport(ref: UnresolvedRef, context: ResolutionContext): Node | null {
  const candidate = ref.candidates?.find((entry) => entry.startsWith('qt.qml-import|'));
  if (!candidate) return null;
  const [, form, ...rest] = candidate.split('|');
  const spec = rest.join('|');
  const fileNode = (filePath: string): Node | null =>
    context.getNodesInFile(filePath).find((node) => node.kind === 'file') ?? null;
  if (form === 'path') {
    if (!/\.(?:m?js|qml)$/i.test(spec)) return null;
    const dir = path.posix.dirname(ref.filePath.replace(/\\/g, '/'));
    const resolved = path.posix.normalize(path.posix.join(dir, spec));
    return resolved.startsWith('..') || !context.fileExists(resolved) ? null : fileNode(resolved);
  }
  if (form !== 'module') return null;
  const files = new Set<string>();
  for (const node of context.getNodesByKind('component')) {
    if ((node.language !== 'cpp' && node.language !== 'c') || !node.signature) continue;
    if (/^qmlRegister/.test(node.signature) && node.signature.endsWith(` from "${spec}"`)) files.add(node.filePath);
  }
  return files.size === 1 ? fileNode([...files][0]!) : null;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * `Owner.Enum.Member` written in QML. `Owner` is what QML sees: a registered
 * C++ type alias (`qmlRegisterType`, `QML_NAMED_ELEMENT`) or the name of a
 * `.qml` file. Each source of candidates decides on its own — the first one
 * that has any wins, and more than one inside it means no answer.
 */
function resolveQmlEnumMember(context: ResolutionContext, enumMember: { ownerName: string; memberName: string }): Node | null {
  const [head, ...middle] = enumMember.ownerName.split('::');
  const path = middle.join('::');
  const members = context.getNodesByName(enumMember.memberName).filter((node) => node.kind === 'enum_member');
  const stages: Array<() => Node[]> = [
    () => {
      const owners = [...getRegisteredOwnerNames(context, head!)];
      if (owners.length === 0) return [];
      return members.filter((node) => {
        if (node.language !== 'cpp' && node.language !== 'c') return false;
        const canonical = qtCanonicalName(node);
        return owners.some((owner) => {
          const between = path ? escapeRegExp(path) : '[^:]+';
          return new RegExp(`(?:^|::)${escapeRegExp(owner)}::${between}::${escapeRegExp(enumMember.memberName)}$`).test(canonical);
        });
      });
    },
    () => members.filter((node) => {
      if (node.language !== 'qml' || node.filePath.replace(/^.*[\\/]/, '').replace(/\.qml$/i, '') !== head) return false;
      const canonical = qtCanonicalName(node);
      return path ? canonical === `${path}::${enumMember.memberName}` : /^[^:]+::[^:]+$/.test(canonical);
    }),
    () => members.filter((node) => qtCanonicalName(node).startsWith(`${enumMember.ownerName}::`)),
  ];
  for (const stage of stages) {
    const found = stage();
    if (found.length) return found.length === 1 ? found[0]! : null;
  }
  return null;
}

function getQtPropertyAccessor(ref: UnresolvedRef): { ownerName: string; accessorName: string } | null {
  const candidate = ref.candidates?.find((entry) => entry.startsWith('qt.property-accessor|'));
  if (!candidate) return null;
  const [, ownerName, accessorName] = candidate.split('|');
  return ownerName && accessorName ? { ownerName, accessorName } : null;
}

function getQmlEnumMember(ref: UnresolvedRef): { ownerName: string; memberName: string } | null {
  for (const candidate of ref.candidates ?? []) {
    const match = candidate.match(/^qt\.enum-member\|([^|]+)\|([^|]+)$/);
    if (match) return { ownerName: match[1]!, memberName: match[2]! };
  }
  return null;
}

// ---------------------------------------------------------------------------
// FrameworkResolver export
// ---------------------------------------------------------------------------

export const qtResolver: FrameworkResolver = {
  name: 'qt',
  languages: ['cpp', 'c', 'qml'],

  detect(context: ResolutionContext): boolean {
    const allFiles = context.getAllFiles();

    // Check for .qml files in the project
    if (allFiles.some((f) => f.endsWith('.qml'))) return true;

    // Check for Qt headers in C++ files
    for (const file of allFiles) {
      if (!file.endsWith('.cpp') && !file.endsWith('.h') && !file.endsWith('.hpp')) continue;
      const content = context.readFile(file);
      const code = content && maskCppNonCode(content);
      if (content && code && hasQtCppMarkers(content, code)) {
        return true;
      }
    }

    // Check CMakeLists.txt for Qt
    const cmake = context.readFile('CMakeLists.txt');
    if (cmake && /find_package\s*\(\s*Qt/i.test(cmake)) return true;

    // Check .pro file (qmake)
    const proFile = allFiles.find((f) => f.endsWith('.pro'));
    if (proFile) {
      const pro = context.readFile(proFile);
      if (pro && /QT\s*[+]?=/.test(pro)) return true;
    }

    return false;
  },

  extract(filePath: string, content: string): FrameworkExtractionResult {
    const ext = path.extname(filePath).toLowerCase();

    if (ext === '.cpp' || ext === '.h' || ext === '.hpp' || ext === '.cxx' || ext === '.cc') {
      return extractQtFromCpp(filePath, content);
    }

    return { nodes: [], references: [] };
  },

  resolve(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
    const propertyAccessor = getQtPropertyAccessor(ref);
    if (propertyAccessor) {
      const canonicalName = `${propertyAccessor.ownerName}::${propertyAccessor.accessorName}`;
      const targets = new Map<string, Node>();
      for (const node of context.getNodesByName(propertyAccessor.accessorName)) {
        if ((node.kind !== 'method' && node.kind !== 'function') || (node.language !== 'cpp' && node.language !== 'c')) continue;
        if (qtCanonicalName(node) !== canonicalName) continue;
        const target = qtExecutableTarget(node, context);
        targets.set(target.id, target);
      }
      const [target] = targets.size === 1 ? [...targets.values()] : [];
      return target && target.id !== ref.fromNodeId
        ? { original: ref, targetNodeId: target.id, confidence: 0.97, resolvedBy: 'framework' }
        : null;
    }
    const qmlEnumMember = getQmlEnumMember(ref);
    if (qmlEnumMember) {
      const target = resolveQmlEnumMember(context, qmlEnumMember);
      return target
        ? { original: ref, targetNodeId: target.id, confidence: 0.97, resolvedBy: 'framework' }
        : null;
    }

    const contextPropertyCall = getQmlContextPropertyCall(ref);
    const contextSignal = getQmlContextSignal(ref);
    const contextMember = contextPropertyCall ?? contextSignal;
    if (contextMember) {
      const registrationPrefix = `qt.context-property|${contextMember.contextName}|`;
      const ownerTypes = new Set(
        context.getNodesByName(contextMember.contextName)
          .map((node: Node) => node.signature)
          .filter((signature): signature is string => signature?.startsWith(registrationPrefix) ?? false)
          .map((signature) => signature.slice(registrationPrefix.length)),
      );
      if (ownerTypes.size === 0) {
        for (const owner of getRegisteredOwnerNames(context, contextMember.contextName, true)) {
          ownerTypes.add(owner);
        }
      }
      if (ownerTypes.size !== 1) return null;
      const ownerName = [...ownerTypes][0]!;
      const canonicalName = `${ownerName}::${contextMember.methodName}`;
      const candidates = context.getNodesByName(contextMember.methodName).filter(
        (node: Node) =>
          node.kind === 'method' &&
          (node.language === 'cpp' || node.language === 'c') &&
          qtCanonicalName(node) === canonicalName &&
          (contextSignal ? /^signal / : /^(?:invokable|slot|signal) /).test(node.signature ?? ''),
      );
      if (candidates.length === 1) {
        return {
          original: ref,
          targetNodeId: (contextSignal ? candidates[0]! : qtExecutableTarget(candidates[0]!, context)).id,
          confidence: 0.97,
          resolvedBy: 'framework',
        };
      }
      return null;
    }

    const qmlIdCall = getQmlIdCall(ref);
    if (qmlIdCall) {
      const registeredTypes = getRegisteredOwnerNames(context, qmlIdCall.ownerName);
      if (registeredTypes.size > 1) return null;
      const hasRegisteredType = registeredTypes.size === 1;
      const ownerNames = hasRegisteredType ? registeredTypes : new Set([qmlIdCall.ownerName]);
      const candidates = context.getNodesByName(qmlIdCall.methodName).filter((node: Node) => {
        if (node.language === 'qml') {
          return (
            !hasRegisteredType &&
            (node.kind === 'function' || node.kind === 'method') &&
            path.basename(node.filePath, path.extname(node.filePath)) === qmlIdCall.ownerName
          );
        }
        if (node.kind !== 'method' || (node.language !== 'cpp' && node.language !== 'c')) return false;
        if (!/^(?:invokable|slot|signal) /.test(node.signature ?? '')) return false;
        return [...ownerNames].some(
          (ownerName) => qtCanonicalName(node) === `${ownerName}::${qmlIdCall.methodName}`,
        );
      });
      if (candidates.length === 1) {
        return {
          original: ref,
          targetNodeId: qtExecutableTarget(candidates[0]!, context).id,
          confidence: 0.97,
          resolvedBy: 'framework',
        };
      }
      return null;
    }

    const ownedSignal = getOwnedQmlSignal(ref);
    if (ownedSignal) {
      const ownerNames = getRegisteredOwnerNames(context, ownedSignal.ownerName);
      if (ownerNames.size > 1) return null;
      if (ownerNames.size === 0) ownerNames.add(ownedSignal.ownerName);
      const candidates = context.getNodesByName(ownedSignal.signalName).filter((node: Node) => {
        if (node.kind !== 'method' || !node.signature?.startsWith('signal ')) return false;
        if (node.language === 'qml') {
          return path.basename(node.filePath, path.extname(node.filePath)) === ownedSignal.ownerName;
        }
        if (node.language === 'cpp' || node.language === 'c') {
          return [...ownerNames].some(
            (ownerName) => qtCanonicalName(node) === `${ownerName}::${ownedSignal.signalName}`,
          );
        }
        return false;
      });
      if (candidates.length === 1) {
        return {
          original: ref,
          targetNodeId: candidates[0]!.id,
          confidence: 0.95,
          resolvedBy: 'framework',
        };
      }
      // `onCountChanged` on an instance of a QML type: the property's change
      // signal is implicit, so the handler belongs to `property count`.
      const changed = candidates.length === 0 ? ownedSignal.signalName.match(/^(\w+)Changed$/) : null;
      if (changed) {
        const properties = context.getNodesByName(changed[1]!).filter((node: Node) =>
          node.kind === 'property' &&
          node.language === 'qml' &&
          path.basename(node.filePath, path.extname(node.filePath)) === ownedSignal.ownerName);
        if (properties.length === 1) {
          return {
            original: ref,
            targetNodeId: properties[0]!.id,
            confidence: 0.9,
            resolvedBy: 'framework',
          };
        }
      }
      return null;
    }

    // QML import: a quoted path goes to the file it names; a module URI goes to
    // the file that registers types under it. Everything else (QtQuick, a
    // directory, an unindexed module) stays unresolved — and an import must
    // never land on another import node or on itself.
    if (ref.language === 'qml' && ref.referenceKind === 'imports') {
      const target = resolveQmlImport(ref, context);
      return target && target.id !== ref.fromNodeId
        ? { original: ref, targetNodeId: target.id, confidence: 0.9, resolvedBy: 'framework' }
        : null;
    }

    // QML component type → C++ class that registered it
    if (ref.language === 'qml' && ref.referenceKind === 'references') {
      const typeName = ref.referenceName;
      const registeredTypes = getRegisteredOwnerNames(context, typeName);
      if (registeredTypes.size > 1) return null;
      if (registeredTypes.size === 1) {
        const ownerName = [...registeredTypes][0]!;
        const separator = ownerName.lastIndexOf('::');
        const lookupName = separator < 0 ? ownerName : ownerName.slice(separator + 2);
        const registeredCandidates = context.getNodesByName(lookupName).filter(
          (node: Node) =>
            node.kind === 'class' &&
            (node.language === 'cpp' || node.language === 'c') &&
            qtCanonicalName(node) === ownerName,
        );
        if (registeredCandidates.length === 1) {
          return {
            original: ref,
            targetNodeId: registeredCandidates[0]!.id,
            confidence: 0.97,
            resolvedBy: 'framework',
          };
        }
        return null;
      }
      const candidates = context.getNodesByName(typeName).filter(
        (n: Node) => n.kind === 'class' || n.kind === 'component',
      );
      if (candidates.length === 1) {
        return {
          original: ref,
          targetNodeId: candidates[0]!.id,
          confidence: 0.7,
          resolvedBy: 'framework',
        };
      }
    }

    return null;
  },

  claimsReference(name: string, ref?: UnresolvedRef): boolean {
    // Only a QML member access (`service.refresh`) needs to bypass the
    // name-exists pre-filter; the same shape in any other language is ordinary.
    if (ref?.language !== 'qml') return false;
    if (/^[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*$/.test(name)) return true;
    // `onCountChanged` names a change signal no node declares: the property's.
    return ref.referenceKind === 'references' && /^\w+Changed$/.test(name) &&
      !!ref.candidates?.some((candidate) => candidate.endsWith(`::${name}`));
  },
};
