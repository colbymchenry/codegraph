/**
 * VB.NET member reads that #2355 and #2377 left unlinked (#2305 follow-up):
 *
 * - A method named without parentheses runs: VB.NET calls the overload that
 *   takes no arguments (`Me.Load` is `Load(Optional force = False)`, not
 *   `Load(path)`), and a constructor's `Me.New` / `MyBase.New` is another
 *   constructor, never itself.
 * - A name before the dot can be a namespace: `Billing.Invoice.MaxLines`,
 *   the project's root namespace in front (`Acme.Billing.Invoice.MaxLines`),
 *   and a Module's member through its namespace (`Assets.Logo`). The namespace
 *   is looked up as VB.NET does — in the namespaces around the read, outward to
 *   the root namespaces, then in the file's `Imports` — so another project's
 *   namespace of that name is not read.
 * - A bare name before the dot that is a field or property of the class around
 *   the read (or of one it inherits, or a Module's variable) is a read of that
 *   member too: `Button1.Text` reads the form's own `Button1` — never another
 *   form's, nor a same-named class's in another project — although `Text` is
 *   .NET's. A parameter or local of that name hides it; a value named like its
 *   type (`Property Mode As Mode`) is read only when the member read through it
 *   is an instance one, and not at all when that type is from outside
 *   (`Responser As Responser`); a method run through the name is the call's
 *   alone.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

let root = '';
let cg: CodeGraph;

const files: Record<string, string> = {
  'App.vbproj': '<Project Sdk="Microsoft.NET.Sdk">\n  <PropertyGroup>\n    <RootNamespace>Acme</RootNamespace>\n  </PropertyGroup>\n</Project>\n',
  'Plugin/Plugin.vbproj': '<Project Sdk="Microsoft.NET.Sdk">\n  <PropertyGroup>\n    <RootNamespace>Plugin</RootNamespace>\n  </PropertyGroup>\n</Project>\n',
  'AppSession.vb': `Public Class AppSession
    Public Shared Property CurrentUser As String
End Class
`,
  'OtherSession.vb': `Public Class OtherSession
    Public Shared SessionId As Guid
End Class
`,
  // Overloads of a method VB.NET runs without parentheses.
  'Chain.vb': `Public Class Chain
    Public Sub New(ByVal name As String)
        Me.New
        Me.Load
        Dim n = Me.Count
    End Sub

    Public Sub New()
    End Sub

    Public Sub Load(ByVal path As String)
    End Sub

    Public Sub Load(Optional ByVal force As Boolean = False)
    End Sub

    Public Function Count(ByVal items As Integer()) As Integer
        Return 0
    End Function

    Public Function Count(ParamArray items As Integer()) As Integer
        Return 0
    End Function
End Class

Public Class LinkedChain
    Inherits Chain

    Public Sub New()
        MyBase.New
    End Sub
End Class

Public Class Calc
    Public Shared Function GetTargetDAR(ByVal width As Integer) As Double
        Return 0
    End Function

    Public Shared Function GetTargetDAR() As Double
        Return 0
    End Function
End Class

Public Class Measurer
    Private Tracker As Chain

    Public Function Ratio(ByVal c As Chain) As Double
        Dim n = c.Count
        Return Calc.GetTargetDAR
    End Function

    Public Sub Track()
        Tracker.Load
    End Sub
End Class
`,
  // Types and a Module in namespaces of the Acme project.
  'Billing/Invoice.vb': `Namespace Billing
    Public Class Invoice
        Public Const MaxLines As Integer = 100
        Public Shared Function Create() As Invoice
            Return Nothing
        End Function
    End Class

    Public Enum Status
        Open
        Paid
    End Enum
End Namespace
`,
  'Assets/Images.vb': `Namespace Assets
    Public Module Images
        Public Logo As String = "logo.png"
        Public Function Pick() As String
            Return Logo
        End Function
    End Module
End Namespace
`,
  'Forms/MainForm.Designer.vb': `<Global.Microsoft.VisualBasic.CompilerServices.DesignerGenerated()>
Partial Class MainForm
    Inherits System.Windows.Forms.Form

    Private Sub InitializeComponent()
        Me.Button1 = New System.Windows.Forms.Button()
        Me.Button1.Size = New System.Drawing.Size(75, 23)
        Me.Size = New System.Drawing.Size(300, 200)
    End Sub

    Friend WithEvents Button1 As System.Windows.Forms.Button
End Class
`,
  'Forms/MainForm.vb': `Public Class MainForm
    Private Clicks As Integer

    Private Sub Button1_Click(sender As Object, e As EventArgs) Handles Button1.Click
        Me.Clicks = Me.Clicks + 1
        Button1.Text = AppSession.CurrentUser
        With Button1
            .Enabled = False
        End With
        Me.Text = Console.Out.ToString()
        Dim n = Billing.Invoice.MaxLines
        Dim m = Acme.Billing.Invoice.MaxLines
        Dim s = Billing.Status.Paid
        Dim l = Assets.Logo
        Dim p = Assets.Pick
        Dim i = Billing.Invoice.Create
        Dim r = System.Drawing.Color.Red
    End Sub
End Class
`,
  'Forms/OtherForm.Designer.vb': `Partial Class OtherForm
    Inherits System.Windows.Forms.Form

    Friend WithEvents Button1 As System.Windows.Forms.Button
End Class
`,
  'Forms/OtherForm.vb': `Public Class OtherForm
    Private Sub Reload()
        Button1.Text = OtherSession.SessionId.ToString()
    End Sub
End Class
`,
  // The Plugin project sees no \`Billing\` namespace: Acme's is another project's.
  'Plugin/Report.vb': `Public Class Report
    Public Sub Run()
        Dim n = Billing.Invoice.MaxLines
    End Sub
End Class
`,
  'Model.vb': `Public Enum Mode
    Fast
    Slow
End Enum

Public Class Settings
    Public Property Level As Integer
End Class

Public Class Widget
    Public Property Length As Integer
End Class
`,
  'Globals.vb': `Public Module Globals
    Public Current As Settings
End Module
`,
  // What the name before the dot binds to: a parameter or local, then a member
  // of the class around it (or one it inherits, or a Module's), then a type.
  'Scopes.vb': `Public Class Reporter
    Public Sub Report(ByVal Mode As String)
        Dim Widget = "x"
        Dim n = Mode.Length + Widget.Length
    End Sub
End Class

Public Class SessionView
    Private ReadOnly Property AppSession As OtherSession

    Public Sub Show()
        Dim id = AppSession.SessionId
    End Sub
End Class

Public Class SettingsUser
    Public Property Settings As Settings
    Public Property Mode As Mode

    Public Sub Apply()
        Dim t = Settings.Level
        Dim f = Mode.Fast
    End Sub
End Class

Public Class BaseView
    Protected Title As String
End Class

Public Class DerivedView
    Inherits BaseView

    Public Sub Render()
        Dim n = Title.Length
    End Sub
End Class

Public Class Viewer
    Private Button1 As Settings

    Public Sub Show()
        Dim lv = Current.Level
    End Sub

    Public Sub Hide()
        Dim Button1 As New Settings()
        Dim x = Button1.Level
    End Sub
End Class

Public Class Detector
    Public Class Data
        Public Shared Empty As Integer
    End Class

    Public Function Probe() As Integer
        Return Data.Empty
    End Function
End Class

Public Class Failure
    Inherits System.Exception

    Public Function Describe() As Integer
        Return Data.Empty
    End Function
End Class
`,
  // CRLF line endings, and multibyte text — naming the field — before the read.
  'Weird.vb': [
    'Public Class Weird',
    '    Private Label1 As Settings',
    '    Public Sub Go()',
    '        Dim s = "Label1 éééé 😀" & Label1.Level & Billing.Invoice.MaxLines',
    '    End Sub',
    'End Class',
    '',
  ].join('\r\n'),
  // One class name in two namespaces and in another project: the file's
  // \`Imports\` says which \`UserData\` it means. A type in the file's own
  // namespace (the root one) comes before an imported one: \`Helper.Name\`.
  'Plugin/UserData.vb': `Public Class UserData
    Public Shared ChannelsLabel As String
    Private Label As String

    Public Function Size() As Integer
        Return Label.Length
    End Function
End Class
`,
  // Another plugin project declares a \`UserData\` of its own: its members are not Plugin's.
  'Plugin2/Plugin2.vbproj': '<Project Sdk="Microsoft.NET.Sdk">\n  <PropertyGroup>\n    <RootNamespace>Plugin2</RootNamespace>\n  </PropertyGroup>\n</Project>\n',
  'Plugin2/UserData.vb': `Public Class UserData
    Private Label As String

    Public Function Size() As Integer
        Return Label.Length
    End Function
End Class
`,
  // A member declared As an outside type of its own name: VB.NET reads that
  // type's Shared members and nested types through the type ("Color Color").
  'Client.vb': `Public Class Client
    Protected Responser As Responser

    Public Function Code() As Integer
        Dim m = Responser.Modes.Curl
        Return Responser.StatusCode
    End Function
End Class
`,
  'Helper.vb': `Public Class Helper
    Public Shared Name As String
End Class
`,
  'Lib/Helper.vb': `Namespace Lib
    Public Class Helper
        Public Shared Name As String
    End Class
End Namespace
`,
  'Reddit/UserData.vb': `Namespace API.Reddit
    Public Class UserData
        Public Const ChannelsLabel As String = "Channels"
    End Class
End Namespace
`,
  'Twitter/UserData.vb': `Namespace API.Twitter
    Public Class UserData
        Public Const ChannelsLabel As String = "Lists"
    End Class
End Namespace
`,
  'ChannelView.vb': `Imports Acme.API.Reddit
Imports Acme.Lib

Public Class ChannelView
    Public Sub Add()
        Dim l = UserData.ChannelsLabel
        Dim h = Helper.Name
    End Sub
End Class
`,
};

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-vb-scope-'));
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

/** The node named `qualifiedName` — at `line`, or in `file`, when the name alone leaves several. */
function nodeId(qualifiedName: string, at?: number | string): string {
  const found = cg.getNodesInFiles(Object.keys(files)).filter((n) => n.qualifiedName === qualifiedName &&
    (at === undefined || (typeof at === 'number' ? n.startLine === at : n.filePath === at)));
  if (found.length !== 1) throw new Error(`${found.length} nodes named ${qualifiedName}${at === undefined ? '' : ` at ${at}`}`);
  return found[0]!.id;
}

