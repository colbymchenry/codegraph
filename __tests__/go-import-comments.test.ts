/**
 * A comment inside a Go import declaration is not part of an import.
 *
 * harbor's `core/main.go` imports
 *
 *     _ "github.com/goharbor/harbor/src/lib/cache/memory" // memory cache
 *     _ "github.com/goharbor/harbor/src/lib/cache/redis"  // redis cache
 *     "github.com/goharbor/harbor/src/lib/config"
 *
 * and the last word of the trailing comment was read as the alias of the
 * import on the next line: the file bound `cache` to `lib/config`, so every
 * `config.X()` in it lost its target or landed on a same-named method. A
 * quoted word in a comment was likewise read as an import of its own, and a
 * `)` in a comment ended the import block early.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { extractImportMappings } from '../src/resolution/import-resolver';

/** `localName=source` of every import the reader finds in `source`. */
const imports = (source: string) =>
  extractImportMappings('main.go', source, 'go').map((m) => `${m.localName}=${m.source}`);

describe('Go import reader: comments', () => {
  it('does not read a trailing line comment as the alias of the next import', () => {
    expect(imports(`package main

import (
	_ "example.com/app/lib/cache/memory" // memory cache
	"example.com/app/lib/errors"
)
`)).toEqual(['_=example.com/app/lib/cache/memory', 'errors=example.com/app/lib/errors']);
  });

  it('does not read a trailing block comment as an alias', () => {
    expect(imports(`package main

import (
	"example.com/app/lib/cache" /* the cache */
	"example.com/app/lib/errors"
	al /* renamed */ "example.com/app/lib/log"
)
`)).toEqual([
      'cache=example.com/app/lib/cache',
      'errors=example.com/app/lib/errors',
      'al=example.com/app/lib/log',
    ]);
  });

  it('does not read a quoted word in a comment as an import', () => {
    expect(imports(`package main

// Usage:
//
//	import "example.com/app/docs"
import (
	"example.com/app/lib/a"
	// was "example.com/app/lib/old" before the move
	/* and "example.com/app/lib/older" before that */
	// _ "example.com/app/lib/disabled"
	"example.com/app/lib/b"
)
`)).toEqual(['a=example.com/app/lib/a', 'b=example.com/app/lib/b']);
  });

  it('reads the whole block when a comment contains a closing parenthesis', () => {
    expect(imports(`package main

import (
	"example.com/app/lib/a" // (legacy)
	"example.com/app/lib/b"
)
`)).toEqual(['a=example.com/app/lib/a', 'b=example.com/app/lib/b']);
  });

  it('keeps a `//` inside the quoted path', () => {
    expect(imports(`package main

import (
	"example.com//app/lib/a"
	b "example.com/app//lib/b" // trailing
)
`)).toEqual(['a=example.com//app/lib/a', 'b=example.com/app//lib/b']);
  });

  it('handles Windows line endings', () => {
    expect(imports(
      'package main\r\n\r\nimport (\r\n\t_ "example.com/app/lib/cache/memory" // memory cache\r\n\t"example.com/app/lib/errors"\r\n\tal "example.com/app/lib/log"\r\n)\r\n'
    )).toEqual([
      '_=example.com/app/lib/cache/memory',
      'errors=example.com/app/lib/errors',
      'al=example.com/app/lib/log',
    ]);
  });

  it('reads the other import forms as before', () => {
    expect(imports('package main\n\nimport "example.com/app/lib/a"\n')).toEqual(['a=example.com/app/lib/a']);
    expect(imports('package main\n\nimport al "example.com/app/lib/a"\n')).toEqual(['al=example.com/app/lib/a']);
    expect(imports('package main\n\nimport _ "example.com/app/lib/a"\n')).toEqual(['_=example.com/app/lib/a']);
    // Several declarations in one file, with a dot and a blank import.
    expect(imports(`package main

import "example.com/app/lib/a"

import (
	"example.com/app/lib/b"
)

import (
	c "example.com/app/lib/d"
	. "example.com/app/lib/e"
	_ "example.com/app/lib/f"
)
`)).toEqual([
      'a=example.com/app/lib/a',
      'b=example.com/app/lib/b',
      'c=example.com/app/lib/d',
      'e=example.com/app/lib/e',
      '_=example.com/app/lib/f',
    ]);
  });

  it('reads `import "C"` under its cgo preamble', () => {
    expect(imports(`package main

/*
#include <stdio.h>
#include "bridge.h"
*/
import "C"

// #cgo LDFLAGS: -lm
// import "example.com/app/not/imported"
import "example.com/app/lib/a"
`)).toEqual(['C=C', 'a=example.com/app/lib/a']);
  });
});

describe('Go calls through an import that follows a commented one', () => {
  let root = '';
  let cg: CodeGraph;

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-go-import-comments-'));
    const files: Record<string, string> = {
      'go.mod': 'module example.com/app\n\ngo 1.22\n',
      'lib/cache/memory/memory.go': 'package memory\n\nfunc init() {}\n',
      'lib/cache/redis/redis.go': 'package redis\n\nfunc init() {}\n',
      'lib/config/config.go': `package config

func Load() error { return nil }
`,
      // A same-named method elsewhere, as harbor's \`ConfigStore.Load\`.
      'pkg/store/store.go': `package store

type ConfigStore struct{}

func (s *ConfigStore) Load() error { return nil }

func Open() *ConfigStore { return &ConfigStore{} }
`,
      // The package a commented-out import names, with the same function.
      'pkg/legacy/store/store.go': `package store

func Open() int { return 0 }
`,
      'core/main.go': `package main

import (
	_ "example.com/app/lib/cache/memory" // memory cache
	_ "example.com/app/lib/cache/redis"  // redis cache
	"example.com/app/lib/config"
)

func main() {
	if err := config.Load(); err != nil {
		panic(err)
	}
}
`,
      'core/open.go': `package main

import (
	// "example.com/app/pkg/legacy/store" until the migration (see the old layout)
	"example.com/app/pkg/store"
)

func open() {
	store.Open()
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

  /** `file:qualifiedName` of every call leaving the function `fn` of `file`. */
  const callsFrom = (file: string, fn: string) => {
    const ids = cg.getNodesInFile(file).filter((n) => n.name === fn).map((n) => n.id);
    return cg.getOutgoingEdgesFrom(ids, ['calls']).map((e) => {
      const target = cg.getNode(e.target)!;
      return `${target.filePath}:${target.qualifiedName}`;
    });
  };

  it('resolves a call into the package imported after a commented blank import', () => {
    expect(callsFrom('core/main.go', 'main')).toEqual(['lib/config/config.go:Load']);
  });

  it('resolves a call into the imported package, not the one a comment names', () => {
    expect(callsFrom('core/open.go', 'open')).toEqual(['pkg/store/store.go:Open']);
  });
});
