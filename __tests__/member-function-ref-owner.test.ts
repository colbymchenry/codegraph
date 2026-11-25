/**
 * A member passed as a value through a receiver nothing types —
 * `device=self.parent.device`, `self.check.last_ping` — is only the
 * project's one method of that name when the receiver is named after its
 * owner: netbox's model-field reads bound to a GraphQL filter's `device`
 * method, healthchecks' `check.last_ping` to a transport's.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

let root = '';
let cg: CodeGraph;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-member-fnref-'));
  const files: Record<string, string> = {
    'app/filters.py': `class FHRPGroupAssignmentFilter:
    def device(self, queryset):
        return queryset
`,
    'app/components.py': `def describe(parent):
    return "{interface}".format(interface=parent, device=parent.device)
`,
    'app/recorder.py': `class HookRecorder:
    def finish_recording(self):
        return None


def register(request, hook_recorder):
    request.addfinalizer(hook_recorder.finish_recording)
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

const refsFrom = (file: string) => {
  const ids = cg.getNodesInFile(file).map((n) => n.id);
  return cg.getOutgoingEdgesFrom(ids).filter((e) => e.kind === 'references').map((e) => cg.getNode(e.target)!.qualifiedName);
};

describe('member values through an untyped receiver', () => {
  it('are not a method whose owner the receiver is not named after', () => {
    expect(refsFrom('app/components.py')).not.toContain('FHRPGroupAssignmentFilter::device');
  });

  it('are a method whose owner the receiver is named after', () => {
    expect(refsFrom('app/recorder.py')).toContain('HookRecorder::finish_recording');
  });
});
