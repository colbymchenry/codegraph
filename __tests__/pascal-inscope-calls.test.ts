/**
 * A bare Pascal call (`Max(1, 2)`, `Log('x')`) links what its scope declares
 * first — a routine nested where it is made, a member of its class, a
 * routine of its unit, then of the units it uses, the last first — whatever
 * same-named routine a guess by name chose. Before, only a call no scope
 * declared was settled (it linked nothing, #3471); one the scope declared
 * kept the guess, which leans on where candidates are: a namesake in the
 * calling file won over the used unit's routine the call means.
 *
 * What the scope declares may be data that holds a routine (the call runs
 * it), a type (`TFoo(X)` is a typecast, no call) or other data (no call),
 * and a parameter or local of the calling routine comes before all of them
 * (`Log('x')` on a `Log: TProc<string>`), none of which the graph holds as
 * a routine.
 *
 * Routines of one name in several units the code sees are one overload set,
 * chosen between by the call's arguments. Another unit sees only what a
 * unit's interface section declares, read past comments, `{$ifdef}`
 * branches, directives inside a header and include files. Two declarations
 * of one name in one unit are `{$ifdef}` alternatives: the routine is linked.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';

const FILES: Record<string, string> = {
  'MathUnit.pas': `unit MathUnit;

interface

function Max(A, B: Integer): Integer;
procedure Log(const S: string);
procedure Hook(N: Integer);
function TColorRec(R, G, B: Byte): Integer;

implementation

function Max(A, B: Integer): Integer;
begin
  if A > B then Result := A else Result := B;
end;

procedure Log(const S: string);
begin
end;

procedure Hook(N: Integer);
begin
end;

function TColorRec(R, G, B: Byte): Integer;
begin
  Result := R;
end;

end.
`,
  // Overloads of one name in two units, and a routine one unit keeps to itself.
  'Say1.pas': `unit Say1;

interface

procedure Say(const S: string);

implementation

procedure Say(const S: string);
begin
end;

procedure Secret(N: Integer);
begin
end;

end.
`,
  'Say2.pas': `unit Say2;

interface

procedure Say(const Fmt: string; const Args: array of const);

implementation

procedure Say(const Fmt: string; const Args: array of const);
begin
end;

end.
`,
  'Talk.pas': `unit Talk;

interface

uses
  Say1, Say2;

type
  TNoise = class
    procedure Say(const S: string);
    procedure Secret(N: Integer);
  end;

procedure Speak;

implementation

procedure TNoise.Say(const S: string);
begin
end;

procedure TNoise.Secret(N: Integer);
begin
end;

procedure Speak;
begin
  Say('x'); // c-overload-one
  Say('%d', [1]); // c-overload-two
  Secret(1); // c-private
end;

end.
`,
  // One name declared twice in a unit, under exclusive {$ifdef}s: data or a
  // type, or a routine whose body an include file holds (mORMot's MoveFast, ToByte).
  'FastUnit.pas': `unit FastUnit;

interface

{$ifdef PUREPASCAL}
var
  MoveFast: procedure(const Source; var Dest; Count: Integer) = nil;
{$else}
procedure MoveFast(const Source; var Dest; Count: Integer);
{$endif}

{$ifdef NOINLINE}
type
  ToByte = Byte;
{$else}
function ToByte(Value: Cardinal): Cardinal;
{$endif}

implementation

{$ifndef PUREPASCAL}
  {$I FastUnit.asm.inc}
{$endif}

{$ifndef NOINLINE}
function ToByte(Value: Cardinal): Cardinal;
begin
  Result := Value and 255;
end;
{$endif}

end.
`,
  'FastUnit.asm.inc': `procedure MoveFast(const Source; var Dest; Count: Integer);
begin
end;
`,
  // A comment line that starts with "implementation" is no section.
  'Sections.pas': `unit Sections;

interface

{ The routines below are documented in the
  implementation. }

procedure Visible(N: Integer);

implementation

procedure Visible(N: Integer);
begin
end;

end.
`,
  // An {$ifdef} branch that opens the implementation opens it for itself alone.
  'Native.pas': `unit Native;

interface

{$ifdef OSPOSIX}

implementation // do-nothing unit on POSIX

{$else}

procedure NativeCall(N: Integer);

implementation

procedure NativeCall(N: Integer);
begin
end;

{$endif}

end.
`,
  // A routine an include file in the interface declares is the unit's to export.
  'Headers.pas': `unit Headers;

interface

{$I Headers.decl.inc}

implementation

procedure FromInclude(N: Integer);
begin
end;

end.
`,
  'Headers.decl.inc': `procedure FromInclude(N: Integer);
`,
  // A routine header a directive splits, as in mORMot's
  // {$ifdef OSLINUXANDROID} function {$endif} CpuThreads: cardinal;
  'SysInfo.pas': `unit SysInfo;

interface

var
  Ready: Boolean;

{$ifdef LINUX} function {$endif} CpuCount: Cardinal;

implementation

{$ifdef LINUX}
function CpuCount: Cardinal;
begin
  Result := 1;
end;
{$endif}

end.
`,
  'Consumer.pas': `unit Consumer;

interface

uses
  FastUnit, Sections, Native, Headers, SysInfo;

procedure Consume;

implementation

procedure Consume;
var
  A, B: Integer;
  C: Cardinal;
begin
  MoveFast(A, B, 4); // c-alt-variable
  C := ToByte(C); // c-alt-type
  Visible(1); // c-comment-implementation
  NativeCall(2); // c-ifdef-implementation
  FromInclude(3); // c-interface-include
  C := CpuCount(); // c-directive-in-header
end;

end.
`,
  'Caller.pas': `unit Caller;

interface

uses
  MathUnit;

type
  // Namesakes in the calling file, which a guess by name prefers.
  TOther = class
    function Max(A, B: Integer): Integer;
    procedure Log(const S: string);
    procedure Hook(N: Integer);
    function Fact(N: Integer): Integer;
  end;

  TColorRec = record
    R, G, B: Byte;
  end;

  TWorker = class
    procedure Log(const S: string);
    procedure Run;
  end;

var
  Hook: procedure(N: Integer);

procedure UseMax;
procedure Show(Log: TProc<string>);
function Fact(N: Integer): Integer;

implementation

function TOther.Max(A, B: Integer): Integer;
begin
  Result := A;
end;

procedure TOther.Log(const S: string);
begin
end;

procedure TOther.Hook(N: Integer);
begin
end;

function TOther.Fact(N: Integer): Integer;
begin
  Result := N;
end;

procedure TWorker.Log(const S: string);
begin
end;

procedure TWorker.Run;
begin
  Log('working'); // c-class-member
end;

procedure UseMax;
var
  C: Integer;
begin
  C := Max(1, 2); // c-used-unit
  Hook(3); // c-procedural-variable
  C := TColorRec(C); // c-typecast
end;

procedure Show(Log: TProc<string>);
begin
  Log('x'); // c-parameter
end;

function Fact(N: Integer): Integer;
begin
  if N > 1 then
    Result := N * Fact(N - 1) // c-recursion
  else
    Result := 1;
end;

end.
`,
};

describe('a bare Pascal call links what its scope declares first', () => {
  let root = '';
  let cg: CodeGraph | undefined;

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-pascal-inscope-'));
    for (const [rel, content] of Object.entries(FILES)) fs.writeFileSync(path.join(root, rel), content);
    cg = await CodeGraph.init(root, { index: true });
  }, 60_000);

  afterAll(() => {
    cg?.close();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  /** What the calls on the line marked `// marker` reach, as `kind Owner::Name @file`. */
  function reached(marker: string, file = 'Caller.pas'): string[] {
    const line = FILES[file]!.split('\n').findIndex((l) => l.includes(`// ${marker}`)) + 1;
    expect(line, marker).toBeGreaterThan(0);
    const out: string[] = [];
    for (const n of cg!.getNodesInFile(file)) {
      for (const e of cg!.getOutgoingEdges(n.id)) {
        if (e.kind !== 'calls' || e.line !== line) continue;
        const t = cg!.getNode(e.target)!;
        out.push(`${t.kind} ${t.qualifiedName} @${t.filePath}`);
      }
    }
    return out.sort();
  }

  it("links the used unit's routine, not a namesake method in the calling file", () => {
    expect(reached('c-used-unit')).toEqual(['function Max @MathUnit.pas']);
  });

  it("links the calling class's own method before a routine of a unit it uses", () => {
    expect(reached('c-class-member')).toEqual(['method TWorker::Log @Caller.pas']);
  });

  it("links the unit's own data holding a routine, which the call runs", () => {
    expect(reached('c-procedural-variable')).toEqual(['variable Hook @Caller.pas']);
  });

  it('links no routine where the name is a type: a typecast', () => {
    expect(reached('c-typecast').filter((r) => r.startsWith('function') || r.startsWith('method'))).toEqual([]);
  });

  it('links no routine where the name is a parameter of the calling routine', () => {
    expect(reached('c-parameter')).toEqual([]);
  });

  it('keeps a routine calling itself', () => {
    expect(reached('c-recursion')).toEqual(['function Fact @Caller.pas']);
  });

  it("takes overloads of one name from all the units in scope, by the call's arguments", () => {
    expect(reached('c-overload-one', 'Talk.pas')).toEqual(['function Say @Say1.pas']);
    expect(reached('c-overload-two', 'Talk.pas')).toEqual(['function Say @Say2.pas']);
  });

  it("links no routine a used unit's implementation alone declares", () => {
    expect(reached('c-private', 'Talk.pas')).toEqual([]);
  });

  it('links the routine of a name its unit also declares as data, under another {$ifdef}', () => {
    expect(reached('c-alt-variable', 'Consumer.pas')).toEqual(['function MoveFast @FastUnit.asm.inc']);
  });

  it('links the routine of a name its unit also declares as a type, under another {$ifdef}', () => {
    expect(reached('c-alt-type', 'Consumer.pas')).toEqual(['function ToByte @FastUnit.pas']);
  });

  it("finds a used unit's interface past a comment line starting with \"implementation\"", () => {
    expect(reached('c-comment-implementation', 'Consumer.pas')).toEqual(['function Visible @Sections.pas']);
  });

  it('finds the interface an {$ifdef} branch declares after another branch opened the implementation', () => {
    expect(reached('c-ifdef-implementation', 'Consumer.pas')).toEqual(['function NativeCall @Native.pas']);
  });

  it('reads the name of an interface routine past a directive in its header', () => {
    expect(reached('c-directive-in-header', 'Consumer.pas')).toEqual(['function CpuCount @SysInfo.pas']);
  });

  it('counts a routine an include file in the interface declares as exported', () => {
    // Its declaration there or its body in the unit's file: one routine.
    const got = reached('c-interface-include', 'Consumer.pas');
    expect(got).toHaveLength(1);
    expect(got[0]).toMatch(/^function FromInclude @Headers\.(?:pas|decl\.inc)$/);
  });
});
