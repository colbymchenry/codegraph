/**
 * VB.NET's extractor keeps only the last name of a member access, so
 * `Me.Panel.Controls.Add(x)` and `New System.Drawing.Size(1, 2)` reach the
 * resolver as bare `Add` / `Size`. A member reached that way must match what
 * the line writes before the dot: `Me` / `MyBase` / `MyClass`, the member's
 * own type or module (`Logger.Log(…)`), or a service locator's type argument
 * (`GetService(Of Notifier).Notify()`). SCrawler's designer code sent
 * `New System.Drawing.Size(…)` to a nested enum's `Size` case 713 times and
 * `Controls.Add(…)` to a collection class's `Add` 547 times.
 *
 * The name read is the one the reference starts at (or after) — in
 * `Me.Size = New System.Drawing.Size(…)` that is `System.Drawing.Size`, not
 * `Me.Size` — and a type is one its written qualifier names: staxrip's
 * designer `New System.Drawing.Point(…)` went to a nested `Point` class 550
 * times. A type nested in a class is named bare only inside it.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

let root = '';
let cg: CodeGraph;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-vb-member-'));
  const files: Record<string, string> = {
    'Editors/UsersInfoForm.vb': `Namespace Editors
    Friend Class UsersInfoForm
        Private Enum EComparers
            Name
            Size
        End Enum
    End Class
End Namespace
`,
    'Collections/DataColorCollection.vb': `Friend Class DataColorCollection
    Friend Sub Add(ByVal Item As Object)
    End Sub
End Class
`,
    'Services/Notifier.vb': `Public Class Notifier
    Public Sub Notify(ByVal Text As String)
    End Sub
End Class
`,
    'Logger.vb': `Public Module Logger
    Public Sub Log(ByVal Text As String)
    End Sub
End Module
`,
    'MainForm.vb': `Public Class MainForm
    Private Sub InitializeComponent()
        Me.Panel.Controls.Add(Me.Button1)
        Me.Panel.Size = New System.Drawing.Size(184, 25)
        Logger.Log("ready")
        Application.GetService(Of Notifier).Notify("ready")
        Me.Refresh()
    End Sub

    Private Sub Refresh()
    End Sub
End Class
`,
    'UI/ButtonEx.vb': `Public Class ButtonEx
    Public Class SymbolDrawer
        Public Class Point
        End Class
        Public Sub Draw()
            Dim p As New Point()
        End Sub
    End Class
End Class
`,
    'Forms/AppsForm.vb': `Public Class AppsForm
    Private Sub InitializeComponent()
        Me.Size = New System.Drawing.Size(315, 205)
        Me.ToolStrip.Location = New System.Drawing.Point(473, 10)
        Me.lDescription.Location = New Point(4, 285)
    End Sub
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

describe('VB.NET member access', () => {
  it('reaches a member only through what the line names', () => {
    const ids = cg.getNodesInFile('MainForm.vb').map((n) => n.id);
    const targets = cg
      .getOutgoingEdgesFrom(ids)
      .filter((e) => e.kind === 'calls')
      .map((e) => cg.getNode(e.target)!.qualifiedName)
      .sort();
    expect(targets).not.toContain('Editors::UsersInfoForm::EComparers::Size');
    expect(targets).not.toContain('DataColorCollection::Add');
    expect(targets).toContain('Logger::Log');
    expect(targets).toContain('Notifier::Notify');
    expect(targets).toContain('MainForm::Refresh');
  });

  it('reads the name the reference starts at, and a type its qualifier names', () => {
    const targetsOf = (file: string) => cg
      .getOutgoingEdgesFrom(cg.getNodesInFile(file).map((n) => n.id))
      .filter((e) => e.kind === 'calls' || e.kind === 'instantiates')
      .map((e) => `${e.kind} ${cg.getNode(e.target)!.qualifiedName}`)
      .sort();
    // `Me.Size = New System.Drawing.Size(…)`, `New System.Drawing.Point(…)`, `New Point(…)` outside ButtonEx.
    expect(targetsOf('Forms/AppsForm.vb')).toEqual([]);
    expect(targetsOf('UI/ButtonEx.vb')).toEqual(['instantiates ButtonEx::SymbolDrawer::Point']);
  });
});
