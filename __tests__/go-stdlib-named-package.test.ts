/**
 * A project package may carry a standard-library name — harbor's
 * `src/lib/errors` and `src/lib/log`, a `pkg/types`, a `model/user`. What a
 * file imports under that name decides whose `errors.New(…)` it writes: the
 * project package's when the import path is inside one of the project's
 * modules, the standard library's otherwise.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

let root = '';
let cg: CodeGraph;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-go-stdname-'));
  const files: Record<string, string> = {
    'go.mod': 'module example.com/app\n\ngo 1.22\n',
    'lib/errors/errors.go': `package errors

type Error struct {
	Code string
}

func New(msg string) *Error {
	return &Error{Code: msg}
}
`,
    'lib/log/log.go': `package log

func Printf(format string, args ...any) {}
`,
    'svc/project.go': `package svc

import (
	"example.com/app/lib/errors"
	"example.com/app/lib/log"
)

func Create(name string) *errors.Error {
	log.Printf("create %s", name)
	return errors.New(name)
}

func Literal() errors.Error {
	return errors.Error{Code: "x"}
}
`,
    'svc/renamed.go': `package svc

import (
	liberrors "example.com/app/lib/errors"
)

func Renamed() *liberrors.Error {
	return liberrors.New("x")
}
`,
    'svc/both.go': `package svc

import (
	stderrors "errors"

	errors "example.com/app/lib/errors"
)

func Ours() *errors.Error {
	return errors.New("x")
}

func Theirs() error {
	return stderrors.New("y")
}
`,
    'svc/std.go': `package svc

import (
	"errors"
	"log"
)

func Std() error {
	log.Printf("std")
	return errors.New("std")
}
`,
    'lib/log/v2/log.go': `package log

func Infof(format string, args ...any) {}
`,
    // Unaliased imports whose paths end in a major version are known as `log`
    // and `errors`; only the first is a package of this module.
    'svc/versioned.go': `package svc

import (
	"example.com/app/lib/log/v2"
	"github.com/acme/errors/v2"
)

func Versioned() error {
	log.Infof("versioned")
	return errors.New("outside")
}
`,
    'svc/variable.go': `package svc

type bag struct{}

func (b *bag) Len() int { return 0 }

func Variable(errors *bag) int {
	errors.New("x")
	return errors.Len()
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

/** `kind file:name` of every edge leaving the function `fn` of `file`. */
const edgesFrom = (file: string, fn: string) => {
  const ids = cg.getNodesInFile(file).filter((n) => n.name === fn).map((n) => n.id);
  return cg.getOutgoingEdgesFrom(ids).filter((e) => e.kind !== 'contains').map((e) => {
    const target = cg.getNode(e.target)!;
    return `${e.kind} ${target.filePath}:${target.qualifiedName}`;
  });
};

describe('Go project package named like a standard-library package', () => {
  it('resolves a call written through its import', () => {
    const edges = edgesFrom('svc/project.go', 'Create');
    expect(edges).toContain('calls lib/errors/errors.go:New');
    expect(edges).toContain('calls lib/log/log.go:Printf');
  });

  it('resolves a composite literal of its type', () => {
    expect(edgesFrom('svc/project.go', 'Literal')).toContain('instantiates lib/errors/errors.go:Error');
  });

  it('resolves through an import alias', () => {
    expect(edgesFrom('svc/renamed.go', 'Renamed')).toContain('calls lib/errors/errors.go:New');
  });

  it('resolves when the alias is the standard-library name itself', () => {
    expect(edgesFrom('svc/both.go', 'Ours')).toContain('calls lib/errors/errors.go:New');
    expect(edgesFrom('svc/both.go', 'Theirs')).toEqual([]);
  });

  it('resolves through an unaliased import whose path ends in a major version', () => {
    expect(edgesFrom('svc/versioned.go', 'Versioned')).toEqual(['calls lib/log/v2/log.go:Infof']);
  });

  it('leaves a file importing the standard library package alone', () => {
    expect(edgesFrom('svc/std.go', 'Std')).toEqual([]);
  });

  it('leaves a variable of that name alone when the file imports no such package', () => {
    const edges = edgesFrom('svc/variable.go', 'Variable');
    expect(edges).not.toContain('calls lib/errors/errors.go:New');
  });
});
