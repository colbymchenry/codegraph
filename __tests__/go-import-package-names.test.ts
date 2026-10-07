/**
 * A Go import without a name written before its path is bound to the name of
 * the package it imports, and the resolver took that to be the path's last
 * element. For a versioned path it isn't: `go.yaml.in/yaml/v3` and
 * `gopkg.in/yaml.v3` are package `yaml`, `github.com/mattn/go-sqlite3` is
 * `sqlite3`. So `yaml.Node`, `klog.V(2)` or `semver.Version` matched none of
 * the file's imports, and resolved by the bare name to whatever project symbol
 * shared it: kubernetes' 1,561 `klog.V(…)` calls went to an etcd3 logger
 * wrapper's `V` method, etcd's `*semver.Version` parameters to client/v3's
 * `Version` function. An unaliased import now also takes the name goimports
 * assumes for its path, while keeping the last element:
 * `k8s.io/api/core/v1` really is package `v1`.
 *
 * And a word in a comment is no import name: `"fmt" // for printing` used to
 * name the next import `printing`.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { extractImportMappings } from '../src/resolution/import-resolver';

/** The names a Go file's imports are bound to, as `name <- path`. */
const names = (source: string): string[] =>
  extractImportMappings('x.go', source, 'go').map((m) => `${m.localName} <- ${m.source}`).sort();

describe('Go import names', () => {
  it('bind an unaliased versioned or go- import to its package name as well as its last element', () => {
    expect(names(`package p

import (
	"go.yaml.in/yaml/v3"
	"github.com/mattn/go-sqlite3"
	"k8s.io/api/core/v1"
	"github.com/gin-gonic/gin"
	"gopkg.in/natefinch/lumberjack.v2"
)
`)).toEqual([
      'core <- k8s.io/api/core/v1',
      'gin <- github.com/gin-gonic/gin',
      'go-sqlite3 <- github.com/mattn/go-sqlite3',
      'lumberjack <- gopkg.in/natefinch/lumberjack.v2',
      'lumberjack.v2 <- gopkg.in/natefinch/lumberjack.v2',
      'sqlite3 <- github.com/mattn/go-sqlite3',
      'v1 <- k8s.io/api/core/v1',
      'v3 <- go.yaml.in/yaml/v3',
      'yaml <- go.yaml.in/yaml/v3',
    ]);
    expect(names('package p\n\nimport "gopkg.in/yaml.v3"\n')).toEqual(['yaml <- gopkg.in/yaml.v3', 'yaml.v3 <- gopkg.in/yaml.v3']);
  });

  it('take no assumed name another import holds, or two imports assume', () => {
    // `core` is pkg/apis/core's own name, not the one assumed for api/core/v1.
    expect(names(`package p

import (
	"k8s.io/api/core/v1"
	"k8s.io/kubernetes/pkg/apis/core"
	yaml "sigs.k8s.io/yaml"
	"go.yaml.in/yaml/v3"
	"github.com/a/semver/v3"
	"github.com/b/go-semver"
)
`)).toEqual([
      'core <- k8s.io/kubernetes/pkg/apis/core',
      'go-semver <- github.com/b/go-semver',
      'v1 <- k8s.io/api/core/v1',
      'v3 <- github.com/a/semver/v3',
      'v3 <- go.yaml.in/yaml/v3',
      'yaml <- sigs.k8s.io/yaml',
    ]);
  });

  it('keep a written name, assume none for a dot import, and read none from a comment', () => {
    expect(names(`package p

import (
	"fmt" // for printing
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	_ "embed"
	. "github.com/onsi/ginkgo/v2"

	// yaml decoding
	"gopkg.in/yaml.v3"
	/* the store */ "example.com/app/store"
)

func run() {}
`)).toEqual([
      '_ <- embed',
      'fmt <- fmt',
      'metav1 <- k8s.io/apimachinery/pkg/apis/meta/v1',
      'store <- example.com/app/store',
      'v2 <- github.com/onsi/ginkgo/v2',
      'yaml <- gopkg.in/yaml.v3',
      'yaml.v3 <- gopkg.in/yaml.v3',
    ]);
  });

  it('read only the import declarations, wherever a comment or a later string spells one', () => {
    expect(names(`/*
Package p is a code generator.

func Example() {}
*/
package p

// import "example.com/commented"
import (
	"text/template" // (for the body below)
	"strings"
)

func run() string {
	return strings.TrimSpace(\`
import "example.com/generated"
\`)
}
`)).toEqual(['strings <- strings', 'template <- text/template']);
  });
});

