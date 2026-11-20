/**
 * A declaration-only C++ header — free function prototypes and `extern`
 * variables, with no `class`, `namespace` or `template <…>` block — was
 * detected as C (#3397). Its C++-only declaration syntax then broke the C
 * grammar's parse, the file contributed no symbols, and indexing warned
 * "parse produced no symbols (tree has errors)":
 *
 *   extern CComPtr<IDiaDataSource> g_pDiaDataSource;        // template type
 *   HRESULT GetPath(bstr_t& path, ULONGLONG& version);      // references
 *   qstring describe(IDiaSymbol* type, int depth = 0);      // default argument
 *
 * A `.h` that uses any of them is now C++. Each is held to a declaration's
 * shape, so the C that shares their characters — a comparison, a bitwise `&`,
 * an address-of, an initializer, a macro body, a comment or a string — stays C.
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';
import { extractFromSource } from '../src/extraction';
import { detectLanguage, findCppDeclarationSyntax, initGrammars, loadGrammarsForLanguages } from '../src/extraction/grammars';

// The issue's three headers.
const PDB_DIA_SESSION = [
  '#pragma once',
  '',
  'extern CComPtr<IDiaDataSource> g_pDiaDataSource;',
  'extern CComPtr<IDiaSession> g_pDiaSession;',
  'extern bool g_dia_available;',
  '',
  'bool init_dia_session();',
  'qstring get_dia_type_declaration(IDiaSymbol* type, int depth = 0);',
  '',
].join('\n');
const PROGRAM = [
  '#pragma once',
  '',
  'HRESULT GetMaxVersionVsInstallationPath(bstr_t& bstrVsInstallationPath, ULONGLONG& ullVersion, qvector<qstring>* installation_paths = nullptr);',
  '',
].join('\n');
const OLD_PDB = [
  '// helper functions provided by the new pdb plugin',
  'bool apply_name(ea_t ea, const qstring &name, int maybe_func);',
  'void load_vc_til(void);',
  '',
].join('\n');

const crlf = (s: string) => s.replace(/\n/g, '\r\n');

beforeAll(async () => {
  await initGrammars();
  await loadGrammarsForLanguages(['c', 'cpp', 'objc']);
});

describe('detecting a declaration-only C++ .h (#3397)', () => {
  it('reads the issue headers as C++, with LF or CRLF line endings', () => {
    for (const [name, source] of [['PdbDiaSession.h', PDB_DIA_SESSION], ['Program.h', PROGRAM], ['oldpdb.h', OLD_PDB]]) {
      expect(detectLanguage(name, source), name).toBe('cpp');
      expect(detectLanguage(name, crlf(source)), `${name} (CRLF)`).toBe('cpp');
    }
    // What decides each one.
    expect(findCppDeclarationSyntax(PDB_DIA_SESSION)).toBe('extern CComPtr<IDiaDataSource> g_pDiaDataSource;');
    expect(findCppDeclarationSyntax(PROGRAM)).toBe(
      'HRESULT GetMaxVersionVsInstallationPath(bstr_t& bstrVsInstallationPath, ULONGLONG& ullVersion, qvector<qstring>* installation_paths = nullptr)'
    );
    expect(findCppDeclarationSyntax(OLD_PDB)).toBe('const qstring &');
  });

  it('sees each construct on its own', () => {
    // A template-instantiated type in a declaration.
    expect(detectLanguage('a.h', 'extern CComPtr<IDiaDataSource> g_pDiaDataSource;\n')).toBe('cpp');
    expect(detectLanguage('b.h', 'typedef std::map<std::string, int> name_map;\n')).toBe('cpp');
    expect(detectLanguage('c.h', 'void collect(qvector<qstring>* paths);\n')).toBe('cpp');
    // A reference parameter, spaced either way, or a reference to const.
    expect(detectLanguage('d.h', 'HRESULT GetPath(bstr_t& path);\n')).toBe('cpp');
    expect(detectLanguage('e.h', 'bool ReadAt(IInStream *stream, UInt64 &pos);\n')).toBe('cpp');
    expect(detectLanguage('f.h', 'bool apply_name(ea_t ea, const qstring &name);\n')).toBe('cpp');
    // A default argument.
    expect(detectLanguage('g.h', 'qstring describe(IDiaSymbol* type, int depth = 0);\n')).toBe('cpp');
    expect(detectLanguage('h.h', 'void PatchClear(const char* module = nullptr);\n')).toBe('cpp');
    // In an inline definition, behind a multi-line comment and a string.
    expect(
      detectLanguage(
        'i.h',
        '/* Reads a whole file.\n   Returns "" on failure. */\nstatic qstring read_all(const char* name, size_t& size, const char* mode = "rb")\n{\n  return qstring();\n}\n'
      )
    ).toBe('cpp');
    // Past the first 8 KB, behind a long C-compatible preamble.
    const preamble = '#ifndef BIG_H\n#define BIG_H\n' + 'int value_0(int x);\n'.repeat(500);
    expect(preamble.length).toBeGreaterThan(8192);
    expect(detectLanguage('big.h', `${preamble}bool ReadAt(UInt64 &pos);\n#endif\n`)).toBe('cpp');
  });

  it('keeps C headers C', () => {
    const controls: Record<string, string> = {
      // `<` in a macro and in a comparison,
      'lt.h': '#define MIN(a, b) ((a) < (b) ? (a) : (b))\nstatic inline int in_range(int a, int lo, int hi) { return lo < a && a < hi; }\nstatic inline int both(int a, int b) { if (a<b && b>0) return a; return b; }\n',
      // `&` in an expression, a macro and an address-of,
      'amp.h': '#define REF(T) T &\n#define HAS(flags, x) ((flags) & (x))\nstatic inline int masked(int flags) { return check(flags & MASK, &flags); }\nint *addr = &counter;\n',
      // `=` in a C initializer and a C99 for loop,
      'eq.h': 'int x = 0;\nstatic const char *names[] = { "a", "b" };\nstatic inline void each(int n) { for (int i = 0, j = n; i < j; i++) step(i, j); }\n',
      // comments and string literals that mention C++,
      'text.h': '/* const std::string &name; int f(int &x = 0); */\n// extern CComPtr<IFoo> g_p;\nstatic const char *usage = "HRESULT f(bstr_t& p, int depth = 0);";\nint parse(const char *s);\n',
      // a macro body spanning lines,
      'macro.h': '#define DECLARE_GETTER(T, name) \\\n  T& get_##name(T& out, int depth = 0)\nint plain(int a);\n',
      // file-scope macros that declare things, and an array bound,
      'decl.h': 'static DECLARE_BITMAP(map, 1 << 8);\nstatic DEFINE_RATELIMIT_STATE(rs, 5 * HZ, 10);\nvoid fill(int a[N & M], size_t n);\n',
      // statements that look like heads: `if mi_unlikely(…)`, a statement macro with no `;`,
      'stmt.h': 'static inline void* next(void* p) {\n  if mi_unlikely(p != NULL && q) { return p; }\n  Py_BEGIN_ALLOW_THREADS\n  return load(&self->hash);\n}\n',
      // a bit-field, a ternary, a function pointer and a cast,
      'misc.h': 'struct S { unsigned a : 3; };\ntypedef void (*handler)(int sig, void *ctx);\nstatic inline long len(const char *s) { return s ? (long)strlen(s) : 0; }\nstatic inline const char *ptr(void) { return (const char *)&buf; }\n',
      // and the existing controls.
      'cfoo.h': '#ifndef CFOO_H\nstruct Point { int x; int y; };\nvoid f(struct Point p);\nextern int counter;\n#endif\n',
    };
    for (const [name, source] of Object.entries(controls)) {
      expect(detectLanguage(name, source), name).toBe('c');
      expect(detectLanguage(name, crlf(source)), `${name} (CRLF)`).toBe('c');
    }
  });

  it('leaves Objective-C to its own check', () => {
    // Lightweight generics and block parameters share these shapes; an
    // Objective-C header stays Objective-C, and one the Objective-C check
    // doesn't see (no `@interface` in its head) is not dragged to C++.
    expect(detectLanguage('Foo.h', '@interface Foo : NSObject\n@property NSArray<NSString *> *names;\n- (void)load:(NSDictionary<NSString *, id> *)options;\n@end\n')).toBe('objc');
    expect(detectLanguage('Blocks.h', '#import <Foundation/Foundation.h>\ntypedef void (^Done)(NSArray<NSString *> *items, NSError *error);\n')).toBe('c');
    expect(detectLanguage('Keys.h', 'extern NSArray<NSString *> *const kKeys;\nstatic NSString *const kName = @"name";\n')).toBe('c');
  });
});

