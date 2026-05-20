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

  it('returns false on Windows by default (mojibake-prone consoles)', () => {
    withEnv({ CODEGRAPH_ASCII: undefined, CODEGRAPH_UNICODE: undefined, TERM: undefined }, () => {
      setPlatform('win32');
      expect(supportsUnicode()).toBe(false);
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

  it('returns ASCII glyphs on Windows', () => {
    withEnv({ CODEGRAPH_ASCII: undefined, CODEGRAPH_UNICODE: undefined }, () => {
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
