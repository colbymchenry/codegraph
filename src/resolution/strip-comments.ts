/**
 * Per-language comment stripper for framework route extractors.
 *
 * Replaces comment characters and string-literal contents that hide
 * routing-shaped text with spaces (NOT removal) so that source offsets
 * are preserved. This means `match.index` from a regex run on the
 * stripped output still maps to the same line in the original source.
 *
 * Example:
 *   Input:  "x = 1  # path('/fake/', V)\n real = 2"
 *   Output: "x = 1                       \n real = 2"
 *
 * Why strip strings/docstrings as well as comments? Python module/class
 * docstrings are a common source of false positives — they often contain
 * `path('/example/', View)` examples in usage docs. We treat triple-quoted
 * strings the same as comments. Single-line strings stay intact (a `#`
 * inside a Python string is NOT a comment).
 *
 * Scope: this is a pragmatic, regex-supporting helper, not a full parser.
 * It does NOT try to detect JS regex literals, Python f-string expressions,
 * or shell-style heredocs. Those edge cases are not load-bearing for the
 * `path(...)`, `Route::get(...)`, `app.get(...)` style patterns that
 * framework extractors scan for.
 */

export type CommentLang =
  | 'python'
  | 'javascript'
  | 'typescript'
  | 'php'
  | 'ruby'
  | 'java'
  | 'csharp'
  | 'swift'
  | 'go'
  | 'rust'
  | 'c'
  | 'cpp'
  | 'erlang';

export function stripCommentsForRegex(content: string, lang: CommentLang): string {
  switch (lang) {
    case 'python':
      return stripPython(content);
    case 'ruby':
      return stripRuby(content);
    case 'rust':
      return stripRust(content);
    case 'erlang':
      return stripErlang(content);
    case 'php':
      return stripPhp(content);
    case 'go':
      return stripGo(content);
    case 'javascript':
    case 'typescript':
    case 'java':
    case 'csharp':
    case 'swift':
    case 'c':
    case 'cpp':
      return stripCStyle(content, /* allowSingleQuoteStrings */ lang === 'javascript' || lang === 'typescript');
    default:
      return content;
  }
}

/**
 * Replace every char in a slice with spaces, but keep newlines so line
 * numbers computed downstream remain valid.
 */
function blankRange(buf: string[], start: number, end: number, src: string): void {
  for (let i = start; i < end; i++) {
    buf[i] = src[i] === '\n' ? '\n' : ' ';
  }
}

// ---------- Python ----------

function stripPython(src: string): string {
  const out = src.split('');
  let i = 0;
  const n = src.length;

  while (i < n) {
    const c = src[i]!;
    const c2 = src[i + 1] ?? '';
    const c3 = src[i + 2] ?? '';

    // Triple-quoted string: """...""" or '''...'''
    if ((c === '"' || c === "'") && c2 === c && c3 === c) {
      const quote = c;
      const start = i;
      i += 3;
      while (i < n) {
        if (src[i] === '\\' && i + 1 < n) {
          i += 2;
          continue;
        }
        if (src[i] === quote && src[i + 1] === quote && src[i + 2] === quote) {
          i += 3;
          break;
        }
        i++;
      }
      blankRange(out, start, i, src);
      continue;
    }

    // Single-line string: '...' or "..."
    if (c === '"' || c === "'") {
      const quote = c;
      i++;
      while (i < n && src[i] !== quote) {
        if (src[i] === '\\' && i + 1 < n) {
          i += 2;
          continue;
        }
        if (src[i] === '\n') break; // unterminated
        i++;
      }
      if (i < n && src[i] === quote) i++;
      continue;
    }

    // Line comment
    if (c === '#') {
      const start = i;
      while (i < n && src[i] !== '\n') i++;
      blankRange(out, start, i, src);
      continue;
    }

    i++;
  }

  return out.join('');
}

// ---------- Ruby ----------

