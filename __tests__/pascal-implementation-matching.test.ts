/**
 * A Pascal implementation finds the declaration it implements, and the
 * routine's node is located at it (#3453), where the declarations of its
 * name differ only in what overloads keep apart: their result type, a type
 * written another way, a `{$IFDEF}` around them. Seen on SynEdit (`AddKey`,
 * declared alike in both `{$IFDEF}` branches), mORMot (`class operator
 * Implicit`, overloaded by its result; assembler and Pascal bodies of one
 * routine under `{$ifdef}`), gnugettext (`Number: Integer` implementing a
 * declared `Number: Longint`) and DelphiMVCFramework (a parse error the
 * routine above ran into).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { extractFromSource } from '../src/extraction';
import { initGrammars, loadGrammarsForLanguages } from '../src/extraction/grammars';
import type { Node } from '../src/types';

beforeAll(async () => {
  await initGrammars();
  await loadGrammarsForLanguages(['pascal']);
});

const extract = (source: string) => extractFromSource('Demo.pas', source, 'pascal');
const routines = (source: string) => extract(source).nodes.filter((n) => n.kind === 'method' || n.kind === 'function');
function body(source: string, node: Node): string {
  return source.split('\n').slice(node.startLine - 1, node.endLine).join('\n');
}
/** The qualified name of the routine a call of `name` is made from, or the file's name. */
function callerOf(source: string, name: string): string | undefined {
  const result = extract(source);
  const ref = result.unresolvedReferences.find((r) => r.referenceName === name);
  return result.nodes.find((n) => n.id === ref?.fromNodeId)?.qualifiedName;
}