describe('extracting a declaration-only C++ .h (#3397)', () => {
  const parseWarnings = (filePath: string, source: string) =>
    extractFromSource(filePath, source).errors.filter((e) => e.code === 'parse_error');

  it('parses the issue headers cleanly and extracts their extern variables', () => {
    const result = extractFromSource('src/PdbDiaSession.h', PDB_DIA_SESSION);
    const variables = result.nodes.filter((n) => n.kind === 'variable').map((n) => `${n.language} ${n.name}`);
    expect(variables).toEqual(['cpp g_pDiaDataSource', 'cpp g_pDiaSession', 'cpp g_dia_available']);
    expect(result.errors.filter((e) => e.code === 'parse_error')).toEqual([]);
    // Prototypes alone add no symbols in either grammar — as in a `.hpp` —
    // but the headers no longer parse with errors or warn.
    expect(parseWarnings('src/Program.h', PROGRAM)).toEqual([]);
    expect(parseWarnings('src/oldpdb.h', OLD_PDB)).toEqual([]);
    expect(extractFromSource('src/oldpdb.h', OLD_PDB).nodes.find((n) => n.kind === 'file')?.language).toBe('cpp');
  });

  it('keeps an inline function the C grammar lost', () => {
    const source = [
      'static qstring GetFileContext(const char* pszFileName, size_t& nFileSize, const char* pszMode = "rb")',
      '{',
      '  FILE* f = qfopen(pszFileName, pszMode);',
      '  return qstring(f, nFileSize);',
      '}',
      '',
    ].join('\n');
    const result = extractFromSource('src/misc.h', source);
    expect(result.nodes.filter((n) => n.kind !== 'file').map((n) => `${n.kind} ${n.name}`)).toEqual(['function GetFileContext']);
  });
});