function stripRuby(src: string): string {
  const out = src.split('');
  let i = 0;
  const n = src.length;
  let atLineStart = true;

  while (i < n) {
    const c = src[i]!;

    // =begin / =end block comments must be at start of line (after optional whitespace)
    if (atLineStart && c === '=' && src.startsWith('=begin', i)) {
      const start = i;
      // consume to matching =end at line start
      i += '=begin'.length;
      while (i < n) {
        if (src[i] === '\n') {
          // check next line for =end
          let j = i + 1;
          while (j < n && (src[j] === ' ' || src[j] === '\t')) j++;
          if (src.startsWith('=end', j)) {
            i = j + '=end'.length;
            // consume rest of that line
            while (i < n && src[i] !== '\n') i++;
            break;
          }
        }
        i++;
      }
      blankRange(out, start, i, src);
      atLineStart = i > 0 && src[i - 1] === '\n';
      continue;
    }

    // String literals
    if (c === '"' || c === "'") {
      const quote = c;
      i++;
      while (i < n && src[i] !== quote) {
        if (src[i] === '\\' && i + 1 < n) {
          i += 2;
          continue;
        }
        if (src[i] === '\n') break;
        i++;
      }
      if (i < n && src[i] === quote) i++;
      atLineStart = false;
      continue;
    }

    // Line comment
    if (c === '#') {
      const start = i;
      while (i < n && src[i] !== '\n') i++;
      blankRange(out, start, i, src);
      atLineStart = false;
      continue;
    }

    if (c === '\n') {
      atLineStart = true;
      i++;
      continue;
    }
    if (c === ' ' || c === '\t') {
      // whitespace doesn't change atLineStart
      i++;
      continue;
    }
    atLineStart = false;
    i++;
  }

  return out.join('');
}

// ---------- C-style (JS/TS/Java/C#/Swift) ----------

function stripCStyle(src: string, allowSingleQuoteStrings: boolean): string {
  const out = src.split('');
  let i = 0;
  const n = src.length;

  while (i < n) {
    const c = src[i]!;
    const c2 = src[i + 1] ?? '';

    // Block comment
    if (c === '/' && c2 === '*') {
      const start = i;
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++;
      if (i < n) i += 2;
      blankRange(out, start, i, src);
      continue;
    }

    // Line comment
    if (c === '/' && c2 === '/') {
      const start = i;
      while (i < n && src[i] !== '\n') i++;
      blankRange(out, start, i, src);
      continue;
    }

    // String literals
    if (c === '"' || (allowSingleQuoteStrings && c === "'") || c === '`') {
      const quote = c;
      i++;
      while (i < n && src[i] !== quote) {
        if (src[i] === '\\' && i + 1 < n) {
          i += 2;
          continue;
        }
        // Template literal can span lines; regular strings break on newline (treat as unterminated)
        if (quote !== '`' && src[i] === '\n') break;
        i++;
      }
      if (i < n && src[i] === quote) i++;
      continue;
    }

    i++;
  }

  return out.join('');
}

// ---------- PHP ----------

function stripPhp(src: string): string {
  const out = src.split('');
  let i = 0;
  const n = src.length;

  while (i < n) {
    const c = src[i]!;
    const c2 = src[i + 1] ?? '';

    // Block comment
    if (c === '/' && c2 === '*') {
      const start = i;
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++;
      if (i < n) i += 2;
      blankRange(out, start, i, src);
      continue;
    }

    // // line comment
    if (c === '/' && c2 === '/') {
      const start = i;
      while (i < n && src[i] !== '\n') i++;
      blankRange(out, start, i, src);
      continue;
    }

    // # line comment (PHP supports both)
    if (c === '#') {
      const start = i;
      while (i < n && src[i] !== '\n') i++;
      blankRange(out, start, i, src);
      continue;
    }

    // String literals: ', ", ` (PHP doesn't really use backticks for strings,
    // but it does have shell-exec backticks; treating as a string is fine here)
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      i++;
      while (i < n && src[i] !== quote) {
        if (src[i] === '\\' && i + 1 < n) {
          i += 2;
          continue;
        }
        if (src[i] === '\n') break;
        i++;
      }
      if (i < n && src[i] === quote) i++;
      continue;
    }

    i++;
  }

  return out.join('');
}

// ---------- Go ----------

