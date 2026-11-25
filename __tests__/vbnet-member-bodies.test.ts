/**
 * VB.NET member bodies the extractor used to skip:
 *
 *  - A `Structure` lists each member as its own `body` field, so reading the
 *    field returned only the first member: SCrawler's `UserMedia` indexed its
 *    nested `States` enum (declared first) and nothing else, and a structure
 *    that opened with a field indexed no members at all.
 *  - A property's `Get` / `Set` blocks, its `= initializer` and its
 *    `As New T` were never walked, nor a `Custom Event`'s accessors.
 *  - A field's `= initializer` and `As New T` were never walked.
 *
 * The calls, instantiations and reads in those places belong to the member
 * that declares them.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import type { Node } from '../src/types';

let root = '';
let cg: CodeGraph;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-vb-bodies-'));
  const files: Record<string, string> = {
    'Helper.vb': `Public Class Helper
    Public Sub New(ByVal n As Integer)
    End Sub
    Public Shared Function Compute(ByVal n As Integer) As Integer
        Return n
    End Function
    Public Shared Sub Store(ByVal n As Integer)
    End Sub
    Public Shared Function Seed() As Integer
        Return 1
    End Function
    Public Shared Function Format(ByVal o As Object) As String
        Return ""
    End Function
    Public Shared Sub Log(ByVal s As String)
    End Sub
    Public Shared Sub Attach(ByVal h As EventHandler)
    End Sub
End Class
`,
    'Widget.vb': `Public Class Widget
End Class
`,
    'UserMedia.vb': `Public Structure UserMedia
    Public State As States
    Private Count As Integer
    Public Enum States
        Unknown
        Downloaded
    End Enum
    Public ReadOnly Property Name As String
        Get
            Return Helper.Format(State)
        End Get
    End Property
    Public Sub New(ByVal s As States)
        State = s
        Helper.Log("created")
    End Sub
    Public Function IsDone() As Boolean
        Return State = States.Downloaded
    End Function
End Structure
`,
    'Box.vb': `Public Class Box
    Private _x As Integer
    Private _items As New Widget
    Private _helper As Helper = New Helper(1)
    Private Shared ReadOnly Def As Integer = Helper.Compute(3), Other As Integer = Helper.Seed()
    Public Property Value As Integer
        Get
            Return Helper.Compute(_x)
        End Get
        Set(ByVal v As Integer)
            Helper.Store(v)
            _x = v
        End Set
    End Property
    Public Property Auto As Integer = Helper.Seed()
    Public ReadOnly Property Lst As New Widget
    Public Custom Event Changed As EventHandler
        AddHandler(ByVal value As EventHandler)
            Helper.Attach(value)
        End AddHandler
        RemoveHandler(ByVal value As EventHandler)
        End RemoveHandler
        RaiseEvent(ByVal sender As Object, ByVal e As EventArgs)
        End RaiseEvent
    End Event
End Class
`,
    // The 1.6.2 receiver gate must hold in the newly walked places too:
    // `Me.Panel.Controls.Add(…)` and `New System.Drawing.Size(…)` name no
    // project member.
    'Collections/DataColorCollection.vb': `Friend Class DataColorCollection
    Friend Sub Add(ByVal Item As Object)
    End Sub
End Class
`,
    'Editors/UsersInfoForm.vb': `Friend Class UsersInfoForm
    Private Enum EComparers
        Name
        Size
    End Enum
End Class
`,
    'MainForm.vb': `Public Class MainForm
    Private ReadOnly DefaultSize As System.Drawing.Size = New System.Drawing.Size(184, 25)
    Public ReadOnly Property Ready As Boolean
        Get
            Me.Panel.Controls.Add(Me.Button1)
            Return True
        End Get
    End Property
End Class
`,
  };
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  cg = await CodeGraph.init(root, { index: true });
});

afterAll(() => {
  cg?.close();
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

function member(file: string, qualifiedName: string): Node {
  const node = cg.getNodesInFile(file).find((n) => n.qualifiedName === qualifiedName);
  expect(node, `${qualifiedName} in ${file}`).toBeDefined();
  return node!;
}

/** `kind` edges leaving `node`, as target qualified names. */
function targets(node: Node, kind: string): string[] {
  return cg
    .getOutgoingEdgesFrom([node.id])
    .filter((e) => e.kind === kind)
    .map((e) => cg.getNode(e.target)!.qualifiedName)
    .sort();
}

describe('VB.NET member bodies', () => {
  it('indexes every member of a Structure, not just the first', () => {
    const struct = member('UserMedia.vb', 'UserMedia');
    expect(struct.kind).toBe('struct');
    const contained = cg
      .getOutgoingEdgesFrom([struct.id])
      .filter((e) => e.kind === 'contains')
      .map((e) => cg.getNode(e.target)!)
      .map((n) => `${n.kind} ${n.qualifiedName}`)
      .sort();
    expect(contained).toEqual([
      'enum UserMedia::States',
      'field UserMedia::Count',
      'field UserMedia::State',
      'method UserMedia::IsDone',
      'method UserMedia::New',
      'property UserMedia::Name',
    ]);
    expect(member('UserMedia.vb', 'UserMedia::States::Downloaded').kind).toBe('enum_member');
    expect(targets(member('UserMedia.vb', 'UserMedia::New'), 'calls')).toEqual(['Helper::Log']);
  });

  it("attributes a property's Get and Set blocks to the property", () => {
    expect(targets(member('Box.vb', 'Box::Value'), 'calls')).toEqual(['Helper::Compute', 'Helper::Store']);
    expect(targets(member('UserMedia.vb', 'UserMedia::Name'), 'calls')).toEqual(['Helper::Format']);
  });

  it("walks a property's initializer and its As New", () => {
    expect(targets(member('Box.vb', 'Box::Auto'), 'calls')).toEqual(['Helper::Seed']);
    expect(targets(member('Box.vb', 'Box::Lst'), 'instantiates')).toEqual(['Widget']);
  });

  it("walks each field's initializer and its As New, per declarator", () => {
    expect(targets(member('Box.vb', 'Box::Def'), 'calls')).toEqual(['Helper::Compute']);
    expect(targets(member('Box.vb', 'Box::Other'), 'calls')).toEqual(['Helper::Seed']);
    expect(targets(member('Box.vb', 'Box::_items'), 'instantiates')).toEqual(['Widget']);
    expect(targets(member('Box.vb', 'Box::_helper'), 'instantiates')).toEqual(['Helper']);
  });

  it("attributes a Custom Event's accessors to the event", () => {
    expect(targets(member('Box.vb', 'Box::Changed'), 'calls')).toEqual(['Helper::Attach']);
  });

  it('keeps the class out of what its members do', () => {
    expect(targets(member('Box.vb', 'Box'), 'calls')).toEqual([]);
    expect(targets(member('Box.vb', 'Box'), 'instantiates')).toEqual([]);
  });

  it('still links nothing through a receiver no name resolves', () => {
    const ids = cg.getNodesInFile('MainForm.vb').map((n) => n.id);
    const linked = cg
      .getOutgoingEdgesFrom(ids)
      .filter((e) => e.kind !== 'contains')
      .map((e) => cg.getNode(e.target)!.qualifiedName);
    expect(linked).not.toContain('DataColorCollection::Add');
    expect(linked).not.toContain('UsersInfoForm::EComparers::Size');
  });
});
