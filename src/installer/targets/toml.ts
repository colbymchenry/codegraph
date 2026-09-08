/**
 * Tiny TOML helpers — just enough to inject / replace / remove a
 * single dotted-key table block (`[mcp_servers.codegraph]`) inside an
 * existing `~/.codex/config.toml`. We deliberately do NOT try to be a
 * general TOML parser/serializer; that would mean pulling in a
 * dependency (~50KB) for ~6 lines of output.
 *
 * Strategy: treat the file as text. Find the `[mcp_servers.codegraph]`
 * header line, splice it (and the lines that follow it until the next
 * `[...]` / `[[...]]` header or EOF) in or out. A small lexical scan keeps
 * header-shaped text inside multiline values out of the boundary search.
 * Everything outside that block is preserved verbatim, byte-for-byte.
 *
 * Limitations (acceptable for our narrow use):
 *   - Only writes a top-level table header. Array-of-tables and sibling
 *     subtables are preserved as opaque blocks (we always write the full
 *     dotted key `[mcp_servers.codegraph]`).
 *   - Doesn't validate sibling TOML — if the file is malformed
 *     elsewhere, our injection won't fix it but won't make it worse.
 *   - Quotes string values with double quotes; escapes `\` and `"`.
 */

/**
 * Serialize a record into the body lines of a TOML table. Values
 * supported: string, string[]. Other types throw — the codex MCP
 * config only needs these two.
 */
export function serializeTomlTableBody(values: Record<string, string | string[]>): string {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(values)) {
    if (typeof value === 'string') {
      lines.push(`${key} = ${quoteString(value)}`);
    } else if (Array.isArray(value) && value.every((v) => typeof v === 'string')) {
      const parts = value.map(quoteString).join(', ');
      lines.push(`${key} = [${parts}]`);
    } else {
      throw new Error(`Unsupported TOML value type for key "${key}"`);
    }
  }
  return lines.join('\n');
}

