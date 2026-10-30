import { describe, it, expect } from 'vitest';
import { stripCommentsForRegex, templateLiteralTextAt } from '../src/resolution/strip-comments';

describe('stripCommentsForRegex', () => {
  it('python: strips line comments', () => {
    const src = "x = 1  # path('/fake/', View)\nreal = 2";
    const out = stripCommentsForRegex(src, 'python');
    expect(out).not.toMatch(/path\('\/fake\//);
    expect(out).toMatch(/real = 2/);
  });

  it('python: strips triple-quoted docstrings', () => {
    const src = `"""
path('/in-docstring/', View)
"""
real = 1
`;
    const out = stripCommentsForRegex(src, 'python');
    expect(out).not.toMatch(/in-docstring/);
    expect(out).toMatch(/real = 1/);
  });

  it('python: keeps # inside strings', () => {
    const src = `path('#/fragment/', View)\n`;
    const out = stripCommentsForRegex(src, 'python');
    expect(out).toContain("'#/fragment/'");
  });

  it('python: handles triple-single-quoted docstrings', () => {
    const src = `'''\npath('/fake/')\n'''\nreal = 1\n`;
    const out = stripCommentsForRegex(src, 'python');
    expect(out).not.toMatch(/fake/);
    expect(out).toMatch(/real = 1/);
  });

  it('typescript: strips //, /* */', () => {
    const src =
      "// app.get('/fake', x)\n/* app.get('/also-fake', y) */\napp.get('/real', z)";
    const out = stripCommentsForRegex(src, 'typescript');
    expect(out).not.toMatch(/fake/);
    expect(out).toMatch(/'\/real'/);
  });

  it('typescript: keeps // inside strings', () => {
    const src = `const url = "https://example.com/path";\n`;
    const out = stripCommentsForRegex(src, 'typescript');
    expect(out).toContain('https://example.com/path');
  });

  it('php: strips //, #, and /* */', () => {
    const src =
      "// Route::get('/a', X::class)\n# Route::get('/b', Y::class)\n/* Route::get('/c', Z::class) */\nReal::go();";
    const out = stripCommentsForRegex(src, 'php');
    expect(out).not.toMatch(/'\/a'/);
    expect(out).not.toMatch(/'\/b'/);
    expect(out).not.toMatch(/'\/c'/);
    expect(out).toContain('Real::go();');
  });

  it('ruby: strips =begin/=end', () => {
    const src =
      "=begin\nget '/fake', to: 'x#y'\n=end\nget '/real', to: 'a#b'\n";
    const out = stripCommentsForRegex(src, 'ruby');
    expect(out).not.toMatch(/fake/);
    expect(out).toMatch(/'\/real'/);
  });

  it('ruby: strips # comments', () => {
    const src = "# get '/fake', to: 'x#y'\nget '/real', to: 'a#b'\n";
    const out = stripCommentsForRegex(src, 'ruby');
    expect(out).not.toMatch(/fake/);
    expect(out).toMatch(/'\/real'/);
  });

  it('rust: handles nested block comments', () => {
    const src =
      '/* outer /* inner */ still in outer */ .route("/real", get(h))';
    const out = stripCommentsForRegex(src, 'rust');
    expect(out).not.toMatch(/inner/);
    expect(out).toMatch(/\/real/);
  });

  it('go: keeps backtick raw strings intact, strips // comments', () => {
    const src = '// r.GET("/fake", h)\nr.GET(`/real`, h2)\n';
    const out = stripCommentsForRegex(src, 'go');
    expect(out).not.toMatch(/fake/);
    // backtick raw string contents preserved
    expect(out).toMatch(/`\/real`/);
  });

  it('go: strips block comments containing route-shaped text', () => {
    const src = '/* r.GET("/fake", h) */\nr.GET("/real", h2)\n';
    const out = stripCommentsForRegex(src, 'go');
    expect(out).not.toMatch(/fake/);
    expect(out).toMatch(/"\/real"/);
  });

  it('java: strips // and /* */ comments', () => {
    const src =
      '// @GetMapping("/fake")\n/* @PostMapping("/also-fake") */\n@GetMapping("/real")\n';
    const out = stripCommentsForRegex(src, 'java');
    expect(out).not.toMatch(/fake/);
    expect(out).toMatch(/"\/real"/);
  });

  it('csharp: strips // and /* */ comments', () => {
    const src =
      '// [HttpGet("/fake")]\n/* [HttpPost("/also-fake")] */\n[HttpGet("/real")]\n';
    const out = stripCommentsForRegex(src, 'csharp');
    expect(out).not.toMatch(/fake/);
    expect(out).toMatch(/"\/real"/);
  });

  it('swift: strips // and /* */ comments', () => {
    const src =
      '// app.get("fake", use: x)\n/* app.get("also-fake", use: y) */\napp.get("real", use: z)\n';
    const out = stripCommentsForRegex(src, 'swift');
    expect(out).not.toMatch(/fake/);
    expect(out).toMatch(/"real"/);
  });

  it('preserves line numbers (newlines retained)', () => {
    const src = "line1\n# comment with path('/fake/')\nline3";
    const out = stripCommentsForRegex(src, 'python');
    expect(out.split('\n').length).toBe(3);
    expect(out.split('\n')[2]).toBe('line3');
  });

  it('preserves overall length so source offsets stay valid', () => {
    const src = "x = 1  # path('/fake/', View)\nreal = 2";
    const out = stripCommentsForRegex(src, 'python');
    expect(out.length).toBe(src.length);
  });
});

describe('templateLiteralTextAt', () => {
  /** Whether the first `marker` in `src` is template text; null when the scan gives up. */
  function inText(src: string, marker: string): boolean | null {
    const at = templateLiteralTextAt(src);
    return at === null ? null : at(src.indexOf(marker));
  }

  it('tells a template text from the code around it and in its interpolations', () => {
    const src = 'const a = `TEXT ${CODE} MORE`;\nAFTER';
    expect(inText(src, 'TEXT')).toBe(true);
    expect(inText(src, 'CODE')).toBe(false);
    expect(inText(src, 'MORE')).toBe(true);
    expect(inText(src, 'AFTER')).toBe(false);
  });

  it('follows a template nested in an interpolation', () => {
    expect(inText('const a = `x ${`inner`} y\nTAIL\n`;', 'TAIL')).toBe(true);
  });

  it('skips a regex that holds a backtick or a brace', () => {
    expect(inText('const re = /[`]/g;\nAFTER', 'AFTER')).toBe(false);
    expect(inText('const s = `h-${t.replace(/[}`]/g, "")} TAIL`;\nAFTER', 'TAIL')).toBe(true);
    expect(inText('const s = `h-${t.replace(/[}`]/g, "")} TAIL`;\nAFTER', 'AFTER')).toBe(false);
  });

  it('skips comments and strings that hold a backtick, and divides after a value', () => {
    const src = '// a ` b\nconst s = "`" + \'`\';\n/* ` */\nconst h = (a + b) / 2 + "`";\nAFTER';
    expect(inText(src, 'AFTER')).toBe(false);
  });

  it('gives up when a template never closes', () => {
    expect(inText('if (ok) /`/.test(s)\nAFTER', 'AFTER')).toBeNull();
  });
});
