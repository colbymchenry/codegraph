import { Node, Edge, ExtractionResult, ExtractionError, UnresolvedReference, Language } from '../types';
import { generateNodeId } from './tree-sitter-helpers';
import { TreeSitterExtractor } from './tree-sitter';
import { isLanguageSupported } from './grammars';
import { vueOptionsMembers } from './vue-options-api';

/**
 * Vue built-in components — skipped so a `<Transition>` / `<KeepAlive>` in the
 * template doesn't become a phantom reference to a user component. Checked
 * AFTER kebab→Pascal conversion, so `<keep-alive>` is caught here too.
 */
const VUE_BUILTIN_COMPONENTS = new Set([
  'Transition',
  'TransitionGroup',
  'KeepAlive',
  'Suspense',
  'Teleport',
  'Component',
  'Slot',
]);

/** Keywords and literals a template expression can contain that bind nothing. */
const TEMPLATE_NON_BINDINGS = new Set([
  'true', 'false', 'null', 'undefined', 'this', 'in', 'of', 'typeof', 'instanceof',
  'new', 'void', 'delete', 'await', 'async', 'return', 'if', 'else', 'let', 'const',
  'var', 'function', 'class', 'NaN', 'Infinity',
]);

/** Globals Vue exposes to templates; a call to one is not a call into the repo. */
const JS_GLOBALS = new Set([
  'Math', 'JSON', 'Object', 'Array', 'Number', 'String', 'Boolean', 'Date', 'RegExp',
  'Map', 'Set', 'Promise', 'Symbol', 'BigInt', 'Intl', 'Error', 'console', 'window',
  'document', 'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'encodeURI',
  'encodeURIComponent', 'decodeURI', 'decodeURIComponent', 'require',
]);

/**
 * Local names a `<script>` block's ES imports bind: `Foo` from `import Foo`,
 * `a` and `c` from `import { a, b as c }`, `ns` from `import * as ns`.
 * Type-only imports bind nothing a template can use.
 */
