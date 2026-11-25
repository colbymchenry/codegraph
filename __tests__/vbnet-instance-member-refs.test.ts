/**
 * VB.NET: a field or property read or written through a value — a parameter
 * (`x.Normal = 3`), a local (`h.Normal`), a field (`_h.Title`), `Me._h.Normal`,
 * `MyBase.Count`, a `With` block's `.Value`, an object initializer's
 * `.Switch` — is a use of the member of the type that value is declared as.
 * Before, calls through a typed receiver linked (#2351) and reads through a
 * type's name (#2305), but no read through a value, so `codegraph callers` on
 * an instance field or property listed almost none of its uses.
 *
 * The receiver is typed by the rules calls use — its declaration (`As`, `As
 * New`, a cast, a `For Each` over a typed collection, a type parameter's
 * constraint, a Module variable), the namespaces around the read, what the
 * type inherits — and a path (`Me._h.Normal`, `n.Child.Value`) one link at a
 * time. An outside type, `Object`, an untyped name or an index links nothing:
 * a value's member is never guessed by name.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { extractFromSource } from '../src/extraction';
import { initGrammars, loadGrammarsForLanguages } from '../src/extraction/grammars';

let root = '';
let cg: CodeGraph;

const files: Record<string, string> = {
  // The issue's two files, verbatim.
  'Holder.vb': `Public Class Holder
    Public Shared SharedCache As Integer
    Public Normal As Integer
    Public Property Title As String
    Public Sub EndSession()
    End Sub
End Class
`,
  'User.vb': `Public Class User
    Private _h As New Holder()
    Public Sub Run(x As Holder)
        Dim b As Integer = x.SharedCache
        Dim n As Integer = x.Normal
        x.Normal = 3
        Dim t As String = _h.Title
        Me._h.Normal = 4
        Dim h As New Holder()
        Dim m As Integer = h.Normal
        x.EndSession()
    End Sub
End Class
`,
  'Node.vb': `Public Class Node
    Public Value As Integer
    Public Property Child As Node
    Public Items As New List(Of String)
    Public Event Changed As EventHandler
    Public Sub Reset()
    End Sub
    Public Function Describe() As String
        Return ""
    End Function
End Class
`,
  // Me, MyBase, a path through members, an inherited member; an index into a
  // field, a method named without parentheses, an event, AddressOf.
  'Views.vb': `Public Class BaseView
    Protected Caption As String
    Public Overridable Property Count As Integer
End Class

Public Class DerivedView
    Inherits BaseView
    Private _node As Node
    Public Sub New(caption As String)
        Me.Caption = caption
    End Sub
    Public Overrides Property Count As Integer
        Get
            Return MyBase.Count + Me._node.Child.Value
        End Get
        Set(value As Integer)
            MyBase.Count = value
        End Set
    End Property
    Public Sub Watch(n As Node)
        Dim first = n.Items(0)
        Dim text = n.Describe
        AddHandler n.Changed, AddressOf OnChanged
        Dim reset As Action = AddressOf n.Reset
        Dim nodes As New List(Of Node)
        For Each child In nodes
            child.Value = 1
        Next
    End Sub
    Private Sub OnChanged(sender As Object, e As EventArgs)
    End Sub
End Class
`,
  // With blocks (nested, through Me, through a cast), an object initializer, a
  // cast; an anonymous type declares its own members.
  'Builder.vb': `Public Class Builder
    Private _node As New Node()
    Property Seed As New Node With {.Value = 7}
    Public Sub Fill(o As Object, n As Node)
        With n
            .Value = 1
            Dim d = .Describe()
            With .Child
                .Reset()
            End With
        End With
        With Me._node
            .Child = Nothing
        End With
        With DirectCast(o, Node)
            .Items.Clear()
        End With
        Dim v = TryCast(o, Node).Value
        Dim anonymous = New With {.Value = 2}
    End Sub
End Class
`,
  // A Module variable, a type parameter's constraint.
  'Globals.vb': `Public Module Globals
    Public Current As Node
End Module
`,
  'Repo.vb': `Public Class Repo(Of T As Node)
    Private _item As T
    Public Function Peek() As Integer
        Return _item.Value + Current.Value
    End Function
End Class
`,
  // A field's type is the one the namespace around it declares.
  'Sites/Reddit.vb': `Namespace API.Reddit
    Friend Class SiteSettings
        Friend Property Header As String
    End Class
    Friend Class UserData
        Private _settings As SiteSettings
        Friend Function Key() As String
            Return _settings.Header
        End Function
    End Class
End Namespace
`,
  'Sites/Twitter.vb': `Namespace API.Twitter
    Friend Class SiteSettings
        Friend Property Header As String
    End Class
End Namespace
`,
  // staxrip's encoder options: a property an initializer sets up, written later.
  'Encoder.vb': `Public MustInherit Class CommandLineParam
    Property Switch As String
    Property Text As String
End Class

Public Class BoolParam
    Inherits CommandLineParam
    Property Value As Boolean
End Class

Public Class x265Enc
    Property ConstVBV As New BoolParam With {
        .Switch = "--const-vbv",
        .Text = "Enable VBV algorithm to be consistent across runs"}
    Sub Apply()
        ConstVBV.Value = False
    End Sub
End Class
`,
  // "Color Color": a value named like its type reads an instance member
  // through itself, a Shared member and an Enum case through the type. And
  // staxrip names enums in lower case.
  'Theme.vb': `Public Class Theme
    Public Shared Current As Theme
    Public Const Version As String = "1"
    Public Property General As String
End Class

Public Enum Mode
    Fast
End Enum

Public Enum x265RateMode
    Bitrate
End Enum

Public Class Painter
    Public Property Mode As Mode
    Public Sub Paint(theme As Theme)
        Dim g = theme.General
        Dim c = theme.Current
        Dim v = theme.Version
        Dim f = Mode.Fast
        Dim r = x265RateMode.Bitrate
    End Sub
End Class
`,
  // What links nothing: an outside type, Object, an untyped name, an index's
  // element; and a parameter named like a type is read as the parameter.
  'Lookalike.vb': `Public Class Lookalike
    Public Length As Integer
    Public Count As Integer
    Public Value As Integer
End Class
`,
  'Negatives.vb': `Public Class Negatives
    Public Sub Go(s As String, o As Object, list As List(Of Node), ByVal untyped)
        Dim a = s.Length
        Dim b = list.Count
        Dim c = o.Value
        Dim d = untyped.Value
        Dim e = list(0).Value
    End Sub
    Public Sub Shadowed(holder As Node)
        Dim f = Holder.SharedCache
        Dim g = holder.Value
    End Sub
End Class
`,
};

beforeAll(async () => {
  await initGrammars();
  await loadGrammarsForLanguages(['vbnet']);
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-vb-instance-'));
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

function nodeId(qualifiedName: string): string {
  const found = cg.getNodesInFiles(Object.keys(files)).filter((n) => n.qualifiedName === qualifiedName);
  if (found.length !== 1) throw new Error(`${found.length} nodes named ${qualifiedName}`);
  return found[0]!.id;
}

/** The qualified names of what links to `qualifiedName` with an edge of `kind`, one per edge. */
function linkedFrom(qualifiedName: string, kind: 'references' | 'calls'): string[] {
  return cg
    .getIncomingEdgesTo([nodeId(qualifiedName)], [kind])
    .map((e) => cg.getNode(e.source)!.qualifiedName)
    .sort();
}

