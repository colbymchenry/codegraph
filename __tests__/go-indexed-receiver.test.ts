/**
 * Go calls on an indexed element: `xs[i].M()`, `m[k].M()`,
 * `(*in)[i].DeepCopyInto(…)`, `m.Items[len(m.Items)-1].Unmarshal(…)`.
 *
 * Such a call reaches the resolver by its bare method name, at the column
 * where the receiver expression starts, and nothing typed the receiver: a
 * method name only one type declares got a guess by name, a common one
 * (every API type's `DeepCopyInto`) nothing at all. The receiver's element
 * type is now read from the declaration of what is indexed: a slice, array,
 * pointer to a slice through `(*x)`, map, or a named slice type, through a
 * parameter, receiver, local, package-level variable or field. An element type
 * from outside the project's modules, or a predeclared one, has no project
 * method: no edge, as before for any receiver typed outside the project.
 *
 * Every method a shape test expects is also declared by a type of `alpha`, which
 * sorts before the real package, so a guess by name can't land on the right
 * one by luck.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

let root = '';
let cg: CodeGraph;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-go-indexed-recv-'));
  const files: Record<string, string> = {
    'go.mod': 'module example.com/app\n\ngo 1.22\n',
    'alpha/decoy.go': `package alpha

type Decoy struct{}

func (d *Decoy) Validate() error { return nil }

func (d Decoy) Key() string { return "" }

func (d *Decoy) Unmarshal(dAtA []byte) error { return nil }

func (d *Decoy) DeepCopyInto(out *Decoy) {}

func (d Decoy) ValidateBytes(data []byte) error { return nil }

type Addr struct{}

func (a *Addr) Contains(ip []byte) bool { return false }
`,
    'model/item.go': `package model

type Item struct {
	Meta
	Name string
}

func (i *Item) Validate() error { return nil }

func (i Item) Key() string { return i.Name }

func (i *Item) Rename(name string) { i.Name = name }

// Archive is the only method of its name in the project.
func (i *Item) Archive() {}

type Validator interface {
	Validate() error
}

// Items is a named slice type.
type Items []*Item

// Catalog holds a list of items and an index of them by name.
type Catalog struct {
	List   []Item
	ByName map[string]*Item
}
`,
    'model/meta.go': `package model

type Meta struct{}

func (m *Meta) Unmarshal(dAtA []byte) error { return nil }

func (m *Meta) Describe() string { return "" }
`,
    // Over the index's 1 MB limit, so none of it is read: Item's own
    // Unmarshal is missing from the graph.
    'model/generated.pb.go': `package model

func (i *Item) Unmarshal(dAtA []byte) error { return nil }
${'// generated padding, never read by the indexer\n'.repeat(24_000)}`,
    'caller/caller.go': `package caller

import (
	"net"
	"sync"

	"example.com/app/alpha"
	"example.com/app/model"
)

func params(xs []*model.Item) error {
	return xs[0].Validate()
}

func array() string {
	var ring [4]model.Item
	return ring[1].Key()
}

func maps(m map[string]*model.Item) error {
	return m["a"].Validate()
}

func deref(p *[]model.Item) string {
	return (*p)[0].Key()
}

func named(items model.Items) error {
	return items[0].Validate()
}

func fields(c *model.Catalog) (string, error) {
	return c.List[len(c.List)-1].Key(), c.ByName["a"].Validate()
}

func literals() (string, error) {
	keys, decoys := []model.Item{{Name: "a"}}, []alpha.Decoy{}
	byName := make(map[string]*model.Item)
	_ = decoys
	return keys[0].Key(), byName["a"].Validate()
}

func sliced(items model.Items) error {
	return items[1:][0].Validate()
}

var defaults = []model.Item{{Name: "a"}}

func packageVar() string {
	return defaults[0].Key()
}

func shadowed(xs []*model.Item) error {
	{
		xs := []alpha.Decoy{}
		_ = xs
	}
	return xs[0].Validate()
}

// A namesake of the call's element type, beside the call: the type the
// method was guessed on by name.
type local struct{}

func (l *local) Rename(name string) {}

func retarget(xs []model.Item) {
	xs[0].Rename("b")
}

// IPNet is the project's namesake of net.IPNet, and the one project type
// with a String, Contains or Error method.
type IPNet struct{}

func (n *IPNet) String() string { return "" }

func (n *IPNet) Contains(ip net.IP) bool { return false }

func (n *IPNet) Error() string { return "" }

func unread(xs []model.Item, dAtA []byte) error {
	return xs[0].Unmarshal(dAtA)
}

func promoted(xs []model.Item) string {
	return xs[0].Describe()
}

func outside(cidrs []*net.IPNet, errs []error) string {
	return cidrs[0].String() + errs[0].Error()
}

func outsideGuessed(cidrs []*net.IPNet, ip net.IP) bool {
	return cidrs[0].Contains(ip)
}

// Addr is net.IPNet under another name; alpha declares a struct Addr.
type Addr = net.IPNet

func aliasOutside(addrs []Addr, ip net.IP) bool {
	return addrs[0].Contains(ip)
}

// Holder embeds a type from outside the project, and hands out its items.
type Holder struct {
	sync.Mutex
}

func (h *Holder) All() []*model.Item { return nil }

func callResult(h *Holder) {
	h.All()[0].Archive()
}

// T is a type of this package, and the type parameter of First.
type T struct{}

func (t *T) Validate() error { return nil }

func First[T interface{ Validate() error }](xs []T) error {
	return xs[0].Validate()
}

func FirstNamed[T model.Validator](xs []T) error {
	return xs[0].Validate()
}
`,
    // kubectl's ConjunctiveSchema (kubernetes 4c05e667,
    // staging/src/k8s.io/kubectl/pkg/validation/schema.go).
    'validation/schema.go': `package validation

type Schema interface {
	ValidateBytes(data []byte) error
}

type NullSchema struct{}

func (NullSchema) ValidateBytes(data []byte) error { return nil }

type ConjunctiveSchema []Schema

func (c ConjunctiveSchema) ValidateBytes(data []byte) error {
	schemas := []Schema(c)
	for ix := range schemas {
		if err := schemas[ix].ValidateBytes(data); err != nil {
			return err
		}
	}
	return nil
}

func (c ConjunctiveSchema) First(data []byte) error {
	return c[0].ValidateBytes(data)
}
`,
    // What deepcopy-gen and go-to-protobuf generate for a list type.
    'api/types.go': `package api

type Item struct {
	Tags []string
}

type ItemList struct {
	Items []Item
}

func (in *Item) DeepCopyInto(out *Item) {
	*out = *in
}

func (in *ItemList) DeepCopyInto(out *ItemList) {
	*out = *in
	if in.Items != nil {
		in, out := &in.Items, &out.Items
		*out = make([]Item, len(*in))
		for i := range *in {
			(*in)[i].DeepCopyInto(&(*out)[i])
		}
	}
}

func (m *Item) Unmarshal(dAtA []byte) error { return nil }

func (m *ItemList) Unmarshal(dAtA []byte) error {
	iNdEx, postIndex := 0, len(dAtA)
	m.Items = append(m.Items, Item{})
	if err := m.Items[len(m.Items)-1].Unmarshal(dAtA[iNdEx:postIndex]); err != nil {
		return err
	}
	return nil
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
function callTargets(file: string, name: string, owner?: string): string[] {
  const fn = cg.getNodesInFile(file).find((n) =>
    n.name === name && (owner === undefined || n.qualifiedName === `${owner}::${name}`));
  expect(fn, `${owner ? `${owner}::` : ''}${name} in ${file}`).toBeDefined();
  return cg
    .getOutgoingEdges(fn!.id)
    .filter((e) => e.kind === 'calls')
    .map((e) => cg.getNode(e.target)!)
    .map((n) => `${n.filePath.replace(/\\/g, '/')}::${n.qualifiedName}`)
    .sort();
}

describe('Go calls on an indexed element', () => {
  it('a slice parameter of pointers reaches the element type\'s method', () => {
    expect(callTargets('caller/caller.go', 'params')).toEqual(['model/item.go::Item::Validate']);
  });

  it('an array local', () => {
    expect(callTargets('caller/caller.go', 'array')).toEqual(['model/item.go::Item::Key']);
  });

  it('a map parameter', () => {
    expect(callTargets('caller/caller.go', 'maps')).toEqual(['model/item.go::Item::Validate']);
  });

  it('a pointer to a slice, dereferenced', () => {
    expect(callTargets('caller/caller.go', 'deref')).toEqual(['model/item.go::Item::Key']);
  });

  it('a named slice type of another package', () => {
    expect(callTargets('caller/caller.go', 'named')).toEqual(['model/item.go::Item::Validate']);
  });

  it('a slice field and a map field of a parameter', () => {
    expect(callTargets('caller/caller.go', 'fields')).toEqual([
      'model/item.go::Item::Key',
      'model/item.go::Item::Validate',
    ]);
  });

  it('a slice of a named slice type keeps that type', () => {
    expect(callTargets('caller/caller.go', 'sliced')).toEqual(['model/item.go::Item::Validate']);
  });

  it('locals bound to a composite literal, each its own of several, and to make', () => {
    expect(callTargets('caller/caller.go', 'literals')).toEqual([
      'model/item.go::Item::Key',
      'model/item.go::Item::Validate',
    ]);
  });

  it('a package-level variable', () => {
    expect(callTargets('caller/caller.go', 'packageVar')).toEqual(['model/item.go::Item::Key']);
  });

  it('a declaration in a block that has closed does not type the receiver', () => {
    expect(callTargets('caller/caller.go', 'shadowed')).toEqual(['model/item.go::Item::Validate']);
  });

  it('a conversion to a slice of an interface, and a receiver of a named slice type', () => {
    expect(callTargets('validation/schema.go', 'ValidateBytes', 'ConjunctiveSchema')).toEqual([
      'validation/schema.go::Schema::ValidateBytes',
    ]);
    expect(callTargets('validation/schema.go', 'First', 'ConjunctiveSchema')).toEqual([
      'validation/schema.go::Schema::ValidateBytes',
    ]);
  });

  it("deepcopy's `(*in)[i]` after `in, out := &in.Items, &out.Items`", () => {
    expect(callTargets('api/types.go', 'DeepCopyInto', 'ItemList')).toEqual(['api/types.go::Item::DeepCopyInto']);
  });

  it("protobuf's `m.Items[len(m.Items)-1].Unmarshal(…)` on the receiver's slice field", () => {
    expect(callTargets('api/types.go', 'Unmarshal', 'ItemList')).toEqual(['api/types.go::Item::Unmarshal']);
  });

  it("a namesake method beside the call is not the element type's", () => {
    expect(callTargets('caller/caller.go', 'retarget')).toEqual(['model/item.go::Item::Rename']);
  });

  // A control: String and Error need a typed receiver to be linked at all,
  // so these had no edge before either. Neither is `IPNet` the project's
  // namesake of the outside type.
  it('an element type from outside the project, or a predeclared one, links nothing', () => {
    expect(callTargets('caller/caller.go', 'outside')).toEqual([]);
  });

  it("a method an embedded type has is not taken for one the index couldn't read", () => {
    expect(callTargets('caller/caller.go', 'unread')).toEqual([]);
  });

  it("a method an embedded type has is the element type's when no file of its package declares it", () => {
    expect(callTargets('caller/caller.go', 'promoted')).toEqual(['model/meta.go::Meta::Describe']);
  });

  it("an outside element type's method is not guessed by its name", () => {
    expect(callTargets('caller/caller.go', 'outsideGuessed')).toEqual([]);
  });

  it('an alias of an outside type is that type, not a namesake of the alias', () => {
    expect(callTargets('caller/caller.go', 'aliasOutside')).toEqual([]);
  });

  // A control: what a call returns isn't read here, so the call goes on to
  // name matching, which finds the one method of its name.
  it("an element of a call's result is left to the other strategies", () => {
    expect(callTargets('caller/caller.go', 'callResult')).toEqual([
      'caller/caller.go::Holder::All',
      'model/item.go::Item::Archive',
    ]);
  });

  it("a type parameter's element has its constraint's methods, not those of the type its package names alike", () => {
    expect(callTargets('caller/caller.go', 'First')).toEqual([]);
    expect(callTargets('caller/caller.go', 'FirstNamed')).toEqual(['model/item.go::Validator::Validate']);
  });
});
