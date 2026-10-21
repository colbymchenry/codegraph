/**
 * A VB.NET call with no receiver — or with `Me` / `MyClass` / `MyBase`,
 * which the extractor drops — is a member of the type it is written in, of a
 * type around it, or of one they inherit; a `Module`'s members are reached
 * from anywhere. Never another class's same-named member, however near its
 * file: SCrawler's `{ToString()}` in the Instagram `UserData` (which
 * `Inherits UserDataBase`) went to a nearby structure's `ToString`.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

let root = '';
let cg: CodeGraph;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-vb-bare-'));
  const files: Record<string, string> = {
    'API/Base/UserDataBase.vb': `Namespace API.Base
    Friend MustInherit Class UserDataBase
        Public Overrides Function ToString() As String
            Return "user"
        End Function
        Protected Sub Refresh()
        End Sub
    End Class
End Namespace
`,
    'API/Instagram/MediaItem.vb': `Namespace API.Instagram
    Friend Class MediaItem
        Public Overrides Function ToString() As String
            Return "media"
        End Function
        Friend Sub Refresh()
        End Sub
    End Class
End Namespace
`,
    'API/Instagram/UserData.vb': `Namespace API.Instagram
    Friend Class UserData : Inherits API.Base.UserDataBase
        Friend Sub SetTagsLimit()
            Dim aStr$ = $"Enter the number of posts from user {ToString()}"
            Me.Refresh()
            Log(aStr)
        End Sub
        Private Class Counter
            Friend Sub Tick()
                Report()
            End Sub
        End Class
        Private Shared Sub Report()
        End Sub
    End Class
End Namespace
`,
    'Tools/Logger.vb': `Public Module Logger
    Public Sub Log(ByVal Text As String)
    End Sub
End Module
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

/** `Owner::member` of every call edge out of one method. */
function callsOf(file: string, qualifiedName: string): string[] {
  const from = cg.getNodesInFile(file).find((n) => n.qualifiedName === qualifiedName)!;
  return cg
    .getOutgoingEdgesFrom([from.id])
    .filter((e) => e.kind === 'calls')
    .map((e) => cg.getNode(e.target)!.qualifiedName)
    .sort();
}

describe('VB.NET receiver-less calls', () => {
  it('reach the members the class inherits, not a nearer class’s, and a module’s', () => {
    expect(callsOf('API/Instagram/UserData.vb', 'API.Instagram::UserData::SetTagsLimit')).toEqual([
      'API.Base::UserDataBase::Refresh',
      'API.Base::UserDataBase::ToString',
      'Logger::Log',
    ]);
  });

  it('reach a member of the class around a nested one', () => {
    expect(callsOf('API/Instagram/UserData.vb', 'API.Instagram::UserData::Counter::Tick')).toEqual([
      'API.Instagram::UserData::Report',
    ]);
  });
});
