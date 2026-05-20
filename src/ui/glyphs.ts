/**
 * Glyph selection for CLI output.
 *
 * On Windows, console output is interpreted via the active output
 * codepage. PowerShell 5.1 and cmd.exe default to OEM codepages
 * (CP437, CP936, ...), so UTF-8 bytes written to the console render
 * as mojibake (see #168). The shimmer worker is hit hardest because
 * it uses `fs.writeSync(1, ...)` (raw bytes, no TTY-aware encoding
 * conversion) to keep animation smooth while the main thread is
 * blocked in SQLite. To stay readable everywhere, we fall back to
 * ASCII glyphs whenever the terminal is not known to handle UTF-8.
 *
 * Detection is intentionally simple:
 *   - `CODEGRAPH_ASCII=1`  -> ASCII (escape hatch for any terminal)
 *   - `CODEGRAPH_UNICODE=1` -> Unicode (opt-in on Windows)
 *   - Windows              -> ASCII by default
 *   - Linux kernel console (`TERM=linux`) -> ASCII
 *   - Everything else      -> Unicode
 */

export function supportsUnicode(): boolean {
  if (process.env.CODEGRAPH_ASCII === '1') return false;
  if (process.env.CODEGRAPH_UNICODE === '1') return true;
  if (process.platform === 'win32') return false;
  return process.env.TERM !== 'linux';
}

export interface Glyphs {
  ok: string;
  err: string;
  info: string;
  warn: string;
  spinner: string[];
  barFilled: string;
  barEmpty: string;
  rail: string;
  phaseDone: string;
  dash: string;
  hLine: string;
  treeBranch: string;
  treeLast: string;
  treePipe: string;
}

export const UNICODE_GLYPHS: Glyphs = {
  ok: '✓',
  err: '✗',
  info: 'ℹ',
  warn: '⚠',
  spinner: ['·', '✢', '✳', '✶', '✻', '✽'],
  barFilled: '█',
  barEmpty: '░',
  rail: '│',
  phaseDone: '◆',
  dash: '—',
  hLine: '─',
  treeBranch: '├── ',
  treeLast: '└── ',
  treePipe: '│   ',
};

export const ASCII_GLYPHS: Glyphs = {
  ok: '[OK]',
  err: '[ERR]',
  info: '[i]',
  warn: '[!]',
  spinner: ['.', '*', '+', 'x', 'o', 'O'],
  barFilled: '#',
  barEmpty: '-',
  rail: '|',
  phaseDone: '*',
  dash: '-',
  hLine: '-',
  treeBranch: '|-- ',
  treeLast: '`-- ',
  treePipe: '|   ',
};

let cached: Glyphs | null = null;

export function getGlyphs(): Glyphs {
  if (cached === null) {
    cached = supportsUnicode() ? UNICODE_GLYPHS : ASCII_GLYPHS;
  }
  return cached;
}

/** Reset the cached glyph set. Test-only; production code should call `getGlyphs()`. */
export function _resetGlyphsCache(): void {
  cached = null;
}
