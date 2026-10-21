/**
 * VB.NET runs on the same .NET base library as C#, so a call such as
 * `x.Contains(…)`, `x.Add(…)` or `x.Dispose()` on a receiver whose type is not
 * known is far more likely the library's method than the one project method
 * that happens to share the name. As in C#, such a guess is kept only when the
 * receiver is named after the method's owner. staxrip's
 * `SupportedInput.Contains(ret)` — a String array — went to `VideoScript`'s
 * `Contains`.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

let root = '';
let cg: CodeGraph;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-vb-std-'));
  const files: Record<string, string> = {
    'Video/VideoScript.vb': `Public Class VideoScript
    Public Function Contains(ByVal value As String) As Boolean
        Return False
    End Function
End Class
`,
    'Audio/AudioProfile.vb': `Public Class AudioProfile
    Public Function IsInputSupported(ByVal inputs As Object, ByVal ext As String) As Boolean
        For Each supported In inputs
            If supported.Contains(ext) Then Return True
        Next
        Return False
    End Function

    Public Function HasScript(ByVal scripts As Object, ByVal name As String) As Boolean
        For Each script In scripts
            If script.Contains(name) Then Return True
        Next
        Return False
    End Function
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

/** `Owner::member` of every call edge out of one method. */
function callsOf(qualifiedName: string): string[] {
  const from = cg.getNodesInFile('Audio/AudioProfile.vb').find((n) => n.qualifiedName === qualifiedName)!;
  return cg
    .getOutgoingEdgesFrom([from.id])
    .filter((e) => e.kind === 'calls')
    .map((e) => cg.getNode(e.target)!.qualifiedName)
    .sort();
}

describe('VB.NET standard-library method names', () => {
  it('are not a project method on a receiver that does not name its owner', () => {
    expect(callsOf('AudioProfile::IsInputSupported')).toEqual([]);
  });

  it('still reach the project method when the receiver names its owner', () => {
    expect(callsOf('AudioProfile::HasScript')).toEqual(['VideoScript::Contains']);
  });
});
