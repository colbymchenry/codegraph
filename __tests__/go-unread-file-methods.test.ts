/**
 * A Go method a type declares in a file the index couldn't read.
 *
 * kubernetes' core/v1 generated.pb.go is 1.7 MB, over the index's 1 MB
 * limit, so `Pod`'s own `String`, `Marshal` and `Unmarshal` are not in the
 * graph. Resolving `pod.String()` on a `*v1.Pod`, the walk over the types
 * `Pod` embeds found the `String` its `TypeMeta` has and linked that, a
 * method the call never runs. Every typed Go receiver took that walk: a
 * parameter, a local, a field, an assertion, a package-level variable.
 *
 * The method declarations of such a file are read from its text: when the
 * type declares the method there, the call links nothing. A method the type
 * really gets from an embedded type, like `GetName` from `ObjectMeta`, still
 * links.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

let root = '';
let cg: CodeGraph;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-go-unread-methods-'));
  const files: Record<string, string> = {
    'go.mod': 'module example.com/app\n\ngo 1.22\n',
    'meta/meta.go': `package meta

type TypeMeta struct {
	Kind string
}

func (m *TypeMeta) String() string { return m.Kind }

func (m *TypeMeta) Unmarshal(dAtA []byte) error { return nil }

type ObjectMeta struct {
	Name string
}

func (m *ObjectMeta) GetName() string { return m.Name }
`,
    'api/types.go': `package api

import "example.com/app/meta"

type Pod struct {
	meta.TypeMeta
	meta.ObjectMeta
	Spec string
}
`,
    // Over the index's 1 MB limit, so none of it is read.
    'api/generated.pb.go': `package api

func (m *Pod) String() string { return "" }

func (m *Pod) Unmarshal(dAtA []byte) error { return nil }
${'// generated padding, never read by the indexer\n'.repeat(24_000)}`,
    'caller/caller.go': `package caller

import "example.com/app/api"

func param(pod *api.Pod) string {
	return pod.String()
}

func local() error {
	pod := &api.Pod{}
	return pod.Unmarshal(nil)
}

type holder struct {
	pod *api.Pod
}

func (h *holder) field() string {
	return h.pod.String()
}

func asserted(x any) string {
	return x.(*api.Pod).String()
}

var shared api.Pod

func packageVar() error {
	return shared.Unmarshal(nil)
}

func promoted(pod *api.Pod) string {
	return pod.GetName()
}
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

/** `file::qualifiedName` of every symbol the function or method `name` in `file` calls. */
function callTargets(file: string, name: string): string[] {
  const fn = cg.getNodesInFile(file).find((n) => n.name === name);
  expect(fn, `${name} in ${file}`).toBeDefined();
  return cg
    .getOutgoingEdges(fn!.id)
    .filter((e) => e.kind === 'calls')
    .map((e) => cg.getNode(e.target)!)
    .map((n) => `${n.filePath.replace(/\\/g, '/')}::${n.qualifiedName}`)
    .sort();
}

describe("Go methods declared in a file the index couldn't read", () => {
  it('the file is indexed without a node', () => {
    expect(cg.getNodesInFile('api/generated.pb.go')).toEqual([]);
  });

  it('a parameter of the type links nothing, not the method an embedded type has', () => {
    expect(callTargets('caller/caller.go', 'param')).toEqual([]);
  });

  it('a local bound to a composite literal', () => {
    expect(callTargets('caller/caller.go', 'local')).toEqual([]);
  });

  it('a field of the type', () => {
    expect(callTargets('caller/caller.go', 'field')).toEqual([]);
  });

  it('a type assertion', () => {
    expect(callTargets('caller/caller.go', 'asserted')).toEqual([]);
  });

  it('a package-level variable', () => {
    expect(callTargets('caller/caller.go', 'packageVar')).toEqual([]);
  });

  it('a method an embedded type gives the type still links', () => {
    expect(callTargets('caller/caller.go', 'promoted')).toEqual(['meta/meta.go::ObjectMeta::GetName']);
  });
});
