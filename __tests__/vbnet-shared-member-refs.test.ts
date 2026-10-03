/**
 * VB.NET: reading or writing a Shared field/property through its class name
 * (`AppSession.SessionId`, `AppSession.CurrentUser = "demo"`) links the caller
 * to the member and to the class (#2305), without binding look-alike members.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

let root = '';
let cg: CodeGraph;

function nodeByQn(qn: string) {
  const found = allNodes().find((n) => n.qualifiedName === qn);
  if (!found) throw new Error(`no node with qualifiedName ${qn}`);
  return found;
}

function allNodes() {
  return fs
    .readdirSync(root)
    .filter((f) => f.endsWith('.vb'))
    .flatMap((f) => cg.getNodesInFile(f));
}

/** Qualified names of the symbols with a `references` edge into `qn`. */
function referencedBy(qn: string): string[] {
  const id = nodeByQn(qn).id;
  return cg
    .getIncomingEdgesTo([id], ['references'])
    .map((e) => cg.getNode(e.source)!.qualifiedName)
    .sort();
}

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-vb-shared-'));
  const files: Record<string, string> = {
    'AppSession.vb': `Public Class AppSession
    Public Shared SessionId As Guid = Guid.NewGuid()
    Public Shared Property CurrentUser As String
    Public Shared Function GetGreeting() As String
        Return "Hello " & CurrentUser
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
    'Form1.vb': `Public Class Form1
    Public Sub Setup()
        Logger.Level = 3
        Dim a = Panel1.Size
        Me.Panel.Size = New System.Drawing.Size(1, 2)
    End Sub
End Class
`,
    // CRLF line endings and multibyte text before the read: the resolver reads
    // the receiver back out of the source line by column.
    'Weird.vb': [
      'Public Class Weird',
      '    Public Sub Go()',
      '        Dim s = "SessionId éééé 😀" & AppSession.SessionId',
      '    End Sub',
      'End Class',
      '',
    ].join('\r\n'),
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

describe('VB.NET Shared member reads through the class name (#2305)', () => {
  it('links a Shared field to every method that reads it', () => {
    expect(referencedBy('AppSession::SessionId')).toEqual(
      expect.arrayContaining(['Consumer::Run', 'Consumer2::Describe']),
    );
  });

  it('links a Shared property to every method that reads or writes it', () => {
    expect(referencedBy('AppSession::CurrentUser')).toEqual(
      expect.arrayContaining(['Consumer::Run', 'Consumer2::Describe']),
    );
  });

  it('links the class to the methods that use its members', () => {
    expect(referencedBy('AppSession')).toEqual(
      expect.arrayContaining(['Consumer::Run', 'Consumer2::Describe']),
    );
  });

  it('keeps the existing call edge to a Shared method', () => {
    const id = nodeByQn('AppSession::GetGreeting').id;
    const callers = cg.getCallers(id).map((c) => c.node.qualifiedName);
    expect(callers).toEqual(['Consumer::Run']);
  });

  it('links a Module variable read through the module name', () => {
    expect(referencedBy('Logger::Level')).toContain('Form1::Setup');
  });

  it('does not bind a same-named member of a different class', () => {
    expect(referencedBy('OtherSession::SessionId')).toEqual([]);
  });

  it('does not bind a dotted read to a member or class that merely shares its name', () => {
    expect(referencedBy('OtherSession::Size')).toEqual([]);
    expect(referencedBy('Size')).not.toContain('Form1::Setup');
  });

  it('resolves on a CRLF file with multibyte text before the read', () => {
    expect(referencedBy('AppSession::SessionId')).toContain('Weird::Go');
  });
});
