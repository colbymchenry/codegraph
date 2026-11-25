/**
 * A Go type written without a package qualifier is the file's own package's,
 * or one of a package the file dot-imports (#2323):
 *
 *   import . "example.com/app/config"
 *
 *   type controllerSuite struct {
 *     controller Controller          // config.Controller
 *   }
 *
 *   func (c *controllerSuite) GetAll() {
 *     c.controller.AllConfigs()      // config.Controller's, not aaa.Controller's
 *   }
 *
 * The type was looked up in the file's own package alone. Not found there,
 * the call went to name matching, which took the same-named type of a
 * package the file doesn't import — the one that sorts first. harbor's config
 * tests have this shape. The same held for a parameter, a local or a
 * package-level variable of such a type, an alias of it, a method promoted
 * from an embedded one and the embedding itself. A type of the file's own
 * package of the name comes first; a name the file can only have from a
 * package outside the project's modules (`. "github.com/onsi/gomega"`) has
 * none of the project's methods, unless a function of the file declares a
 * type of that name, which hides the dot import's.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';

/**
 * The module the tests index. `aaa` declares a namesake of every type and
 * sorts ahead of `config`, where name matching looked first.
 */
const FILES: Record<string, string> = {
  'go.mod': 'module example.com/app\n\ngo 1.22\n',
  'aaa/aaa.go': `package aaa

type Controller interface {
	AllConfigs() map[string]any
	UserConfigs() map[string]any
}

type Manager struct{}

func (m *Manager) Save() error { return nil }

type Level int

func (l Level) Label() string { return "" }

type Gomega interface {
	Expect(actual any) bool
}
`,
  'config/controller.go': `package config

type Controller interface {
	AllConfigs() map[string]any
	UserConfigs() map[string]any
}

type Manager struct{}

func (m *Manager) Save() error { return nil }

type Level int

func (l Level) Label() string { return "" }
`,
  // The issue's file, and the other ways a file can use a dot-imported type.
  'config/test/suite.go': `package test

import (
	"testing"

	. "example.com/app/config"
)

type controllerSuite struct {
	t          *testing.T
	controller Controller
	mgr        *Manager
}

func (c *controllerSuite) GetAll() {
	c.controller.AllConfigs()
}

func (c *controllerSuite) Persist() error {
	return c.mgr.Save()
}

func ViaParam(s *controllerSuite) {
	s.controller.UserConfigs()
}

func Param(ctl Controller) {
	ctl.AllConfigs()
}

func Local() {
	var ctl Controller
	ctl.UserConfigs()
	var m *Manager
	m.Save()
}

func Indexed(ctls []Controller) {
	ctls[0].AllConfigs()
}

type embedded struct {
	Controller
	*Manager
}

func (e *embedded) Run() {
	e.AllConfigs()
	e.Save()
}

var shared Controller

var level = Level(2)

func Shared() string {
	shared.AllConfigs()
	return level.Label()
}

type Ctl = Controller

func Aliased(c Ctl) {
	c.UserConfigs()
}

func register(fn any) {}

func Values(ctl Controller, c *controllerSuite) {
	register(ctl.AllConfigs)
	register(c.controller.UserConfigs)
}
`,
  // A file whose own package declares the name too: Go rejects the clash,
  // but the package's own type is the one the index reads first. Its
  // directory is as far from aaa as from config.
  'own/own.go': `package own

import . "example.com/app/config"

type Controller interface {
	AllConfigs() map[string]any
}

type suite struct {
	controller Controller
}

func (s *suite) Get() {
	s.controller.AllConfigs()
}

func Param(ctl Controller) {
	ctl.AllConfigs()
}

func Uses(m *Manager) error {
	return m.Save()
}

type wrapper struct {
	*Manager
}

func (w *wrapper) Keep() error {
	return w.Save()
}
`,
  // A dot import of a package from outside the project's modules: a name
  // its own package doesn't declare may be that package's.
  'ext/ext.go': `package ext

import (
	. "github.com/onsi/gomega"
)

type matcherSuite struct {
	g Gomega
}

func (m *matcherSuite) Check() {
	m.g.Expect(1)
}

func Param(g Gomega) {
	g.Expect(2)
}

func Many(gs []Gomega) {
	gs[0].Expect(3)
}
`,
  // ginkgo's spec context test: a type a function declares hides the dot
  // import's names, and the index holds no node for it.
  'ext/local.go': `package ext

import (
	. "github.com/onsi/gomega"
)

type progressManager struct{}

func (p *progressManager) QueryProgressReporters() []string { return nil }

func Attached(v any) {
	type CompleteSpecContext interface {
		QueryProgressReporters() []string
	}
	ctx := v.(CompleteSpecContext)
	ctx.QueryProgressReporters()
}
`,
};