function quoteString(s: string): string {
  // TOML basic strings: backslash and double-quote escapes; control
  // chars not expected in our payload (paths/args).
  return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

/**
 * Build a full table block: header line + body. Suitable for direct
 * insertion into a TOML file.
 */
export function buildTomlTable(header: string, values: Record<string, string | string[]>): string {
  return `[${header}]\n${serializeTomlTableBody(values)}`;
}

/**
 * Insert or replace a top-level dotted-key TOML table block in the
 * given file content. Preserves all other content verbatim.
 *
 * Returns `'inserted'` when the table was newly added, `'replaced'`
 * when an existing one was rewritten, `'unchanged'` when the
 * existing block already matches `block` byte-for-byte.
 */
export function upsertTomlTable(
  fileContent: string,
  header: string,
  block: string,
): { content: string; action: 'inserted' | 'replaced' | 'unchanged' } {
  const headerLine = `[${header}]`;
  const headerIdx = findHeaderIndex(fileContent, headerLine);

  if (headerIdx === -1) {
    // Insert at end with separating blank line if there's existing content.
    const trimmed = fileContent.trimEnd();
    const sep = trimmed.length > 0 ? '\n\n' : '';
    return {
      content: trimmed + sep + block + '\n',
      action: 'inserted',
    };
  }

  // Find the end of this block: next table header or EOF.
  const blockEnd = findNextTableHeader(fileContent, headerIdx + headerLine.length);
  const existingBlock = fileContent.substring(headerIdx, blockEnd).replace(/\n+$/, '');

  if (existingBlock === block) {
    return { content: fileContent, action: 'unchanged' };
  }

  const before = fileContent.substring(0, headerIdx);
  const after = fileContent.substring(blockEnd);
  // Trim trailing blank lines from `before` (we'll re-add one) and
  // leading blank lines from `after` so the file shape stays clean.
  const beforeClean = before.replace(/\n+$/, '');
  const afterClean = after.replace(/^\n+/, '');
  const sepBefore = beforeClean.length > 0 ? '\n\n' : '';
  const sepAfter = afterClean.length > 0 ? '\n\n' : '\n';
  return {
    content: beforeClean + sepBefore + block + sepAfter + afterClean,
    action: 'replaced',
  };
}

/**
 * Remove a top-level dotted-key TOML table block. Returns the
 * possibly-empty new content + an action flag.
 */
export function removeTomlTable(
  fileContent: string,
  header: string,
): { content: string; action: 'removed' | 'not-found' } {
  const headerLine = `[${header}]`;
  const headerIdx = findHeaderIndex(fileContent, headerLine);
  if (headerIdx === -1) return { content: fileContent, action: 'not-found' };

  const blockEnd = findNextTableHeader(fileContent, headerIdx + headerLine.length);
  const before = fileContent.substring(0, headerIdx).replace(/\n+$/, '');
  const after = fileContent.substring(blockEnd).replace(/^\n+/, '');
  const joined = before + (before && after ? '\n\n' : '') + after;
  return { content: joined, action: 'removed' };
}

/**
 * Locate the byte index of a header line (`[foo.bar]`) when it
 * appears at the start of a line. Returns -1 if not found.
 */
function findHeaderIndex(content: string, headerLine: string): number {
  // Search BOL or right after a newline.
  if (content.startsWith(headerLine)) return 0;
  const needle = '\n' + headerLine;
  const idx = content.indexOf(needle);
  return idx === -1 ? -1 : idx + 1;
}

/**
 * Find the byte index of the next `[...]` or `[[...]]` table header
 * starting from `from`, or return content length when none.
 */
function findNextTableHeader(content: string, from: number): number {
  const state: TomlLexState = { multilineString: null, arrayDepth: 0, inlineTableDepth: 0 };
  let lineStart = from;
  let isHeaderRemainder = true;

  while (lineStart < content.length) {
    const newlineIdx = content.indexOf('\n', lineStart);
    const lineEnd = newlineIdx === -1 ? content.length : newlineIdx;
    const line = content.slice(lineStart, lineEnd);

    if (
      !isHeaderRemainder &&
      state.multilineString === null &&
      state.arrayDepth === 0 &&
      state.inlineTableDepth === 0 &&
      isTomlTableHeader(line)
    ) {
      return lineStart;
    }

    scanTomlLine(line, state);
    if (newlineIdx === -1) break;
    lineStart = newlineIdx + 1;
    isHeaderRemainder = false;
  }

  return content.length;
}

type MultilineStringDelimiter = '"""' | "'''";

interface TomlLexState {
  multilineString: MultilineStringDelimiter | null;
  arrayDepth: number;
  inlineTableDepth: number;
}

const TOML_KEY_PART = String.raw`(?:[A-Za-z0-9_-]+|"(?:\\.|[^"\\])*"|'[^']*')`;
const TOML_DOTTED_KEY = String.raw`${TOML_KEY_PART}(?:[ \t]*\.[ \t]*${TOML_KEY_PART})*`;
const TOML_TABLE = String.raw`\[[ \t]*${TOML_DOTTED_KEY}[ \t]*\]`;
const TOML_ARRAY_TABLE = String.raw`\[\[[ \t]*${TOML_DOTTED_KEY}[ \t]*\]\]`;
const TOML_TABLE_HEADER = new RegExp(
  String.raw`^[ \t]*(?:${TOML_TABLE}|${TOML_ARRAY_TABLE})[ \t]*(?:#.*)?\r?$`
);

function isTomlTableHeader(line: string): boolean {
  return TOML_TABLE_HEADER.test(line);
}

/** Track value constructs that may legally span lines so bracket-shaped string
 * content and nested arrays cannot be mistaken for sibling table headers. */
function scanTomlLine(line: string, state: TomlLexState): void {
  for (let i = 0; i < line.length;) {
    if (state.multilineString !== null) {
      const end = findMultilineStringEnd(line, i, state.multilineString);
      if (end === -1) return;
      i = end + state.multilineString.length;
      state.multilineString = null;
      continue;
    }

    if (line[i] === '#') return;

    const multiline = line.startsWith('"""', i)
      ? '"""'
      : line.startsWith("'''", i)
        ? "'''"
        : null;
    if (multiline !== null) {
      state.multilineString = multiline;
      i += multiline.length;
      continue;
    }

    const ch = line[i]!;
    if (ch === '"' || ch === "'") {
      i = skipSingleLineString(line, i, ch);
      continue;
    }
    if (ch === '[') state.arrayDepth++;
    else if (ch === ']' && state.arrayDepth > 0) state.arrayDepth--;
    else if (ch === '{') state.inlineTableDepth++;
    else if (ch === '}' && state.inlineTableDepth > 0) state.inlineTableDepth--;
    i++;
  }
}

function findMultilineStringEnd(
  line: string,
  from: number,
  delimiter: MultilineStringDelimiter,
): number {
  let end = line.indexOf(delimiter, from);
  while (delimiter === '"""' && end !== -1 && isBackslashEscaped(line, end)) {
    end = line.indexOf(delimiter, end + 1);
  }
  return end;
}

function isBackslashEscaped(line: string, index: number): boolean {
  let backslashes = 0;
  for (let i = index - 1; i >= 0 && line[i] === '\\'; i--) backslashes++;
  return backslashes % 2 === 1;
}

function skipSingleLineString(line: string, start: number, quote: '"' | "'"): number {
  for (let i = start + 1; i < line.length; i++) {
    if (quote === '"' && line[i] === '\\') {
      i++;
      continue;
    }
    if (line[i] === quote) return i + 1;
  }
  return line.length;
}
