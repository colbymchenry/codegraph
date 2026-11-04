/**
 * What of an F# text is code, read as F#'s own lexer reads it — for the names a
 * signature file declares and for whether a `.fs` file holds any code — and the
 * compile order a project file gives.
 */
import { describe, it, expect } from 'vitest';
import { fsharpNames, hasFsharpCode } from '../src/extraction/fsharp-lexer';
import { fsprojCompileItems, signatureNames } from '../src/resolution/fsharp-scope';

describe('fsharpNames', () => {
  it('reads `(*)` as the multiplication operator, not a comment, and nested comments as one', () => {
    expect(fsharpNames('val (*) : int -> int\nval dot : int\n(* a (* nested *) comment *)\nval cross : int // (* not a comment start *)\n'))
      .toEqual(['val', '(*)', 'int', 'int', 'val', 'dot', 'int', 'val', 'cross', 'int']);
  });

  it('names operators and active patterns as their declarations spell them', () => {
    expect(fsharpNames('val ( +++ ) : int\nval (|Even|Odd|) : int -> Choice<unit,unit>\nval (|Int|_|) : string -> int option'))
      .toEqual(expect.arrayContaining(['(+++)', '(|Even|Odd|)', '(|Int|_|)']));
  });

  it('reads no names in strings, verbatim and triple-quoted strings, or character literals', () => {
    expect(fsharpNames('let a = "x (* y" + @"c:\\dir""q" + """b (* """ + \'(\'\nlet b = 1')).toEqual(['let', 'a', 'let', 'b']);
  });

  it('keeps a type parameter and a primed name apart from a character literal', () => {
    expect(fsharpNames("val f : 'T -> 'T\nlet x' = 1")).toEqual(['val', 'f', 'T', 'T', 'let', "x'"]);
  });
});

describe('hasFsharpCode', () => {
  it('finds no code in comments alone, and code after `(*)`', () => {
    expect(hasFsharpCode('// header\n(* block *)\n')).toBe(false);
    expect(hasFsharpCode('(*) 2 3\n')).toBe(true);
  });
});

describe('signatureNames', () => {
  it('lists what a signature file declares, operators and active patterns included', () => {
    expect(signatureNames('module Ops\nval (+++) : int -> int -> int\nval (|Even|Odd|) : int -> Choice<unit, unit>\n'))
      .toEqual(expect.arrayContaining(['(+++)', '(|Even|Odd|)', 'Ops']));
  });
});

describe('fsprojCompileItems', () => {
  it('orders `CompileBefore`, `Compile`, `CompileAfter`, whatever order the attributes are in, and skips comments', () => {
    const project = `<Project>
  <ItemGroup>
    <!-- <Compile Include="Old.fs" /> -->
    <CompileAfter Include="Last.fs" />
    <Compile Link="Shared/B.fs" Include="..\\Shared\\B.fs" />
    <Compile Include="A.fs;C.fs" />
    <Compile Include="Gen/*.fs" />
    <CompileBefore Include='First.fs' />
  </ItemGroup>
</Project>`;
    expect(fsprojCompileItems(project)).toEqual(['First.fs', '../Shared/B.fs', 'A.fs', 'C.fs', 'Last.fs']);
  });
});
