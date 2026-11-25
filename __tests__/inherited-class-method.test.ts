/**
 * A call through a class name reaches a class method the class inherits,
 * read from its own and its ancestors' declaration heads, before any guess by
 * name: Horse's `THorse.Get('/ping', …)` is THorseCore's (three `class(…)`
 * heads up), not a route-group interface's `Get`; DRF's `MyView.as_view()` is
 * APIView's; netbox's `ColorChoices.values()` is ChoiceSet's.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

let root = '';
let cg: CodeGraph;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-inherited-class-method-'));
  const files: Record<string, string> = {
    'src/Horse.Core.pas': `unit Horse.Core;

interface

type
  THorseCore = class
  public
    class function Get(const APath: string): THorseCore;
  end;

implementation

class function THorseCore.Get(const APath: string): THorseCore;
begin
  Result := nil;
end;

end.
`,
    'src/Horse.Core.Group.pas': `unit Horse.Core.Group;

interface

type
  IHorseCoreGroup = interface
    function Get(const APath: string): IHorseCoreGroup;
  end;

implementation

end.
`,
    'src/Horse.pas': `unit Horse;

interface

uses Horse.Core;

type
  THorseProvider = class(THorseCore)
  end;

  THorse = class(THorseProvider)
  end;

implementation

end.
`,
    'samples/Console.dpr': `program Console;

uses Horse;

begin
  THorse.Get('/ping');
end.
`,
    'app/views.py': `class APIView:
    @classmethod
    def as_view(cls):
        return cls


class GenericAPIView(APIView):
    pass


class UserList(GenericAPIView):
    pass


class Router:
    def as_view(self):
        return None
`,
    'app/urls.py': `from app.views import UserList

urlpatterns = [UserList.as_view()]
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

/** `Owner::member` of every call edge out of a file. */
function callsFrom(file: string): string[] {
  const ids = cg.getNodesInFile(file).map((n) => n.id);
  return cg
    .getOutgoingEdgesFrom(ids)
    .filter((e) => e.kind === 'calls')
    .map((e) => cg.getNode(e.target)!.qualifiedName)
    .sort();
}

describe('a class method reached through a subclass name', () => {
  it('Pascal: walks the class(…) heads', () => {
    expect(callsFrom('samples/Console.dpr').filter((q) => q.endsWith('Get'))).toEqual(['THorseCore::Get']);
  });

  it('Python: walks the class bases', () => {
    expect(callsFrom('app/urls.py')).toEqual(['APIView::as_view']);
  });
});
