/**
 * Glyph fallback / Unicode-support detection.
 *
 * Pinned because the matrix is small and the consequence of regression
 * is highly visible: shimmer-worker output on Windows mojibakes when
 * UTF-8 glyphs are written via `fs.writeSync` (see #168). The detection
 * + ASCII fallback is the contract that prevents this.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  supportsUnicode,
  supportsUnicodeRawWrites,
  getGlyphs,
  UNICODE_GLYPHS,
  ASCII_GLYPHS,
  _resetGlyphsCache,
} from '../src/ui/glyphs';

function withEnv(patch: Record<string, string | undefined>, fn: () => void): void {
  const saved: Record<string, string | undefined> = {};
  const savedPlatform = process.platform;
  for (const key of Object.keys(patch)) {
    saved[key] = process.env[key];
    if (patch[key] === undefined) delete process.env[key];
    else process.env[key] = patch[key];
  }
  _resetGlyphsCache();
  try {
    fn();
  } finally {
    for (const key of Object.keys(saved)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    Object.defineProperty(process, 'platform', { value: savedPlatform });
    _resetGlyphsCache();
  }
}

function setPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value });
}

describe('supportsUnicode', () => {
  let originalPlatform: NodeJS.Platform;

  beforeEach(() => {
    originalPlatform = process.platform;
    _resetGlyphsCache();
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
    _resetGlyphsCache();
  });

  /** Clears every signal the Windows detection reads, so cases are explicit. */
  const NO_TERMINAL_SIGNALS: Record<string, string | undefined> = {
    CODEGRAPH_ASCII: undefined,
    CODEGRAPH_UNICODE: undefined,
    TERM: undefined,
    CI: undefined,
    WT_SESSION: undefined,
    TERMINUS_SUBLIME: undefined,
    ConEmuTask: undefined,
    TERM_PROGRAM: undefined,
    TERMINAL_EMULATOR: undefined,
  };

  it('returns false on Windows in an unrecognized console (mojibake-prone legacy conhost)', () => {
    withEnv(NO_TERMINAL_SIGNALS, () => {
      setPlatform('win32');
      expect(supportsUnicode()).toBe(false);
    });
  });

  // The Windows allowlist must match @clack/prompts' bundled detection —
  // wherever clack draws its Unicode frame, our rails must be Unicode too,
  // or `codegraph index` mixes `|` and `│` in one output block (#398).
  it.each([
    ['Windows Terminal', { WT_SESSION: 'a-guid' }],
    ['VS Code terminal', { TERM_PROGRAM: 'vscode' }],
    ['ConEmu/Cmder', { ConEmuTask: '{cmd::Cmder}' }],
    ['Alacritty', { TERM: 'alacritty' }],
    ['xterm-256color', { TERM: 'xterm-256color' }],
    ['JetBrains terminal', { TERMINAL_EMULATOR: 'JetBrains-JediTerm' }],
    ['CI', { CI: 'true' }],
  ])('returns true on Windows in %s (agrees with clack, #398)', (_name, envPatch) => {
    withEnv({ ...NO_TERMINAL_SIGNALS, ...envPatch }, () => {
      setPlatform('win32');
      expect(supportsUnicode()).toBe(true);
    });
  });

  it('CODEGRAPH_ASCII=1 still wins inside Windows Terminal (escape hatch)', () => {
    withEnv({ ...NO_TERMINAL_SIGNALS, CODEGRAPH_ASCII: '1', WT_SESSION: 'a-guid' }, () => {
      setPlatform('win32');
      expect(supportsUnicode()).toBe(false);
    });
  });

  // The raw fs.writeSync(1) path (shimmer animation frames) decodes through
  // the console CODEPAGE on Windows, so it must stay ASCII there even in
  // terminals where the codepage-immune main-thread path goes Unicode (#168).
  describe('supportsUnicodeRawWrites', () => {
    it('stays ASCII on Windows even inside Windows Terminal / vscode / CI', () => {
      for (const envPatch of [{ WT_SESSION: 'a-guid' }, { TERM_PROGRAM: 'vscode' }, { CI: 'true' }]) {
        withEnv({ ...NO_TERMINAL_SIGNALS, ...envPatch }, () => {
          setPlatform('win32');
          expect(supportsUnicodeRawWrites()).toBe(false);
          expect(supportsUnicode()).toBe(true); // main-thread path DOES go Unicode there
        });
      }
    });

    it('CODEGRAPH_UNICODE=1 opts the raw path in on Windows', () => {
      withEnv({ ...NO_TERMINAL_SIGNALS, CODEGRAPH_UNICODE: '1' }, () => {
        setPlatform('win32');
        expect(supportsUnicodeRawWrites()).toBe(true);
      });
    });

    it('matches supportsUnicode() off Windows (Unicode on macOS, ASCII on TERM=linux)', () => {
      withEnv({ ...NO_TERMINAL_SIGNALS }, () => {
        setPlatform('darwin');
        expect(supportsUnicodeRawWrites()).toBe(true);
      });
      withEnv({ ...NO_TERMINAL_SIGNALS, TERM: 'linux' }, () => {
        setPlatform('linux');
        expect(supportsUnicodeRawWrites()).toBe(false);
      });
    });
  });

  it('returns true on macOS by default', () => {
    withEnv({ CODEGRAPH_ASCII: undefined, CODEGRAPH_UNICODE: undefined, TERM: undefined }, () => {
      setPlatform('darwin');
      expect(supportsUnicode()).toBe(true);
    });
  });

  it('returns true on Linux by default', () => {
    withEnv({ CODEGRAPH_ASCII: undefined, CODEGRAPH_UNICODE: undefined, TERM: undefined }, () => {
      setPlatform('linux');
      expect(supportsUnicode()).toBe(true);
    });
  });

  it('returns false on Linux kernel console (TERM=linux)', () => {
    withEnv({ CODEGRAPH_ASCII: undefined, CODEGRAPH_UNICODE: undefined, TERM: 'linux' }, () => {
      setPlatform('linux');
      expect(supportsUnicode()).toBe(false);
    });
  });

  it('respects CODEGRAPH_UNICODE=1 on Windows (opt-in escape hatch)', () => {
    withEnv({ CODEGRAPH_UNICODE: '1', CODEGRAPH_ASCII: undefined }, () => {
      setPlatform('win32');
      expect(supportsUnicode()).toBe(true);
    });
  });

  it('respects CODEGRAPH_ASCII=1 on macOS (opt-out escape hatch)', () => {
    withEnv({ CODEGRAPH_ASCII: '1', CODEGRAPH_UNICODE: undefined }, () => {
      setPlatform('darwin');
      expect(supportsUnicode()).toBe(false);
    });
  });

  it('CODEGRAPH_ASCII takes precedence over CODEGRAPH_UNICODE', () => {
    withEnv({ CODEGRAPH_ASCII: '1', CODEGRAPH_UNICODE: '1' }, () => {
      setPlatform('darwin');
      expect(supportsUnicode()).toBe(false);
    });
  });
});