function stripGo(src: string): string {
  const out = src.split('');
  let i = 0;
  const n = src.length;

  while (i < n) {
    const c = src[i]!;
    const c2 = src[i + 1] ?? '';

    // Block comment
    if (c === '/' && c2 === '*') {
      const start = i;
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++;
      if (i < n) i += 2;
      blankRange(out, start, i, src);
      continue;
    }

    // Line comment
    if (c === '/' && c2 === '/') {
      const start = i;
      while (i < n && src[i] !== '\n') i++;
      blankRange(out, start, i, src);
      continue;
    }

    // Raw string with backticks (no escapes, can span lines)
    if (c === '`') {
      i++;
      while (i < n && src[i] !== '`') i++;
      if (i < n) i++;
      continue;
    }

    // Interpreted string with double quotes
    if (c === '"') {
      i++;
      while (i < n && src[i] !== '"') {
        if (src[i] === '\\' && i + 1 < n) {
          i += 2;
          continue;
        }
        if (src[i] === '\n') break;
        i++;
      }
      if (i < n && src[i] === '"') i++;
      continue;
    }

    // Rune literal with single quotes (handle as a tiny string)
    if (c === "'") {
      i++;
      while (i < n && src[i] !== "'") {
        if (src[i] === '\\' && i + 1 < n) {
          i += 2;
          continue;
        }
        if (src[i] === '\n') break;
        i++;
      }
      if (i < n && src[i] === "'") i++;
      continue;
    }

    i++;
  }

  return out.join('');
}

// ---------- Rust ----------

function stripRust(src: string): string {
  const out = src.split('');
  let i = 0;
  const n = src.length;

  while (i < n) {
    const c = src[i]!;
    const c2 = src[i + 1] ?? '';

    // Nested block comment /* ... /* ... */ ... */
    if (c === '/' && c2 === '*') {
      const start = i;
      i += 2;
      let depth = 1;
      while (i < n && depth > 0) {
        if (src[i] === '/' && src[i + 1] === '*') {
          depth++;
          i += 2;
        } else if (src[i] === '*' && src[i + 1] === '/') {
          depth--;
          i += 2;
        } else {
          i++;
        }
      }
      blankRange(out, start, i, src);
      continue;
    }

    // Line comment
    if (c === '/' && c2 === '/') {
      const start = i;
      while (i < n && src[i] !== '\n') i++;
      blankRange(out, start, i, src);
      continue;
    }

    // String literals
    if (c === '"') {
      i++;
      while (i < n && src[i] !== '"') {
        if (src[i] === '\\' && i + 1 < n) {
          i += 2;
          continue;
        }
        i++;
      }
      if (i < n && src[i] === '"') i++;
      continue;
    }

    // Char literal — keep simple: skip 'x' or '\x'
    if (c === "'") {
      // Could be a lifetime, e.g. 'a, but those don't contain routing text
      i++;
      while (i < n && src[i] !== "'") {
        if (src[i] === '\\' && i + 1 < n) {
          i += 2;
          continue;
        }
        if (src[i] === '\n') break;
        i++;
      }
      if (i < n && src[i] === "'") i++;
      continue;
    }

    i++;
  }

  return out.join('');
}

// ---------- Erlang ----------

/**
 * Erlang: `%` starts a line comment unless it sits inside a `"string"`, a
 * `'quoted atom'`, or is the character literal `$%`. Strings and quoted atoms
 * are left intact (a behaviour callback name can be a quoted atom); only the
 * comment text is blanked.
 */
function stripErlang(src: string): string {
  const out = src.split('');
  let i = 0;
  const n = src.length;

  while (i < n) {
    const c = src[i];

    if (c === '"' || c === "'") {
      const quote = c;
      i++;
      while (i < n && src[i] !== quote) {
        if (src[i] === '\\' && i + 1 < n) {
          i += 2;
          continue;
        }
        i++;
      }
      if (i < n) i++;
      continue;
    }

    // Character literal: `$x`, `$\n`, `$%` — the next char (or escape) is data.
    if (c === '$') {
      i++;
      if (i < n && src[i] === '\\') i++;
      i++;
      continue;
    }

    if (c === '%') {
      let end = i;
      while (end < n && src[end] !== '\n') end++;
      blankRange(out, i, end, src);
      i = end;
      continue;
    }

    i++;
  }

  return out.join('');
}