describe('indexing a declaration-only C++ .h (#3397)', () => {
  let root = '';
  let cg: CodeGraph | undefined;

  afterEach(() => {
    cg?.destroy();
    cg = undefined;
    if (root) fs.rmSync(root, { recursive: true, force: true });
    root = '';
  });

  it('indexes the issue headers as C++ with no parse warning, and a C header as C', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-cpp-decl-headers-'));
    const files: Record<string, string> = {
      'PdbDiaSession.h': PDB_DIA_SESSION,
      'Program.h': PROGRAM,
      'oldpdb.h': OLD_PDB,
      'plain_c.h': '#include <stdio.h>\nint add(int a, int b);\nextern int counter;\n',
    };
    for (const [rel, content] of Object.entries(files)) fs.writeFileSync(path.join(root, rel), content);
    cg = await CodeGraph.init(root);
    const result = await cg.indexAll();
    expect(result.errors.filter((e) => e.code === 'parse_error')).toEqual([]);

    const fileLanguage = (rel: string) => cg!.getNodesInFile(rel).find((n) => n.kind === 'file')?.language;
    expect(fileLanguage('PdbDiaSession.h')).toBe('cpp');
    expect(fileLanguage('Program.h')).toBe('cpp');
    expect(fileLanguage('oldpdb.h')).toBe('cpp');
    expect(fileLanguage('plain_c.h')).toBe('c');
    const externs = cg.getNodesInFile('PdbDiaSession.h').filter((n) => n.kind === 'variable').map((n) => n.name).sort();
    expect(externs).toEqual(['g_dia_available', 'g_pDiaDataSource', 'g_pDiaSession']);
  }, 60_000);
});
