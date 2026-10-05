/**
 * A VB.NET solution often carries the same type in two projects: staxrip's
 * main app and its separate AutoCrop tool (its own AutoCrop.vbproj) each
 * declare `ColorHSL`, `FrameServerFactory` and `DirectFrameServer`. A call
 * in the main app means its own project's copy — about 90 calls such as
 * `_backColor.AddLuminance(0.025)` went to the AutoCrop copy, whichever was
 * indexed first. Between equally good guesses, the caller's project decides,
 * then the nearer directory; when neither does, there is no guess.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

let root = '';
let cg: CodeGraph;

const VBPROJ = `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>WinExe</OutputType>
  </PropertyGroup>
</Project>
`;

const COLOR_HSL = `Public Class ColorHSL
    Public Sub New(ByVal h As Double, ByVal s As Double, ByVal l As Double, ByVal a As Double)
    End Sub
    Public Function AddLuminance(ByVal offset As Single) As ColorHSL
        Return Me
    End Function
End Class
`;

const FRAME_SERVER_FACTORY = `Public Class FrameServerFactory
    Public Shared Function Create(ByVal path As String) As Object
        Return Nothing
    End Function
End Class
`;

const HELPER = `Public Class Helper
    Public Sub Run()
    End Sub
End Class
`;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-vb-ties-'));
  const files: Record<string, string> = {
    'Source/StaxRip.vbproj': VBPROJ,
    'Source/Tools/AutoCrop/AutoCrop.vbproj': VBPROJ,
    'Source/Tools/AutoCrop/Main.vb': COLOR_HSL + FRAME_SERVER_FACTORY,
    'Source/UI/ColorHSL.vb': COLOR_HSL,
    'Source/Video/FrameServer.vb': FRAME_SERVER_FACTORY,
    'Source/General/ThemeManager.vb': `Public Class ThemeManager
    Public Sub Apply(ByVal palette As Object)
        Dim _backColor As ColorHSL = New ColorHSL(0, 0.01, 0.1, 1)
        Dim _controlBackColor As ColorHSL = _backColor.AddLuminance(0.025)
        For Each backgroundColor In palette
            backgroundColor.AddLuminance(-0.1)
        Next
        Dim server = FrameServerFactory.Create("video.mkv")
    End Sub
End Class
`,
    'Source/UI/TipProvider.vb': `Public Class TipProvider
    Public Sub SetTip(ByVal text As String)
    End Sub
    Public Sub SetTip(ByVal text As String, ByVal title As String)
    End Sub
End Class
`,
    'Source/General/Tips.vb': `Public Class Tips
    Public Sub Apply(ByVal providers As Object)
        For Each tipProvider In providers
            tipProvider.SetTip("x")
        Next
    End Sub
End Class
`,
    'Plugins/A/A.vbproj': VBPROJ,
    'Plugins/A/Helper.vb': HELPER,
    'Plugins/B/B.vbproj': VBPROJ,
    'Plugins/B/Helper.vb': HELPER,
    'App/App.vbproj': VBPROJ,
    'App/Main.vb': `Public Class Main
    Public Sub Start(ByVal helpers As Object)
        For Each runHelper In helpers
            runHelper.Run()
        Next
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

/** `Owner::member @ file` of every call / instantiation edge out of a file. */
function targetsFrom(file: string, kind: 'calls' | 'instantiates'): string[] {
  const ids = cg.getNodesInFile(file).map((n) => n.id);
  return cg
    .getOutgoingEdgesFrom(ids)
    .filter((e) => e.kind === kind)
    .map((e) => {
      const target = cg.getNode(e.target)!;
      return `${target.qualifiedName} @ ${target.filePath}`;
    })
    .sort();
}

describe('VB.NET duplicate types across projects', () => {
  it('resolve a call to the caller’s own project’s copy', () => {
    expect(targetsFrom('Source/General/ThemeManager.vb', 'calls')).toEqual([
      'ColorHSL::AddLuminance @ Source/UI/ColorHSL.vb',
      'ColorHSL::AddLuminance @ Source/UI/ColorHSL.vb',
      'FrameServerFactory::Create @ Source/Video/FrameServer.vb',
    ]);
  });

  it('resolve a construction to the caller’s own project’s copy', () => {
    expect(targetsFrom('Source/General/ThemeManager.vb', 'instantiates')).toEqual([
      'ColorHSL @ Source/UI/ColorHSL.vb',
    ]);
  });

  it('make no guess between copies nothing tells apart', () => {
    expect(targetsFrom('App/Main.vb', 'calls')).toEqual([]);
  });

  it('take one type’s overloads as one guess, not a tie', () => {
    expect(targetsFrom('Source/General/Tips.vb', 'calls')).toEqual(['TipProvider::SetTip @ Source/UI/TipProvider.vb']);
  });
});
