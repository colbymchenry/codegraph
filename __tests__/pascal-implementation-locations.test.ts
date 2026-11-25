import { beforeAll, describe, expect, it } from 'vitest';
import { extractFromSource } from '../src/extraction';
import { initGrammars, loadGrammarsForLanguages } from '../src/extraction/grammars';
import type { Node } from '../src/types';

beforeAll(async () => {
  await initGrammars();
  await loadGrammarsForLanguages(['pascal']);
});

const extract = (source: string) => extractFromSource('Demo.pas', source, 'pascal');
const routines = (source: string) => extract(source).nodes.filter(n => n.kind === 'method' || n.kind === 'function');
function body(source: string, node: Node): string {
  const lines = source.split('\n').slice(node.startLine - 1, node.endLine);
  if (lines.length === 1) return lines[0]!.slice(node.startColumn, node.endColumn);
  lines[0] = lines[0]!.slice(node.startColumn);
  lines[lines.length - 1] = lines[lines.length - 1]!.slice(0, node.endColumn);
  return lines.join('\n');
}

describe('Pascal implementations own routine source ranges (#3453)', () => {
  it('keeps declaration identity and metadata while locating the complete implementation', () => {
    const declaration = `unit Demo;
interface
type TWorker = class
protected
  /// Stops the worker.
  procedure Stop(Count: Integer); virtual;
end;
implementation
`;
    const source = declaration + `procedure TWorker.Stop(Value: Integer);
var Local: Integer;
begin
  Local := Value;
  WriteLn('stop');
end;
end.`;
    const node = routines(source).find(n => n.name === 'Stop')!;
    const original = routines(declaration + 'end.').find(n => n.name === 'Stop')!;
    expect(node).toMatchObject({ id: original.id, qualifiedName: 'TWorker::Stop', visibility: 'protected', signature: '(Count: Integer)' });
    expect(node.docstring).toContain('Stops the worker.');
    expect(body(source, node)).toBe("procedure TWorker.Stop(Value: Integer);\nvar Local: Integer;\nbegin\n  Local := Value;\n  WriteLn('stop');\nend;");
  });

  it('locates an interface-declared free function at its implementation', () => {
    const source = `unit Demo;
interface
function Value: Integer;
implementation
function Value: Integer;
begin
  Result := 42;
end;
end.`;
    const nodes = routines(source);
    expect(nodes).toHaveLength(1);
    expect(nodes[0]).toMatchObject({ startLine: 5, endLine: 8 });
    expect(body(source, nodes[0]!)).toContain('Result := 42;');
  });

  it('reuses a forward declared after an earlier implementation', () => {
    const source = `unit Demo;
interface
implementation
procedure First; begin end;
procedure Later(N: Integer); forward;
procedure Later(N: Integer);
begin
  WriteLn(N);
end;
end.`;
    const nodes = routines(source).filter(n => n.name === 'Later');
    expect(nodes).toHaveLength(1);
    expect(nodes[0]).toMatchObject({ startLine: 6, endLine: 9 });
  });

  it('spans implementation-only functions and their nested routines independently', () => {
    const source = `unit Demo;
interface
implementation
procedure Outer;
  procedure Inner;
  begin
    WriteLn('inner');
  end;
begin
  Inner;
end;
end.`;
    const nodes = routines(source);
    expect(nodes.find(n => n.qualifiedName === 'Outer')).toMatchObject({ startLine: 4, endLine: 11 });
    expect(nodes.find(n => n.qualifiedName === 'Outer::Inner')).toMatchObject({ startLine: 5, endLine: 8 });
  });

  it('pairs overloaded methods by parameter types despite renamed parameters and reversed implementations', () => {
    const source = `unit Demo;
interface
type TWorker = class
  procedure Send(I: Integer); overload;
  procedure Send(const S: string); overload;
end;
implementation
procedure TWorker.Send(const Text: string); begin WriteLn('text body'); end;
procedure TWorker.Send(Value: Integer); begin WriteLn('integer body'); end;
end.`;
    const nodes = routines(source).filter(n => n.name === 'Send');
    expect(nodes).toHaveLength(2);
    expect(body(source, nodes.find(n => n.signature === '(I: Integer)')!)).toContain("'integer body'");
    expect(body(source, nodes.find(n => n.signature === '(const S: string)')!)).toContain("'text body'");
    expect(new Set(nodes.map(n => n.startLine))).toEqual(new Set([8, 9]));
  });

  it('matches grouped parameters and ignores declaration default values', () => {
    const source = `unit Demo;
interface
procedure Send(Left, Right: Integer); overload;
procedure Send(Text: string = 'default'); overload;
implementation
procedure Send(A: Integer; B: Integer); begin WriteLn('pair body'); end;
procedure Send(Value: string); begin WriteLn('string body'); end;
end.`;
    const nodes = routines(source).filter(n => n.name === 'Send');
    expect(nodes).toHaveLength(2);
    expect(body(source, nodes.find(n => n.signature?.includes('Left'))!)).toContain("'pair body'");
    expect(body(source, nodes.find(n => n.signature?.includes('default'))!)).toContain("'string body'");
  });

  it('keeps implementation-only overloads as separate bodies', () => {
    const source = `unit Demo;
interface
implementation
procedure Send(I: Integer); overload; begin WriteLn('integer body'); end;
procedure Send(S: string); overload; begin WriteLn('string body'); end;
end.`;
    const nodes = routines(source).filter(n => n.name === 'Send');
    expect(nodes).toHaveLength(2);
    expect(body(source, nodes.find(n => n.signature === '(I: Integer)')!)).toContain("'integer body'");
    expect(body(source, nodes.find(n => n.signature === '(S: string)')!)).toContain("'string body'");
  });

  it('keeps a zero-argument implementation-only overload separate from an earlier body', () => {
    const source = `unit Demo;
interface
implementation
procedure Run(I: Integer); overload; begin WriteLn('integer body'); end;
procedure Run; overload; begin WriteLn('zero argument body'); end;
end.`;
    const nodes = routines(source).filter(n => n.name === 'Run');
    expect(nodes).toHaveLength(2);
    expect(body(source, nodes.find(n => n.signature === '(I: Integer)')!)).toContain("'integer body'");
    expect(body(source, nodes.find(n => !n.signature)!)).toContain("'zero argument body'");
  });

  it('reuses an unimplemented declaration when its implementation omits the parameter list', () => {
    const source = `unit Demo;
interface
procedure Run(I: Integer);
implementation
procedure Run;
begin
  WriteLn(I);
end;
end.`;
    const nodes = routines(source).filter(n => n.name === 'Run');
    expect(nodes).toHaveLength(1);
    expect(nodes[0]).toMatchObject({ signature: '(I: Integer)', startLine: 5, endLine: 8 });
    expect(body(source, nodes[0]!)).toContain('WriteLn(I);');
  });

  it.each([
    ['method', 'type TWorker = class procedure Run(I: Integer); end;', 'TWorker.Run'],
    ['free routine', 'procedure Run(I: Integer);', 'Run'],
  ])('matches a unique %s when the implementation qualifies its parameter type', (_label, declaration, name) => {
    const source = `unit Demo;
interface
${declaration}
implementation
procedure ${name}(I: System.Integer);
begin
  WriteLn(I);
end;
end.`;
    const result = extract(source);
    const nodes = result.nodes.filter(n => n.name === 'Run');
    expect(nodes).toHaveLength(1);
    expect(body(source, nodes[0]!)).toContain('WriteLn(I);');
    expect(result.unresolvedReferences.find(r => r.referenceName === 'WriteLn')?.fromNodeId).toBe(nodes[0]!.id);
  });

  it('does not attach an implementation-only overload to a different public overload', () => {
    const source = `unit Demo;
interface
procedure Run(I: Integer); overload;
implementation
procedure Run(S: string); overload; begin WriteLn('private body'); end;
procedure Run(I: Integer); begin WriteLn('public body'); end;
end.`;
    const nodes = routines(source).filter(n => n.name === 'Run');
    expect(nodes).toHaveLength(2);
    expect(body(source, nodes.find(n => n.signature === '(I: Integer)')!)).toContain("'public body'");
    expect(body(source, nodes.find(n => n.signature === '(S: string)')!)).toContain("'private body'");
  });

  it('keeps similarly named class methods separate and matches names without case sensitivity', () => {
    const source = `unit Demo;
interface
type TFirst = class procedure Run; end;
     TSecond = class procedure Run; end;
implementation
procedure tsecond.run; begin WriteLn('second body'); end;
procedure TFirst.Run; begin WriteLn('first body'); end;
end.`;
    const nodes = routines(source);
    expect(body(source, nodes.find(n => n.qualifiedName === 'TFirst::Run')!)).toContain("'first body'");
    expect(body(source, nodes.find(n => n.qualifiedName === 'TSecond::Run')!)).toContain("'second body'");
  });

  it.each([
    ['T: class', 'T'],
    ['T, U: class; V: record', 'T, U, V'],
  ])('matches generic class parameters %s without losing declaration constraints', (declaration, implementation) => {
    const source = `unit Demo;
interface
type TBox<${declaration}> = class procedure Reset; end;
implementation
procedure TBox<${implementation}>.Reset;
begin
  WriteLn('generic body');
end;
end.`;
    const nodes = routines(source).filter(n => n.name === 'Reset');
    expect(nodes).toHaveLength(1);
    expect(nodes[0]!.qualifiedName).toContain(`TBox<${declaration}>`);
    expect(body(source, nodes[0]!)).toContain("'generic body'");
  });

  it.each([
    ['a non-generic routine', 'Make'],
    ['a different generic arity', 'Make<T, U>'],
  ])('keeps a generic implementation separate from %s', (_label, otherName) => {
    const implementations = [
      'function Make<T>: Integer; begin Result := 1; end;',
      `function ${otherName}: Integer; begin Result := 2; end;`,
    ];
    const source = `unit Demo;\ninterface\nimplementation\n${implementations.join('\n')}\nend.`;
    const nodes = routines(source);
    expect(nodes).toHaveLength(2);
    expect(nodes.map(n => body(source, n))).toEqual(implementations);
  });

  it('keeps methods of generic and non-generic classes with the same name separate', () => {
    const source = `unit Demo;
interface
type TWorker = class procedure Run; end;
     TWorker<T> = class procedure Run; end;
implementation
procedure TWorker<T>.Run; begin WriteLn('generic body'); end;
procedure TWorker.Run; begin WriteLn('plain body'); end;
end.`;
    const nodes = routines(source).filter(n => n.name === 'Run');
    expect(nodes).toHaveLength(2);
    expect(body(source, nodes.find(n => n.qualifiedName === 'TWorker::Run')!)).toContain("'plain body'");
    expect(body(source, nodes.find(n => n.qualifiedName === 'TWorker<T>::Run')!)).toContain("'generic body'");
  });

  it('keeps declaration-only methods at their original locations', () => {
    const source = `unit Demo;
interface
type TWorker = class
  procedure Pending; virtual; abstract;
end;
implementation
end.`;
    const node = routines(source).find(n => n.name === 'Pending')!;
    expect(node).toMatchObject({ startLine: 4, endLine: 4 });
    expect(body(source, node)).toBe('procedure Pending; virtual; abstract;');
  });

  it('does not move a free routine onto an unmatched qualified method body', () => {
    const source = `unit Demo;
interface
procedure Run;
implementation
procedure Run; begin WriteLn('free body'); end;
procedure TMissing.Run; begin WriteLn('unrelated body'); end;
end.`;
    const node = routines(source).find(n => n.qualifiedName === 'Run')!;
    expect(body(source, node)).toContain("'free body'");
    expect(body(source, node)).not.toContain('TMissing');
  });

  it.each([
    ['asm', 'procedure Run; assembler;\nasm\n  nop\nend;'],
    ['conditional bodies', 'procedure Run;\n{$IFDEF FIRST}\nbegin WriteLn(1); end;\n{$ELSE}\nbegin WriteLn(2); end;\n{$ENDIF}'],
  ])('retains the complete %s implementation', (_label, implementation) => {
    const source = `unit Demo;\ninterface\nprocedure Run;\nimplementation\n${implementation}\nend.`;
    expect(body(source, routines(source).find(n => n.name === 'Run')!)).toBe(implementation);
  });

  it('does not swallow a later routine when a broken parse nests it', () => {
    const source = `procedure First
begin
end;
function Second: Integer;
begin
  Result := 2;
end;`;
    const nodes = routines(source);
    expect(body(source, nodes.find(n => n.name === 'First')!)).not.toContain('Second');
    expect(body(source, nodes.find(n => n.name === 'Second')!)).toContain('Result := 2;');
  });
});