describe('getGlyphs', () => {
  let originalPlatform: NodeJS.Platform;

  beforeEach(() => {
    originalPlatform = process.platform;
    _resetGlyphsCache();
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
    _resetGlyphsCache();
  });

  it('returns ASCII glyphs on Windows in an unrecognized console', () => {
    withEnv(
      {
        CODEGRAPH_ASCII: undefined,
        CODEGRAPH_UNICODE: undefined,
        TERM: undefined,
        CI: undefined,
        WT_SESSION: undefined,
        TERMINUS_SUBLIME: undefined,
        ConEmuTask: undefined,
        TERM_PROGRAM: undefined,
        TERMINAL_EMULATOR: undefined,
      },
      () => {
      setPlatform('win32');
      const g = getGlyphs();
      expect(g).toBe(ASCII_GLYPHS);
      expect(g.ok).toBe('[OK]');
      expect(g.rail).toBe('|');
      expect(g.phaseDone).toBe('*');
      expect(g.dash).toBe('-');
    });
  });

  it('returns Unicode glyphs on macOS', () => {
    withEnv({ CODEGRAPH_ASCII: undefined, CODEGRAPH_UNICODE: undefined }, () => {
      setPlatform('darwin');
      const g = getGlyphs();
      expect(g).toBe(UNICODE_GLYPHS);
      expect(g.ok).toBe('✓');
      expect(g.rail).toBe('│');
      expect(g.phaseDone).toBe('◆');
      expect(g.dash).toBe('—');
    });
  });

  it('caches the result so repeated calls return the same object', () => {
    withEnv({ CODEGRAPH_ASCII: undefined, CODEGRAPH_UNICODE: undefined }, () => {
      setPlatform('darwin');
      expect(getGlyphs()).toBe(getGlyphs());
    });
  });
});

describe('Glyph sets', () => {
  it('ASCII and Unicode sets cover the same keys', () => {
    expect(Object.keys(ASCII_GLYPHS).sort()).toEqual(Object.keys(UNICODE_GLYPHS).sort());
  });

  it('ASCII glyphs are all 7-bit ASCII', () => {
    for (const [key, value] of Object.entries(ASCII_GLYPHS)) {
      const flat = Array.isArray(value) ? value.join('') : value;
      for (let i = 0; i < flat.length; i++) {
        const codepoint = flat.charCodeAt(i);
        expect(codepoint, `ASCII_GLYPHS.${key} contains non-ASCII char U+${codepoint.toString(16).toUpperCase().padStart(4, '0')}`).toBeLessThan(128);
      }
    }
  });

  it('ASCII spinner has the same frame count as the Unicode spinner', () => {
    expect(ASCII_GLYPHS.spinner.length).toBe(UNICODE_GLYPHS.spinner.length);
  });
});