describe.each(['default', 'wasm'])('Go types written bare are read in the packages the file dot-imports too (%s)', (backend) => {
  let root = '';
  let cg: CodeGraph | undefined;
  let kernel: string | undefined;

  beforeAll(async () => {
    kernel = process.env.CODEGRAPH_KERNEL;
    if (backend === 'wasm') process.env.CODEGRAPH_KERNEL = '0';
    else delete process.env.CODEGRAPH_KERNEL;
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-go-dot-import-'));
    for (const [rel, content] of Object.entries(FILES)) {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      // One file with a Windows checkout's line endings.
      fs.writeFileSync(path.join(root, rel), rel === 'own/own.go' ? content.replace(/\n/g, '\r\n') : content);
    }
    cg = await CodeGraph.init(root, { index: true });
  }, 60_000);

  afterAll(() => {
    cg?.close();
    if (root) fs.rmSync(root, { recursive: true, force: true });
    if (kernel === undefined) delete process.env.CODEGRAPH_KERNEL;
    else process.env.CODEGRAPH_KERNEL = kernel;
  });

  /** The node `qualifiedName` in `file`. */
  function nodeOf(file: string, qualifiedName: string) {
    const node = cg!.getNodesInFile(file).find((n) => n.qualifiedName === qualifiedName && n.kind !== 'parameter');
    expect(node, `${qualifiedName} in ${file}`).toBeDefined();
    return node!;
  }

  /**
   * `<source line> -> <target file>::<target qualified name>` for every edge
   * of `kind` the function or method `name` in `file` has to a function or
   * method.
   */
  function links(file: string, name: string, kind: 'calls' | 'references' = 'calls'): string[] {
    const lines = FILES[file]!.split('\n');
    return cg!
      .getOutgoingEdges(nodeOf(file, name).id)
      .filter((e) => e.kind === kind)
      .map((e) => ({ e, target: cg!.getNode(e.target)! }))
      .filter(({ target }) => target.kind === 'method' || target.kind === 'function')
      .map(({ e, target }) => `${lines[e.line! - 1]!.trim()} -> ${target.filePath}::${target.qualifiedName}`)
      .sort();
  }

  /** `<kind> <target file>::<target qualified name>` for each edge of `kinds` from `name` in `file` to a type, as resolved (no synthesized edge). */
  function typeLinks(file: string, name: string, kinds: string[]): string[] {
    return cg!
      .getOutgoingEdges(nodeOf(file, name).id)
      .filter((e) => kinds.includes(e.kind) && e.provenance !== 'heuristic')
      .map((e) => ({ e, target: cg!.getNode(e.target)! }))
      .filter(({ target }) => ['interface', 'struct', 'type_alias'].includes(target.kind))
      .map(({ e, target }) => `${e.kind} ${target.filePath}::${target.qualifiedName}`)
      .sort();
  }

  it("resolves a call through a field typed by a dot-imported package's type", () => {
    // The issue: name matching took aaa's Controller, which sorts first.
    expect(links('config/test/suite.go', 'controllerSuite::GetAll')).toEqual([
      'c.controller.AllConfigs() -> config/controller.go::Controller::AllConfigs',
    ]);
    expect(links('config/test/suite.go', 'controllerSuite::Persist')).toEqual([
      'return c.mgr.Save() -> config/controller.go::Manager::Save',
    ]);
    expect(links('config/test/suite.go', 'ViaParam')).toEqual([
      's.controller.UserConfigs() -> config/controller.go::Controller::UserConfigs',
    ]);
  });

  it('resolves a call through a parameter, a local or a package-level variable of such a type', () => {
    expect(links('config/test/suite.go', 'Param')).toEqual([
      'ctl.AllConfigs() -> config/controller.go::Controller::AllConfigs',
    ]);
    expect(links('config/test/suite.go', 'Local')).toEqual([
      'ctl.UserConfigs() -> config/controller.go::Controller::UserConfigs',
      'm.Save() -> config/controller.go::Manager::Save',
    ]);
    expect(links('config/test/suite.go', 'Indexed')).toEqual([
      'ctls[0].AllConfigs() -> config/controller.go::Controller::AllConfigs',
    ]);
    // `var level = Level(2)` converts to the dot-imported type.
    expect(links('config/test/suite.go', 'Shared')).toEqual([
      'return level.Label() -> config/controller.go::Level::Label',
      'shared.AllConfigs() -> config/controller.go::Controller::AllConfigs',
    ]);
  });

  it('follows an alias of such a type to it', () => {
    expect(links('config/test/suite.go', 'Aliased')).toEqual([
      'c.UserConfigs() -> config/controller.go::Controller::UserConfigs',
    ]);
  });

  it('resolves a method promoted from an embedded field of such a type, and links the embedding to it', () => {
    expect(links('config/test/suite.go', 'embedded::Run')).toEqual([
      'e.AllConfigs() -> config/controller.go::Controller::AllConfigs',
      'e.Save() -> config/controller.go::Manager::Save',
    ]);
    expect(links('own/own.go', 'wrapper::Keep')).toEqual(['return w.Save() -> config/controller.go::Manager::Save']);
    expect(typeLinks('config/test/suite.go', 'embedded', ['extends', 'implements'])).toEqual([
      'extends config/controller.go::Manager',
      'implements config/controller.go::Controller',
    ]);
    expect(typeLinks('own/own.go', 'wrapper', ['extends', 'implements'])).toEqual(['extends config/controller.go::Manager']);
  });

  it('links a method value taken through such a receiver as the call would', () => {
    expect(links('config/test/suite.go', 'Values', 'references')).toEqual([
      'register(c.controller.UserConfigs) -> config/controller.go::Controller::UserConfigs',
      'register(ctl.AllConfigs) -> config/controller.go::Controller::AllConfigs',
    ]);
  });

  it("links a type written bare to the dot-imported package's type", () => {
    // A struct's field types, a parameter's type: the dot import's even
    // where another package's namesake is as near.
    expect(typeLinks('config/test/suite.go', 'controllerSuite', ['references'])).toEqual([
      'references config/controller.go::Controller',
      'references config/controller.go::Manager',
    ]);
    expect(typeLinks('config/test/suite.go', 'Param', ['references'])).toEqual(['references config/controller.go::Controller']);
    expect(typeLinks('own/own.go', 'Uses', ['references'])).toEqual(['references config/controller.go::Manager']);
  });

  it("reads the file's own package's type of the name first", () => {
    expect(links('own/own.go', 'suite::Get')).toEqual(['s.controller.AllConfigs() -> own/own.go::Controller::AllConfigs']);
    expect(links('own/own.go', 'Param')).toEqual(['ctl.AllConfigs() -> own/own.go::Controller::AllConfigs']);
    expect(typeLinks('own/own.go', 'suite', ['references'])).toEqual(['references own/own.go::Controller']);
    // A name its own package lacks is still the dot import's.
    expect(links('own/own.go', 'Uses')).toEqual(['return m.Save() -> config/controller.go::Manager::Save']);
  });

  it('makes no guess onto a project type through a dot import from outside the project', () => {
    expect(links('ext/ext.go', 'matcherSuite::Check')).toEqual([]);
    expect(links('ext/ext.go', 'Param')).toEqual([]);
    expect(links('ext/ext.go', 'Many')).toEqual([]);
    expect(typeLinks('ext/ext.go', 'matcherSuite', ['references'])).toEqual([]);
    expect(typeLinks('ext/ext.go', 'Param', ['references'])).toEqual([]);
  });

  it('leaves a type a function declares to name matching, as before, beside such a dot import', () => {
    expect(links('ext/local.go', 'Attached')).toEqual([
      'ctx.QueryProgressReporters() -> ext/local.go::progressManager::QueryProgressReporters',
    ]);
  });

  it('never links a same-named type of a package the file does not import', () => {
    const decoys = cg!.getNodesInFile('aaa/aaa.go').filter((n) => n.kind !== 'file');
    expect(decoys.map((n) => n.qualifiedName).sort()).toEqual([
      'Controller',
      'Controller::AllConfigs',
      'Controller::UserConfigs',
      'Gomega',
      'Gomega::Expect',
      'Level',
      'Level::Label',
      'Manager',
      'Manager::Save',
    ]);
    for (const decoy of decoys) {
      // A struct whose promoted methods satisfy an interface does implement
      // it, whichever package declares it: those edges are synthesized.
      expect(
        cg!.getIncomingEdges(decoy.id).filter((e) => e.kind !== 'contains' && e.provenance !== 'heuristic'),
        decoy.qualifiedName,
      ).toEqual([]);
    }
  });
});