describe('Go references through a versioned or go- import', () => {
  let root = '';
  let cg: CodeGraph;

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-go-import-names-'));
    const files: Record<string, string> = {
      'go.mod': 'module example.com/app\n\ngo 1.22\n',
      // Project symbols named like what yaml, klog, semver and sqlite3 export.
      'other/other.go': [
        'package other',
        '',
        'type Node struct{}',
        '',
        'type Version struct{}',
        '',
        'type Error struct{}',
        '',
        'func Unmarshal(b []byte, v any) error { return nil }',
        '',
        'type klogWrapper struct{}',
        '',
        'func (k *klogWrapper) V(level int) bool { return true }',
        '',
        'func (k *klogWrapper) Infof(format string, args ...any) {}',
        '',
      ].join('\n'),
      'store/store.go': [
        'package store',
        '',
        'import (',
        '\t"github.com/Masterminds/semver/v3"',
        '\t"github.com/mattn/go-sqlite3"',
        '\t"go.yaml.in/yaml/v3"',
        '\t"k8s.io/klog/v2"',
        ')',
        '',
        'func Load(b []byte, root *yaml.Node, min *semver.Version) error {',
        '\tif klog.V(2) {',
        '\t\tklog.Infof("loading %d bytes", len(b))',
        '\t}',
        '\tvar e sqlite3.Error',
        '\t_ = e',
        '\treturn yaml.Unmarshal(b, root)',
        '}',
        '',
      ].join('\n'),
      // A project module whose path ends in a major version: package kit.
      'kit/go.mod': 'module example.com/kit/v2\n\ngo 1.22\n',
      'kit/kit.go': [
        'package kit',
        '',
        'type Kit struct{}',
        '',
        'func New() *Kit { return &Kit{} }',
        '',
      ].join('\n'),
      'decoy/decoy.go': [
        'package decoy',
        '',
        'type Kit struct{}',
        '',
        'func New() *Kit { return &Kit{} }',
        '',
        'func Find(id string) string { return id }',
        '',
      ].join('\n'),
      // k8s.io/api/core/v1 is package v1, beside a package named core.
      'api/core/v1/types.go': 'package v1\n\ntype Pod struct{}\n',
      'pkg/apis/core/types.go': 'package core\n\ntype Pod struct{}\n',
      'repo/repo.go': 'package repo\n\nfunc Find(id string) string { return id }\n',
      'app/app.go': [
        'package app',
        '',
        'import (',
        '\t"fmt" // for printing',
        '\t"example.com/app/repo"',
        '\t"example.com/app/api/core/v1"',
        '\t"example.com/app/pkg/apis/core"',
        '\t"example.com/kit/v2"',
        ')',
        '',
        'func Run(p *v1.Pod, q *core.Pod) *kit.Kit {',
        '\tfmt.Println(repo.Find("x"))',
        '\treturn kit.New()',
        '}',
        '',
      ].join('\n'),
    };
    for (const [rel, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), content);
    }
    cg = await CodeGraph.init(root, { index: true });
  }, 60_000);

  afterAll(() => {
    cg?.close();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  const targetsFrom = (file: string) => {
    const ids = cg.getNodesInFile(file).map((n) => n.id);
    return cg.getOutgoingEdgesFrom(ids)
      .filter((e) => e.kind !== 'contains')
      .map((e) => {
        const t = cg.getNode(e.target)!;
        return `${e.kind} ${t.qualifiedName}@${t.filePath}`;
      })
      .sort();
  };

  it('never reach a project symbol that only shares the name', () => {
    expect(targetsFrom('store/store.go').filter((t) => t.includes('@other/'))).toEqual([]);
  });

  it('reach the project package the import names', () => {
    expect(targetsFrom('app/app.go')).toEqual([
      'calls Find@repo/repo.go',
      'calls New@kit/kit.go',
      'references Kit@kit/kit.go',
      'references Pod@api/core/v1/types.go',
      'references Pod@pkg/apis/core/types.go',
    ]);
  });
});
