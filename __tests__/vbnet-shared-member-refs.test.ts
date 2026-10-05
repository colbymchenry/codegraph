/**
 * VB.NET: a value read or written through a type or module name —
 * `AppSession.SessionId`, `AppSession.CurrentUser = "demo"`, `Logger.Level`,
 * `Mode.Fast` — is a use of the member and of the type (#2305). Before, only
 * calls linked, so `codegraph callers` on a Shared field or property, and on
 * the class itself, came back empty.
 *
 * The name is looked up as VB.NET does, without regard to case: a local, a
 * parameter or a field of that name holds a value, and links nothing here (a
 * member typed as its own name's type, `Property Settings As Settings`, reads
 * that type's members either way); a type is the one the namespaces around
 * the read, its `Imports` and aliases see — SCrawler declares a
 * `SiteSettings` in every site's namespace. A method named without
 * parentheses is called, unless `AddressOf` only names it, and an index into
 * a Shared field (`AppSession.Items(0)`), which VB.NET writes as a call, reads
 * the field.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

let root = '';
let cg: CodeGraph;

const files: Record<string, string> = {
  // The issue's three files.
  'AppSession.vb': `Public Class AppSession
    Public Shared SessionId As Guid = Guid.NewGuid()
    Public Shared Property CurrentUser As String
    Public Shared Items As New List(Of String)
    Public Shared Function GetGreeting() As String
        Return "Hello " & CurrentUser
    End Function
    Public Shared Sub OnTick(ByVal sender As Object, ByVal e As EventArgs)
    End Sub
    Public Shared Function Describe() As String
        Return AppSession.CurrentUser
    End Function
End Class
`,
  'Consumer.vb': `Public Class Consumer
    Public Sub Run()
        Dim id As Guid = AppSession.SessionId
        AppSession.CurrentUser = "demo"
        Console.WriteLine(AppSession.GetGreeting())
    End Sub
End Class
`,
  'Consumer2.vb': `Public Class Consumer2
    Public Function Describe() As String
        Return AppSession.CurrentUser & AppSession.SessionId.ToString()
    End Function
End Class
`,
  'OtherSession.vb': `Public Class OtherSession
    Public Shared SessionId As Guid = Guid.NewGuid()
    Public Property Size As Integer
End Class
`,
  'Size.vb': `Public Class Size
End Class
`,
  'Logger.vb': `Public Module Logger
    Public Level As Integer
End Module
`,
  'Mode.vb': `Public Enum Mode
    Fast
    Slow
End Enum
`,
  'Form1.vb': `Public Class Form1
    Private Panel1 As Panel
    Public Sub Setup()
        Logger.Level = 3
        Dim a = Panel1.Size
        Me.Panel1.Size = New System.Drawing.Size(1, 2)
        Dim speed = Mode.Fast
        Dim greeting = AppSession.GetGreeting
        AddHandler Timer1.Tick, AddressOf AppSession.OnTick
        Dim first = AppSession.Items(0)
        Dim empty = String.Empty
    End Sub
    Public Sub Shadowed(ByVal appSession As OtherSession)
        Dim id = AppSession.SessionId
    End Sub
End Class
`,
  // A type declared in each site's namespace, and one read through an import alias.
  'Sites/Reddit/SiteSettings.vb': `Namespace API.Reddit
    Friend Class SiteSettings
        Friend Const Header As String = "r"
    End Class
    Friend Class UserData
        Friend Function Key() As String
            Return SiteSettings.Header
        End Function
    End Class
End Namespace
`,
  'Sites/Twitter/SiteSettings.vb': `Namespace API.Twitter
    Friend Class SiteSettings
        Friend Const Header As String = "t"
    End Class
    Friend Class UserData
        Friend Function Key() As String
            Return SiteSettings.Header
        End Function
    End Class
End Namespace
`,
  'Sites/Facebook/UserData.vb': `Imports RS = API.Reddit.SiteSettings
Namespace API.Facebook
    Friend Class UserData
        Friend Function Key() As String
            Return RS.Header
        End Function
    End Class
End Namespace
`,
  // A property typed as the type of its own name; a property initializer.
  'Settings.vb': `Public Class Settings
    Public Property Theme As String
End Class
`,
  'Window.vb': `Public Class Window
    Public Property Settings As Settings
    Public Property Title As String = AppSession.CurrentUser
    Public Function CurrentTheme() As String
        Return Settings.Theme
    End Function
End Class
`,
  // CRLF line endings and multibyte text before the read.
  'Weird.vb': [
    'Public Class Weird',
    '    Public Sub Go()',
    '        Dim s = "SessionId éééé 😀" & AppSession.SessionId',
    '    End Sub',
    'End Class',
    '',
  ].join('\r\n'),
};

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-vb-shared-'));
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

/** The qualified names of what links to `qualifiedName` with an edge of `kind`. */
function linkedFrom(qualifiedName: string, kind: 'references' | 'calls'): string[] {
  return cg
    .getIncomingEdgesTo([nodeId(qualifiedName)], [kind])
    .map((e) => cg.getNode(e.source)!.qualifiedName)
    .sort();
}

