/**
 * A struct, union or enum DEFINED in the type of an Objective-C variable
 * declaration was never indexed — the gap #2446 closed for C and C++:
 *
 *   static struct { Class isa; } placeholder;   // only the variable
 *   struct Foo { int a; } foo;                  // no struct Foo
 *   enum { ModeA, ModeB } mode;                 // no enumerators
 *
 * The walker handed such a declaration to the variable extractor and skipped
 * its children, so the type and its enumerators never became nodes. The same
 * happened to a `typedef enum { … } Name;` written after a macro such as
 * `OF_ASSUME_NONNULL_BEGIN`: the parser reads the typedef as a declaration of
 * a variable `Name`, so a public enum and every value in it went missing.
 *
 * The type is now walked beside the variables, the comment above the
 * declaration documents it, and an unnamed one takes the name of the first
 * variable its declaration declares, as in C. Most Objective-C trees have
 * errors (that macro is enough), and as in C the type is walked anyway.
 * Objective-C has no kernel walker, so only the wasm extractor runs.
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';
import { extractFromSource } from '../src/extraction';
import { getParser, initGrammars, loadGrammarsForLanguages } from '../src/extraction/grammars';
import type { ExtractionResult } from '../src/types';

/** `<kind> <qualifiedName>` for every symbol, file and imports aside. */
function symbols(result: ExtractionResult): string[] {
  return result.nodes
    .filter((n) => n.kind !== 'file' && n.kind !== 'import')
    .map((n) => `${n.kind} ${n.qualifiedName}`);
}

describe('a type defined in an Objective-C declaration', () => {
  beforeAll(async () => {
    await initGrammars();
    await loadGrammarsForLanguages(['objc']);
  });

  for (const crlf of [false, true]) {
    const eol = (s: string) => (crlf ? s.replace(/\n/g, '\r\n') : s);
    const label = crlf ? ' (CRLF)' : '';

    it(`structs, unions and enums beside their variables; an unnamed one takes its variable's name${label}`, () => {
      const source = [
        'struct Foo { int a; } foo;',
        'static struct { Class isa; } placeholder;',
        'union { int i; float f; } u1, u2;',
        'enum { ModeA, ModeB } mode;',
        'typedef struct Bar { int c; } Bar;',
        '',
      ].join('\n');
      const result = extractFromSource('src/decl.m', eol(source), 'objc');
      expect(symbols(result)).toEqual([
        'struct Foo',
        'variable foo',
        'struct placeholder',
        'variable placeholder',
        'union u1',
        'variable u1',
        'variable u2',
        'enum mode',
        'enum_member mode::ModeA',
        'enum_member mode::ModeB',
        'variable mode',
        'struct Bar',
      ]);
    });

    it(`the comment above the declaration documents the type${label}`, () => {
      const source = '/** The shared cache. */\nstatic struct { int hits; } cache;\n';
      const result = extractFromSource('src/cache.m', eol(source), 'objc');
      const docs = result.nodes.filter((n) => n.name === 'cache').map((n) => `${n.kind} ${n.docstring}`);
      expect(docs).toEqual(['struct The shared cache.', 'variable The shared cache.']);
    });

    it(`an unnamed type in a method body takes its variable's name too${label}`, () => {
      const source = '@implementation Widget\n- (void)spin {\n  struct { int z; } local;\n  local.z = 1;\n}\n@end\n';
      const result = extractFromSource('src/Widget.m', eol(source), 'objc');
      expect(symbols(result)).toEqual(['class Widget', 'method Widget::spin', 'struct Widget::spin::local']);
    });

    it(`a file the parser misreads still has its types walked${label}`, () => {
      // The macro makes the parser read the typedef as a declaration of a
      // variable named after the enum (and one named `typedef`).
      const header = eol([
        'OF_ASSUME_NONNULL_BEGIN',
        '',
        'typedef enum {',
        '\tOFZIPArchiveEntryCompressionMethodNone = 0,',
        '\tOFZIPArchiveEntryCompressionMethodDeflate = 8',
        '} OFZIPArchiveEntryCompressionMethod;',
        '',
        '@interface OFZIPArchiveEntry: OFObject',
        '@end',
        '',
        'OF_ASSUME_NONNULL_END',
        '',
      ].join('\n'));
      expect(getParser('objc')!.parse(header)!.rootNode.hasError).toBe(true);
      expect(symbols(extractFromSource('src/OFZIPArchiveEntry.h', header, 'objc'))).toEqual(
        expect.arrayContaining([
          'enum OFZIPArchiveEntryCompressionMethod',
          'enum_member OFZIPArchiveEntryCompressionMethod::OFZIPArchiveEntryCompressionMethodNone',
          'enum_member OFZIPArchiveEntryCompressionMethod::OFZIPArchiveEntryCompressionMethodDeflate',
          'class OFZIPArchiveEntry',
        ])
      );
      // A member type the grammar can't read errs inside the struct's own body.
      const atomic = eol('static struct {\n    _Atomic(int) installedState;\n    atomic_bool isEnabled;\n} g_state;\n');
      expect(getParser('objc')!.parse(atomic)!.rootNode.hasError).toBe(true);
      expect(symbols(extractFromSource('src/Monitor.m', atomic, 'objc'))).toEqual(['struct g_state', 'variable g_state']);
    });
  }
});