describe('VB.NET members read and written through a value', () => {
  it('link each read and write of the issue to the member', () => {
    expect(linkedFrom('Holder::SharedCache', 'references')).toEqual(['User::Run']);
    expect(linkedFrom('Holder::Normal', 'references')).toEqual(['User::Run', 'User::Run', 'User::Run', 'User::Run']);
    expect(linkedFrom('Holder::Title', 'references')).toEqual(['User::Run']);
    expect(linkedFrom('Holder::EndSession', 'calls')).toEqual(['User::Run']);
    expect(cg.getCallers(nodeId('Holder::Normal')).map((c) => c.node.qualifiedName)).toEqual(['User::Run']);
  });

  it('link the member alone: the type is not written at the read', () => {
    expect(linkedFrom('Holder', 'references')).toEqual([]);
    expect(linkedFrom('Node', 'references')).toEqual([]);
  });

  it('read through Me, MyBase and a path of members, one link at a time', () => {
    expect(linkedFrom('BaseView::Caption', 'references')).toEqual(['DerivedView::New']);
    expect(linkedFrom('BaseView::Count', 'references')).toEqual(['DerivedView::Count', 'DerivedView::Count']);
    expect(linkedFrom('DerivedView::_node', 'references')).toEqual(['DerivedView::Count']);
    expect(linkedFrom('Node::Child', 'references')).toEqual(['Builder::Fill', 'Builder::Fill', 'DerivedView::Count']);
  });

  it('index a field, run a method named without parentheses, name an event and a method', () => {
    expect(linkedFrom('Node::Items', 'references')).toEqual(['Builder::Fill', 'DerivedView::Watch']);
    expect(linkedFrom('Node::Describe', 'calls')).toEqual(['Builder::Fill', 'DerivedView::Watch']);
    expect(linkedFrom('Node::Changed', 'references')).toEqual(['DerivedView::Watch']);
    expect(linkedFrom('Node::Reset', 'references')).toEqual(['DerivedView::Watch']);
    expect(linkedFrom('Node::Reset', 'calls')).toEqual(['Builder::Fill']);
  });

  it('read through With blocks, an object initializer, a cast, a loop variable, a Module variable and a type parameter', () => {
    expect(linkedFrom('Node::Value', 'references')).toEqual([
      'Builder::Fill', 'Builder::Fill', 'Builder::Seed', 'DerivedView::Count', 'DerivedView::Watch',
      'Negatives::Shadowed', 'Repo::Peek', 'Repo::Peek',
    ]);
  });

  it('read the type the namespace around the declaration sees', () => {
    expect(linkedFrom('API.Reddit::SiteSettings::Header', 'references')).toEqual(['API.Reddit::UserData::Key']);
    expect(linkedFrom('API.Twitter::SiteSettings::Header', 'references')).toEqual([]);
  });

  it('link an initializer and a later write to the members the type declares or inherits', () => {
    expect(linkedFrom('CommandLineParam::Switch', 'references')).toEqual(['x265Enc::ConstVBV']);
    expect(linkedFrom('CommandLineParam::Text', 'references')).toEqual(['x265Enc::ConstVBV']);
    expect(linkedFrom('BoolParam::Value', 'references')).toEqual(['x265Enc::Apply']);
  });

  it('read an instance member of a value named like its type through the value, a Shared one through the type', () => {
    expect(linkedFrom('Theme::General', 'references')).toEqual(['Painter::Paint']);
    expect(linkedFrom('Theme::Current', 'references')).toEqual(['Painter::Paint']);
    expect(linkedFrom('Theme::Version', 'references')).toEqual(['Painter::Paint']);
    // `theme.Current` and the Const `theme.Version`; not `theme.General`.
    expect(linkedFrom('Theme', 'references')).toEqual(['Painter::Paint', 'Painter::Paint']);
    expect(linkedFrom('Mode::Fast', 'references')).toEqual(['Painter::Paint']);
    expect(linkedFrom('Mode', 'references')).toEqual(['Painter::Paint']);
  });

  it('read through a type whose name is in lower case', () => {
    expect(linkedFrom('x265RateMode::Bitrate', 'references')).toEqual(['Painter::Paint']);
    expect(linkedFrom('x265RateMode', 'references')).toEqual(['Painter::Paint']);
  });

  it('send no read for a qualified type after New, which the grammar splits into members', () => {
    // `New System.Windows.Forms.ListBox()` parses as `.Windows.Forms` read through `New System`.
    const reads = extractFromSource('Designer.vb', `Public Class Form1
    Sub InitializeComponent()
        Me.ListBox1 = New System.Windows.Forms.ListBox()
        Dim h = New Sites.Holder
        Dim n = New Holder().Normal
        Dim p = DirectCast(sender, System.Windows.Forms.Control).Parent
    End Sub
End Class
`).unresolvedReferences.filter((r) => r.referenceKind === 'references').map((r) => r.referenceName);
    expect(reads).toEqual(['Me.ListBox1', '{Holder}.Normal']);
  });

  it('link nothing through an outside type, Object, an untyped name or an index', () => {
    for (const member of ['Lookalike::Length', 'Lookalike::Count', 'Lookalike::Value']) {
      expect(linkedFrom(member, 'references')).toEqual([]);
    }
    expect(linkedFrom('Holder::SharedCache', 'references')).not.toContain('Negatives::Shadowed');
  });
});
