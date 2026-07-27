import * as path from 'path';
import { Edge, ExtractionError, ExtractionResult, Node, NodeKind, UnresolvedReference } from '../types';
import { generateNodeId } from './tree-sitter-helpers';

interface Scope {
  id: string;
  indent: number;
  kind: NodeKind;
}

interface FunctionScope extends Scope {
  startLine: number;
}

const KEYWORDS = new Set([
  'if',
  'elif',
  'for',
  'while',
  'match',
  'return',
  'await',
  'assert',
  'print',
  'push_error',
  'push_warning',
  'preload',
  'load',
  'super',
  'func',
  'signal',
]);

const ANNOTATION_PREFIX = '(?:(?:@\\w+(?:\\([^)]*\\))?)\\s+)*';

const GODOT_BUILT_IN_CALLS = new Set([
  'AABB',
  'Array',
  'Basis',
  'Callable',
  'Color',
  'Dictionary',
  'NodePath',
  'PackedByteArray',
  'PackedColorArray',
  'PackedFloat32Array',
  'PackedFloat64Array',
  'PackedInt32Array',
  'PackedInt64Array',
  'PackedScene',
  'PackedStringArray',
  'PackedVector2Array',
  'PackedVector3Array',
  'Plane',
  'Projection',
  'Quaternion',
  'Rect2',
  'Rect2i',
  'RID',
  'Signal',
  'String',
  'StringName',
  'Transform2D',
  'Transform3D',
  'Vector2',
  'Vector2i',
  'Vector3',
  'Vector3i',
  'Vector4',
  'Vector4i',
]);

/**
 * Lightweight GDScript extractor.
 *
 * This intentionally avoids a hard dependency on a GDScript WASM grammar while
 * still giving Godot projects useful symbol search and reference edges.
 */
export class GDScriptExtractor {
  private filePath: string;
  private source: string;
  private lines: string[];
  private nodes: Node[] = [];
  private edges: Edge[] = [];
  private unresolvedReferences: UnresolvedReference[] = [];
  private errors: ExtractionError[] = [];
  private stringConstants = new Map<string, string>();
  private dynamicNodeNames = new Set<string>();
  private nodePathAliases = new Map<string, Map<string, string>>();
  private nodeLookupHelperArgumentIndex = new Map<string, number>();

  constructor(filePath: string, source: string) {
    this.filePath = filePath;
    this.source = source;
    this.lines = source.split('\n');
  }

  extract(): ExtractionResult {
    const startTime = Date.now();

    try {
      const fileNode = this.createFileNode();
      const scriptClass = this.extractScriptClass(fileNode) ?? this.extractImplicitScriptClass(fileNode);
      if (scriptClass && /^@tool\b/m.test(this.source)) {
        scriptClass.decorators = ['tool'];
      }
      this.extractDeclarations(fileNode, scriptClass);
      this.extractReferences(fileNode, scriptClass);
    } catch (error) {
      this.errors.push({
        message: `GDScript extraction error: ${error instanceof Error ? error.message : String(error)}`,
        filePath: this.filePath,
        severity: 'error',
        code: 'parse_error',
      });
    }

    return {
      nodes: this.nodes,
      edges: this.edges,
      unresolvedReferences: this.unresolvedReferences,
      errors: this.errors,
      durationMs: Date.now() - startTime,
    };
  }

  private createFileNode(): Node {
    const node: Node = {
      id: `file:${this.filePath}`,
      kind: 'file',
      name: path.basename(this.filePath),
      qualifiedName: this.filePath,
      filePath: this.filePath,
      language: 'gdscript',
      startLine: 1,
      endLine: this.lines.length,
      startColumn: 0,
      endColumn: this.lines[this.lines.length - 1]?.length ?? 0,
      updatedAt: Date.now(),
    };
    this.nodes.push(node);
    return node;
  }

  private extractScriptClass(fileNode: Node): Node | null {
    const classNameMatch = this.source.match(new RegExp(`^\\s*${ANNOTATION_PREFIX}class_name\\s+([A-Za-z_]\\w*)`, 'm'));
    if (!classNameMatch) return null;

    const index = classNameMatch.index ?? 0;
    const line = this.getLineNumber(index);
    const column = index - this.getLineStart(line) + classNameMatch[0].indexOf(classNameMatch[1]!);
    const name = classNameMatch[1]!;
    const node = this.createNode('class', name, `${this.filePath}::${name}`, line, column, line, column + classNameMatch[0].trimEnd().length);
    this.addContains(fileNode.id, node.id);
    return node;
  }

