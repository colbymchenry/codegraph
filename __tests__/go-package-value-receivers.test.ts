/**
 * Go calls through a variable or constant a package declares at the top
 * level — `lg.Panic(…)` after `var lg *zap.Logger`, `RoleEndpoint.String()`
 * after `RoleEndpoint Role = "endpoints"` — read by that declaration, in the
 * file or another of the package, as a local's is: the method of the project
 * type it is declared as, or nothing for a type or value from outside the
 * project. Before, nothing read such a declaration, and the call was guessed
 * by its method's name: etcd's `lg.Panic(…)` reached a project logger's
 * `Panic`, prometheus's `RoleEndpoint.String()` another package's `Role`.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

let root = '';
let cg: CodeGraph;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-go-pkg-values-'));
  const files: Record<string, string> = {
    'go.mod': 'module example.com/app\n\ngo 1.22\n',
    'logx/logger.go': `package logx

type Logger struct{}

func New() *Logger { return &Logger{} }

func (l *Logger) Panic(msg string) {}

func (l *Logger) Info(msg string) {}
`,
    'tools/dump.go': `package tools

import "go.uber.org/zap"

var lg *zap.Logger

func dump() {
	lg.Panic("boom")
}
`,
    'tools/other.go': `package tools

func other() {
	lg.Info("other file")
}
`,
    'tools/shadow.go': `package tools

import "example.com/app/logx"

func shadow() {
	lg := logx.New()
	lg.Panic("local")
}
`,
    'discovery/kubernetes/kubernetes.go': `package kubernetes

type Role string

func (r Role) String() string { return string(r) }

const (
	RoleNode Role = "node"
	RolePod  Role = "pod"
)
`,
    'discovery/kubernetes/metrics.go': `package kubernetes

func nodeRole() string {
	return RoleNode.String()
}
`,
    'discovery/kubernetes/kind.go': `package kubernetes

type Kind int

const (
	KindA Kind = iota
	// KindB repeats KindA's type.
	KindB
	KindC
)

func (k Kind) Label() string { return "" }

func kindLabel() string {
	return KindB.Label()
}
`,
    'discovery/kubernetes/roles.go': `package kubernetes

var podRole = Role("pod")

func podRoleName() string {
	return podRole.String()
}
`,
    'discovery/aws/aws.go': `package aws

type Role string

func (r Role) String() string { return string(r) }
`,
    'tags/tag.go': `package tags

type Tag struct{}

func (t Tag) Label() string { return "" }
`,
    'registry/registry.go': `package registry

type Registry struct{}

func (r *Registry) Register(name string) {}

var defaultRegistry = &Registry{}

func register() {
	defaultRegistry.Register("x")
}
`,
    'plugins/manager.go': `package plugins

type Manager struct{}

func (m *Manager) Register(name string) {}
`,
    'buffers/buffers.go': `package buffers

import (
	"bytes"
	"io"
)

var buf = bytes.NewBuffer(nil)

func flush(w io.Writer) {
	buf.WriteTo(w)
}
`,
    'sinks/sink.go': `package sinks

import "io"

type Sink struct{}

func (s *Sink) WriteTo(w io.Writer) (int64, error) { return 0, nil }
`,
    'parsers/parser.go': `package parsers

type Parser struct{}

func NewParser() *Parser { return &Parser{} }

func (p *Parser) ParseExpr(s string) {}
`,
    'codecs/codec.go': `package codecs

type Encoder interface {
	Encode() string
}

type Serializer interface {
	Encoder
}

type Codec Serializer

type jsonCodec struct{}

func (jsonCodec) Encode() string { return "" }

var JSONCodec Codec = jsonCodec{}

func encode() string {
	return JSONCodec.Encode()
}
`,
    'parsers/use.go': `package parsers

var testParser = NewParser()

func parse() {
	testParser.ParseExpr("x")
}
`,
  };
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  cg = await CodeGraph.init(root, { index: true });
}, 120_000);

afterAll(() => {
  cg?.close();
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

/** `file::qualifiedName resolvedBy@confidence` of every method the function `name` in `file` calls. */
function calls(file: string, name: string): string[] {
  const fn = cg.getNodesInFile(file).find((n) => n.name === name && n.kind !== 'method');
  expect(fn, name).toBeDefined();
  return cg
    .getOutgoingEdges(fn!.id)
    .filter((e) => e.kind === 'calls')
    .map((e) => ({ e, n: cg.getNode(e.target)! }))
    .filter(({ n }) => n.kind === 'method')
    .map(({ e, n }) => `${n.filePath.replace(/\\/g, '/')}::${n.qualifiedName} ${String(e.metadata?.resolvedBy)}@${String(e.metadata?.confidence)}`)
    .sort();
}

describe('Go calls through a package-level variable or constant', () => {
  it.each([
    // `var lg *zap.Logger`: not the project's only `Panic`.
    ['tools/dump.go', 'dump', 'a variable of a type from outside the project'],
    // The same `lg`, declared in another file of the package.
    ['tools/other.go', 'other', 'a variable another file declares'],
    // `var buf = bytes.NewBuffer(nil)`: not the project's only `WriteTo`.
    ['buffers/buffers.go', 'flush', 'a value a package from outside the project hands out'],
  ])('links nothing from %s %s: %s', (file, fn) => {
    expect(calls(file, fn)).toEqual([]);
  });

  it.each([
    // `RoleNode Role = "node"` in kubernetes.go, not aws's `Role`.
    ['discovery/kubernetes/metrics.go', 'nodeRole', 'discovery/kubernetes/kubernetes.go::Role::String instance-method@0.9'],
    // `KindB`, alone in its group, has `Kind` from `KindA Kind = iota`.
    ['discovery/kubernetes/kind.go', 'kindLabel', 'discovery/kubernetes/kind.go::Kind::Label instance-method@0.9'],
    // `var defaultRegistry = &Registry{}`, not a plugin `Manager`.
    ['registry/registry.go', 'register', 'registry/registry.go::Registry::Register instance-method@0.9'],
    // `var podRole = Role("pod")`.
    ['discovery/kubernetes/roles.go', 'podRoleName', 'discovery/kubernetes/kubernetes.go::Role::String instance-method@0.9'],
  ])('links %s %s through the declared type', (file, fn, target) => {
    expect(calls(file, fn)).toEqual([target]);
  });

  it('leaves a local of the name, a value a project function returns and a type whose methods it can\'t see as they were', () => {
    // `lg := logx.New()` shadows the package's `lg`.
    expect(calls('tools/shadow.go', 'shadow').filter((c) => c.startsWith('logx/logger.go::Logger::Panic '))).toHaveLength(1);
    // `var testParser = NewParser()` says no type.
    expect(calls('parsers/use.go', 'parse').filter((c) => c.startsWith('parsers/parser.go::Parser::ParseExpr '))).toHaveLength(1);
    // `var JSONCodec Codec = jsonCodec{}`: `Codec` is defined over an
    // interface, whose methods its node doesn't carry.
    expect(calls('codecs/codec.go', 'encode')).not.toEqual([]);
  });
});
