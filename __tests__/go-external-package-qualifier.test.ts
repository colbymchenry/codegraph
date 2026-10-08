/**
 * A Go name written through an imported package from outside the module —
 * `context.Context`, `http.ResponseWriter`, testify's `require.Contains` — is
 * that package's, never a project symbol of the name: fiber's 85
 * `context.Context` parameters went to a same-file method `Stream.Context`,
 * and 403 `require.Contains(…)` to an extractor's `Contains`. A name through
 * one of the module's own packages still resolves.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

let root = '';
let cg: CodeGraph;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-go-ext-qual-'));
  const files: Record<string, string> = {
    'go.mod': 'module github.com/gofiber/fiber/v3\n\ngo 1.22\n',
    'middleware/sse/sse.go': `package sse

import (
	"context"

	"github.com/gofiber/fiber/v3/extractors"
)

type Stream struct{}

func (s *Stream) Context() context.Context {
	return nil
}

func run(ctx context.Context) bool {
	return extractors.Contains("a", "b")
}
`,
    'extractors/extractors.go': `package extractors

func Contains(haystack, needle string) bool {
	return true
}
`,
    'middleware/sse/sse_test.go': `package sse

import (
	"testing"

	"github.com/stretchr/testify/require"
)

func TestStream(t *testing.T) {
	require.Contains(t, "abc", "a")
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

const targetsFrom = (file: string) => {
  const ids = cg.getNodesInFile(file).map((n) => n.id);
  return cg.getOutgoingEdgesFrom(ids).filter((e) => e.kind !== 'contains').map((e) => cg.getNode(e.target)!.qualifiedName);
};

describe('Go names through an outside package', () => {
  it('are never a project symbol of that name', () => {
    expect(targetsFrom('middleware/sse/sse.go')).not.toContain('Stream::Context');
    expect(targetsFrom('middleware/sse/sse_test.go')).not.toContain('Contains');
  });

  it('while the module’s own packages still resolve', () => {
    expect(targetsFrom('middleware/sse/sse.go')).toContain('Contains');
  });
});