  private extractImplicitScriptClass(fileNode: Node): Node | null {
    const extendsMatch = this.source.match(new RegExp(`^\\s*${ANNOTATION_PREFIX}extends\\s+(?:"([^"]+)"|'([^']+)'|([A-Za-z_][\\w.]*))`, 'm'));
    if (!extendsMatch) return null;

    const index = extendsMatch.index ?? 0;
    const line = this.getLineNumber(index);
    const name = this.scriptClassNameFromPath();
    const column = index - this.getLineStart(line);
    const node = this.createNode('class', name, `${this.filePath}::${name}`, line, column, line, column + (this.lines[line - 1]?.trimEnd().length ?? 0));
    node.signature = `implicit script class extends ${extendsMatch[1] || extendsMatch[2] || extendsMatch[3]}`;
    this.addContains(fileNode.id, node.id);
    return node;
  }

  private extractDeclarations(fileNode: Node, scriptClass: Node | null): void {
    const scopes: Scope[] = [{ id: scriptClass?.id ?? fileNode.id, indent: -1, kind: scriptClass ? 'class' : 'file' }];

    for (let i = 0; i < this.lines.length; i++) {
      const lineNumber = i + 1;
      const rawLine = this.lines[i] ?? '';
      const code = this.stripComment(rawLine);
      if (!code.trim()) continue;

      const indent = this.indentOf(rawLine);
      while (scopes.length > 1 && indent <= scopes[scopes.length - 1]!.indent) {
        scopes.pop();
      }

      const trimmed = code.trim();
      if (new RegExp(`^${ANNOTATION_PREFIX}class_name\\s+`).test(trimmed)) continue;

      const classMatch = trimmed.match(new RegExp(`^${ANNOTATION_PREFIX}class\\s+([A-Za-z_]\\w*)\\s*(?:extends\\s+[^:]+)?\\s*:?`));
      if (classMatch) {
        const node = this.createDeclarationNode('class', classMatch[1]!, rawLine, lineNumber, indent);
        this.addContains(scopes[scopes.length - 1]!.id, node.id);
        scopes.push({ id: node.id, indent, kind: 'class' });
        continue;
      }

      const enumMatch = trimmed.match(/^enum(?:\s+([A-Za-z_]\w*))?/);
      if (enumMatch) {
        const name = enumMatch[1] || '<anonymous_enum>';
        const node = this.createDeclarationNode('enum', name, rawLine, lineNumber, indent);
        this.addContains(scopes[scopes.length - 1]!.id, node.id);
        continue;
      }

      const signalMatch = trimmed.match(/^signal\s+([A-Za-z_]\w*)/);
      if (signalMatch) {
        const node = this.createDeclarationNode('signal', signalMatch[1]!, rawLine, lineNumber, indent);
        node.signature = trimmed;
        this.addContains(scopes[scopes.length - 1]!.id, node.id);
        continue;
      }

      const funcMatch = trimmed.match(new RegExp(`^${ANNOTATION_PREFIX}(?:static\\s+)?func\\s+([A-Za-z_]\\w*)\\s*(\\([^)]*\\))?(?:\\s*->\\s*([^:]+))?`));
      if (funcMatch) {
        const insideClass = scopes.some((scope) => scope.kind === 'class');
        const node = this.createDeclarationNode(insideClass ? 'method' : 'function', funcMatch[1]!, rawLine, lineNumber, indent);
        node.signature = `${funcMatch[2] || '()'}${funcMatch[3] ? ` -> ${funcMatch[3].trim()}` : ''}`;
        node.isStatic = /\bstatic\s+func\b/.test(trimmed);
        this.addContains(scopes[scopes.length - 1]!.id, node.id);
        scopes.push({ id: node.id, indent, kind: node.kind });
        continue;
      }

      const varMatch = trimmed.match(new RegExp(`^${ANNOTATION_PREFIX}(?:static\\s+)?(var|const)\\s+([A-Za-z_]\\w*)`));
      if (varMatch) {
        const kind: NodeKind = varMatch[1] === 'const' ? 'constant' : 'variable';
        const node = this.createDeclarationNode(kind, varMatch[2]!, rawLine, lineNumber, indent);
        node.signature = trimmed;
        const exportAnn = rawLine.match(/@export(?:_(\w+))?(?:\(([^)]*)\))?/);
        if (exportAnn) {
          node.decorators = [exportAnn[1] ? `export_${exportAnn[1]}` : 'export'];
        }
        this.addContains(scopes[scopes.length - 1]!.id, node.id);
        if (kind === 'constant') {
          const stringValueMatch = trimmed.match(/:=?\s*&?["']([^"']+)["']/);
          if (stringValueMatch) {
            const constName = varMatch[2]!;
            const stringValue = stringValueMatch[1]!;
            this.stringConstants.set(constName, stringValue);
            if (/_NAME$/.test(constName) && this.isSimpleNodeName(stringValue)) {
              this.addDynamicNodeNameDeclaration(stringValue, rawLine, trimmed, lineNumber, scopes[scopes.length - 1]!.id);
            }
          }
        }
        if (rawLine.includes('@onready')) {
          const onreadyPath = rawLine.match(/[$]([A-Za-z_]\w*(?:\/[A-Za-z_]\w*)*)/);
          if (onreadyPath) {
            this.addReference(node.id, onreadyPath[1]!, 'references', lineNumber, rawLine.indexOf('$'));
          }
        }
      }

      const dynamicNodeNameMatch = trimmed.match(/\b[A-Za-z_]\w*\s*\.\s*name\s*=\s*["']([A-Za-z_]\w*)["']/);
      if (dynamicNodeNameMatch) {
        this.addDynamicNodeNameDeclaration(dynamicNodeNameMatch[1]!, rawLine, trimmed, lineNumber, scopes[scopes.length - 1]!.id);
      }

      const formattedNodeName = this.extractFormattedNodePathBase(trimmed);
      if (formattedNodeName) {
        this.addDynamicNodeNameDeclaration(formattedNodeName, rawLine, trimmed, lineNumber, scopes[scopes.length - 1]!.id);
      }
    }
  }

  private extractReferences(fileNode: Node, scriptClass: Node | null): void {
    const functionScopes = this.nodes
      .filter((node) => (node.kind === 'function' || node.kind === 'method') && node.language === 'gdscript')
      .map((node) => ({ id: node.id, indent: this.indentOf(this.lines[node.startLine - 1] ?? ''), kind: node.kind, startLine: node.startLine } as FunctionScope))
      .sort((a, b) => a.startLine - b.startLine);
    this.extractNodeLookupHelpers(functionScopes);
    const declarationByLine = new Map<number, Node>();
    for (const node of this.nodes) {
      if ((node.kind === 'variable' || node.kind === 'constant') && node.language === 'gdscript') {
        declarationByLine.set(node.startLine, node);
      }
    }

    const functionOwnerForLine = (line: number, indent: number): string => {
      let owner = scriptClass?.id ?? fileNode.id;
      for (const scope of functionScopes) {
        if (scope.startLine < line && scope.indent < indent) {
          owner = scope.id;
        }
      }
      return owner;
    };

    const ownerForLine = (line: number, indent: number): string => {
      const sameLineDeclaration = declarationByLine.get(line);
      if (sameLineDeclaration) return sameLineDeclaration.id;

      return functionOwnerForLine(line, indent);
    };

    for (let i = 0; i < this.lines.length; i++) {
      const lineNumber = i + 1;
      const rawLine = this.lines[i] ?? '';
      const code = this.stripComment(rawLine);
      const indent = this.indentOf(rawLine);
      const owner = ownerForLine(lineNumber, indent);
      const functionOwner = functionOwnerForLine(lineNumber, indent);

      const extendsMatch = code.match(new RegExp(`^\\s*${ANNOTATION_PREFIX}(?:(?:class_name|class)\\s+[A-Za-z_]\\w*\\s+)?extends\\s+(?:"([^"]+)"|'([^']+)'|([A-Za-z_][\\w.]*))`));
      if (extendsMatch) {
        this.addReference(owner, extendsMatch[1] || extendsMatch[2] || extendsMatch[3]!, 'extends', lineNumber, code.indexOf('extends'));
      }

      const resourceRegex = /\b(?:preload|load)\s*\(\s*["']([^"']+)["']\s*\)/g;
      let resourceMatch;
      while ((resourceMatch = resourceRegex.exec(code)) !== null) {
        this.addReference(owner, resourceMatch[1]!, 'references', lineNumber, resourceMatch.index);
      }

      const dynamicCallRegex = /\b(?:call|call_deferred)\s*\(\s*["']([A-Za-z_]\w*)["']/g;
      let dynamicCallMatch;
      while ((dynamicCallMatch = dynamicCallRegex.exec(code)) !== null) {
        this.addReference(owner, dynamicCallMatch[1]!, 'calls', lineNumber, dynamicCallMatch.index);
      }

      const groupRegex = /\b(?:add_to_group|remove_from_group)\s*\(\s*["']([^"']+)["']/g;
      let groupMatch;
      while ((groupMatch = groupRegex.exec(code)) !== null) {
        this.addReference(owner, groupMatch[1]!, 'references', lineNumber, groupMatch.index);
      }

      const tweenPathRegex = /\b(?:tween_property|tween_method|tween_value)\s*\(\s*[^,]+,\s*["']([^"']+)["']/g;
      let tweenPathMatch;
      while ((tweenPathMatch = tweenPathRegex.exec(code)) !== null) {
        this.addReference(owner, tweenPathMatch[1]!, 'references', lineNumber, tweenPathMatch.index);
      }

      this.extractNodePathReferences(owner, code, lineNumber, scriptClass, functionOwner);
      this.extractSignalReferences(functionOwner, code, lineNumber);
      this.extractCallableReferences(functionOwner, code, lineNumber);

      const memberCallRegex = /(?:\b([A-Za-z_]\w*)|([$%][A-Za-z_]\w*(?:\/[A-Za-z_]\w*)*))\s*\.\s*([A-Za-z_]\w*)\s*\(/g;
      let memberCallMatch;
      while ((memberCallMatch = memberCallRegex.exec(code)) !== null) {
        const receiver = memberCallMatch[1] || this.nodePathReceiverName(memberCallMatch[2]!);
        const method = memberCallMatch[3]!;
        if (KEYWORDS.has(method)) continue;
        this.addReference(owner, `${receiver}.${method}`, 'calls', lineNumber, memberCallMatch.index);
      }

      const callRegex = /\b([A-Za-z_]\w*)\s*\(/g;
      let callMatch;
      while ((callMatch = callRegex.exec(code)) !== null) {
        const name = callMatch[1]!;
        const prefix = code.slice(Math.max(0, callMatch.index - 8), callMatch.index);
        if (
          KEYWORDS.has(name) ||
          GODOT_BUILT_IN_CALLS.has(name) ||
          /\.\s*$/.test(prefix) ||
          /\bfunc\s+$/.test(prefix) ||
          /\bsignal\s+$/.test(prefix)
        ) continue;
        this.addReference(owner, name, 'calls', lineNumber, callMatch.index);
      }
    }
  }

  private extractSignalReferences(owner: string, code: string, lineNumber: number): void {
    this.extractSignalConnectReferences(owner, code, lineNumber);
    this.extractSignalEmitReferences(owner, code, lineNumber);
  }

  private extractSignalConnectReferences(owner: string, code: string, lineNumber: number): void {
    const memberConnectRegex = /\b(?:([A-Za-z_]\w*)|([$%][A-Za-z_]\w*(?:\/[A-Za-z_]\w*)*))\s*\.\s*([A-Za-z_]\w*)\s*\.\s*connect\s*\(/g;
    let memberConnectMatch;
    while ((memberConnectMatch = memberConnectRegex.exec(code)) !== null) {
      const receiver = memberConnectMatch[1] || this.nodePathReceiverName(memberConnectMatch[2]!);
      const signalName = memberConnectMatch[3]!;
      this.addReference(owner, signalName, 'references', lineNumber, memberConnectMatch.index);
      this.addReference(owner, `${receiver}.${signalName}`, 'references', lineNumber, memberConnectMatch.index);

      const argsStart = memberConnectRegex.lastIndex;
      const argsEnd = this.findCallEnd(code, argsStart - 1);
      if (argsEnd > argsStart) {
        this.addCallableTargetReferences(owner, code.slice(argsStart, argsEnd), lineNumber, argsStart);
      }
    }

    const bareConnectRegex = /\b([A-Za-z_]\w*)\s*\.\s*connect\s*\(/g;
    let bareConnectMatch;
    while ((bareConnectMatch = bareConnectRegex.exec(code)) !== null) {
      const signalName = bareConnectMatch[1]!;
      if (signalName === 'node') continue;
      this.addReference(owner, signalName, 'references', lineNumber, bareConnectMatch.index);

      const argsStart = bareConnectRegex.lastIndex;
      const argsEnd = this.findCallEnd(code, argsStart - 1);
      if (argsEnd > argsStart) {
        this.addCallableTargetReferences(owner, code.slice(argsStart, argsEnd), lineNumber, argsStart);
      }
    }

    const legacyConnectRegex = /\bconnect\s*\(\s*(?:&)?["']([^"']+)["']\s*,/g;
    let legacyConnectMatch;
    while ((legacyConnectMatch = legacyConnectRegex.exec(code)) !== null) {
      this.addReference(owner, legacyConnectMatch[1]!, 'references', lineNumber, legacyConnectMatch.index);

      const argsStart = legacyConnectRegex.lastIndex;
      const argsEnd = this.findCallEnd(code, code.indexOf('(', legacyConnectMatch.index));
      if (argsEnd > argsStart) {
        this.addCallableTargetReferences(owner, code.slice(argsStart, argsEnd), lineNumber, argsStart);
      }
    }
  }

  private extractSignalEmitReferences(owner: string, code: string, lineNumber: number): void {
    const memberEmitRegex = /\b([A-Za-z_]\w*)\s*\.\s*emit\s*\(/g;
    let memberEmitMatch;
    while ((memberEmitMatch = memberEmitRegex.exec(code)) !== null) {
      this.addReference(owner, memberEmitMatch[1]!, 'calls', lineNumber, memberEmitMatch.index);
    }

    const emitSignalRegex = /\bemit_signal\s*\(\s*(?:&)?["']([^"']+)["']/g;
    let emitSignalMatch;
    while ((emitSignalMatch = emitSignalRegex.exec(code)) !== null) {
      this.addReference(owner, emitSignalMatch[1]!, 'calls', lineNumber, emitSignalMatch.index);
    }
  }

  private addCallableTargetReferences(owner: string, args: string, lineNumber: number, argsColumn: number): void {
    const callableRegex = /\bCallable\s*\(\s*(?:self|this|[A-Za-z_]\w*)\s*,\s*["']([A-Za-z_]\w*)["']\s*\)/g;
    let callableMatch;
    while ((callableMatch = callableRegex.exec(args)) !== null) {
      this.addReference(owner, callableMatch[1]!, 'calls', lineNumber, argsColumn + callableMatch.index);
    }

    const directHandlerMatch = args.match(/^\s*([A-Za-z_]\w*)\b/);
    if (directHandlerMatch) {
      const name = directHandlerMatch[1]!;
      if (!KEYWORDS.has(name) && !GODOT_BUILT_IN_CALLS.has(name) && name !== 'func') {
        this.addReference(owner, name, 'calls', lineNumber, argsColumn + args.indexOf(name));
      }
    }
  }

  private extractCallableReferences(owner: string, code: string, lineNumber: number): void {
    const callableRegex = /\bCallable\s*\(\s*(?:self|this|[A-Za-z_]\w*)\s*,\s*["']([A-Za-z_]\w*)["']\s*\)/g;
    let callableMatch;
    while ((callableMatch = callableRegex.exec(code)) !== null) {
      this.addReference(owner, callableMatch[1]!, 'calls', lineNumber, callableMatch.index);
    }
  }

  private extractNodePathReferences(owner: string, code: string, lineNumber: number, scriptClass: Node | null, aliasOwner: string): void {
    this.extractStringNodePathAlias(aliasOwner, code);

    const shorthandRegex = /[$%]([A-Za-z_]\w*(?:\/[A-Za-z_]\w*)*)/g;
    let shorthandMatch;
    while ((shorthandMatch = shorthandRegex.exec(code)) !== null) {
      this.addNodePathReference(owner, shorthandMatch[1]!, lineNumber, shorthandMatch.index, scriptClass);
    }

    const getNodeRegex = /\b(?:get_node|get_node_or_null|has_node)\s*\(\s*["']([^"']+)["']\s*\)/g;
    let getNodeMatch;
    while ((getNodeMatch = getNodeRegex.exec(code)) !== null) {
      this.addNodePathReference(owner, getNodeMatch[1]!, lineNumber, getNodeMatch.index, scriptClass);
    }

    const findChildRegex = /\bfind_child\s*\(\s*["']([^"']+)["']/g;
    let findChildMatch;
    while ((findChildMatch = findChildRegex.exec(code)) !== null) {
      this.addNodePathReference(owner, findChildMatch[1]!, lineNumber, findChildMatch.index, scriptClass);
    }

    const findChildAliasRegex = /\bfind_child\s*\(\s*([A-Za-z_]\w*)\b/g;
    let findChildAliasMatch;
    while ((findChildAliasMatch = findChildAliasRegex.exec(code)) !== null) {
      const nodePath = this.resolveStringAlias(aliasOwner, findChildAliasMatch[1]!);
      if (!nodePath) continue;
      this.addNodePathReference(owner, nodePath, lineNumber, findChildAliasMatch.index, scriptClass);
    }

    const projectFindNodeRegex = /\b_find_node\s*\(\s*[^,\n]+,\s*["']([^"']+)["']/g;
    let projectFindNodeMatch;
    while ((projectFindNodeMatch = projectFindNodeRegex.exec(code)) !== null) {
      this.addNodePathReference(owner, projectFindNodeMatch[1]!, lineNumber, projectFindNodeMatch.index, scriptClass);
    }

    const projectFindNodeAliasRegex = /\b_find_node\s*\(\s*[^,\n]+,\s*([A-Za-z_]\w*)\b/g;
    let projectFindNodeAliasMatch;
    while ((projectFindNodeAliasMatch = projectFindNodeAliasRegex.exec(code)) !== null) {
      const nodePath = this.resolveStringAlias(aliasOwner, projectFindNodeAliasMatch[1]!);
      if (!nodePath) continue;
      this.addNodePathReference(owner, nodePath, lineNumber, projectFindNodeAliasMatch.index, scriptClass);
    }

    const getNodeFormattedRegex = /\b(?:get_node|get_node_or_null|has_node)\s*\(\s*["']([^"']*%d[^"']*)["']\s*%/g;
    let getNodeFormattedMatch;
    while ((getNodeFormattedMatch = getNodeFormattedRegex.exec(code)) !== null) {
      const formattedNodePath = this.formattedNodePathBase(getNodeFormattedMatch[1]!);
      if (formattedNodePath) {
        this.addNodePathReference(owner, formattedNodePath, lineNumber, getNodeFormattedMatch.index, scriptClass);
      }
    }

    const formattedNodePathVariableRegex = /\b[A-Za-z_]\w*(?:_name|_path)\s*:=?\s*["']([^"']*%d[^"']*)["']\s*%/g;
    let formattedNodePathVariableMatch;
    while ((formattedNodePathVariableMatch = formattedNodePathVariableRegex.exec(code)) !== null) {
      const formattedNodePath = this.formattedNodePathBase(formattedNodePathVariableMatch[1]!);
      if (formattedNodePath) {
        const variableName = (code.slice(formattedNodePathVariableMatch.index).match(/\b([A-Za-z_]\w*(?:_name|_path))\s*:=?/) || [])[1];
        if (variableName) this.addNodePathAlias(aliasOwner, variableName, formattedNodePath);
        this.addNodePathReference(owner, formattedNodePath, lineNumber, formattedNodePathVariableMatch.index, scriptClass);
      }
    }

    const getNodeConstantRegex = /\b(?:get_node|get_node_or_null|has_node)\s*\(\s*([A-Za-z_]\w*)\s*\)/g;
    let getNodeConstantMatch;
    while ((getNodeConstantMatch = getNodeConstantRegex.exec(code)) !== null) {
      const constName = getNodeConstantMatch[1]!;
      const nodePath = this.lookupNodePathAlias(aliasOwner, constName) ?? this.stringConstants.get(constName);
      if (!nodePath) continue;
      this.addNodePathReference(owner, nodePath, lineNumber, getNodeConstantMatch.index, scriptClass);
    }

    const helperCallRegex = /\b([A-Za-z_]\w*)\s*\(([^)]*)\)/g;
    let helperCallMatch;
    while ((helperCallMatch = helperCallRegex.exec(code)) !== null) {
      const helperName = helperCallMatch[1]!;
      const argumentIndex = this.nodeLookupHelperArgumentIndex.get(helperName);
      if (argumentIndex === undefined) continue;
      const args = this.splitCallArguments(helperCallMatch[2]!);
      const nodePath = this.resolveStringArgument(aliasOwner, args[argumentIndex]);
      if (!nodePath) continue;
      this.addNodePathReference(owner, nodePath, lineNumber, helperCallMatch.index, scriptClass);
    }
  }

  private extractStringNodePathAlias(owner: string, code: string): void {
    const stringAliasRegex = /\b(?:var|const)\s+([A-Za-z_]\w*)\s*(?::\s*[A-Za-z_]\w*)?\s*:=?\s*&?["']([^"']+)["']/g;
    let stringAliasMatch;
    while ((stringAliasMatch = stringAliasRegex.exec(code)) !== null) {
      const value = stringAliasMatch[2]!;
      if (this.isLikelyNodePath(value)) {
        this.addNodePathAlias(owner, stringAliasMatch[1]!, value);
      }
    }
  }

  private resolveStringArgument(owner: string, argument: string | undefined): string | null {
    if (!argument) return null;
    const literal = argument.match(/^\s*&?["']([^"']+)["']\s*$/);
    if (literal) return literal[1]!;

    const identifier = argument.match(/^\s*([A-Za-z_]\w*)\s*$/);
    if (!identifier) return null;
    return this.resolveStringAlias(owner, identifier[1]!);
  }

  private resolveStringAlias(owner: string, name: string): string | null {
    return this.lookupNodePathAlias(owner, name) ?? this.stringConstants.get(name) ?? null;
  }

  private extractNodeLookupHelpers(functionScopes: FunctionScope[]): void {
    if (this.nodeLookupHelperArgumentIndex.size > 0) return;

    for (let i = 0; i < functionScopes.length; i++) {
      const scope = functionScopes[i]!;
      const node = this.nodes.find((candidate) => candidate.id === scope.id);
      if (!node) continue;

      const functionLine = this.stripComment(this.lines[scope.startLine - 1] ?? '');
      const params = this.extractFunctionParameterNames(functionLine);
      if (params.length === 0) continue;

      const endLineExclusive = this.functionBodyEndLine(scope, functionScopes, i);
      const body = this.lines
        .slice(scope.startLine, endLineExclusive - 1)
        .map((line) => this.stripComment(line))
        .join('\n');

      for (let paramIndex = 0; paramIndex < params.length; paramIndex++) {
        const paramName = params[paramIndex]!;
        const escaped = this.escapeRegExp(paramName);
        const directLookupRegex = new RegExp(`\\b(?:get_node|get_node_or_null|has_node|find_child)\\s*\\(\\s*${escaped}\\b`);
        const projectLookupRegex = new RegExp(`\\b_find_node\\s*\\([^,\\n]+,\\s*${escaped}\\b`);
        if (directLookupRegex.test(body) || projectLookupRegex.test(body)) {
          this.nodeLookupHelperArgumentIndex.set(node.name, paramIndex);
          break;
        }
      }
    }
  }

  private extractFunctionParameterNames(functionLine: string): string[] {
    const match = functionLine.match(/\bfunc\s+[A-Za-z_]\w*\s*\(([^)]*)\)/);
    if (!match) return [];
    return this.splitCallArguments(match[1]!)
      .map((arg) => (arg.trim().match(/^([A-Za-z_]\w*)/) || [])[1])
      .filter((name): name is string => Boolean(name));
  }

  private functionBodyEndLine(scope: FunctionScope, functionScopes: FunctionScope[], scopeIndex: number): number {
    for (let i = scopeIndex + 1; i < functionScopes.length; i++) {
      const next = functionScopes[i]!;
      if (next.indent <= scope.indent) return next.startLine;
    }
    return this.lines.length + 1;
  }

  private splitCallArguments(args: string): string[] {
    const result: string[] = [];
    let start = 0;
    let depth = 0;
    let inSingle = false;
    let inDouble = false;
    for (let i = 0; i < args.length; i++) {
      const char = args[i];
      const prev = args[i - 1];
      if (char === "'" && !inDouble && prev !== '\\') inSingle = !inSingle;
      if (char === '"' && !inSingle && prev !== '\\') inDouble = !inDouble;
      if (inSingle || inDouble) continue;
      if (char === '(' || char === '[' || char === '{') depth += 1;
      if (char === ')' || char === ']' || char === '}') depth -= 1;
      if (char === ',' && depth === 0) {
        result.push(args.slice(start, i));
        start = i + 1;
      }
    }
    result.push(args.slice(start));
    return result;
  }

  private escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  private addNodePathReference(owner: string, nodePath: string, lineNumber: number, column: number, scriptClass: Node | null): void {
    const cleaned = nodePath.replace(/^[$%]/, '');
    const name = this.nodePathReceiverName(cleaned);
    this.addReference(owner, name, 'references', lineNumber, column);
    if (cleaned.includes('/')) {
      this.addReference(owner, cleaned, 'references', lineNumber, column);
    }
    if (scriptClass && cleaned) {
      this.addReference(owner, `${scriptClass.name}/${cleaned}`, 'references', lineNumber, column);
    }
  }

  private addDynamicNodeNameDeclaration(name: string, rawLine: string, signature: string, lineNumber: number, owner: string): void {
    if (this.dynamicNodeNames.has(name)) return;
    this.dynamicNodeNames.add(name);
    const node = this.createNode(
      'component',
      name,
      `${this.filePath}::dynamic_node:${name}:${lineNumber}`,
      lineNumber,
      rawLine.indexOf(name),
      lineNumber,
      rawLine.length
    );
    node.signature = signature;
    this.addContains(owner, node.id);
  }

  private addNodePathAlias(owner: string, alias: string, nodePath: string): void {
    if (!this.nodePathAliases.has(owner)) this.nodePathAliases.set(owner, new Map());
    this.nodePathAliases.get(owner)!.set(alias, nodePath);
  }

  private lookupNodePathAlias(owner: string, alias: string): string | undefined {
    return this.nodePathAliases.get(owner)?.get(alias);
  }

  private extractFormattedNodePathBase(code: string): string | null {
    if (!/\b(?:get_node|get_node_or_null|has_node)\s*\(/.test(code) && !/\b[A-Za-z_]\w*\s*:=?\s*["'][^"']*%d/.test(code)) {
      return null;
    }

    const formattedStringMatch = code.match(/["']([^"']*%d[^"']*)["']\s*%/);
    if (!formattedStringMatch) return null;
    return this.formattedNodePathBase(formattedStringMatch[1]!);
  }

  private formattedNodePathBase(nodePath: string): string | null {
    if (!nodePath.includes('%d')) return null;
    const stripped = nodePath.replace(/%d/g, '');
    if (!/^[A-Z_][A-Za-z0-9_]*(?:\/[A-Z_][A-Za-z0-9_]*)*$/.test(stripped)) return null;
    return stripped;
  }

  private isSimpleNodeName(value: string): boolean {
    return /^[A-Z_][A-Za-z0-9_]*$/.test(value);
  }

  private isLikelyNodePath(value: string): boolean {
    return /^[A-Z_][A-Za-z0-9_]*(?:\/[A-Z_][A-Za-z0-9_]*)*$/.test(value);
  }

  private createDeclarationNode(kind: NodeKind, name: string, rawLine: string, line: number, indent: number): Node {
    const column = rawLine.indexOf(name);
    return this.createNode(kind, name, `${this.filePath}::${name}`, line, column < 0 ? indent : column, line, rawLine.length);
  }

  private createNode(kind: NodeKind, name: string, qualifiedName: string, startLine: number, startColumn: number, endLine: number, endColumn: number): Node {
    const node: Node = {
      id: generateNodeId(this.filePath, kind, name, startLine),
      kind,
      name,
      qualifiedName,
      filePath: this.filePath,
      language: 'gdscript',
      startLine,
      endLine,
      startColumn,
      endColumn,
      updatedAt: Date.now(),
    };
    this.nodes.push(node);
    return node;
  }

  private addContains(source: string, target: string): void {
    this.edges.push({ source, target, kind: 'contains' });
  }

  private addReference(fromNodeId: string, referenceName: string, referenceKind: UnresolvedReference['referenceKind'], line: number, column: number): void {
    this.unresolvedReferences.push({
      fromNodeId,
      referenceName,
      referenceKind,
      line,
      column,
      filePath: this.filePath,
      language: 'gdscript',
    });
  }

  private indentOf(line: string): number {
    let indent = 0;
    for (const char of line) {
      if (char === ' ') indent += 1;
      else if (char === '\t') indent += 4;
      else break;
    }
    return indent;
  }

  private stripComment(line: string): string {
    let inSingle = false;
    let inDouble = false;
    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      const prev = line[i - 1];
      if (char === "'" && !inDouble && prev !== '\\') inSingle = !inSingle;
      if (char === '"' && !inSingle && prev !== '\\') inDouble = !inDouble;
      if (char === '#' && !inSingle && !inDouble) return line.slice(0, i);
    }
    return line;
  }

  private findCallEnd(code: string, openingParenIndex: number): number {
    let depth = 0;
    let inSingle = false;
    let inDouble = false;
    for (let i = openingParenIndex; i < code.length; i++) {
      const char = code[i];
      const prev = code[i - 1];
      if (char === "'" && !inDouble && prev !== '\\') inSingle = !inSingle;
      if (char === '"' && !inSingle && prev !== '\\') inDouble = !inDouble;
      if (inSingle || inDouble) continue;
      if (char === '(') depth += 1;
      if (char === ')') {
        depth -= 1;
        if (depth === 0) return i;
      }
    }
    return code.length;
  }

  private getLineNumber(index: number): number {
    return this.source.substring(0, index).split('\n').length;
  }

  private getLineStart(line: number): number {
    let pos = 0;
    for (let i = 1; i < line; i++) {
      pos += (this.lines[i - 1]?.length ?? 0) + 1;
    }
    return pos;
  }

  private scriptClassNameFromPath(): string {
    const base = path.basename(this.filePath, path.extname(this.filePath));
    const words = base.split(/[^A-Za-z0-9]+/).filter(Boolean);
    const pascal = words.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join('');
    return pascal || path.basename(this.filePath);
  }

  private nodePathReceiverName(nodePath: string): string {
    const cleaned = nodePath.replace(/^[$%]/, '');
    const lastSegment = cleaned.split('/').filter(Boolean).pop();
    return lastSegment || cleaned || nodePath;
  }
}
