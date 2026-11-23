/**
 * What a Pascal call reaches once a routine is located at its
 * implementation (#3453), where the name strategies, which weigh candidates
 * by where they are, find it nearer:
 *  - the overload its argument count fits: HeidiSQL's `SetRedraw(False)`
 *    reached `SetRedraw(AHandle: HWND; const Value: Boolean)`, implemented
 *    nearer the call;
 *  - through a receiver, a method other than the calling routine: SynEdit's
 *    `Attribute[i].Assign(…)` in `TSynCustomHighlighter.Assign` reached the
 *    routine itself, an answer the resolver drops.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';

const FILLER = Array.from({ length: 30 }, (_, i) => `procedure Filler${i};\nbegin\nend;`).join('\n');

const FILES: Record<string, string> = {
  'Win.pas': `unit Win;
interface
type
  TWin = class
    procedure SetRedraw(const Value: Boolean); overload;
    procedure SetRedraw(Handle: Integer; const Value: Boolean); overload;
    procedure Log(const Text: string); overload;
    procedure Log(const Text, Detail: string); overload;
    procedure Show(const Caption: string; Flags: Integer = 0); overload;
    procedure Show(Left, Top, Width: Integer); overload;
    procedure Paint;
    procedure Trace;
  end;
implementation
procedure TWin.SetRedraw(const Value: Boolean);
begin
end;
procedure TWin.Log(const Text: string);
begin
end;
procedure TWin.Show(const Caption: string; Flags: Integer = 0);
begin
end;
${FILLER}
procedure TWin.SetRedraw(Handle: Integer; const Value: Boolean);
begin
end;
procedure TWin.Log(const Text, Detail: string);
begin
end;
procedure TWin.Show(Left, Top, Width: Integer);
begin
end;
procedure TWin.Paint;
begin
  SetRedraw(False);
  SetRedraw(0, True);
  Log(Format('%d, %d', [1, 2]));
  Log('a, b', { a comment, with a comma }
    'c');
  Show('title');
  Show('title', 1);
  Show(1, 2, 3);
end;
procedure TWin.Trace;
var
  log: TWin;
begin
  log := Self;
  log.Log('a', 'b');
end;
end.
`,
};

describe('a Pascal call reaches the overload its arguments fit', () => {
  let root = '';
  let cg: CodeGraph | undefined;

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-pascal-overload-fit-'));
    for (const [rel, content] of Object.entries(FILES)) fs.writeFileSync(path.join(root, rel), content);
    cg = await CodeGraph.init(root, { index: true });
  }, 60_000);

  afterAll(() => {
    cg?.close();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  /** For each call the method `from` makes to `name`, by line: the signature of the overload it reaches. */
  function reached(name: string, from = 'Paint'): string[] {
    const caller = cg!.getNodesInFile('Win.pas').find((n) => n.name === from && n.kind === 'method');
    expect(caller).toBeDefined();
    return cg!
      .getOutgoingEdges(caller!.id)
      .filter((e) => e.kind === 'calls')
      .map((e) => ({ line: e.line ?? 0, target: cg!.getNode(e.target)! }))
      .filter((c) => c.target.name === name)
      .sort((a, b) => a.line - b.line)
      .map((c) => c.target.signature ?? '');
  }

  it('reaches the one-parameter overload for one argument, though the other is implemented nearer', () => {
    expect(reached('SetRedraw')).toEqual(['(const Value: Boolean)', '(Handle: Integer; const Value: Boolean)']);
  });

  it('counts arguments past commas in strings, brackets, nested calls, comments and line breaks', () => {
    expect(reached('Log')).toEqual(['(const Text: string)', '(const Text, Detail: string)']);
  });

  it('counts the arguments of the call, not of a receiver named like it', () => {
    expect(reached('Log', 'Trace')).toEqual(['(const Text, Detail: string)']);
  });

  it('counts a parameter with a default as one an argument may leave out', () => {
    expect(reached('Show')).toEqual([
      '(const Caption: string; Flags: Integer = 0)',
      '(const Caption: string; Flags: Integer = 0)',
      '(Left, Top, Width: Integer)',
    ]);
  });
});

describe('a Pascal call through a receiver is not the routine making it', () => {
  let root = '';
  let cg: CodeGraph | undefined;

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-pascal-receiver-call-'));
    fs.writeFileSync(path.join(root, 'Highlighter.pas'), `unit Highlighter;
interface
type
  TAttr = class
    procedure Assign(Source: TAttr);
  end;
  THighlighter = class
  private
    function GetAttribute(Index: Integer): TAttr;
  public
    procedure Assign(Source: THighlighter);
    property Attribute[Index: Integer]: TAttr read GetAttribute;
  end;
implementation
procedure TAttr.Assign(Source: TAttr);
begin
end;
function THighlighter.GetAttribute(Index: Integer): TAttr;
begin
  Result := nil;
end;
procedure THighlighter.Assign(Source: THighlighter);
var
  i: Integer;
begin
  for i := 0 to 3 do
    Attribute[i].Assign(Source.Attribute[i]);
end;
end.
`);
    cg = await CodeGraph.init(root, { index: true });
  }, 60_000);

  afterAll(() => {
    cg?.close();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it("reaches the receiver's method of the name, not the calling routine", () => {
    const caller = cg!.getNodesInFile('Highlighter.pas').find((n) => n.qualifiedName === 'THighlighter::Assign');
    expect(caller).toBeDefined();
    const called = cg!
      .getOutgoingEdges(caller!.id)
      .filter((e) => e.kind === 'calls')
      .map((e) => cg!.getNode(e.target)!.qualifiedName);
    expect(called).toEqual(['TAttr::Assign']);
  });
});
