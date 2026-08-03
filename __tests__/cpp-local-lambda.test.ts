import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { initGrammars, loadGrammarsForLanguages } from '../src/extraction/grammars';
import { extractFromSource } from '../src/extraction/tree-sitter';

beforeAll(async () => {
  await initGrammars();
  await loadGrammarsForLanguages(['cpp']);
});

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('C++ named local lambdas', () => {
  it('indexes lambda-valued locals as scoped functions without indexing ordinary locals', () => {
    const result = extractFromSource('renderer.cpp', `int helper() { return 1; }
void recordGraph() {
  int ordinaryLocal = 0;
  auto imageResource = [](int binding) { return helper() + binding; };
  auto bufferResource = [&](int binding) { return imageResource(binding); };
  bufferResource(3);
}
`);
    const image = result.nodes.find((node) => node.kind === 'function' && node.name === 'imageResource');
    const buffer = result.nodes.find((node) => node.kind === 'function' && node.name === 'bufferResource');
    expect(image?.qualifiedName).toBe('recordGraph::imageResource');
    expect(buffer?.qualifiedName).toBe('recordGraph::bufferResource');
    expect(image?.startLine).toBe(4);
    expect(result.nodes.some((node) => node.name === 'ordinaryLocal')).toBe(false);
    expect(result.unresolvedReferences.some((ref) => ref.fromNodeId === image?.id && ref.referenceName === 'helper')).toBe(true);
    expect(result.unresolvedReferences.some((ref) => ref.fromNodeId === buffer?.id && ref.referenceName === 'imageResource')).toBe(true);
  });

  it('resolves calls to the enclosing function lambda instead of an unrelated method', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-cpp-local-lambda-'));
    tempDirs.push(dir);
    fs.writeFileSync(path.join(dir, 'cache.h'), `class NativeGpuAssetCache {
public:
  int bufferResource();
  bool empty();
};
`);
    fs.writeFileSync(path.join(dir, 'cache.cpp'), `#include "cache.h"
int NativeGpuAssetCache::bufferResource() { return 0; }
bool NativeGpuAssetCache::empty() { return false; }
`);
    fs.writeFileSync(path.join(dir, 'renderer.cpp'), `#include "cache.h"
#include <string>
namespace rtv {
class PathTracerRenderer { public: void recordGraph(); private: std::string status_; };
int helper() { return 1; }
void PathTracerRenderer::recordGraph() {
  auto bufferResource = [](int binding) { return helper() + binding; };
  bufferResource(3);
  status_.empty();
}
}
`);
    const cg = CodeGraph.initSync(dir);
    try {
      await cg.indexAll();
      const rendererNodes = cg.getNodesInFile('renderer.cpp');
      const lambda = rendererNodes.find((node) => node.kind === 'function' && node.name === 'bufferResource')!;
      const helper = rendererNodes.find((node) => node.kind === 'function' && node.name === 'helper')!;
      const cacheMethod = cg.getNodesInFile('cache.cpp').find((node) => node.kind === 'method' && node.name === 'bufferResource')!;
      const unrelatedEmpty = cg.getNodesInFile('cache.cpp').find((node) => node.kind === 'method' && node.name === 'empty')!;

      expect(lambda.qualifiedName).toBe('rtv::PathTracerRenderer::recordGraph::bufferResource');
      expect(lambda.decorators).toContain('cpp:lambda');
      expect(cg.getCallers(lambda.id).some((caller) => caller.node.name === 'recordGraph' && caller.edge.line === 8)).toBe(true);
      expect(cg.getCallees(lambda.id).some((callee) => callee.node.id === helper.id)).toBe(true);
      expect(cg.getCallers(cacheMethod.id).some((caller) => caller.node.filePath === 'renderer.cpp')).toBe(false);
      expect(cg.getCallers(unrelatedEmpty.id).some((caller) => caller.node.filePath === 'renderer.cpp')).toBe(false);
    } finally {
      cg.close();
    }
  });
});