/** What links to `qualifiedName` with an edge of `kind`, one per edge: `file:qualifiedName` when `withFiles`. */
function linkedFrom(qualifiedName: string, kind: 'references' | 'calls', at?: number | string, withFiles = false): string[] {
  return cg
    .getIncomingEdgesTo([nodeId(qualifiedName, at)], [kind])
    .map((e) => cg.getNode(e.source)!)
    .map((n) => (withFiles ? `${n.filePath}:${n.qualifiedName}` : n.qualifiedName))
    .sort();
}

describe('VB.NET member reads through a namespace, a member of the class around them, or a method without parentheses (#2305)', () => {
  it('calls the overload that takes no arguments, and a constructor never itself', () => {
    // Chain.vb: New(name) at 2, New() at 8, Load(path) at 11, Load(Optional) at 14,
    // Count(items) at 17, Count(ParamArray) at 21.
    expect(linkedFrom('Chain::New', 'calls', 8)).toEqual(['Chain::New', 'LinkedChain::New']);
    expect(linkedFrom('Chain::New', 'calls', 2)).toEqual([]);
    // `Me.Load`, and `Tracker.Load` through a field, whose read is the call's alone.
    expect(linkedFrom('Chain::Load', 'calls', 14)).toEqual(['Chain::New', 'Measurer::Track']);
    expect(linkedFrom('Chain::Load', 'calls', 11)).toEqual([]);
    expect(linkedFrom('Measurer::Tracker', 'calls')).toEqual([]);
    expect(linkedFrom('Chain::Count', 'calls', 21)).toEqual(['Chain::New', 'Measurer::Ratio']);
    expect(linkedFrom('Chain::Count', 'calls', 17)).toEqual([]);
    // Calc's GetTargetDAR(width) at 35, GetTargetDAR() at 39.
    expect(linkedFrom('Calc::GetTargetDAR', 'calls', 39)).toEqual(['Measurer::Ratio']);
    expect(linkedFrom('Calc::GetTargetDAR', 'calls', 35)).toEqual([]);
  });

  it('reads a type, a constant, an Enum case and a Module member through their namespace, the root namespace in front or not', () => {
    // `Billing.Invoice.MaxLines` and `Acme.Billing.Invoice.MaxLines`.
    expect(linkedFrom('Billing::Invoice::MaxLines', 'references'))
      .toEqual(['MainForm::Button1_Click', 'MainForm::Button1_Click', 'Weird::Go']);
    // The type each of them, and `Billing.Invoice.Create`, names.
    expect(linkedFrom('Billing::Invoice', 'references'))
      .toEqual(['MainForm::Button1_Click', 'MainForm::Button1_Click', 'MainForm::Button1_Click', 'Weird::Go']);
    expect(linkedFrom('Billing::Invoice::Create', 'calls')).toEqual(['MainForm::Button1_Click']);
    expect(linkedFrom('Billing::Status::Paid', 'references')).toEqual(['MainForm::Button1_Click']);
    expect(linkedFrom('Billing::Status', 'references')).toEqual(['MainForm::Button1_Click']);
    // A Module's members are its namespace's; the Module itself is not written.
    expect(linkedFrom('Assets::Images::Logo', 'references')).toEqual(['MainForm::Button1_Click']);
    expect(linkedFrom('Assets::Images::Pick', 'calls')).toEqual(['MainForm::Button1_Click']);
    expect(linkedFrom('Assets::Images', 'references')).toEqual([]);
  });

  it('reads no namespace another project declares', () => {
    for (const qn of ['Billing::Invoice::MaxLines', 'Billing::Invoice']) {
      expect(linkedFrom(qn, 'references')).not.toContain('Report::Run');
    }
  });

  it('reads a field or property of the class around the read through its bare name', () => {
    // `Button1.Text` in Button1_Click and the designer's two `Me.Button1`; the
    // `With Button1` block's `.Enabled` is no second read of it.
    expect(linkedFrom('MainForm::Button1', 'references'))
      .toEqual(['MainForm::Button1_Click', 'MainForm::InitializeComponent', 'MainForm::InitializeComponent']);
    expect(linkedFrom('OtherForm::Button1', 'references')).toEqual(['OtherForm::Reload']);
    expect(linkedFrom('MainForm::Clicks', 'references')).toEqual(['MainForm::Button1_Click', 'MainForm::Button1_Click']);
    // An inherited field, a Module's variable, and a field read after multibyte text.
    expect(linkedFrom('BaseView::Title', 'references')).toEqual(['DerivedView::Render']);
    expect(linkedFrom('Globals::Current', 'references')).toEqual(['Viewer::Show']);
    expect(linkedFrom('Weird::Label1', 'references')).toEqual(['Weird::Go']);
    expect(linkedFrom('Settings::Level', 'references')).toEqual(['SettingsUser::Apply', 'Viewer::Hide', 'Viewer::Show', 'Weird::Go']);
  });

  it('binds the name before the dot as VB does: parameter or local, own member, then type', () => {
    // `Mode` is a parameter and `Widget` a local of Report; `Button1` a local of Hide.
    expect(linkedFrom('Mode', 'references')).toEqual(['SettingsUser::Apply']);
    expect(linkedFrom('Widget', 'references')).toEqual([]);
    expect(linkedFrom('Widget::Length', 'references')).toEqual([]);
    expect(linkedFrom('Viewer::Button1', 'references')).toEqual([]);
    // SessionView's own `AppSession` property holds an OtherSession.
    expect(linkedFrom('SessionView::AppSession', 'references')).toEqual(['SessionView::Show']);
    expect(linkedFrom('OtherSession::SessionId', 'references')).toEqual(['OtherForm::Reload', 'SessionView::Show']);
    // "Color Color": `Settings.Level` reads the property, and an instance
    // member of its type; `Mode.Fast` reads an Enum case through the type.
    expect(linkedFrom('SettingsUser::Settings', 'references')).toEqual(['SettingsUser::Apply']);
    expect(linkedFrom('SettingsUser::Mode', 'references')).toEqual([]);
    expect(linkedFrom('Mode::Fast', 'references')).toEqual(['SettingsUser::Apply']);
    // A type nested in a class is a bare name only inside it: Failure's `Data` is Exception's.
    expect(linkedFrom('Detector::Data::Empty', 'references')).toEqual(['Detector::Probe']);
    expect(linkedFrom('Detector::Data', 'references')).toEqual(['Detector::Probe']);
    // `Responser As Responser`, a type from outside: `Responser.Modes` may name
    // the type's nested enum, which nothing here can tell, so no read is linked.
    expect(linkedFrom('Client::Responser', 'references')).toEqual([]);
  });

  it("reads a member of the class's own project, not of a same-named class in another", () => {
    expect(linkedFrom('UserData::Label', 'references', 'Plugin/UserData.vb', true)).toEqual(['Plugin/UserData.vb:UserData::Size']);
    expect(linkedFrom('UserData::Label', 'references', 'Plugin2/UserData.vb', true)).toEqual(['Plugin2/UserData.vb:UserData::Size']);
  });

  it('picks among same-named classes the one VB finds first, for the member and the class', () => {
    expect(linkedFrom('API.Reddit::UserData::ChannelsLabel', 'references')).toEqual(['ChannelView::Add']);
    expect(linkedFrom('API.Reddit::UserData', 'references')).toEqual(['ChannelView::Add']);
    expect(linkedFrom('API.Twitter::UserData::ChannelsLabel', 'references')).toEqual([]);
    expect(linkedFrom('UserData::ChannelsLabel', 'references')).toEqual([]);
    expect(linkedFrom('Helper::Name', 'references')).toEqual(['ChannelView::Add']);
    expect(linkedFrom('Lib::Helper::Name', 'references')).toEqual([]);
  });

  it('does not bind a member of another class that only shares the name', () => {
    // `Me.Size` / `Me.Text` on a Form, `Console.Out`, `System.Drawing.Color.Red`.
    expect(linkedFrom('MainForm::Button1', 'references')).not.toContain('OtherForm::Reload');
    expect(linkedFrom('OtherForm::Button1', 'references')).not.toContain('MainForm::Button1_Click');
    expect(linkedFrom('Widget::Length', 'references')).toEqual([]);
  });

  it('keeps the edges through an incremental sync', async () => {
    for (const rel of ['Forms/MainForm.vb', 'Billing/Invoice.vb', 'Chain.vb', 'Scopes.vb']) {
      fs.writeFileSync(path.join(root, rel), `' touched\n${files[rel]}`);
    }
    await cg.sync();
    expect(linkedFrom('Billing::Invoice::MaxLines', 'references'))
      .toEqual(['MainForm::Button1_Click', 'MainForm::Button1_Click', 'Weird::Go']);
    expect(linkedFrom('Assets::Images::Logo', 'references')).toEqual(['MainForm::Button1_Click']);
    expect(linkedFrom('MainForm::Button1', 'references'))
      .toEqual(['MainForm::Button1_Click', 'MainForm::InitializeComponent', 'MainForm::InitializeComponent']);
    expect(linkedFrom('SessionView::AppSession', 'references')).toEqual(['SessionView::Show']);
    // The touched Chain.vb moved down a line.
    expect(linkedFrom('Chain::Load', 'calls', 15)).toEqual(['Chain::New', 'Measurer::Track']);
    expect(linkedFrom('Chain::New', 'calls', 9)).toEqual(['Chain::New', 'LinkedChain::New']);
  });
});
