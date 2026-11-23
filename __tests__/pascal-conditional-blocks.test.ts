/**
 * A conditional whose branches each open a block for the code after it to
 * close (`{$IFDEF X86} case R of … else {$ELSE} if V = nil then begin
 * {$ENDIF} … end;`) opens one block more than the code closes when the
 * grammar reads its branches together. The routine around it never closed:
 * in mORMot2, `TInterfacedObjectFakeRaw.FakeCallGetParamsFromStack` ran on
 * for 3,000 lines, the 111 routines after it had no nodes, and their calls
 * were its own. The preParse already blanked a second `begin` when every
 * branch opened one, but not when one branch opened a `case` or a `try`
 * (mORMot's `{$IFDEF HASFASTTRYFINALLY} try {$ELSE} begin {$ENDIF}`), nor
 * when a branch held a conditional of its own, even one that opens no block
 * (DWScript's `InterlockedIncrement`, a Pascal body beside an assembler one).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { CodeGraph } from '../src';
import { extractFromSource } from '../src/extraction';
import { getParser, initGrammars, loadGrammarsForLanguages } from '../src/extraction/grammars';
import { preParsePascal } from '../src/extraction/languages/pascal-preparse';

beforeAll(async () => {
  await initGrammars();
  await loadGrammarsForLanguages(['pascal']);
});

/** Whether the unit parses whole: a `unit` node and no error anywhere. */
function parsesWhole(code: string): boolean {
  const tree = getParser('pascal')!.parse(preParsePascal(code))!;
  try {
    return !tree.rootNode.hasError && tree.rootNode.namedChildren.some((c) => c.type === 'unit');
  } finally {
    tree.delete();
  }
}

/** Every routine's calls as `Caller->Callee`, sorted, and each routine's lines as `Name:start-end`. */
function extract(code: string, file: string): { calls: string[]; routines: string[] } {
  const result = extractFromSource(file, code);
  const byId = new Map(result.nodes.map((n) => [n.id, n]));
  return {
    calls: result.unresolvedReferences
      .filter((r) => r.referenceKind === 'calls')
      .map((r) => `${byId.get(r.fromNodeId)?.name}->${r.referenceName}`)
      .sort(),
    routines: result.nodes
      .filter((n) => (n.kind === 'method' || n.kind === 'function') && n.startLine !== n.endLine)
      .sort((a, b) => a.startLine - b.startLine)
      .map((n) => `${n.name}:${n.startLine}-${n.endLine}`),
  };
}

// mORMot2's shape: on x86 a `case` whose `else` the shared code ends, elsewhere a `begin` that it ends, with
// conditionals of its own in that branch.
const CASE_OR_BEGIN = `unit Fakes;

interface

type
  TFake = class
    procedure GetParams(var Ctxt: TContext);
    function Find(const Name: string): Integer;
  end;

implementation

procedure TFake.GetParams(var Ctxt: TContext);
var
  V: Pointer;
  Arg: Integer;
begin
  for Arg := 1 to Ctxt.Count do
  begin
    V := nil;
    {$ifdef CPUX86}
    case Ctxt.Reg[Arg] of
      1:
        RaiseError(Ctxt);
      2:
        V := @Ctxt.EDX;
    else
    {$else}
    {$ifdef HAS_FPREG}
    if Ctxt.FPReg[Arg] > 0 then
      V := @Ctxt.FPRegs[Arg]
    else
    {$endif HAS_FPREG}
      if Ctxt.Reg[Arg] > 0 then
        V := @Ctxt.Regs[Arg];
    if V = nil then
    begin
    {$endif CPUX86}
      if Ctxt.OnStack[Arg] then
        V := @Ctxt.Stack[Arg]
      else
        V := @Ctxt.Vars[Arg];
    end;
    Ctxt.Value[Arg] := Deref(V);
  end;
  Finish(Ctxt);
end;

function TFake.Find(const Name: string): Integer;
begin
  Result := LockedFind(Name);
end;

end.
`;

