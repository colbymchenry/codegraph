/**
 * A Razor file as the C# class Razor compiles it to, as far as the names it
 * writes go: `@using` becomes a `using`, `@namespace` (or the project's root
 * namespace and the folder) the namespace around the class, `@inherits` and
 * `@implements` its base list, `@typeparam` its type parameters, `@inject` and
 * `@model` members, `@code` / `@functions` the rest of its body, and `@{ … }`,
 * `@typeof(…)`, a component tag and its type arguments (`<Grid TItem="Order">`)
 * what its render method writes. A folder's `_Imports.razor` applies to every
 * file below it.
 *
 * Where a piece of C# starts in the markup is found the way the Razor
 * extractor finds it, so a reference it emitted is read where it was written;
 * the piece itself is C#, for the C# grammar to read.
 */

import { razorCodeBlocks } from '../extraction/razor-extractor';

export interface RazorCsharp {
  /** The C# text. */
  text: string;
  /**
   * The rows of `text` (0-based) holding the C# of a `@code` / `@functions` /
   * `@{ }` block line, by the line of the Razor file (1-based). A row keeps the
   * columns the extractor reports: a block's first line counted from the block's
   * start, every other line as written.
   */
  codeRows: ReadonlyMap<number, readonly number[]>;
  /** The rows holding what a directive, a tag or a tag's type argument on that line of the Razor file names. */
  directiveRows: ReadonlyMap<number, readonly number[]>;
  /** Rows naming a type through a component tag, which writes no type arguments even where Razor infers some. */
  tagRows: ReadonlySet<number>;
}

/** What a Razor file and the `_Imports.razor` above it say with directives. */
interface RazorDirectives {
  usings: string[];
  namespace: string | null;
  inherits: { text: string; line: number | null } | null;
  implements: { text: string; line: number }[];
  members: { text: string; line: number | null }[];
  typeParameters: string[];
}

const DIRECTIVE = /^\s*@(using|namespace|inherits|implements|inject|model|typeparam)\s+(.*?)\s*;?\s*$/;

/** The directives of one Razor source, outside its C# blocks; `own` says whether its lines are where references are written. */
function readDirectives(lines: readonly string[], inBlock: ReadonlySet<number>, own: boolean, into: RazorDirectives): void {
  for (let i = 0; i < lines.length; i++) {
    if (inBlock.has(i + 1)) continue;
    const directive = DIRECTIVE.exec(lines[i]!);
    if (!directive) continue;
    const text = directive[2]!;
    const line = own ? i + 1 : null;
    switch (directive[1]) {
      case 'using': into.usings.push(text); break;
      case 'namespace': into.namespace = text; break;
      case 'inherits': into.inherits = { text, line }; break;
      case 'implements': if (line !== null) into.implements.push({ text, line }); break;
      case 'inject': into.members.push({ text: `${text};`, line }); break;
      case 'model': into.members.push({ text: `${text} Model;`, line }); break;
      case 'typeparam': if (own) into.typeParameters.push(text.split(/\s/)[0]!); break;
    }
  }
}

function splitLines(text: string): string[] {
  return text.split('\n').map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/** A C# identifier for the class a Razor file compiles to: its file name, as Razor names it. */
function className(file: string): string {
  const stem = (file.split('/').pop() ?? file).replace(/\.(razor|cshtml)$/i, '');
  const name = stem.replace(/[^A-Za-z0-9_]/g, '_');
  return /^[A-Za-z_]/.test(name) ? name : `_${name}`;
}

/**
 * The C# of the Razor file `file` (project-relative, `/`-separated). `read`
 * reads a project file; `rootNamespace` is the namespace Razor gives a
 * component in folder `dir` that no `@namespace` names.
 */
export function razorAsCsharp(file: string, read: (path: string) => string | null, rootNamespace: (dir: string) => string): RazorCsharp {
  const source = read(file) ?? '';
  const lines = splitLines(source);
  const blocks = razorCodeBlocks(source);
  const inBlock = new Set<number>();
  for (const block of blocks) {
    const count = block.content.split('\n').length;
    for (let i = 0; i < count; i++) inBlock.add(block.lineOffset + 1 + i);
  }

  const directives: RazorDirectives = { usings: [], namespace: null, inherits: null, implements: [], members: [], typeParameters: [] };
  // `_Imports.razor` from the project root down: a nearer one overrides what a farther one sets.
  const dir = file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : '';
  const parts = dir === '' ? [] : dir.split('/');
  for (let depth = 0; depth <= parts.length; depth++) {
    const folder = parts.slice(0, depth).join('/');
    const imports = folder === '' ? '_Imports.razor' : `${folder}/_Imports.razor`;
    if (imports === file) continue;
    const text = read(imports);
    if (text !== null) readDirectives(splitLines(text), new Set(), false, directives);
  }
  readDirectives(lines, inBlock, true, directives);

  const rows: string[] = [];
  const codeRows = new Map<number, number[]>();
  const directiveRows = new Map<number, number[]>();
  const tagRows = new Set<number>();
  const push = (text: string): number => rows.push(text) - 1;
  const at = (map: Map<number, number[]>, line: number | null, row: number): void => {
    if (line !== null) map.set(line, [...(map.get(line) ?? []), row]);
  };

  for (const using of directives.usings) push(`using ${using};`);
  const namespace = directives.namespace ?? rootNamespace(dir);
  if (namespace !== '') push(`namespace ${namespace} {`);
  push(`class ${className(file)}${directives.typeParameters.length > 0 ? `<${directives.typeParameters.join(', ')}>` : ''}`);
  const bases = [...(directives.inherits ? [directives.inherits] : []), ...directives.implements];
  bases.forEach((base, i) => {
    push(i === 0 ? ':' : ',');
    at(directiveRows, base.line, push(base.text));
  });
  push('{');
  for (const member of directives.members) at(directiveRows, member.line, push(member.text));
  const pushBlock = (block: { content: string; lineOffset: number }): void => {
    splitLines(block.content).forEach((text, i) => at(codeRows, block.lineOffset + 1 + i, push(text)));
  };
  for (const block of blocks) if (!block.statements) pushBlock(block);
  push('void __Render() {');
  for (const block of blocks) {
    if (!block.statements) continue;
    push('{');
    pushBlock(block);
    push('}');
  }
  const isComponentFile = /\.razor$/i.test(file);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    for (const m of line.matchAll(/@typeof\(\s*([A-Za-z_][\w.]*)\s*\)/g)) at(directiveRows, i + 1, push(`_ = typeof(${m[1]!});`));
    if (!isComponentFile || inBlock.has(i + 1)) continue;
    for (const tag of line.matchAll(/<([A-Z][A-Za-z0-9_]*)\b([^>]*)>/g)) {
      const row = push(`${tag[1]!} __tag;`);
      tagRows.add(row);
      at(directiveRows, i + 1, row);
      for (const argument of (tag[2] ?? '').matchAll(/\bT[A-Za-z]*\s*=\s*"([A-Za-z_][\w.]*)"/g)) {
        at(directiveRows, i + 1, push(`${argument[1]!} __argument;`));
      }
    }
  }
  push('}');
  push('}');
  if (namespace !== '') push('}');
  return { text: rows.join('\n'), codeRows, directiveRows, tagRows };
}
