import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

const BIN = path.resolve(__dirname, '../dist/bin/codegraph.js');
let dir: string;

function write(relative: string, content: string): void {
  const file = path.join(dir, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function affected(file: string): string[] {
  const stdout = execFileSync(process.execPath, [BIN, 'affected', file, '--path', dir, '--json'], {
    encoding: 'utf8',
    env: { ...process.env, CODEGRAPH_NO_DAEMON: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return JSON.parse(stdout).affectedTests as string[];
}

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-affected-vendor-'));
  write('src/core.ts', 'export function core() { return 1; }\n');
  write('tests/core.test.ts', 'import { core } from "../src/core"; core();\n');
  write('External/lib/source.ts', 'export function external() { return 1; }\n');
  write('External/lib/tests/external.test.ts', 'import { core } from "../../../src/core"; import { external } from "../source"; core(); external();\n');
  write('Shaders/shared.hlsli', 'float sharedShader(){ return 1.0; }\n');
  write('Samples/Minimal/Shaders/Render.hlsl', '#include "../../../Shaders/shared.hlsli"\nfloat main(){ return sharedShader(); }\n');
  write('Samples/Full/Shaders/Bridge/RAB_Surface.hlsli', 'float fullBridge(){ return 1.0; }\n');
  write('Samples/Full/Shaders/Full.hlsl', '#include "Bridge/RAB_Surface.hlsli"\n#include "../../../Shaders/shared.hlsli"\nfloat main(){ return fullBridge() + sharedShader(); }\n');
  write('Support/Tests/Runtime/Shaders/Bridge/RAB_Surface.hlsli', 'float testBridge(){ return 1.0; }\n');
  write('Support/Tests/Runtime/Shaders/RAB_PathTracer.hlsli', 'float helperHeader(){ return 1.0; }\n');
  write('Support/Tests/Runtime/Shaders/CompileTest.hlsl', '#include "../../../../Shaders/shared.hlsli"\n#include "Bridge/RAB_Surface.hlsli"\n#include "RAB_PathTracer.hlsli"\nfloat main(){ return sharedShader() + testBridge() + helperHeader(); }\n');
  const cg = CodeGraph.initSync(dir);
  await cg.indexAll();
  cg.close();
}, 60_000);

afterAll(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

describe('affected vendored-test filtering', () => {
  it('omits dependency-suite tests for a project-owned change', () => {
    expect(affected('src/core.ts')).toEqual(['tests/core.test.ts']);
  });

  it('keeps vendored tests when the changed file is itself vendored', () => {
    expect(affected('External/lib/source.ts')).toContain('External/lib/tests/external.test.ts');
  });

  it('recognizes shader compile tests under case-insensitive test directories', () => {
    expect(affected('Shaders/shared.hlsli')).toContain('Support/Tests/Runtime/Shaders/CompileTest.hlsl');
  });

  it('does not cross from one shader compilation root into another', () => {
    expect(affected('Samples/Minimal/Shaders/Render.hlsl')).toEqual([]);
    expect(affected('Samples/Full/Shaders/Bridge/RAB_Surface.hlsli')).toEqual([]);
  });

  it('maps a test bridge to its compile-test entry instead of the helper header itself', () => {
    expect(affected('Support/Tests/Runtime/Shaders/Bridge/RAB_Surface.hlsli')).toEqual([
      'Support/Tests/Runtime/Shaders/CompileTest.hlsl',
    ]);
    expect(affected('Support/Tests/Runtime/Shaders/RAB_PathTracer.hlsli')).toEqual([
      'Support/Tests/Runtime/Shaders/CompileTest.hlsl',
    ]);
  });

  it('does not classify shader helper headers as tests', () => {
    expect(affected('Shaders/shared.hlsli')).not.toContain('Support/Tests/Runtime/Shaders/RAB_PathTracer.hlsli');
  });
});