// mORMot's lock idiom: a `try` where the compiler makes it cheap, else a plain block, the same `end` closing either.
const TRY_OR_BEGIN = `unit Queues;

interface

type
  TQueue = class
    function Pop(out Value: Integer): Boolean;
    procedure Push(Value: Integer);
  end;

implementation

function TQueue.Pop(out Value: Integer): Boolean;
begin
  Lock(fSafe);
  {$ifdef HASFASTTRYFINALLY}
  try
  {$else}
  begin
  {$endif HASFASTTRYFINALLY}
    Result := Take(Value);
  {$ifdef HASFASTTRYFINALLY}
  finally
  {$endif HASFASTTRYFINALLY}
    Unlock(fSafe);
  end;
end;

procedure TQueue.Push(Value: Integer);
begin
  Store(Value);
end;

end.
`;

// DWScript's shape: a Pascal body beside an assembler one right after the header, the Pascal one holding a
// conditional of its own.
const PASCAL_OR_ASM = `unit Atomics;

interface

function AtomicInc(var Value: Integer): Integer;
function AtomicDec(var Value: Integer): Integer;

implementation

function AtomicInc(var Value: Integer): Integer;
{$ifndef WIN32_ASM}
begin
  {$ifdef WINDOWS}
  Result := WinIncrement(Value);
  {$else}
  Result := PortableIncrement(Value);
  {$endif}
{$else}
asm
  mov ecx, eax
  mov eax, 1
  lock xadd [ecx], eax
  inc eax
{$endif}
end;

function AtomicDec(var Value: Integer): Integer;
begin
  Result := PortableDecrement(Value);
end;

end.
`;

// Two branches that each open a `begin` (which the preParse handled) but hold a conditional of their own.
const BEGINS_WITH_NESTED = `unit Macs;

interface

procedure Scan(Info: PInfo);
procedure After;

implementation

procedure Scan(Info: PInfo);
begin
  while Info <> nil do
  begin
    {$ifdef OSDARWIN}
    if Info^.Family = AF_LINK then
    begin
      {$ifdef OSIOS}
      if Info^.Len <> 2 then
      {$endif OSIOS}
        AddLinkMac(Info);
    {$else}
    if Info^.Family = AF_PACKET then
    begin
      AddPacketMac(Info);
    {$endif OSDARWIN}
      Count(Info);
    end;
    Info := Info^.Next;
  end;
end;

procedure After;
begin
  Finish(1);
end;

end.
`;

// DWScript's dwsSHA512 shape: the conditional right after the header holds, at its start, one whose branches each
// open the body. With the outer directives blanked, the inner conditional came right after the header, where the
// grammar reads alternative bodies only.
const NESTED_AT_BODY_START = `unit Swaps;

interface

procedure Swap64(const A: PUInt64; var R: UInt64);
procedure After;

implementation

procedure Swap64(const A: PUInt64; var R: UInt64);
{$ifndef WIN32_ASM}
{$ifndef CPUX64}
  function Swap32(V: Cardinal): Cardinal;
  begin
    Result := Rotate(V);
  end;

begin
  R := Swap32(A^);
{$else CPUX64}
begin
  R := Shuffle(A^)
{$endif CPUX64}
{$else WIN32_ASM}
asm
  mov ecx, eax
  bswap ecx
{$endif WIN32_ASM}
end;

procedure After;
begin
  Finish(1);
end;

end.
`;

// DWScript's dwsXXHash shape: assembler first, then a conditional holding another assembler version beside the
// Pascal body. With both assembler branches blanked, the inner conditional comes right after the header.
const ASSEMBLER_FIRST = `unit Hashes;

interface

function Tail(Data: Pointer; Size: Cardinal): Cardinal;
function After: Cardinal;

implementation

function Tail(Data: Pointer; Size: Cardinal): Cardinal;
{$ifdef WIN32_ASM}
asm
  push ebx
  pop ebx
{$else}{$ifdef WIN64_ASM}
asm
  push rbx
  pop rbx
{$else}
var
  I: Integer;
begin
  Result := Mix(Data, Size);
{$endif}{$endif}
end;

function After: Cardinal;
begin
  Result := Finish(1);
end;

end.
`;

const FIXTURES: Array<[string, string]> = [
  ['a case on one branch and a begin on the other', CASE_OR_BEGIN],
  ['a try on one branch and a begin on the other', TRY_OR_BEGIN],
  ['a Pascal body holding a conditional beside an assembler one', PASCAL_OR_ASM],
  ['two begins on branches that hold conditionals', BEGINS_WITH_NESTED],
  ['a conditional that opens the body nested at its start, after the header', NESTED_AT_BODY_START],
  ['a Pascal body nested after two assembler ones', ASSEMBLER_FIRST],
];