describe('Pascal implementations find their declarations (#3453)', () => {
  it('gives the body to the first of two declarations that {$IFDEF} branches write alike', () => {
    const source = `unit Demo;
interface
type
  TEditor = class
{$IFDEF NEWER}
    procedure AddKey(Key: Word; Shift: Integer = 0);
{$ELSE}
    procedure AddKey(Key: Word; Shift: Integer);
{$ENDIF}
  end;
implementation
procedure TEditor.AddKey(Key: Word; Shift: Integer);
begin
  Store(Key);
end;
end.`;
    const keys = routines(source).filter((n) => n.name === 'AddKey');
    expect(keys).toHaveLength(2);
    expect(body(source, keys[0]!)).toContain('Store(Key);');
    expect(keys[1]!.startLine).toBe(8);
    expect(callerOf(source, 'Store')).toBe('TEditor::AddKey');
  });

  it('tells operator overloads apart by their result type', () => {
    const source = `unit Demo;
interface
type
  TValue = record
    class operator Implicit(const A: TValue): Integer;
    class operator Implicit(const A: TValue): Boolean;
  end;
implementation
class operator TValue.Implicit(const A: TValue): Integer;
begin
  Result := AsNumber(A);
end;
class operator TValue.Implicit(const A: TValue): Boolean;
begin
  Result := AsFlag(A);
end;
end.`;
    const ops = routines(source).filter((n) => n.name === 'Implicit');
    expect(ops).toHaveLength(2);
    expect(body(source, ops[0]!)).toContain('AsNumber(A)');
    expect(body(source, ops[1]!)).toContain('AsFlag(A)');
    expect(callerOf(source, 'AsNumber')).toBe('TValue::Implicit');
    expect(callerOf(source, 'AsFlag')).toBe('TValue::Implicit');
  });

  it('matches an overload whose implementation writes Integer for a declared Longint', () => {
    const source = `unit Demo;
interface
type
  TList = class
    function Get(N: Longint): Integer; overload;
    function Get(const S: string): Integer; overload;
  end;
implementation
function TList.Get(N: Integer): Integer;
begin
  Result := ByIndex(N);
end;
function TList.Get(const S: string): Integer;
begin
  Result := ByName(S);
end;
end.`;
    const gets = routines(source).filter((n) => n.name === 'Get');
    expect(body(source, gets.find((n) => n.signature?.includes('Longint'))!)).toContain('ByIndex(N)');
    expect(body(source, gets.find((n) => n.signature?.includes('string'))!)).toContain('ByName(S)');
    expect(callerOf(source, 'ByIndex')).toBe('TList::Get');
  });

  it('matches an overload when at least half of its parameter types are written alike', () => {
    const source = `unit Demo;
interface
type
  TCount = Integer;
  TText = class
    function Plural(const D: string; const S, P: WideString; N: TCount): string; overload;
    function Plural(const D: string; const S, P: AnsiString; N: TCount): string; overload;
  end;
implementation
function TText.Plural(const D: string; const S, P: WideString; N: Integer): string;
begin
  Result := Lookup(S);
end;
function TText.Plural(const D: string; const S, P: AnsiString; N: Integer): string;
begin
  Result := Widen(S);
end;
end.`;
    const plurals = routines(source).filter((n) => n.name === 'Plural');
    expect(body(source, plurals.find((n) => n.signature?.includes('WideString'))!)).toContain('Lookup(S)');
    expect(body(source, plurals.find((n) => n.signature?.includes('AnsiString'))!)).toContain('Widen(S)');
  });

  it('keeps a routine with no parameters in common apart from a declared overload', () => {
    const source = `unit Demo;
interface
procedure Run(I: Integer); overload;
implementation
procedure Run(const S: string); overload;
begin
  Private1;
end;
procedure Run(I: Integer);
begin
  Public1;
end;
end.`;
    const runs = routines(source).filter((n) => n.name === 'Run');
    expect(runs).toHaveLength(2);
    expect(body(source, runs.find((n) => n.signature === '(I: Integer)')!)).toContain('Public1;');
    expect(body(source, runs.find((n) => n.signature === '(const S: string)')!)).toContain('Private1;');
  });

  it('spans both implementations a routine has under {$IFDEF}', () => {
    const source = `unit Demo;
interface
procedure Move(Count: Integer);
implementation
{$IFDEF CPUX64}
procedure Move(Count: Integer);
begin
  FastMove(Count);
end;
{$ELSE}
procedure Move(Count: Integer);
begin
  SlowMove(Count);
end;
{$ENDIF}
end.`;
    const move = routines(source).find((n) => n.name === 'Move')!;
    expect(move).toMatchObject({ startLine: 6, endLine: 14 });
    expect(callerOf(source, 'FastMove')).toBe('Move');
    expect(callerOf(source, 'SlowMove')).toBe('Move');
  });

  it('keeps the first implementation when another routine stands between the two', () => {
    const source = `unit Demo;
interface
procedure Move(Count: Integer);
implementation
{$IFDEF CPUX64}
procedure Move(Count: Integer);
begin
  FastMove(Count);
end;
{$ENDIF}
procedure Other;
begin
end;
{$IFNDEF CPUX64}
procedure Move(Count: Integer);
begin
  SlowMove(Count);
end;
{$ENDIF}
end.`;
    const move = routines(source).find((n) => n.name === 'Move')!;
    expect(move).toMatchObject({ startLine: 6, endLine: 9 });
    expect(callerOf(source, 'SlowMove')).toBe('Move');
  });

  it.each([
    ['a subrange', 'TPercent = 0 .. 100;'],
    ['a set of a subrange', 'TBits = set of 0..255;'],
  ])('names a class declared after %s, which the grammar cannot read, and finds its methods', (_label, before) => {
    const source = `unit Demo;
interface
type
  ${before}

  /// The area a constraint applies to.
  TArea = class(TObject)
  protected
    function AsJson: string;
  end;
implementation
function TArea.AsJson: string;
begin
  Result := Dump();
end;
end.`;
    const result = extract(source);
    expect(result.nodes.filter((n) => n.kind === 'class').map((n) => n.name)).toEqual(['TArea']);
    expect(result.nodes.find((n) => n.kind === 'type_alias')?.name).toBe(before.split(' ')[0]);
    const method = result.nodes.find((n) => n.name === 'AsJson')!;
    expect(method.qualifiedName).toBe('TArea::AsJson');
    expect(body(source, method)).toContain('Result := Dump();');
    expect(callerOf(source, 'Dump')).toBe('TArea::AsJson');
  });

  it('starts a routine a parse error ran into at its own header', () => {
    // The parse of the `Assign` operator's implementation, with its
    // `const [ref]` parameter, breaks and runs into the header of `Keys`
    // below it. (The grammar's error recovery depends on this exact text.)
    const source = `unit Demo;
interface
type

  TStoreItemsData<T: class> = class;

  TStoreItemsWriteTransactionRec<T: class> = record
  private
    fInUse_: Boolean;
    fStore_: TStoreItemsData<T>;
    constructor OpenForWrite(Parent: TStoreItemsData<T>);
  public
    class operator Finalize(var Dest: TStoreItemsWriteTransactionRec<T>);
    class operator Initialize (out Dest: TStoreItemsWriteTransactionRec<T>);
    class operator Assign (var Dest: TStoreItemsWriteTransactionRec<T>; const [ref] Src: TStoreItemsWriteTransactionRec<T>);
    // Members a writer calls while open
    procedure PutValue(const AName: string; const AValue: T);
    procedure DropItem(const AName: string);
    function HasValue(const AName: string; out AValue: T): Boolean;
    function ReadValue(const AName: string): T;
    function Keys: TArray<String>;
  end;
implementation
class operator TStoreItemsWriteTransactionRec<T>.Initialize(out Dest: TStoreItemsWriteTransactionRec<T>);
begin
  Dest.fInUse_ := False;
  Dest.fStore_ := nil;
end;

class operator TStoreItemsWriteTransactionRec<T>.Finalize(var Dest: TStoreItemsWriteTransactionRec<T>);
begin
  if Dest.fInUse_ then
  begin
    Dest.fStore_.FLOCK.UnlockWrite;
  end;
end;

class operator TStoreItemsWriteTransactionRec<T>.Assign(var Dest: TStoreItemsWriteTransactionRec<T>;  const [ref] Src: TStoreItemsWriteTransactionRec<T>);
begin
  if Src.fInUse_ then
  begin
    raise Exception.Create('Transaction slot is already in use now');
  end;
  Dest.fInUse_ := True;
  Dest.fStore_ := Src.fStore_;
  Dest.fStore_.FLOCK.LockWrite;
end;

function TStoreItemsWriteTransactionRec<T>.Keys: TArray<String>;
begin
  Result := fStore_.FItems.Keys.ToArray;
end;

procedure TStoreItemsWriteTransactionRec<T>.DropItem(const AName: string);
begin
  Self.fStore_.FItems.Remove(AName);
end;
end.`;
    const keys = routines(source).find((n) => n.name === 'Keys')!;
    expect(keys.startLine).toBe(49);
    expect(body(source, keys)).not.toContain('Assign');
    expect(body(source, keys)).toContain('Result := fStore_.FItems.Keys.ToArray;');
  });
});