function importedLocalNames(script: string): string[] {
  const names: string[] = [];
  const importRegex = /(?:^|[\n;])\s*import\s+(?!type\s)([^'";]+?)\s+from\s*['"]/g;
  let m: RegExpExecArray | null;
  while ((m = importRegex.exec(script)) !== null) {
    const clause = m[1]!;
    const braces = /\{([\s\S]*)\}/.exec(clause);
    const outside = braces ? clause.replace(braces[0], '') : clause;
    for (const part of outside.split(',')) {
      const ns = /\*\s*as\s+([A-Za-z_$][\w$]*)/.exec(part);
      const id = ns ? ns[1] : /^\s*([A-Za-z_$][\w$]*)\s*$/.exec(part)?.[1];
      if (id) names.push(id);
    }
    if (braces) {
      for (const spec of braces[1]!.split(',')) {
        if (/^\s*type\s/.test(spec)) continue;
        const id = /([A-Za-z_$][\w$]*)\s*$/.exec(spec.trim())?.[1];
        if (id) names.push(id);
      }
    }
  }
  return names;
}

/** `my-component` → `MyComponent` (Vue allows either form in templates). */
function kebabToPascal(name: string): string {
  return name
    .split('-')
    .map((part) => (part ? part[0]!.toUpperCase() + part.slice(1) : ''))
    .join('');
}

/**
 * VueExtractor - Extracts code relationships from Vue Single-File Component files
 *
 * Vue SFCs are multi-language (script + template + style). Rather than
 * parsing the full Vue grammar, we extract the <script> block content
 * and delegate it to the TypeScript/JavaScript TreeSitterExtractor.
 *
 * Every .vue file produces a component node (Vue components are always importable).
 */
export class VueExtractor {
  private filePath: string;
  private source: string;
  private nodes: Node[] = [];
  private edges: Edge[] = [];
  private unresolvedReferences: UnresolvedReference[] = [];
  private errors: ExtractionError[] = [];

  constructor(filePath: string, source: string) {
    this.filePath = filePath;
    this.source = source;
  }

  /**
   * Extract from Vue source
   */
  extract(): ExtractionResult {
    const startTime = Date.now();

    try {
      // Create component node for the .vue file itself
      const componentNode = this.createComponentNode();

      // Extract and process script blocks
      const scriptBlocks = this.extractScriptBlocks();

      // Names the <script> blocks bind (declarations + imports) — the only
      // names a template identifier can reach in Vue besides globals.
      const scriptBindings = new Set<string>();
      for (const block of scriptBlocks) {
        for (const name of this.processScriptBlock(block, componentNode.id)) scriptBindings.add(name);
        for (const name of importedLocalNames(block.content)) scriptBindings.add(name);
      }

      // Extract component usages from the <template> (<ComponentName>).
      // Without this, a Vue component used only in another component's
      // markup (incl. through a barrel import) is invisible to callers /
      // impact (#629 follow-up).
      this.extractTemplateComponents(componentNode.id);

      // Extract identifiers the template binds (`:prop="x"`, `@click="save"`,
      // `v-if="locked"`, `{{ label }}`). This is where a component's state is
      // actually rendered, so without it "where is `myLinkBrandingLocked`
      // used" had no answer from the graph and explore never reached the
      // template lines that bind it.
      this.extractTemplateBindings(componentNode.id, scriptBindings);
    } catch (error) {
      this.errors.push({
        message: `Vue extraction error: ${error instanceof Error ? error.message : String(error)}`,
        severity: 'error',
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

  /**
   * Create a component node for the .vue file
   */
  private createComponentNode(): Node {
    const lines = this.source.split('\n');
    const fileName = this.filePath.split(/[/\\]/).pop() || this.filePath;
    const componentName = fileName.replace(/\.vue$/, '');
    const id = generateNodeId(this.filePath, 'component', componentName, 1);

    const node: Node = {
      id,
      kind: 'component',
      name: componentName,
      qualifiedName: `${this.filePath}::${componentName}`,
      filePath: this.filePath,
      language: 'vue',
      startLine: 1,
      endLine: lines.length,
      startColumn: 0,
      endColumn: lines[lines.length - 1]?.length || 0,
      isExported: true, // Vue components are always importable
      updatedAt: Date.now(),
    };

    this.nodes.push(node);
    return node;
  }

  /**
   * Method nodes for an Options API component's members (see
   * ./vue-options-api), and the references and edges written inside each —
   * which the TS extractor attributed to the file — re-attributed to it.
   * Lines are block-relative here; the caller offsets them with the rest.
   */
  private addOptionsMembers(
    block: { content: string; startLine: number },
    result: ExtractionResult,
    componentNodeId: string
  ): void {
    const members = vueOptionsMembers(block.content);
    if (members.length === 0) return;
    const component = this.nodes.find((n) => n.id === componentNodeId);
    const owner = component?.name ?? 'component';
    const lineAt = (offset: number) => block.content.slice(0, offset).split('\n').length;
    const colAt = (offset: number) => offset - block.content.lastIndexOf('\n', offset - 1) - 1;
    const now = Date.now();
    const created: Node[] = [];
    for (const m of members) {
      const startLine = lineAt(m.start);
      const endLine = lineAt(m.end);
      created.push({
        id: generateNodeId(this.filePath, 'method', `${owner}.${m.name}`, startLine + block.startLine),
        kind: 'method',
        name: m.name,
        qualifiedName: `${owner}::${m.name}`,
        filePath: this.filePath,
        language: 'vue',
        startLine,
        endLine,
        startColumn: colAt(m.start),
        endColumn: colAt(m.end),
        updatedAt: now,
      });
    }
    // Innermost member for a line: `computed: { x: { get() {…} } }` is one member.
    const memberAt = (line: number): Node | undefined => {
      let best: Node | undefined;
      for (const n of created) {
        if (n.startLine <= line && n.endLine >= line && (!best || n.startLine >= best.startLine)) best = n;
      }
      return best;
    };
    // What the TS extractor attributed to the file (or to nothing narrower).
    const fileNode = result.nodes.find((n) => n.kind === 'file');
    const narrower = new Set(result.nodes.filter((n) => n.kind !== 'file').map((n) => n.id));
    const isFileLevel = (id: string) => (fileNode ? id === fileNode.id : !narrower.has(id));
    for (const ref of result.unresolvedReferences) {
      if (!isFileLevel(ref.fromNodeId)) continue;
      const member = memberAt(ref.line);
      if (member) ref.fromNodeId = member.id;
    }
    for (const edge of result.edges) {
      if (edge.kind === 'contains' || !edge.line || !isFileLevel(edge.source)) continue;
      const member = memberAt(edge.line);
      if (member) edge.source = member.id;
    }
    result.nodes.push(...created);
  }

  /**
   * Extract <script> and <script setup> blocks from the Vue source
   */
  private extractScriptBlocks(): Array<{
    content: string;
    startLine: number;
    isSetup: boolean;
    isTypeScript: boolean;
  }> {
    const blocks: Array<{
      content: string;
      startLine: number;
      isSetup: boolean;
      isTypeScript: boolean;
    }> = [];

    const scriptRegex = /<script(\s[^>]*)?>(?<content>[\s\S]*?)<\/script>/g;
    let match;

    while ((match = scriptRegex.exec(this.source)) !== null) {
      const attrs = match[1] || '';
      const content = match.groups?.content || match[2] || '';

      // Detect TypeScript from lang attribute
      const isTypeScript = /lang\s*=\s*["'](ts|typescript)["']/.test(attrs);

      // Detect <script setup>
      const isSetup = /\bsetup\b/.test(attrs);

      // Calculate the 0-indexed line where the content begins. The content
      // starts right after the opening tag's `>` — its leading `\n` is part
      // of the content, so relative line 1 sits ON the tag's closing line
      // (adding 1 here double-counted the embedded newline and shifted every
      // script-block symbol down a line).
      const beforeScript = this.source.substring(0, match.index);
      const scriptTagLine = (beforeScript.match(/\n/g) || []).length;
      const openingTag = match[0].substring(0, match[0].indexOf('>') + 1);
      const openingTagLines = (openingTag.match(/\n/g) || []).length;
      const contentStartLine = scriptTagLine + openingTagLines; // 0-indexed line

      blocks.push({
        content,
        startLine: contentStartLine,
        isSetup,
        isTypeScript,
      });
    }

    return blocks;
  }

  /**
   * Process a script block by delegating to TreeSitterExtractor
   */
  private processScriptBlock(
    block: { content: string; startLine: number; isSetup: boolean; isTypeScript: boolean },
    componentNodeId: string
  ): string[] {
    const scriptLanguage: Language = block.isTypeScript ? 'typescript' : 'javascript';

    // Check if the script language parser is available
    if (!isLanguageSupported(scriptLanguage)) {
      this.errors.push({
        message: `Parser for ${scriptLanguage} not available, cannot parse Vue script block`,
        severity: 'warning',
      });
      return [];
    }

    // Delegate to TreeSitterExtractor
    const extractor = new TreeSitterExtractor(this.filePath, block.content, scriptLanguage);
    const result = extractor.extract();

    // An Options API component's functions — `methods`, `computed`, `watch`,
    // lifecycle hooks — are object-literal members the TS extractor leaves as
    // part of the file. Name each one, and hand it the calls written inside it.
    if (!block.isSetup) this.addOptionsMembers(block, result, componentNodeId);

    // Offset line numbers from script block back to .vue file positions
    for (const node of result.nodes) {
      node.startLine += block.startLine;
      node.endLine += block.startLine;
      node.language = 'vue'; // Mark as vue, not TS/JS

      this.nodes.push(node);

      // Add containment edge from component to this node
      this.edges.push({
        source: componentNodeId,
        target: node.id,
        kind: 'contains',
      });
    }

    // Offset edges (they reference line numbers)
    for (const edge of result.edges) {
      if (edge.line) {
        edge.line += block.startLine;
      }
      this.edges.push(edge);
    }

    // Offset unresolved references
    for (const ref of result.unresolvedReferences) {
      ref.line += block.startLine;
      ref.filePath = this.filePath;
      ref.language = 'vue';
      this.unresolvedReferences.push(ref);
    }

    // Carry over errors
    for (const error of result.errors) {
      if (error.line) {
        error.line += block.startLine;
      }
      this.errors.push(error);
    }

    return result.nodes
      .filter((n) => n.kind !== 'import' && n.kind !== 'export')
      .map((n) => n.name);
  }

  /**
   * Extract the identifiers a Vue `<template>` binds as references.
   *
   * Scans directive values (`:prop` / `v-bind:`, `@event` / `v-on:`, `v-if`,
   * `v-show`, `v-model`, `v-for`'s source, ...) and `{{ mustache }}`
   * interpolations. In each expression:
   *
   * - `fn(...)` is a `calls` reference (as the Svelte extractor does for
   *   `{fn(...)}`), unless `fn` is a JS global, a `$`-prefixed Vue instance
   *   helper (`$emit`, `$t`) or a template-local.
   * - A bare identifier is a `references` reference ONLY when a `<script>`
   *   block declares or imports that name. Template scope is exactly those
   *   bindings plus globals, so the restriction drops nothing real, and it
   *   keeps object-literal keys and props-only names from name-matching a
   *   same-named symbol elsewhere in the repo (silent beats wrong).
   * - An `@event="save"` handler that is a bare name is a `calls` reference:
   *   Vue invokes it.
   *
   * `v-for` aliases and slot props (`v-slot="{ item }"`, `#row="{ item }"`)
   * are template-locals and never emitted.
   */
  private extractTemplateBindings(componentNodeId: string, scriptBindings: Set<string>): void {
    // Blank out <script>/<style> blocks and HTML comments, keeping every
    // newline, so offsets in the masked text are offsets in the file.
    const blank = (m: string) => m.replace(/[^\n]/g, ' ');
    const masked = this.source
      .replace(/<(script|style)(\s[^>]*)?>[\s\S]*?<\/\1>/g, blank)
      .replace(/<!--[\s\S]*?-->/g, blank);

    const lineStarts: number[] = [0];
    for (let i = 0; i < masked.length; i++) if (masked[i] === '\n') lineStarts.push(i + 1);
    const lineOf = (offset: number): number => {
      let lo = 0;
      let hi = lineStarts.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (lineStarts[mid]! <= offset) lo = mid;
        else hi = mid - 1;
      }
      return lo; // 0-indexed
    };

    // Directive attributes: `:x`, `@x`, `#x`, `v-xxx[:arg][.mod]`, with a quoted value.
    const directiveRegex = /\s((?:v-[a-z][\w-]*|[:@#])[^\s=>"']*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
    const expressions: Array<{ text: string; offset: number; handler: boolean }> = [];
    const templateLocals = new Set<string>();
    let m: RegExpExecArray | null;
    while ((m = directiveRegex.exec(masked)) !== null) {
      const name = m[1]!;
      const value = m[2] ?? m[3] ?? '';
      const valueOffset = m.index + m[0].length - value.length - 1;
      if (name.startsWith('#') || name.startsWith('v-slot')) {
        // Slot props declare template-locals; they reference nothing.
        for (const id of value.match(/[A-Za-z_$][\w$]*/g) ?? []) templateLocals.add(id);
        continue;
      }
      if (name === 'v-for') {
        // `(item, index) in items` / `item of items`: aliases are locals,
        // the source expression is a reference.
        const split = /^\s*([\s\S]*?)\s+(?:in|of)\s+([\s\S]*)$/.exec(value);
        if (split) {
          for (const id of split[1]!.match(/[A-Za-z_$][\w$]*/g) ?? []) templateLocals.add(id);
          expressions.push({ text: split[2]!, offset: valueOffset + value.length - split[2]!.length, handler: false });
        }
        continue;
      }
      const handler = name.startsWith('@') || name.startsWith('v-on');
      expressions.push({ text: value, offset: valueOffset, handler });
    }
    const mustacheRegex = /\{\{([\s\S]*?)\}\}/g;
    while ((m = mustacheRegex.exec(masked)) !== null) {
      expressions.push({ text: m[1]!, offset: m.index + 2, handler: false });
    }

    const seen = new Set<string>();
    const emit = (name: string, kind: 'calls' | 'references', offset: number) => {
      const line = lineOf(offset);
      const key = `${kind}:${name}:${line}`;
      if (seen.has(key)) return;
      seen.add(key);
      this.unresolvedReferences.push({
        fromNodeId: componentNodeId,
        referenceName: name,
        referenceKind: kind,
        line: line + 1, // 1-indexed
        column: offset - lineStarts[line]! + 1,
        filePath: this.filePath,
        language: 'vue',
      });
    };

    for (const expr of expressions) {
      // Blank string literals (keeping length) so their words aren't read as identifiers.
      const text = expr.text.replace(/(['"`])(?:\\.|(?!\1)[^\\])*\1/g, blank);
      const handlerName = expr.handler ? /^\s*([A-Za-z_$][\w$]*)\s*$/.exec(text)?.[1] : undefined;
      const idRegex = /[A-Za-z_$][\w$]*/g;
      let id: RegExpExecArray | null;
      while ((id = idRegex.exec(text)) !== null) {
        const name = id[0];
        const start = id.index;
        const before = text.slice(0, start).replace(/\s+$/, '');
        // A member (`obj.name`, `obj?.name`) is not a template binding; its head is.
        if (before.endsWith('.')) continue;
        // The tail of a number literal (`1e5`), not an identifier.
        if (start > 0 && /[\w$]/.test(text[start - 1]!)) continue;
        if (name.startsWith('$') || TEMPLATE_NON_BINDINGS.has(name) || templateLocals.has(name)) continue;
        const after = text.slice(start + name.length);
        // Object-literal key (`{ active: isActive }`), not a reference.
        if (/^\s*:(?!:)/.test(after) && /[{,]$/.test(before)) continue;
        const offset = expr.offset + start;
        if (/^\s*\(/.test(after)) {
          if (!JS_GLOBALS.has(name)) emit(name, 'calls', offset);
        } else if (scriptBindings.has(name)) {
          emit(name, name === handlerName ? 'calls' : 'references', offset);
        }
      }
    }
  }

  /**
   * Extract component usages from the Vue `<template>`.
   *
   * PascalCase tags (`<Modal>`, `<Button />`) and kebab-case tags
   * (`<my-button>`) both represent component instantiations — analogous to
   * function calls in imperative code. Capturing them creates parent→child
   * component edges and lets `callers` / `impact` see a component that is
   * only ever used in markup. Vue's extractor previously parsed only the
   * `<script>` block, so these usages produced no edge at all (#629).
   *
   * HTML elements (lowercase, no hyphen) and Vue built-ins are skipped.
   * Unmatched names create no edge during resolution, so converting
   * kebab-case is safe even for native custom elements.
   */
  private extractTemplateComponents(componentNodeId: string): void {
    // Ranges covered by <script> / <style> blocks — skip them so script
    // identifiers and CSS selectors aren't mistaken for template tags. This
    // also correctly handles nested <template> tags (v-if / slots), which a
    // single non-greedy <template>…</template> match would mis-bound.
    const coveredRanges: Array<[number, number]> = [];
    const blockRegex = /<(script|style)(\s[^>]*)?>[\s\S]*?<\/\1>/g;
    let blockMatch;
    while ((blockMatch = blockRegex.exec(this.source)) !== null) {
      const startLine = (this.source.substring(0, blockMatch.index).match(/\n/g) || []).length;
      const endLine = startLine + (blockMatch[0].match(/\n/g) || []).length;
      coveredRanges.push([startLine, endLine]);
    }

    const lines = this.source.split('\n');
    // Opening / self-closing tags (closing `</Foo>` starts with `</`, so the
    // leading `<` followed by a name letter won't match it).
    const tagRegex = /<([A-Za-z][A-Za-z0-9_-]*)\b/g;

    for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
      if (coveredRanges.some(([start, end]) => lineIdx >= start && lineIdx <= end)) continue;

      const line = lines[lineIdx]!;
      let match;
      while ((match = tagRegex.exec(line)) !== null) {
        const raw = match[1]!;
        let componentName: string;
        if (/^[A-Z]/.test(raw)) {
          componentName = raw; // PascalCase component
        } else if (raw.includes('-')) {
          componentName = kebabToPascal(raw); // kebab-case component
        } else {
          continue; // lowercase, no hyphen → native HTML element
        }
        if (VUE_BUILTIN_COMPONENTS.has(componentName)) continue;

        this.unresolvedReferences.push({
          fromNodeId: componentNodeId,
          referenceName: componentName,
          referenceKind: 'references',
          line: lineIdx + 1, // 1-indexed
          column: match.index + 1,
          filePath: this.filePath,
          language: 'vue',
        });
      }
    }
  }
}