describe('conditionals whose branches each open a block that the code after them closes', () => {
  it.each(FIXTURES)('parses a unit whole past %s', (_name, code) => {
    expect(parsesWhole(code)).toBe(true);
  });

  it('ends the routine at its own end, and gives the routine after it its node and calls', () => {
    const { calls, routines } = extract(CASE_OR_BEGIN, 'Fakes.pas');
    expect(routines).toEqual(['GetParams:13-47', 'Find:49-52']);
    expect(calls).toEqual(['Find->LockedFind', 'GetParams->Deref', 'GetParams->Finish', 'GetParams->RaiseError']);
  });

  it('reads a try kept where another branch opens a begin, finally and all', () => {
    const { calls, routines } = extract(TRY_OR_BEGIN, 'Queues.pas');
    expect(routines).toEqual(['Pop:13-27', 'Push:29-32']);
    expect(calls).toEqual(['Pop->Lock', 'Pop->Take', 'Pop->Unlock', 'Push->Store']);
  });

  it('reads the Pascal body when it holds a conditional of its own', () => {
    const { calls, routines } = extract(PASCAL_OR_ASM, 'Atomics.pas');
    expect(routines).toEqual(['AtomicInc:10-25', 'AtomicDec:27-30']);
    expect(calls).toEqual(['AtomicDec->PortableDecrement', 'AtomicInc->PortableIncrement', 'AtomicInc->WinIncrement']);
  });

  it('keeps one begin of two when the branches hold conditionals of their own', () => {
    const { calls, routines } = extract(BEGINS_WITH_NESTED, 'Macs.pas');
    expect(routines).toEqual(['Scan:10-30', 'After:32-35']);
    expect(calls).toEqual(['After->Finish', 'Scan->AddLinkMac', 'Scan->AddPacketMac', 'Scan->Count']);
  });

  it('reads the body when the conditional that opens it ends up right after the header', () => {
    const swaps = extract(NESTED_AT_BODY_START, 'Swaps.pas');
    expect(swaps.routines).toEqual(['Swap64:10-29', 'Swap32:13-16', 'After:31-34']);
    expect(swaps.calls).toEqual(['After->Finish', 'Swap32->Rotate', 'Swap64->Shuffle', 'Swap64->Swap32']);
    const hashes = extract(ASSEMBLER_FIRST, 'Hashes.pas');
    expect(hashes.routines).toEqual(['Tail:10-25', 'After:27-30']);
    expect(hashes.calls).toEqual(['After->Finish', 'Tail->Mix']);
  });

  it('keeps every offset and line, CRLF included', () => {
    for (const [, code] of FIXTURES) {
      const crlf = code.replace(/\n/g, '\r\n');
      const out = preParsePascal(crlf);
      expect(out.length).toBe(crlf.length);
      const breaks = (s: string) => [...s.matchAll(/\r\n/g)].map((m) => m.index);
      expect(breaks(out)).toEqual(breaks(crlf));
    }
  });

  it('blanks only the begin of the branch that is not kept', () => {
    const line = (code: string, n: number) => preParsePascal(code).split('\n')[n - 1];
    // The case and the try stay; the begin beside each goes.
    expect(line(CASE_OR_BEGIN, 22)).toBe('    case Ctxt.Reg[Arg] of');
    expect(line(CASE_OR_BEGIN, 37)).toBe('         ');
    expect(line(TRY_OR_BEGIN, 17)).toBe('  try');
    expect(line(TRY_OR_BEGIN, 19)).toBe('       ');
    // Of two begins, the first stays.
    expect(line(BEGINS_WITH_NESTED, 16)).toBe('    begin');
    expect(line(BEGINS_WITH_NESTED, 23)).toBe('         ');
    // The assembler branches go whole, and the conditional they leave right after the header loses its directives.
    expect(line(PASCAL_OR_ASM, 13)).toBe('  {$ifdef WINDOWS}');
    expect(line(PASCAL_OR_ASM, 21)!.trim()).toBe('');
    expect(line(ASSEMBLER_FIRST, 15)!.trim()).toBe('');
    expect(line(ASSEMBLER_FIRST, 19)!.trim()).toBe('');
    expect(line(ASSEMBLER_FIRST, 24)!.trim()).toBe('');
  });

  it('leaves alone branches it cannot tell one of to keep', () => {
    // Each branch opens a case: neither can be read as the other's statements.
    const twoCases = `unit Keep;

interface

procedure Pick(K: Integer);

implementation

procedure Pick(K: Integer);
begin
  {$ifdef A}
  case K of
    1: Foo;
  else
  {$else}
  case K + 1 of
    2: Bar;
  else
  {$endif}
    Baz;
  end;
end;

end.
`;
    expect(preParsePascal(twoCases)).toBe(twoCases);
    // The branches open different numbers of blocks, and code under the same condition closes the extra one: which
    // branch's blocks the code after them closes, the count can't tell.
    const uneven = `unit Keep;

interface

procedure Run;

implementation

procedure Run;
begin
  {$ifdef A}
  with Y do
  begin
    if X then
    begin
  {$else}
  if Z then
  begin
  {$endif A}
    Go;
  {$ifdef A}
    end;
  {$endif A}
  end;
end;

end.
`;
    expect(preParsePascal(uneven)).toBe(uneven);
  });

  it('leaves a conditional it did not settle right after a header to the grammar', () => {
    // mORMot's BlowFishCtrInc: whole assembler bodies for two CPUs inside the conditional after the header, which
    // loses its directives. Blanked too, the inner directives would leave `nostackframe; assembler; asm … end;
    // nostackframe; assembler; asm … end;` as plain code; the grammar reads them as alternative bodies instead.
    const code = `unit Ctr;

interface

procedure CtrInc(Iv: PQWord);
function Pop(out Value: Integer): Boolean;

implementation

procedure CtrInc(Iv: PQWord);
{$ifdef ASMINTEL}
{$ifdef ASMX64}
{$ifdef FPC}nostackframe; assembler; asm {$else} asm .noframe {$endif FPC}
  mov rax, qword ptr [Iv]
end;
{$else}
{$ifdef FPC}nostackframe; assembler;{$endif}
asm
  mov ecx, dword ptr [eax]
end;
{$endif ASMX64}
{$else}
begin
  Iv^ := Swap64(Iv^);
end;
{$endif ASMINTEL}

function Pop(out Value: Integer): Boolean;
begin
  {$ifdef HASFASTTRYFINALLY}
  try
  {$else}
  begin
  {$endif HASFASTTRYFINALLY}
    Result := Take(Value);
  {$ifdef HASFASTTRYFINALLY}
  finally
  {$endif HASFASTTRYFINALLY}
    Unlock(1);
  end;
end;

end.
`;
    const out = preParsePascal(code).split('\n');
    expect(out[10]!.trim()).toBe(''); // the conditional after the header: its directives go
    expect(out[11]).toBe('{$ifdef ASMX64}');
    expect(out[12]).toBe('{$ifdef FPC}nostackframe; assembler; asm {$else} asm .noframe {$endif FPC}');
    expect(out[15]).toBe('{$else}');
    // The other routine's begin went, which is what has this pass look again after the header.
    expect(out[32]!.trim()).toBe('');
    expect(extract(code, 'Ctr.pas').calls.filter((c) => c.startsWith('Pop->'))).toEqual(['Pop->Take', 'Pop->Unlock']);
  });

  it('links a call in the routine after the conditional to that routine', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-pascal-conditional-blocks-'));
    try {
      fs.writeFileSync(path.join(dir, 'Lib.pas'), `unit Lib;

interface

function LockedFind(const Name: string): Integer;
function Deref(P: Pointer): Pointer;

implementation

function LockedFind(const Name: string): Integer; begin Result := 0; end;
function Deref(P: Pointer): Pointer; begin Result := P; end;

end.
`);
      fs.writeFileSync(path.join(dir, 'Fakes.pas'), CASE_OR_BEGIN.replace('implementation\n', 'implementation\n\nuses Lib;\n'));
      const cg = await CodeGraph.init(dir, { index: true });
      try {
        const callers = (name: string) => {
          const target = cg.getNodesByKind('function').find((n) => n.qualifiedName === name && n.filePath === 'Lib.pas');
          return target ? cg.getIncomingEdges(target.id).filter((e) => e.kind === 'calls').map((e) => cg.getNode(e.source)?.qualifiedName) : [];
        };
        expect(callers('LockedFind')).toEqual(['TFake::Find']);
        expect(callers('Deref')).toEqual(['TFake::GetParams']);
      } finally {
        cg.close();
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