describe('VB.NET Shared members read through their type (#2305)', () => {
  it('link a Shared field and property to the methods that read or write them', () => {
    expect(linkedFrom('AppSession::SessionId', 'references')).toEqual(['Consumer2::Describe', 'Consumer::Run', 'Weird::Go']);
    expect(linkedFrom('AppSession::CurrentUser', 'references'))
      .toEqual(['AppSession::Describe', 'Consumer2::Describe', 'Consumer::Run', 'Window::Title']);
  });

  it('link the class to the code outside it that reads through it', () => {
    expect(linkedFrom('AppSession', 'references'))
      .toEqual(['Consumer2::Describe', 'Consumer2::Describe', 'Consumer::Run', 'Consumer::Run', 'Form1::Setup', 'Weird::Go', 'Window::Title']);
    expect(cg.getCallers(nodeId('AppSession')).map((c) => c.node.qualifiedName).sort())
      .toEqual(['Consumer2::Describe', 'Consumer::Run', 'Form1::Setup', 'Weird::Go', 'Window::Title']);
  });

  it('keep the call to a Shared method, and call one named without parentheses', () => {
    expect(linkedFrom('AppSession::GetGreeting', 'calls')).toEqual(['Consumer::Run', 'Form1::Setup']);
    expect(linkedFrom('AppSession::OnTick', 'references')).toEqual(['Form1::Setup']);
    expect(linkedFrom('AppSession::OnTick', 'calls')).toEqual([]);
  });

  it('read a Shared field indexed like a call, a Module variable and an Enum value', () => {
    expect(linkedFrom('AppSession::Items', 'references')).toEqual(['Form1::Setup']);
    expect(linkedFrom('Logger::Level', 'references')).toEqual(['Form1::Setup']);
    expect(linkedFrom('Mode::Fast', 'references')).toEqual(['Form1::Setup']);
    expect(linkedFrom('Mode', 'references')).toEqual(['Form1::Setup']);
  });

  it('link nothing through a local, parameter or field, whatever its case', () => {
    expect(linkedFrom('OtherSession::SessionId', 'references')).toEqual([]);
    expect(linkedFrom('OtherSession::Size', 'references')).toEqual([]);
    expect(linkedFrom('Size', 'references')).toEqual([]);
    expect(linkedFrom('OtherSession', 'references')).toEqual([]);
  });

  it('read the type the namespaces and imports around the read see', () => {
    expect(linkedFrom('API.Reddit::SiteSettings::Header', 'references'))
      .toEqual(['API.Facebook::UserData::Key', 'API.Reddit::UserData::Key']);
    expect(linkedFrom('API.Twitter::SiteSettings::Header', 'references')).toEqual(['API.Twitter::UserData::Key']);
  });

  it('read through a member typed as the type of its own name', () => {
    expect(linkedFrom('Settings::Theme', 'references')).toEqual(['Window::CurrentTheme']);
  });
});
