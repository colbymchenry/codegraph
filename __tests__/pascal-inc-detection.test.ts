/**
 * `.inc` is both PHP's include extension and Pascal/Delphi's (#2279).
 *
 * The extension map routes `.inc` to PHP (Drupal), so a Delphi include — a
 * `{$IFDEF}`/`{$DEFINE}` block or a declaration fragment pulled in with
 * `{$I defs.inc}` — was parsed as PHP and contributed nothing. Detection now
 * reads the file: a PHP open tag keeps it PHP, Pascal-shaped content makes it
 * Pascal, and anything else keeps the old PHP routing so C / assembly /
 * template `.inc` files are not handed to the Pascal grammar. An explicit
 * `codegraph.json` mapping for `.inc` still wins.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { CodeGraph } from '../src';
import { detectLanguage } from '../src/extraction/grammars';
import { preloadLanguagesForFiles } from '../src/extraction';
import { clearProjectConfigCache } from '../src/project-config';

const DIRECTIVES = [
  '{ Compiler version switches }',
  '{$IFDEF VER150}',
  '  {$DEFINE DELPHI7}',
  '{$ENDIF}',
  '{$IFNDEF FPC}',
  '  {$WARN SYMBOL_PLATFORM OFF}',
  '{$ELSE}',
  '  {$MODE DELPHI}{$H+}',
  '{$ENDIF}',
  '',
].join('\n');

const ROUTINES = [
  'procedure Foo;',
  'begin',
  "  WriteLn('foo');",
  'end;',
  '',
  'function Bar(A: Integer): Integer;',
  'begin',
  '  Result := A + 1;',
  'end;',
  '',
].join('\n');

describe('.inc language detection (#2279)', () => {
  describe('detectLanguage', () => {
    it('reads a directive-only include as Pascal', () => {
      expect(detectLanguage('src/defs.inc', DIRECTIVES)).toBe('pascal');
      expect(detectLanguage('src/defs.inc', '{$I other.inc}\n')).toBe('pascal');
      expect(detectLanguage('src/defs.inc', '{$R-}\n{$Q-}\n')).toBe('pascal');
      expect(detectLanguage('src/DEFS.INC', '{$define FOO}\n')).toBe('pascal');
      // Lazarus opens its includes with an IDE marker naming the owning unit.
      expect(detectLanguage('lcl/include/control.inc', '{%MainUnit ../controls.pp}\n{ comment }\n')).toBe('pascal');
    });

    it('skips a leading UTF-8 BOM and CRLF line endings', () => {
      expect(detectLanguage('defs.inc', '\uFEFF{$IFDEF WIN32}\r\n{$DEFINE X}\r\n{$ENDIF}\r\n')).toBe('pascal');
      expect(detectLanguage('defs.inc', '\uFEFFprocedure Foo;\r\n')).toBe('pascal');
    });

    it('reads a declaration fragment as Pascal', () => {
      expect(detectLanguage('r.inc', ROUTINES)).toBe('pascal');
      expect(detectLanguage('r.inc', 'procedure Foo;\nfunction Bar(A: Integer): Integer;\n')).toBe('pascal');
      expect(detectLanguage('r.inc', 'procedure TForm1.Button1Click(Sender: TObject);\n')).toBe('pascal');
      expect(detectLanguage('r.inc', 'const\n  X = 1;\n')).toBe('pascal');
      expect(detectLanguage('r.inc', 'const // ids\n{ Internal functions }\n   fpc_in_lo = 1;\n')).toBe('pascal');
      expect(detectLanguage('r.inc', 'const Max: Integer = 10;\n')).toBe('pascal');
      expect(detectLanguage('r.inc', 'type\n  TColor = (Red, Green);\n')).toBe('pascal');
      expect(detectLanguage('r.inc', 'type TFoo = class(TObject)\nend;\n')).toBe('pascal');
      expect(detectLanguage('r.inc', 'var\n  G, H: Integer;\n')).toBe('pascal');
      expect(detectLanguage('r.inc', 'uses\n  SysUtils, Classes;\n')).toBe('pascal');
      expect(detectLanguage('r.inc', 'unit Foo;\ninterface\nimplementation\nend.\n')).toBe('pascal');
    });

    it('keeps an include with a PHP open tag as PHP', () => {
      expect(detectLanguage('page.inc', '<?php\nfunction mymodule_help() {}\n')).toBe('php');
      expect(detectLanguage('page.inc', '\uFEFF  <?PHP\nfunction a() {}\n')).toBe('php');
      expect(detectLanguage('page.inc', '<div><?= $title ?></div>\n')).toBe('php');
      // A tag anywhere wins over Pascal-looking text elsewhere in the file.
      expect(detectLanguage('page.inc', '<p>\nprocedure Foo;\n</p>\n<?php echo 1; ?>\n')).toBe('php');
    });

    it('leaves non-Pascal, untagged includes on the PHP mapping', () => {
      // C / C++ preprocessor and X-macro tables.
      expect(detectLanguage('tbl.inc', '#define X 1\n#define Y 2\nconst int z = 3;\n')).toBe('php');
      expect(detectLanguage('tbl.inc', 'OPCODE(ADD, 0x01)\nOPCODE(SUB, 0x02)\n')).toBe('php');
      // C++ out-of-line static member definition.
      expect(detectLanguage('Path.inc', 'const file_t::value_type file_t::Invalid = nullptr;\n')).toBe('php');
      // SourcePawn typeset members: `function <return type> (<params>);`.
      expect(
        detectLanguage('menus.inc', 'typeset MenuHandler\n{\n\tfunction int (Menu menu, MenuAction action);\n\tfunction void (Menu menu);\n};\n'),
      ).toBe('php');
      // NASM / MASM.
      expect(detectLanguage('m.inc', '%define STACK 0x1000\n; comment\nfoo equ 1\nmov eax, 1\n')).toBe('php');
      // POV-Ray.
      expect(detectLanguage('s.inc', '#declare R = 1;\n#macro M(a)\n#end\n')).toBe('php');
      // Classic ASP / VBScript server-side include.
      expect(detectLanguage('a.inc', 'Const X = 1\nFunction Foo(a)\n  Foo = a\nEnd Function\n')).toBe('php');
      // Makefile include.
      expect(detectLanguage('config.inc', 'CC := gcc\nCFLAGS := -O2\n')).toBe('php');
      // HTML fragment with inline script, and a Smarty-style `{$var}` line.
      expect(
        detectLanguage('f.inc', '<script>\n  const x = 1;\n  var y = 2;\n  function go() { return x; }\n</script>\n{$title}\n'),
      ).toBe('php');
      // Prose that happens to put Pascal keywords on their own lines.
      expect(detectLanguage('f.inc', '<li>\n  Implementation\n</li>\n<li>\n  Begin\n</li>\n')).toBe('php');
    });

    it('keeps the path-only answer (no source) on PHP', () => {
      expect(detectLanguage('defs.inc')).toBe('php');
      expect(detectLanguage('defs.inc', '')).toBe('php');
    });

    it('lets an explicit codegraph.json mapping for .inc win', () => {
      expect(detectLanguage('defs.inc', DIRECTIVES, { '.inc': 'php' })).toBe('php');
      expect(detectLanguage('defs.inc', '#define X 1\n', { '.inc': 'cpp' })).toBe('cpp');
      expect(detectLanguage('page.inc', '<?php echo 1;', { '.inc': 'pascal' })).toBe('pascal');
    });
  });

  describe('grammar preload set', () => {
    it('loads the Pascal grammar when an .inc file is in the set', () => {
      expect(preloadLanguagesForFiles(['defs.inc'])).toEqual(expect.arrayContaining(['php', 'pascal']));
    });

    it('adds nothing for a PHP project without .inc files, or when .inc is mapped explicitly', () => {
      expect(preloadLanguagesForFiles(['index.php', 'a.module'])).not.toContain('pascal');
      expect(preloadLanguagesForFiles(['defs.inc'], { '.inc': 'php' })).not.toContain('pascal');
    });
  });

  describe('index and sync', () => {
    let dir: string;
    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-pascal-inc-'));
      clearProjectConfigCache();
    });
    afterEach(() => {
      clearProjectConfigCache();
      fs.rmSync(dir, { recursive: true, force: true });
    });
    const write = (rel: string, body: string) => {
      const p = path.join(dir, rel);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, body);
    };
    const languageOf = (cg: CodeGraph, rel: string) => cg.getFiles().find((f) => f.path === rel)?.language;
    const symbolsIn = (cg: CodeGraph, rel: string) =>
      cg.getNodesInFile(rel).filter((n) => n.kind !== 'file').map((n) => `${n.kind}:${n.name}:${n.language}`).sort();

    // Runs first, before anything in this file has loaded the Pascal grammar
    // through a `.pas` file: an include-only tree must still get a parser.
    it('indexes a tree of Pascal includes with no .pas file', async () => {
      write('inc/defs.inc', DIRECTIVES);
      write('inc/routines.inc', ROUTINES);
      const cg = await CodeGraph.init(dir, { index: true });
      try {
        expect(languageOf(cg, 'inc/defs.inc')).toBe('pascal');
        expect(languageOf(cg, 'inc/routines.inc')).toBe('pascal');
        expect(symbolsIn(cg, 'inc/routines.inc')).toEqual(['function:Bar:pascal', 'function:Foo:pascal']);
        expect(cg.getFiles().find((f) => f.path === 'inc/routines.inc')?.errors ?? []).toEqual([]);
      } finally {
        cg.close();
      }
    });

    it('classifies each include by content, and sync keeps the language', async () => {
      write('U.pas', 'unit U;\n\ninterface\n\n{$I defs.inc}\n\nprocedure Foo;\n\nimplementation\n\n{$I routines.inc}\n\nend.\n');
      write('defs.inc', DIRECTIVES);
      write('routines.inc', ROUTINES);
      write('drupal/mymodule.inc', '<?php\n\nfunction mymodule_helper() {\n  return 1;\n}\n');
      write('native/table.inc', '#define X 1\n#define Y 2\n');
      const cg = await CodeGraph.init(dir, { index: true });
      try {
        expect(languageOf(cg, 'defs.inc')).toBe('pascal');
        expect(languageOf(cg, 'routines.inc')).toBe('pascal');
        expect(languageOf(cg, 'drupal/mymodule.inc')).toBe('php');
        expect(languageOf(cg, 'native/table.inc')).toBe('php');

        // A directive-only fragment: a file record, no symbols, no errors.
        expect(symbolsIn(cg, 'defs.inc')).toEqual([]);
        expect(cg.getFiles().find((f) => f.path === 'defs.inc')?.errors ?? []).toEqual([]);
        expect(symbolsIn(cg, 'routines.inc')).toEqual(['function:Bar:pascal', 'function:Foo:pascal']);
        expect(symbolsIn(cg, 'drupal/mymodule.inc')).toEqual(['function:mymodule_helper:php']);

        write('defs.inc', DIRECTIVES + '{$DEFINE USE_FAST_MM}\n');
        write('routines.inc', ROUTINES + 'procedure Baz;\nbegin\nend;\n');
        await cg.sync();

        expect(languageOf(cg, 'defs.inc')).toBe('pascal');
        expect(languageOf(cg, 'routines.inc')).toBe('pascal');
        expect(symbolsIn(cg, 'routines.inc')).toEqual(['function:Bar:pascal', 'function:Baz:pascal', 'function:Foo:pascal']);
        expect(languageOf(cg, 'drupal/mymodule.inc')).toBe('php');
      } finally {
        cg.close();
      }
    });

    it('honors a codegraph.json .inc mapping through index and sync', async () => {
      write('codegraph.json', JSON.stringify({ extensions: { '.inc': 'php' } }));
      write('defs.inc', DIRECTIVES);
      const cg = await CodeGraph.init(dir, { index: true });
      try {
        expect(languageOf(cg, 'defs.inc')).toBe('php');
        write('defs.inc', DIRECTIVES + '{$DEFINE MORE}\n');
        await cg.sync();
        expect(languageOf(cg, 'defs.inc')).toBe('php');
      } finally {
        cg.close();
      }
    });
  });
});