describe('an indexed Objective-C project with types defined in declarations', () => {
  let root = '';
  let cg: CodeGraph | undefined;

  afterEach(() => {
    cg?.destroy();
    cg = undefined;
    if (root) fs.rmSync(root, { recursive: true, force: true });
    root = '';
  });

  it('finds a class cluster placeholder and the values of an enum a macro hid', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-objc-declaration-types-'));
    const files: Record<string, string> = {
      'src/OFArray.m': [
        '#import "OFObject.h"',
        '',
        '/* The object every +alloc of the cluster returns. */',
        'static struct {',
        '\tClass isa;',
        '} placeholder;',
        '',
        '@interface OFArray: OFObject',
        '@end',
        '',
        '@implementation OFArray',
        '+ (instancetype)alloc',
        '{',
        '\treturn (id)&placeholder;',
        '}',
        '@end',
        '',
      ].join('\n'),
      'src/OFZIPArchiveEntry.h': [
        'OF_ASSUME_NONNULL_BEGIN',
        '',
        'typedef enum {',
        '\tOFZIPArchiveEntryCompressionMethodNone = 0,',
        '\tOFZIPArchiveEntryCompressionMethodDeflate = 8',
        '} OFZIPArchiveEntryCompressionMethod;',
        '',
        '@interface OFZIPArchiveEntry: OFObject',
        '- (OFZIPArchiveEntryCompressionMethod)method;',
        '@end',
        '',
        'OF_ASSUME_NONNULL_END',
        '',
      ].join('\n'),
    };
    for (const [rel, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), content);
    }
    cg = await CodeGraph.init(root, { index: true });

    const placeholder = cg.searchNodes('placeholder', { limit: 5 }).map((r) => `${r.node.kind} ${r.node.name}`);
    expect(placeholder).toContain('struct placeholder');
    const struct = cg.getNodesByName('placeholder').find((n) => n.kind === 'struct');
    expect(struct?.docstring).toBe('The object every +alloc of the cluster returns.');

    const deflate = cg.getNodesByName('OFZIPArchiveEntryCompressionMethodDeflate').map((n) => `${n.kind} ${n.qualifiedName} ${n.language}`);
    expect(deflate).toEqual([
      'enum_member OFZIPArchiveEntryCompressionMethod::OFZIPArchiveEntryCompressionMethodDeflate objc',
    ]);
  }, 60_000);

  it('keeps a struct a .m file defines to that file, as C keeps a .c file\'s', async () => {
    // An Objective-C source file is a translation unit: no other file can name
    // the struct it defines, so a call of an outside function that shares its
    // name (AmigaOS's `Lock(path, mode)` in ObjFW) makes no such struct.
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-objc-declaration-types-'));
    const files: Record<string, string> = {
      'src/runtime/synchronized.m': [
        'static struct Lock {',
        '\tid object;',
        '\tint count;',
        '} *locks = NULL;',
        '',
        'int objc_sync_count(void)',
        '{',
        '\treturn locks->count;',
        '}',
        '',
      ].join('\n'),
      'src/OFFileManager.m': [
        '@implementation OFFileManager',
        '- (long)lockPath: (const char *)path',
        '{',
        '\treturn Lock(path, 1);',
        '}',
        '@end',
        '',
      ].join('\n'),
    };
    for (const [rel, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), content);
    }
    cg = await CodeGraph.init(root, { index: true });

    const lock = cg.getNodesByName('Lock').map((n) => `${n.kind} ${n.filePath}`);
    expect(lock).toEqual(['struct src/runtime/synchronized.m']);
    const caller = cg.getNodesByName('lockPath:').find((n) => n.kind === 'method')!;
    expect(caller).toBeDefined();
    expect(cg.getOutgoingEdges(caller.id).filter((e) => e.kind !== 'contains')).toEqual([]);
  }, 60_000);
});
