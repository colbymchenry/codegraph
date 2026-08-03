import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { extractFromSource } from '../src/extraction/tree-sitter';
import { initGrammars, loadGrammarsForLanguages } from '../src/extraction/grammars';
import { clearProjectConfigCache, loadShaderIncludeAliases, loadShaderIncludePaths } from '../src/project-config';
import { ShaderResolver } from '../src/resolution/shader-resolver';
import { shaderIntegrationEdges } from '../src/resolution/shader-synthesizer';
import { ToolHandler } from '../src/mcp/tools';
import type { Language, Node } from '../src/types';
import type { ResolutionContext, UnresolvedRef } from '../src/resolution/types';

beforeAll(async () => {
  await initGrammars();
  await loadGrammarsForLanguages(['glsl', 'hlsl']);
});

const tempDirs: string[] = [];
afterEach(() => {
  clearProjectConfigCache();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function node(partial: Partial<Node> & Pick<Node, 'id' | 'kind' | 'name' | 'filePath' | 'language'>): Node {
  return {
    qualifiedName: partial.name,
    startLine: 1,
    endLine: 1,
    startColumn: 0,
    endColumn: 0,
    updatedAt: 1,
    ...partial,
  } as Node;
}

describe('shader extraction', () => {
  it('extracts Vulkan GLSL resources, macros, structs, specialization constants, and calls', () => {
    const source = `#version 460
#include "common.glsl"
#define ENABLE_GI 1
#define WRAP(x) shade(x)
struct Payload { vec3 color; float depth; };
layout(set = 1, binding = 4) uniform accelerationStructureEXT scene;
layout(push_constant) uniform Push { uint frame; } pc;
layout(constant_id = 3) const int MODE = 0;
layout(location = 0) rayPayloadEXT Payload payload;
vec3 shade(vec3 value) { return value; }
void main() { payload.color = WRAP(shade(vec3(MODE))); }
`;
    const result = extractFromSource('shaders/path.rgen', source);
    expect(result.errors).toEqual([]);
    expect(result.nodes.find((n) => n.kind === 'import' && n.name === 'common.glsl')).toBeDefined();
    expect(result.nodes.find((n) => n.kind === 'constant' && n.name === 'ENABLE_GI')).toBeDefined();
    expect(result.nodes.find((n) => n.kind === 'function' && n.name === 'WRAP')).toBeDefined();
    expect(result.nodes.find((n) => n.kind === 'struct' && n.name === 'Payload')).toBeDefined();
    expect(result.nodes.filter((n) => n.kind === 'field').map((n) => n.name)).toEqual(expect.arrayContaining(['color', 'depth', 'frame']));
    expect(result.nodes.find((n) => n.name === 'scene')?.decorators).toEqual(expect.arrayContaining(['set:1', 'binding:4', 'resource:acceleration-structure']));
    expect(result.nodes.find((n) => n.name === 'Push')?.decorators).toContain('push_constant');
    expect(result.nodes.find((n) => n.name === 'MODE')?.decorators).toContain('constant_id:3');
    expect(result.nodes.find((n) => n.name === 'main')?.decorators).toEqual(expect.arrayContaining(['entrypoint', 'shader:ray-generation']));
    expect(result.unresolvedReferences.some((ref) => ref.referenceKind === 'calls' && ref.referenceName === 'shade')).toBe(true);
    const macro = result.nodes.find((n) => n.kind === 'function' && n.name === 'WRAP');
    expect(result.unresolvedReferences.some((ref) => ref.fromNodeId === macro?.id && ref.referenceName === 'shade')).toBe(true);
    expect(result.unresolvedReferences.some((ref) => ref.referenceName === 'vec3')).toBe(false);
  });

  it('indexes every conditional branch with its normalized condition', () => {
    const result = extractFromSource('shaders/branches.comp', `#if USE_PRIMARY
layout(binding = 0) uniform sampler2D primaryTexture;
#elif USE_FALLBACK
layout(binding = 0) uniform sampler2D fallbackTexture;
#else
layout(binding = 0) uniform sampler2D debugTexture;
#endif
`);
    expect(result.nodes.find((n) => n.name === 'primaryTexture')?.decorators).toContain('pp:USE_PRIMARY');
    expect(result.nodes.find((n) => n.name === 'fallbackTexture')?.decorators).toContain('pp:!(USE_PRIMARY)&&(USE_FALLBACK)');
    expect(result.nodes.find((n) => n.name === 'debugTexture')?.decorators).toContain('pp:!(USE_PRIMARY||USE_FALLBACK)');
  });

  it('extracts HLSL cbuffers, registers, semantics, entry points, and NRD macro resources', () => {
    const source = `#define BINDING(x) [[vk::binding(x, 0)]]
#define DECL_RESOURCE_IMPL(name, slot) Texture2D<float4> name : register(t##slot);
#define DECL_RESOURCE(name, slot) DECL_RESOURCE_IMPL(name, slot)
BINDING(0) cbuffer Globals : register(b0) { float exposure; uint frame; }
BINDING(1) Texture2D<float4> inputTex : register(t1, space2);
RWTexture2D<float4> outputTex : register(u2);
DECL_RESOURCE(gHistory, 7)
NRD_INPUT(Texture2D, float4, gIn_Normal, t, 3)
NRD_OUTPUT(RWTexture2D, float4, gOut_Color, u, 4)
[numthreads(8, 8, 1)]
void main(uint3 id : SV_DispatchThreadID) { outputTex[id.xy] = inputTex.Load(int3(id.xy, 0)); }
`;
    const result = extractFromSource('shaders/filter.cs.hlsl', source);
    expect(result.errors).toEqual([]);
    expect(result.nodes.find((n) => n.kind === 'struct' && n.name === 'Globals')?.decorators).toEqual(expect.arrayContaining(['register:b0', 'resource:constant-buffer']));
    expect(result.nodes.filter((n) => n.kind === 'field').map((n) => n.name)).toEqual(expect.arrayContaining(['exposure', 'frame']));
    expect(result.nodes.find((n) => n.name === 'inputTex')?.decorators).toEqual(expect.arrayContaining(['register:t1', 'space:2', 'resource:texture']));
    expect(result.nodes.find((n) => n.name === 'gHistory')?.decorators).toEqual(expect.arrayContaining(['register:t7', 'resource:texture']));
    expect(result.nodes.find((n) => n.name === 'gIn_Normal')?.decorators).toContain('register:t3');
    expect(result.nodes.find((n) => n.name === 'gOut_Color')?.decorators).toContain('register:u4');
    expect(result.nodes.find((n) => n.name === 'main')?.decorators).toEqual(expect.arrayContaining(['entrypoint', 'shader:compute', 'numthreads:8,8,1']));
    expect(result.nodes.find((n) => n.name === 'main')?.decorators).toContain('semantic:SV_DispatchThreadID');
    expect(result.unresolvedReferences.some((ref) => /(?:Load|int3)/.test(ref.referenceName))).toBe(false);
  });

  it('keeps calls to user-defined functions that shadow intrinsic names', () => {
    const result = extractFromSource('shaders/shadow.frag', 'float clamp(float x){return x;}\nvoid main(){clamp(1.0);}\n');
    expect(result.unresolvedReferences.some((ref) => ref.referenceKind === 'calls' && ref.referenceName === 'clamp')).toBe(true);
  });

  it('records shader call arity so same-file overloads can be disambiguated', () => {
    const result = extractFromSource('shaders/overloads.hlsl', `
float pick(float a) { return a; }
float pick(float a, float b) { return a + b; }
float run() { return pick(1.0, 2.0); }
`);
    expect(result.nodes.find((candidate) => candidate.name === 'pick')?.signature).toMatch(/^float pick\(float a\)$/);
    const ref = result.unresolvedReferences.find((candidate) => candidate.referenceName === 'pick');
    expect(ref?.candidates).toContain('arity:2');
  });

  it('keeps GLSL function names and parameter parentheses in signatures', () => {
    const result = extractFromSource('shaders/overloads.glsl', `
bool resolve(Item item, out uint index) { index = 0u; return true; }
`);
    expect(result.nodes.find((candidate) => candidate.name === 'resolve')?.signature)
      .toBe('bool resolve(Item item, out uint index)');
  });

  it('records conservative HLSL argument types for overload resolution', () => {
    const result = extractFromSource('shaders/checkerboard.hlsl', `
void activate(inout uint2 pixel, bool previous, uint field) {}
void activate(inout int2 pixel, bool previous, uint field) {}
void run(uint2 pixel) { activate(pixel, false, 0); }
`);
    const run = result.nodes.find((candidate) => candidate.name === 'run');
    const ref = result.unresolvedReferences.find((candidate) => candidate.fromNodeId === run?.id && candidate.referenceName === 'activate');
    expect(ref?.candidates).toEqual(expect.arrayContaining(['arity:3', 'argtype:0:uint2', 'argtype:1:bool']));
  });

  it('recovers functions whose bodies are detached by GLSL preprocessor error recovery', () => {
    const result = extractFromSource('shaders/pathtrace_integrator.glsl', `#ifndef RTV_PATHTRACE_INTEGRATOR_GLSL
#define RTV_PATHTRACE_INTEGRATOR_GLSL
#ifndef RTV_MATERIAL_RAY_CONE_LOD
#define RTV_MATERIAL_RAY_CONE_LOD 0
// Main path integration routine.
vec3 trace_path(Ray ray, inout uint rng, uint pixelIndex, ivec2 coords, ivec2 dims, out bool did_hit, out float first_depth, out vec3 first_normal, out vec3 first_position, out PathComponents components) {
  vec3 radiance = vec3(0.0);
  renderer_debug_view();
`);
    const tracePath = result.nodes.find((candidate) => candidate.kind === 'function' && candidate.name === 'trace_path');
    expect(tracePath).toBeDefined();
    expect(tracePath!.endLine).toBeGreaterThan(tracePath!.startLine);
    expect(tracePath!.decorators ?? []).not.toEqual(expect.arrayContaining(['interface:in', 'interface:out']));
    expect(result.unresolvedReferences.some((ref) =>
      ref.fromNodeId === tracePath!.id && ref.referenceKind === 'calls' && ref.referenceName === 'renderer_debug_view'
    )).toBe(true);
    expect(result.unresolvedReferences.filter((ref) => ref.referenceName === 'renderer_debug_view')).toHaveLength(1);
  });

  it('recovers complete signatures for detached declarations', () => {
    const result = extractFromSource('shaders/pathtrace_ray_queries.glsl', `
vec3 direct_shadow_transmittance_stats(
  vec3 origin, vec3 direction, float tMax, float rayTime,
  Material receiverMaterial, out uint transmissiveHits,
  out uint visiblePath, out uint blockedPath) {
  return caustic_shadow_transmittance_stats(origin, direction, tMax, rayTime, transmissiveHits, visiblePath, blockedPath);
}
`);
    const fn = result.nodes.find((candidate) => candidate.name === 'direct_shadow_transmittance_stats');
    expect(fn?.signature).toContain('vec3 origin');
    expect(fn?.signature).toContain('Material receiverMaterial');
    expect(fn?.signature).not.toMatch(/^}/);
  });

  it('extracts OpenUSD GLSLFX sections, techniques, embedded symbols, and imports with original lines', () => {
    const source = `-- glslfx version 0.1
#import "$TOOLS/hdSt/shared.glslfx"
-- configuration
{"techniques":{"default":{"vertexShader":{"source":"Surface.Vertex"},"fragmentShader":{"source":"Surface.Fragment"}}}}
-- glsl Surface.Vertex
void vertexMain() {}
-- glsl Surface.Fragment
vec4 shade() { return vec4(1.0); }
`;
    const result = extractFromSource('pxr/shaders/material.glslfx', source);
    expect(result.errors).toEqual([]);
    expect(result.nodes.find((n) => n.kind === 'file')?.decorators).toContain('glslfx:0.1');
    expect(result.nodes.filter((n) => n.kind === 'module').map((n) => n.name)).toEqual(['Surface.Vertex', 'Surface.Fragment']);
    expect(result.nodes.find((n) => n.kind === 'component' && n.name === 'default')).toBeDefined();
    expect(result.nodes.find((n) => n.kind === 'function' && n.name === 'vertexMain')?.startLine).toBe(6);
    expect(result.nodes.find((n) => n.kind === 'import')?.name).toBe('$TOOLS/hdSt/shared.glslfx');
    expect(result.edges.filter((edge) => edge.kind === 'references')).toHaveLength(2);
  });

  it('keeps useful symbols from partial shaders and leaves ambiguous GLSLFX sections unresolved', () => {
    const partial = extractFromSource('shaders/partial.rchit', 'layout(set=0,binding=2) uniform accelerationStructureEXT scene;\nvoid main( {\n');
    expect(partial.nodes.find((node) => node.name === 'scene')?.decorators).toEqual(expect.arrayContaining(['set:0', 'binding:2']));

    const glslfx = extractFromSource('pxr/shaders/ambiguous.glslfx', `-- glslfx version 0.2
-- configuration
{"techniques":{"default":{"source":"Shared.Surface"}}}
-- glsl Shared.Surface
void first() {}
-- glsl Shared.Surface
void second() {}
`);
    expect(glslfx.errors.some((error) => error.code === 'glslfx_version' && error.severity === 'warning')).toBe(true);
    expect(glslfx.edges.filter((edge) => edge.kind === 'references')).toEqual([]);
  });
});

describe('shader exploration', () => {
  it('expands an explicit shader through its transitive include closure when requested', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-shader-explore-'));
    tempDirs.push(dir);
    const shaders = path.join(dir, 'shaders');
    fs.mkdirSync(shaders);
    fs.writeFileSync(path.join(shaders, 'root.comp'), `#version 460
#include "common.glsl"
void main() { shade(); }
`);
    fs.writeFileSync(path.join(shaders, 'common.glsl'), `#include "nested.glsl"
void shade() { helper(); }
`);
    fs.writeFileSync(path.join(shaders, 'nested.glsl'), `void helper() {}
`);
    const cg = CodeGraph.initSync(dir, { config: { include: ['shaders/**/*'], exclude: [] } });
    try {
      await cg.indexAll();
      const result = await new ToolHandler(cg).execute('codegraph_explore', {
        query: 'root.comp main and its included GLSL files',
        maxFiles: 6,
      });
      const text = result.content[0]!.text;
      expect(text).toContain('root.comp');
      expect(text).toContain('common.glsl');
      expect(text).toContain('nested.glsl');
      expect(text).toContain('void shade()');
      expect(text).toContain('void helper()');
    } finally {
      cg.destroy();
    }
  });

  it('treats a full shader path as exact instead of matching every same basename', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-shader-path-anchor-'));
    tempDirs.push(dir);
    fs.mkdirSync(path.join(dir, 'a'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'b'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'a', 'bridge.hlsli'), 'float SelectedBridge(){ return 1.0; }\n');
    fs.writeFileSync(path.join(dir, 'b', 'bridge.hlsli'), 'float UnrelatedBridge(){ return 2.0; }\n');
    const cg = CodeGraph.initSync(dir);
    try {
      await cg.indexAll();
      const result = await new ToolHandler(cg).execute('codegraph_explore', {
        query: 'a/bridge.hlsli SelectedBridge callers and impact',
        maxFiles: 4,
      });
      const text = result.content[0]!.text;
      expect(text).toContain('a/bridge.hlsli');
      expect(text).toContain('SelectedBridge');
      expect(text).not.toContain('b/bridge.hlsli');
      expect(text).not.toContain('UnrelatedBridge');
    } finally {
      cg.destroy();
    }
  });

  it('keeps explored bridge symbols inside the explicitly named shader translation unit', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-shader-context-explore-'));
    tempDirs.push(dir);
    for (const target of ['A', 'B']) {
      fs.mkdirSync(path.join(dir, 'Targets', target, 'Bridge'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'Targets', target, 'main.hlsl'), '#include "../../Shared/algorithm.hlsli"\n#include "Bridge/bridge.hlsli"\nvoid main(){ sharedAlgorithm(); }\n');
      fs.writeFileSync(path.join(dir, 'Targets', target, 'Bridge', 'bridge.hlsli'), `float BridgeSurface(int2 p){ return ${target === 'A' ? '1.0' : '2.0'}; }\n`);
    }
    fs.mkdirSync(path.join(dir, 'Shared'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'Shared', 'algorithm.hlsli'), 'void sharedLeaf(){}\nvoid sharedAlgorithm(){ sharedLeaf(); BridgeSurface(int2(0, 0)); }\n');
    const cg = CodeGraph.initSync(dir);
    try {
      await cg.indexAll();
      const result = await new ToolHandler(cg).execute('codegraph_explore', {
        query: 'Trace BridgeSurface from Targets/A/main.hlsl through Targets/A/Bridge/bridge.hlsli',
        maxFiles: 8,
      });
      const text = result.content[0]!.text;
      expect(text).toContain('Targets/A/Bridge/bridge.hlsli');
      expect(text).toContain('Targets/A/main.hlsl');
      expect(text).not.toContain('Targets/B/Bridge/bridge.hlsli');
      expect(text).not.toContain('Targets/B/main.hlsl');
    } finally {
      cg.destroy();
    }
  });

  it('shows direct shader call paths pinned by explicit file lines', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-shader-line-flow-'));
    tempDirs.push(dir);
    const shaders = path.join(dir, 'shaders');
    fs.mkdirSync(shaders);
    fs.writeFileSync(path.join(shaders, 'common.glsl'), 'bool resolve_light(uint value){return true;}\nbool resolve_light(uint value,uint version){return true;}\n');
    fs.writeFileSync(path.join(shaders, 'a.comp'), '#include "common.glsl"\nvoid main(){\n  resolve_light(1u, 2u);\n}\n');
    fs.writeFileSync(path.join(shaders, 'b.comp'), '#include "common.glsl"\nvoid evaluate(){\n  resolve_light(3u, 4u);\n}\n');
    fs.writeFileSync(path.join(shaders, 'temporal.hlsli'), 'void RTXDI_DITemporalResampling(uint2 pixel){}\n');
    fs.writeFileSync(path.join(shaders, 'di.hlsl'), '#include "temporal.hlsli"\nvoid main(){\n  RTXDI_DITemporalResampling(uint2(0, 0));\n}\n');
    const largeCalleeBody = Array.from({ length: 700 }, (_, index) =>
      `  value += ${index}u; // keep this endpoint larger than the explore output budget`
    ).join('\n');
    fs.writeFileSync(path.join(shaders, 'huge_trace.glsl'), `void huge_trace(){\n  uint value = 0u;\n${largeCalleeBody}\n}\n`);
    fs.writeFileSync(path.join(shaders, 'huge.rgen'), '#include "huge_trace.glsl"\nvoid main(){ huge_trace(); }\n');
    const fillers = path.join(dir, 'fillers');
    fs.mkdirSync(fillers);
    for (let index = 0; index < 500; index++) fs.writeFileSync(path.join(fillers, `f${index}.ts`), '');
    const cg = CodeGraph.initSync(dir);
    try {
      await cg.indexAll();
      const result = await new ToolHandler(cg).execute('codegraph_explore', {
        query: 'trace resolve_light from shaders/a.comp line 3 and shaders/b.comp (line 3)',
        maxFiles: 5,
      });
      const text = result.content[0]!.text;
      expect(text).toContain('Flow (call paths at the source locations you queried)');
      expect(text).toContain('@shaders/a.comp:3');
      expect(text).toContain('@shaders/b.comp:3');
      expect(text).toContain('**Relationships**');
      expect(text).toContain('- main → resolve_light');
      expect(text).toContain('- evaluate → resolve_light');
      expect(text).toContain('**`shaders/a.comp`**');
      expect(text).toContain('**`shaders/b.comp`**');

      const namedResult = await new ToolHandler(cg).execute('codegraph_explore', {
        query: 'main resolve_light from shaders/a.comp',
        maxFiles: 5,
      });
      const namedText = namedResult.content[0]!.text;
      expect(namedText).toContain('**Relationships**');
      expect(namedText).toContain('- main → resolve_light');

      const directNamedResult = await new ToolHandler(cg).execute('codegraph_explore', {
        query: 'show main → resolve_light',
        maxFiles: 5,
      });
      const directNamedText = directNamedResult.content[0]!.text;
      expect(directNamedText).toContain('Flow (direct call paths among the symbols you queried)');
      expect(directNamedText).toContain('- main → resolve_light');
      expect(directNamedText).toContain('**`shaders/a.comp`**');
      expect(directNamedText).toContain('**`shaders/common.glsl`**');

      const hlslResult = await new ToolHandler(cg).execute('codegraph_explore', {
        query: 'trace main to RTXDI_DITemporalResampling from shaders/di.hlsl line 3',
        maxFiles: 5,
      });
      const hlslText = hlslResult.content[0]!.text;
      expect(hlslText).toContain('@shaders/di.hlsl:3');
      expect(hlslText).toContain('- main → RTXDI_DITemporalResampling');

      const directHlslResult = await new ToolHandler(cg).execute('codegraph_explore', {
        query: 'show main → RTXDI_DITemporalResampling',
        maxFiles: 5,
      });
      const directHlslText = directHlslResult.content[0]!.text;
      expect(directHlslText).toContain('Flow (direct call paths among the symbols you queried)');
      expect(directHlslText).toContain('- main → RTXDI_DITemporalResampling');
      expect(directHlslText).toContain('**`shaders/di.hlsl`**');
      expect(directHlslText).toContain('**`shaders/temporal.hlsli`**');

      const largeEndpointResult = await new ToolHandler(cg).execute('codegraph_explore', {
        query: 'show main → huge_trace',
        maxFiles: 5,
      });
      const largeEndpointText = largeEndpointResult.content[0]!.text;
      expect(largeEndpointText).toContain('- main → huge_trace');
      expect(largeEndpointText).toContain('**`shaders/huge.rgen`**');
      expect(largeEndpointText).toContain('**`shaders/huge_trace.glsl`**');
    } finally {
      cg.destroy();
    }
  });
});

describe('shader config and include-scoped resolution', () => {
  it('loads include roots and aliases from codegraph.json', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-shader-config-'));
    tempDirs.push(dir);
    fs.writeFileSync(path.join(dir, 'codegraph.json'), JSON.stringify({
      shaderIncludePaths: ['shaders/include', './vendor/shaders/'],
      shaderIncludeAliases: { '$TOOLS': 'pxr/imaging' },
    }));
    expect(loadShaderIncludePaths(dir)).toEqual(['shaders/include', 'vendor/shaders']);
    expect(loadShaderIncludeAliases(dir)).toEqual({ '$TOOLS': 'pxr/imaging' });
  });

  it('applies quoted, angle, root, and alias include rules without escaping the project', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-shader-includes-'));
    tempDirs.push(dir);
    fs.writeFileSync(path.join(dir, 'codegraph.json'), JSON.stringify({
      shaderIncludePaths: ['shared'],
      shaderIncludeAliases: { '$TOOLS': 'vendor/tools' },
    }));
    const files = new Map<string, string>([
      ['shaders/main.comp', '#include "common.glsl"\n#include <root.glsl>\n#include "$TOOLS/lib.glsl"\n#include "../../outside.glsl"\nvoid main(){}'],
      ['shaders/common.glsl', 'float localHelper(){}'],
      ['shared/common.glsl', 'float wrongHelper(){}'],
      ['shared/root.glsl', 'float rootHelper(){}'],
      ['vendor/tools/lib.glsl', 'float aliasHelper(){}'],
      ['../outside.glsl', 'float outsideHelper(){}'],
    ]);
    const nodes = new Map<string, Node[]>();
    for (const file of files.keys()) nodes.set(file, [node({ id: `file:${file}`, kind: 'file', name: path.basename(file), filePath: file, language: 'glsl' })]);
    const context = fakeContext(files, nodes, [...nodes.values()].flat(), dir);
    const closure = new ShaderResolver(context).getClosure('shaders/main.comp', 'glsl');
    expect([...closure.keys()]).toEqual(expect.arrayContaining(['shaders/main.comp', 'shaders/common.glsl', 'shared/root.glsl', 'vendor/tools/lib.glsl']));
    expect(closure.has('shared/common.glsl')).toBe(false);
    expect(closure.has('../outside.glsl')).toBe(false);
  });

  it('resolves a compiler-root include by unique project suffix but leaves duplicate bridge suffixes ambiguous', () => {
    const files = new Map<string, string>([
      ['Tests/Compile.hlsl', '#include <Rtxdi/DI/Reservoir.hlsli>\n#include <Bridge/RAB_Surface.hlsli>'],
      ['Libraries/Rtxdi/Include/Rtxdi/DI/Reservoir.hlsli', 'void finalize(){}'],
      ['Samples/A/Bridge/RAB_Surface.hlsli', 'void surface(){}'],
      ['Samples/B/Bridge/RAB_Surface.hlsli', 'void surface(){}'],
    ]);
    const nodes = new Map<string, Node[]>();
    for (const file of files.keys()) nodes.set(file, [node({ id: `file:${file}`, kind: 'file', name: path.basename(file), filePath: file, language: 'hlsl' })]);
    const closure = new ShaderResolver(fakeContext(files, nodes, [...nodes.values()].flat(), process.cwd()))
      .getClosure('Tests/Compile.hlsl', 'hlsl');
    expect(closure.has('Libraries/Rtxdi/Include/Rtxdi/DI/Reservoir.hlsli')).toBe(true);
    expect(closure.has('Samples/A/Bridge/RAB_Surface.hlsli')).toBe(false);
    expect(closure.has('Samples/B/Bridge/RAB_Surface.hlsli')).toBe(false);
  });

  it('resolves calls only through the transitive include closure and drops equal-depth ambiguity', () => {
    const files = new Map<string, string>([
      ['shaders/main.rgen', '#include "a.glsl"\nvoid main(){ helper(); }'],
      ['shaders/a.glsl', '#include "nested/b.glsl"'],
      ['shaders/nested/b.glsl', 'void helper(){}'],
      ['other/helper.glsl', 'void helper(){}'],
    ]);
    const nodes = new Map<string, Node[]>([
      ['shaders/main.rgen', [node({ id: 'f-main', kind: 'file', name: 'main.rgen', filePath: 'shaders/main.rgen', language: 'glsl' }), node({ id: 'main', kind: 'function', name: 'main', filePath: 'shaders/main.rgen', language: 'glsl' })]],
      ['shaders/a.glsl', [node({ id: 'f-a', kind: 'file', name: 'a.glsl', filePath: 'shaders/a.glsl', language: 'glsl' })]],
      ['shaders/nested/b.glsl', [node({ id: 'f-b', kind: 'file', name: 'b.glsl', filePath: 'shaders/nested/b.glsl', language: 'glsl' }), node({ id: 'included-helper', kind: 'function', name: 'helper', filePath: 'shaders/nested/b.glsl', language: 'glsl' })]],
      ['other/helper.glsl', [node({ id: 'f-other', kind: 'file', name: 'helper.glsl', filePath: 'other/helper.glsl', language: 'glsl' }), node({ id: 'global-helper', kind: 'function', name: 'helper', filePath: 'other/helper.glsl', language: 'glsl' })]],
    ]);
    const allNodes = [...nodes.values()].flat();
    const context = fakeContext(files, nodes, allNodes, process.cwd());
    const resolver = new ShaderResolver(context);
    const ref: UnresolvedRef = { fromNodeId: 'main', referenceName: 'helper', referenceKind: 'calls', line: 2, column: 0, filePath: 'shaders/main.rgen', language: 'glsl' };
    expect(resolver.resolve(ref)?.targetNodeId).toBe('included-helper');

    files.set('shaders/c.glsl', 'void helper(){}');
    files.set('shaders/a.glsl', 'void helper(){}');
    files.set('shaders/main.rgen', '#include "a.glsl"\n#include "c.glsl"\nvoid main(){ helper(); }');
    nodes.set('shaders/a.glsl', [node({ id: 'f-a', kind: 'file', name: 'a.glsl', filePath: 'shaders/a.glsl', language: 'glsl' }), node({ id: 'a-helper', kind: 'function', name: 'helper', filePath: 'shaders/a.glsl', language: 'glsl' })]);
    nodes.set('shaders/c.glsl', [node({ id: 'f-c', kind: 'file', name: 'c.glsl', filePath: 'shaders/c.glsl', language: 'glsl' }), node({ id: 'c-helper', kind: 'function', name: 'helper', filePath: 'shaders/c.glsl', language: 'glsl' })]);
    const ambiguousContext = fakeContext(files, nodes, [...nodes.values()].flat(), process.cwd());
    expect(new ShaderResolver(ambiguousContext).resolve(ref)).toBeNull();
  });

  it('resolves equivalent injected shader declarations when no textual include edge exists', () => {
    const files = new Map<string, string>([
      ['shaders/use.glsl', 'float use(inout uint state) { return rand_f32(state); }'],
      ['shaders/a.glsl', 'float rand_f32(inout uint seed) { return 0.0; }'],
      ['shaders/b.glsl', 'float rand_f32(inout uint state) { return 1.0; }'],
    ]);
    const nodes = new Map<string, Node[]>([
      ['shaders/use.glsl', [node({ id: 'use-file', kind: 'file', name: 'use.glsl', filePath: 'shaders/use.glsl', language: 'glsl' })]],
      ['shaders/a.glsl', [node({ id: 'a-file', kind: 'file', name: 'a.glsl', filePath: 'shaders/a.glsl', language: 'glsl' }), node({ id: 'rand-a', kind: 'function', name: 'rand_f32', filePath: 'shaders/a.glsl', language: 'glsl', signature: 'float inout uint seed' })]],
      ['shaders/b.glsl', [node({ id: 'b-file', kind: 'file', name: 'b.glsl', filePath: 'shaders/b.glsl', language: 'glsl' }), node({ id: 'rand-b', kind: 'function', name: 'rand_f32', filePath: 'shaders/b.glsl', language: 'glsl', signature: 'float inout uint state' })]],
    ]);
    const ref: UnresolvedRef = { fromNodeId: 'use-fn', referenceName: 'rand_f32', referenceKind: 'calls', line: 1, column: 0, filePath: 'shaders/use.glsl', language: 'glsl' };
    const resolved = new ShaderResolver(fakeContext(files, nodes, [...nodes.values()].flat(), process.cwd())).resolve(ref);
    expect(resolved?.targetNodeId).toBe('rand-a');
  });

  it('resolves sibling includes through their shared shader translation unit', () => {
    const files = new Map<string, string>([
      ['shaders/path.rgen', '#include "rt_common.glsl"\n#include "pathtrace_integrator.glsl"\nvoid main(){}'],
      ['shaders/rt_common.glsl', 'uint renderer_debug_view(){ return 0u; }'],
      ['shaders/pathtrace_integrator.glsl', 'vec3 trace_path(){ return vec3(renderer_debug_view()); }'],
      ['other/rt_common.glsl', 'uint renderer_debug_view(){ return 1u; }'],
    ]);
    const nodes = new Map<string, Node[]>([
      ['shaders/path.rgen', [node({ id: 'root-file', kind: 'file', name: 'path.rgen', filePath: 'shaders/path.rgen', language: 'glsl' })]],
      ['shaders/rt_common.glsl', [node({ id: 'common-file', kind: 'file', name: 'rt_common.glsl', filePath: 'shaders/rt_common.glsl', language: 'glsl' }), node({ id: 'debug-view', kind: 'function', name: 'renderer_debug_view', filePath: 'shaders/rt_common.glsl', language: 'glsl' })]],
      ['shaders/pathtrace_integrator.glsl', [node({ id: 'integrator-file', kind: 'file', name: 'pathtrace_integrator.glsl', filePath: 'shaders/pathtrace_integrator.glsl', language: 'glsl' }), node({ id: 'trace-path', kind: 'function', name: 'trace_path', filePath: 'shaders/pathtrace_integrator.glsl', language: 'glsl' })]],
      ['other/rt_common.glsl', [node({ id: 'other-file', kind: 'file', name: 'rt_common.glsl', filePath: 'other/rt_common.glsl', language: 'glsl' }), node({ id: 'other-debug-view', kind: 'function', name: 'renderer_debug_view', filePath: 'other/rt_common.glsl', language: 'glsl' })]],
    ]);
    const allNodes = [...nodes.values()].flat();
    const ref: UnresolvedRef = { fromNodeId: 'trace-path', referenceName: 'renderer_debug_view', referenceKind: 'calls', line: 1, column: 33, filePath: 'shaders/pathtrace_integrator.glsl', language: 'glsl' };
    expect(new ShaderResolver(fakeContext(files, nodes, allNodes, process.cwd())).resolve(ref)?.targetNodeId).toBe('debug-view');

    files.set('shaders/path-alt.rgen', '#include "../other/rt_common.glsl"\n#include "pathtrace_integrator.glsl"\nvoid main(){}');
    nodes.set('shaders/path-alt.rgen', [node({ id: 'alt-root-file', kind: 'file', name: 'path-alt.rgen', filePath: 'shaders/path-alt.rgen', language: 'glsl' })]);
    const ambiguousNodes = [...nodes.values()].flat();
    expect(new ShaderResolver(fakeContext(files, nodes, ambiguousNodes, process.cwd())).resolve(ref)).toBeNull();
  });

  it('selects the HLSL overload reachable through a compiler-root include suffix', () => {
    const files = new Map<string, string>([
      ['Tests/DiCompile.hlsl', '#include <Rtxdi/DI/Reservoir.hlsli>\n#include <Rtxdi/DI/TemporalResampling.hlsli>'],
      ['Libraries/Rtxdi/Include/Rtxdi/DI/Reservoir.hlsli', 'void RTXDI_FinalizeResampling(inout DIReservoir r, float n, float d){}'],
      ['Libraries/Rtxdi/Include/Rtxdi/DI/TemporalResampling.hlsli', 'void run(){ RTXDI_FinalizeResampling(r, 1, 1); }'],
      ['Libraries/Rtxdi/Include/Rtxdi/PT/Reservoir.hlsli', 'void RTXDI_FinalizeResampling(inout PTReservoir r, float n, float d){}'],
    ]);
    const nodes = new Map<string, Node[]>([
      ['Tests/DiCompile.hlsl', [node({ id: 'root', kind: 'file', name: 'DiCompile.hlsl', filePath: 'Tests/DiCompile.hlsl', language: 'hlsl' })]],
      ['Libraries/Rtxdi/Include/Rtxdi/DI/Reservoir.hlsli', [node({ id: 'di-file', kind: 'file', name: 'Reservoir.hlsli', filePath: 'Libraries/Rtxdi/Include/Rtxdi/DI/Reservoir.hlsli', language: 'hlsl' }), node({ id: 'di-finalize', kind: 'function', name: 'RTXDI_FinalizeResampling', filePath: 'Libraries/Rtxdi/Include/Rtxdi/DI/Reservoir.hlsli', language: 'hlsl', signature: 'void (inout DIReservoir r, float n, float d)' })]],
      ['Libraries/Rtxdi/Include/Rtxdi/DI/TemporalResampling.hlsli', [node({ id: 'temporal-file', kind: 'file', name: 'TemporalResampling.hlsli', filePath: 'Libraries/Rtxdi/Include/Rtxdi/DI/TemporalResampling.hlsli', language: 'hlsl' }), node({ id: 'run', kind: 'function', name: 'run', filePath: 'Libraries/Rtxdi/Include/Rtxdi/DI/TemporalResampling.hlsli', language: 'hlsl' })]],
      ['Libraries/Rtxdi/Include/Rtxdi/PT/Reservoir.hlsli', [node({ id: 'pt-file', kind: 'file', name: 'Reservoir.hlsli', filePath: 'Libraries/Rtxdi/Include/Rtxdi/PT/Reservoir.hlsli', language: 'hlsl' }), node({ id: 'pt-finalize', kind: 'function', name: 'RTXDI_FinalizeResampling', filePath: 'Libraries/Rtxdi/Include/Rtxdi/PT/Reservoir.hlsli', language: 'hlsl', signature: 'void (inout PTReservoir r, float n, float d)' })]],
    ]);
    const ref: UnresolvedRef = { fromNodeId: 'run', referenceName: 'RTXDI_FinalizeResampling', referenceKind: 'calls', line: 1, column: 12, filePath: 'Libraries/Rtxdi/Include/Rtxdi/DI/TemporalResampling.hlsli', language: 'hlsl' };
    expect(new ShaderResolver(fakeContext(files, nodes, [...nodes.values()].flat(), process.cwd())).resolve(ref)?.targetNodeId).toBe('di-finalize');
  });

  it('selects a same-file HLSL overload by call arity', () => {
    const files = new Map<string, string>([['shaders/use.hlsl', 'float load(float a){}\nfloat load(float a,float b){}\nfloat run(){return load(1,2);}']]);
    const nodes = new Map<string, Node[]>([['shaders/use.hlsl', [
      node({ id: 'file', kind: 'file', name: 'use.hlsl', filePath: 'shaders/use.hlsl', language: 'hlsl' }),
      node({ id: 'one', kind: 'function', name: 'load', filePath: 'shaders/use.hlsl', language: 'hlsl', signature: 'float (float a)' }),
      node({ id: 'two', kind: 'function', name: 'load', filePath: 'shaders/use.hlsl', language: 'hlsl', signature: 'float (float a, float b)' }),
      node({ id: 'run', kind: 'function', name: 'run', filePath: 'shaders/use.hlsl', language: 'hlsl' }),
    ]]]);
    const ref: UnresolvedRef = { fromNodeId: 'run', referenceName: 'load', referenceKind: 'calls', line: 3, column: 19, filePath: 'shaders/use.hlsl', language: 'hlsl', candidates: ['arity:2'] };
    expect(new ShaderResolver(fakeContext(files, nodes, [...nodes.values()].flat(), process.cwd())).resolve(ref)?.targetNodeId).toBe('two');
  });

  it('selects same-arity HLSL overloads using exact argument-type evidence', () => {
    const files = new Map<string, string>([['shaders/use.hlsl', 'void activate(inout uint2 p,bool prev,uint field){}\nvoid activate(inout int2 p,bool prev,uint field){}\nvoid run(uint2 p){activate(p,false,0);}\n']]);
    const nodes = new Map<string, Node[]>([['shaders/use.hlsl', [
      node({ id: 'file', kind: 'file', name: 'use.hlsl', filePath: 'shaders/use.hlsl', language: 'hlsl' }),
      node({ id: 'uint', kind: 'function', name: 'activate', filePath: 'shaders/use.hlsl', language: 'hlsl', signature: 'void (inout uint2 p, bool prev, uint field)' }),
      node({ id: 'int', kind: 'function', name: 'activate', filePath: 'shaders/use.hlsl', language: 'hlsl', signature: 'void (inout int2 p, bool prev, uint field)' }),
      node({ id: 'run', kind: 'function', name: 'run', filePath: 'shaders/use.hlsl', language: 'hlsl' }),
    ]]]);
    const ref: UnresolvedRef = { fromNodeId: 'run', referenceName: 'activate', referenceKind: 'calls', line: 3, column: 18, filePath: 'shaders/use.hlsl', language: 'hlsl', candidates: ['arity:3', 'argtype:0:uint2'] };
    expect(new ShaderResolver(fakeContext(files, nodes, [...nodes.values()].flat(), process.cwd())).resolve(ref)?.targetNodeId).toBe('uint');
  });

  it('unions same-name shader implementations from mutually exclusive preprocessor branches', () => {
    const files = new Map<string, string>([
      ['shaders/main.comp', '#include "common.glsl"\nvoid main(){ recordCounter(1u); }'],
      ['shaders/common.glsl', '#if DIAGNOSTICS\nvoid recordCounter(uint index){}\n#else\n#define recordCounter(index)\n#endif\n'],
    ]);
    const nodes = new Map<string, Node[]>([
      ['shaders/main.comp', [
        node({ id: 'main-file', kind: 'file', name: 'main.comp', filePath: 'shaders/main.comp', language: 'glsl' }),
        node({ id: 'main', kind: 'function', name: 'main', filePath: 'shaders/main.comp', language: 'glsl', startLine: 2 }),
      ]],
      ['shaders/common.glsl', [
        node({ id: 'common-file', kind: 'file', name: 'common.glsl', filePath: 'shaders/common.glsl', language: 'glsl' }),
        node({ id: 'enabled', kind: 'function', name: 'recordCounter', filePath: 'shaders/common.glsl', language: 'glsl', startLine: 2, signature: 'void recordCounter(uint index)', decorators: ['pp:DIAGNOSTICS'] }),
        node({ id: 'disabled', kind: 'function', name: 'recordCounter', filePath: 'shaders/common.glsl', language: 'glsl', startLine: 4, signature: '#define recordCounter(index)', decorators: ['pp:!(DIAGNOSTICS)'] }),
      ]],
    ]);
    const ref: UnresolvedRef = { fromNodeId: 'main', referenceName: 'recordCounter', referenceKind: 'calls', line: 2, column: 13, filePath: 'shaders/main.comp', language: 'glsl', candidates: ['arity:1'] };
    const resolver = new ShaderResolver(fakeContext(files, nodes, [...nodes.values()].flat(), process.cwd()));
    expect(resolver.resolve(ref)).toBeNull();
    expect(resolver.getConditionalCallTargets(ref).map((target) => target.id)).toEqual(['enabled', 'disabled']);
  });

  it('does not union overloads from independent shader conditionals', () => {
    const files = new Map<string, string>([
      ['shaders/main.comp', '#include "common.glsl"\nvoid main(){ choose(value); }'],
      ['shaders/common.glsl', '#if FEATURE_A\nvoid choose(uint value){}\n#endif\n#if FEATURE_B\nvoid choose(float value){}\n#endif\n'],
    ]);
    const nodes = new Map<string, Node[]>([
      ['shaders/main.comp', [node({ id: 'main-file', kind: 'file', name: 'main.comp', filePath: 'shaders/main.comp', language: 'glsl' }), node({ id: 'main', kind: 'function', name: 'main', filePath: 'shaders/main.comp', language: 'glsl', startLine: 2 })]],
      ['shaders/common.glsl', [
        node({ id: 'common-file', kind: 'file', name: 'common.glsl', filePath: 'shaders/common.glsl', language: 'glsl' }),
        node({ id: 'a', kind: 'function', name: 'choose', filePath: 'shaders/common.glsl', language: 'glsl', startLine: 2, signature: 'void choose(uint value)', decorators: ['pp:FEATURE_A'] }),
        node({ id: 'b', kind: 'function', name: 'choose', filePath: 'shaders/common.glsl', language: 'glsl', startLine: 5, signature: 'void choose(float value)', decorators: ['pp:FEATURE_B'] }),
      ]],
    ]);
    const ref: UnresolvedRef = { fromNodeId: 'main', referenceName: 'choose', referenceKind: 'calls', line: 2, column: 13, filePath: 'shaders/main.comp', language: 'glsl', candidates: ['arity:1'] };
    expect(new ShaderResolver(fakeContext(files, nodes, [...nodes.values()].flat(), process.cwd())).getConditionalCallTargets(ref)).toEqual([]);
  });

  it('returns every equivalent application-bridge target for a shared HLSL call site', () => {
    const files = new Map<string, string>([
      ['Samples/A/main.hlsl', '#include "../../Shared/Algorithm.hlsli"\n#include "Bridge/RAB_Surface.hlsli"'],
      ['Samples/B/main.hlsl', '#include "../../Shared/Algorithm.hlsli"\n#include "Bridge/RAB_Surface.hlsli"'],
      ['Shared/Algorithm.hlsli', 'void run(){ RAB_GetGBufferSurface(0, false); }'],
      ['Samples/A/Bridge/RAB_Surface.hlsli', 'Surface RAB_GetGBufferSurface(int2 p, bool prev){return 0;}'],
      ['Samples/B/Bridge/RAB_Surface.hlsli', 'Surface RAB_GetGBufferSurface(int2 p, bool prev){return 0;}'],
    ]);
    const nodes = new Map<string, Node[]>([
      ['Samples/A/main.hlsl', [node({ id: 'a-root', kind: 'file', name: 'main.hlsl', filePath: 'Samples/A/main.hlsl', language: 'hlsl' })]],
      ['Samples/B/main.hlsl', [node({ id: 'b-root', kind: 'file', name: 'main.hlsl', filePath: 'Samples/B/main.hlsl', language: 'hlsl' })]],
      ['Shared/Algorithm.hlsli', [node({ id: 'shared-file', kind: 'file', name: 'Algorithm.hlsli', filePath: 'Shared/Algorithm.hlsli', language: 'hlsl' }), node({ id: 'run', kind: 'function', name: 'run', filePath: 'Shared/Algorithm.hlsli', language: 'hlsl' })]],
      ['Samples/A/Bridge/RAB_Surface.hlsli', [node({ id: 'a-file', kind: 'file', name: 'RAB_Surface.hlsli', filePath: 'Samples/A/Bridge/RAB_Surface.hlsli', language: 'hlsl' }), node({ id: 'a-surface', kind: 'function', name: 'RAB_GetGBufferSurface', filePath: 'Samples/A/Bridge/RAB_Surface.hlsli', language: 'hlsl', signature: 'Surface (int2 p, bool prev)' })]],
      ['Samples/B/Bridge/RAB_Surface.hlsli', [node({ id: 'b-file', kind: 'file', name: 'RAB_Surface.hlsli', filePath: 'Samples/B/Bridge/RAB_Surface.hlsli', language: 'hlsl' }), node({ id: 'b-surface', kind: 'function', name: 'RAB_GetGBufferSurface', filePath: 'Samples/B/Bridge/RAB_Surface.hlsli', language: 'hlsl', signature: 'Surface (int2, bool previousFrame)' })]],
    ]);
    const ref: UnresolvedRef = { fromNodeId: 'run', referenceName: 'RAB_GetGBufferSurface', referenceKind: 'calls', line: 1, column: 12, filePath: 'Shared/Algorithm.hlsli', language: 'hlsl' };
    const resolver = new ShaderResolver(fakeContext(files, nodes, [...nodes.values()].flat(), process.cwd()));
    expect(resolver.resolve(ref)).toBeNull();
    expect(resolver.getContextualCallTargets(ref).map((target) => target.id)).toEqual(['a-surface', 'b-surface']);
    expect(resolver.getContextualCallTargetContexts(ref).map((target) => [target.node.id, target.contextRoots])).toEqual([
      ['a-surface', ['Samples/A/main.hlsl']],
      ['b-surface', ['Samples/B/main.hlsl']],
    ]);
  });

  it('keeps shader impact inside the selected translation-unit context', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-shader-context-impact-'));

        tempDirs.push(dir);
    for (const target of ['A', 'B']) {
      fs.mkdirSync(path.join(dir, 'Targets', target, 'Bridge'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'Targets', target, 'main.hlsl'), '#include "../../Shared/algorithm.hlsli"\n#include "Bridge/bridge.hlsli"\nvoid main(){ sharedAlgorithm(); }\n');
      fs.writeFileSync(path.join(dir, 'Targets', target, 'Bridge', 'bridge.hlsli'), 'float BridgeSurface(int2 p){ return 1.0; }\n');
    }
    fs.mkdirSync(path.join(dir, 'Shared'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'Shared', 'algorithm.hlsli'), 'void sharedLeaf(){}\nvoid sharedAlgorithm(){ sharedLeaf(); BridgeSurface(int2(0, 0)); }\n');
    const cg = CodeGraph.initSync(dir);
    try {
      await cg.indexAll();
      const bridge = cg.getNodesInFile('Targets/A/Bridge/bridge.hlsli').find((candidate) => candidate.name === 'BridgeSurface');
      expect(bridge).toBeDefined();
      const impact = cg.getImpactRadius(bridge!.id, 6);
      const files = new Set([...impact.nodes.values()].map((candidate) => candidate.filePath));
      expect(files).toContain('Targets/A/main.hlsl');
      expect(files).not.toContain('Targets/B/main.hlsl');
      expect([...impact.nodes.values()].some((candidate) => candidate.filePath === 'Targets/A/main.hlsl' && candidate.kind === 'import' && candidate.startLine === 2)).toBe(true);

      const leaf = cg.getNodesInFile('Shared/algorithm.hlsli').find((candidate) => candidate.name === 'sharedLeaf');
      expect(leaf).toBeDefined();
      const sharedImpact = cg.getImpactRadius(leaf!.id, 2);
      expect([...sharedImpact.nodes.values()].some((candidate) => candidate.filePath === 'Targets/A/main.hlsl' && candidate.kind === 'import' && candidate.startLine === 1)).toBe(true);
      expect([...sharedImpact.nodes.values()].some((candidate) => candidate.filePath === 'Targets/B/main.hlsl' && candidate.kind === 'import' && candidate.startLine === 1)).toBe(true);
      expect([...sharedImpact.nodes.values()].filter((candidate) => candidate.filePath.endsWith('/main.hlsl') && candidate.name === 'main')).toHaveLength(2);
      expect(sharedImpact.edges.filter((edge) => edge.metadata?.synthesizedBy === 'shader-context-entry').map((edge) => edge.line)).toEqual([3, 3]);
    } finally {
      cg.destroy();
    }
  });

  it('persists include-scoped HLSL overload edges selected by call arity', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-hlsl-overload-'));
    tempDirs.push(dir);
    const shaders = path.join(dir, 'shaders');
    fs.mkdirSync(shaders);
    fs.writeFileSync(path.join(shaders, 'main.hlsl'), '#include "library.hlsli"\nfloat run(){return load(1.0, 2.0);}\n');
    fs.writeFileSync(path.join(shaders, 'library.hlsli'), 'float load(float a){return a;}\nfloat load(float a,float b){return a+b;}\n');
    const cg = CodeGraph.initSync(dir);
    try {
      await cg.indexAll();
      const twoArg = cg.getNodesInFile('shaders/library.hlsli').find((candidate) => candidate.name === 'load' && candidate.startLine === 2);
      expect(twoArg).toBeDefined();
      expect(cg.getCallers(twoArg!.id).map((caller) => caller.node.name)).toContain('run');
    } finally {
      cg.close();
    }
  });

  it('persists include-scoped GLSL overload edges selected by call arity', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-glsl-overload-'));
    tempDirs.push(dir);
    const shaders = path.join(dir, 'shaders');
    fs.mkdirSync(shaders);
    fs.writeFileSync(path.join(shaders, 'main.comp'), '#include "library.glsl"\nvoid main(){uint index; Item item; resolve(item, index, 1u, 2u);}\n');
    fs.writeFileSync(path.join(shaders, 'library.glsl'), 'bool resolve(Item item,out uint index){return true;}\nbool resolve(Item item,out uint index,uint version,uint environment){return true;}\n');
    const cg = CodeGraph.initSync(dir);
    try {
      await cg.indexAll();
      const fourArg = cg.getNodesInFile('shaders/library.glsl').find((candidate) => candidate.name === 'resolve' && candidate.startLine === 2);
      expect(fourArg?.signature).toBe('bool resolve(Item item,out uint index,uint version,uint environment)');
      expect(cg.getCallers(fourArg!.id).map((caller) => caller.node.name)).toContain('main');
    } finally {
      cg.close();
    }
  });

  it('persists calls to every mutually exclusive function/macro shader variant', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-glsl-conditional-call-'));
    tempDirs.push(dir);
    const shaders = path.join(dir, 'shaders');
    fs.mkdirSync(shaders);
    fs.writeFileSync(path.join(shaders, 'main.comp'), '#include "common.glsl"\nvoid main(){\n  recordCounter(1u);\n  recordCounter(2u);\n}\n');
    fs.writeFileSync(path.join(shaders, 'common.glsl'), '#if DIAGNOSTICS\nvoid recordCounter(uint index){}\n#else\n#define recordCounter(index)\n#endif\n');
    const cg = CodeGraph.initSync(dir);
    try {
      await cg.indexAll();
      const main = cg.getNodesInFile('shaders/main.comp').find((candidate) => candidate.name === 'main');
      const variants = cg.getNodesInFile('shaders/common.glsl').filter((candidate) => candidate.name === 'recordCounter');
      expect(variants).toHaveLength(2);
      for (const variant of variants) {
        expect(cg.getCallers(variant.id).map((caller) => caller.node.name)).toContain('main');
      }
      const variantIds = new Set(variants.map((variant) => variant.id));
      expect(cg.getOutgoingEdges(main!.id).filter((edge) => edge.kind === 'calls' && variantIds.has(edge.target))).toHaveLength(4);
    } finally {
      cg.close();
    }
  });

  it('re-resolves shader include closures after incremental sync', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-shader-sync-'));
    tempDirs.push(dir);
    const shaders = path.join(dir, 'shaders');
    fs.mkdirSync(shaders);
    fs.writeFileSync(path.join(shaders, 'main.comp'), '#include "common.glsl"\nvoid main() { helper(); }\n');
    fs.writeFileSync(path.join(shaders, 'common.glsl'), 'float oldLeaf(){return 1.0;}\nfloat newLeaf(){return 2.0;}\nfloat helper(){return oldLeaf();}\n');
    const cg = CodeGraph.initSync(dir);
    try {
      await cg.indexAll();
      let main = cg.getNodesInFile('shaders/main.comp').find((candidate) => candidate.name === 'main');
      let helper = cg.getNodesInFile('shaders/common.glsl').find((candidate) => candidate.name === 'helper');
      expect(cg.getCallees(main!.id).map((callee) => callee.node.name)).toContain('helper');
      expect(cg.getCallees(helper!.id).map((callee) => callee.node.name)).toContain('oldLeaf');

      fs.writeFileSync(path.join(shaders, 'common.glsl'), 'float oldLeaf(){return 1.0;}\nfloat newLeaf(){return 2.0;}\nfloat helper(){return newLeaf();}\n');
      const synced = await cg.sync();
      expect(synced.filesModified).toBe(1);
      main = cg.getNodesInFile('shaders/main.comp').find((candidate) => candidate.name === 'main');
      helper = cg.getNodesInFile('shaders/common.glsl').find((candidate) => candidate.name === 'helper');
      expect(cg.getCallees(main!.id).map((callee) => callee.node.name)).toContain('helper');
      expect(cg.getCallees(helper!.id).map((callee) => callee.node.name)).toContain('newLeaf');
      expect(cg.getCallees(helper!.id).map((callee) => callee.node.name)).not.toContain('oldLeaf');
    } finally {
      cg.close();
    }
  });
});

describe('C++ shader integration synthesis', () => {
  it('links shader filenames, entry points, bindings, specialization IDs, and push constants', async () => {
    const cpp = `void buildPipeline() {
  loadShader("compiled/path.rgen.variant.spv");
  VkDescriptorSetLayoutBinding binding = { 4, VK_DESCRIPTOR_TYPE_ACCELERATION_STRUCTURE_KHR };
  VkSpecializationMapEntry spec{ 3, 0, 4 };
  VkVertexInputAttributeDescription attribute{ 2, 0, VK_FORMAT_R32G32B32_SFLOAT, 0 };
  vkCmdPushConstants(cmd, layout, stages, 0, sizeof(Push), &push);
}`;
    const files = new Map<string, string>([
      ['src/pipeline.cpp', cpp],
      ['shaders/path.rgen', 'void main() {}'],
    ]);
    const cppFn = node({ id: 'cpp-fn', kind: 'function', name: 'buildPipeline', qualifiedName: 'buildPipeline', filePath: 'src/pipeline.cpp', language: 'cpp', startLine: 1, endLine: 7 });
    const shaderFile = node({ id: 'shader-file', kind: 'file', name: 'path.rgen', filePath: 'shaders/path.rgen', language: 'glsl' });
    const entry = node({ id: 'entry', kind: 'function', name: 'main', filePath: 'shaders/path.rgen', language: 'glsl', decorators: ['entrypoint', 'shader:ray-generation'] });
    const resource = node({ id: 'resource', kind: 'variable', name: 'scene', filePath: 'shaders/path.rgen', language: 'glsl', decorators: ['binding:4', 'resource:acceleration-structure'] });
    const spec = node({ id: 'spec', kind: 'constant', name: 'MODE', filePath: 'shaders/path.rgen', language: 'glsl', decorators: ['constant_id:3'] });
    const vertex = node({ id: 'vertex', kind: 'variable', name: 'position', filePath: 'shaders/path.rgen', language: 'glsl', decorators: ['location:2', 'interface:in'] });
    const push = node({ id: 'push', kind: 'struct', name: 'Push', filePath: 'shaders/path.rgen', language: 'glsl', decorators: ['push_constant'] });
    const byFile = new Map<string, Node[]>([['src/pipeline.cpp', [node({ id: 'cpp-file', kind: 'file', name: 'pipeline.cpp', filePath: 'src/pipeline.cpp', language: 'cpp' }), cppFn]], ['shaders/path.rgen', [shaderFile, entry, resource, spec, vertex, push]]]);
    const context = fakeContext(files, byFile, [...byFile.values()].flat(), process.cwd());
    const queries = { getOutgoingEdges: () => [], getNodeById: () => null } as any;
    const edges = await shaderIntegrationEdges(queries, context, async () => {});
    expect(edges.some((edge) => edge.kind === 'calls' && edge.target === 'entry')).toBe(true);
    expect(edges.some((edge) => edge.target === 'shader-file' && edge.metadata?.synthesizedBy === 'shader-file')).toBe(true);
    expect(edges.some((edge) => edge.target === 'resource')).toBe(true);
    expect(edges.some((edge) => edge.target === 'spec')).toBe(true);
    expect(edges.some((edge) => edge.target === 'vertex')).toBe(true);
    expect(edges.some((edge) => edge.target === 'push')).toBe(true);
  });

  it('keeps passive shader filenames as file references without calling the entry point', async () => {
    const cpp = `bool resolveProjectRoot() {
  return std::filesystem::exists("shaders/pathtrace.rgen");
}
Contract buildPipelineContract() {
  const char* dependency = "shaders/pathtrace.rgen";
  return rendererContractArray({"shaders/pathtrace.rgen"});
}
void buildPipeline() {
  compileShaderVariant(shaderDirectory / "shaders/pathtrace.rgen", ".variant", defines);
}`;
    const files = new Map<string, string>([
      ['src/pipeline.cpp', cpp],
      ['shaders/pathtrace.rgen', 'void main() {}'],
    ]);
    const passive = node({ id: 'passive', kind: 'function', name: 'resolveProjectRoot', filePath: 'src/pipeline.cpp', language: 'cpp', startLine: 1, endLine: 3 });
    const contract = node({ id: 'contract', kind: 'function', name: 'buildPipelineContract', filePath: 'src/pipeline.cpp', language: 'cpp', startLine: 4, endLine: 7 });
    const loader = node({ id: 'loader', kind: 'function', name: 'buildPipeline', filePath: 'src/pipeline.cpp', language: 'cpp', startLine: 8, endLine: 10 });
    const shaderFile = node({ id: 'shader-file', kind: 'file', name: 'pathtrace.rgen', filePath: 'shaders/pathtrace.rgen', language: 'glsl' });
    const entry = node({ id: 'entry', kind: 'function', name: 'main', filePath: 'shaders/pathtrace.rgen', language: 'glsl', decorators: ['entrypoint'] });
    const byFile = new Map<string, Node[]>([
      ['src/pipeline.cpp', [node({ id: 'cpp-file', kind: 'file', name: 'pipeline.cpp', filePath: 'src/pipeline.cpp', language: 'cpp' }), passive, contract, loader]],
      ['shaders/pathtrace.rgen', [shaderFile, entry]],
    ]);
    const edges = await shaderIntegrationEdges(
      { getOutgoingEdges: () => [], getNodeById: () => null } as any,
      fakeContext(files, byFile, [...byFile.values()].flat(), process.cwd()),
      async () => {},
    );

    expect(edges.filter((edge) => edge.target === 'shader-file').map((edge) => edge.source).sort())
      .toEqual(['contract', 'loader', 'passive']);
    expect(edges.filter((edge) => edge.target === 'entry').map((edge) => edge.source)).toEqual(['loader']);
    expect(edges.find((edge) => edge.source === 'loader' && edge.target === 'entry')?.line).toBe(9);
  });

  it('emits no interface edge when a C++ symbol is associated with multiple shaders', async () => {
    const cpp = `void buildPipelines() {
  loadShader("shaders/a.comp");
  loadShader("shaders/b.comp");
  VkDescriptorSetLayoutBinding binding = { 0, VK_DESCRIPTOR_TYPE_STORAGE_BUFFER };
}`;
    const files = new Map<string, string>([
      ['src/pipeline.cpp', cpp],
      ['shaders/a.comp', 'void main() {}'],
      ['shaders/b.comp', 'void main() {}'],
    ]);
    const cppFn = node({ id: 'cpp-fn', kind: 'function', name: 'buildPipelines', filePath: 'src/pipeline.cpp', language: 'cpp', startLine: 1, endLine: 5 });
    const shaderNodes = (name: string) => [
      node({ id: `${name}-file`, kind: 'file', name: `${name}.comp`, filePath: `shaders/${name}.comp`, language: 'glsl' }),
      node({ id: `${name}-entry`, kind: 'function', name: 'main', filePath: `shaders/${name}.comp`, language: 'glsl', decorators: ['entrypoint'] }),
      node({ id: `${name}-resource`, kind: 'struct', name: `${name}Buffer`, filePath: `shaders/${name}.comp`, language: 'glsl', decorators: ['binding:0', 'storage:buffer'] }),
    ];
    const byFile = new Map<string, Node[]>([
      ['src/pipeline.cpp', [node({ id: 'cpp-file', kind: 'file', name: 'pipeline.cpp', filePath: 'src/pipeline.cpp', language: 'cpp' }), cppFn]],
      ['shaders/a.comp', shaderNodes('a')],
      ['shaders/b.comp', shaderNodes('b')],
    ]);
    const context = fakeContext(files, byFile, [...byFile.values()].flat(), process.cwd());
    const edges = await shaderIntegrationEdges({ getOutgoingEdges: () => [], getNodeById: () => null } as any, context, async () => {});
    expect(edges.filter((edge) => edge.metadata?.synthesizedBy === 'shader-interface')).toEqual([]);
  });
});

function fakeContext(
  files: Map<string, string>,
  byFile: Map<string, Node[]>,
  allNodes: Node[],
  root: string,
): ResolutionContext {
  const byName = (name: string) => allNodes.filter((candidate) => candidate.name === name);
  return {
    getNodesInFile: (file) => byFile.get(file) ?? [],
    getNodesByName: byName,
    getNodesByQualifiedName: (name) => allNodes.filter((candidate) => candidate.qualifiedName === name),
    getNodesByKind: (kind) => allNodes.filter((candidate) => candidate.kind === kind),
    iterateNodesByKind: function* (kind) { yield* allNodes.filter((candidate) => candidate.kind === kind); },
    fileExists: (file) => files.has(file),
    readFile: (file) => files.get(file) ?? null,
    getFileLines: (file) => files.get(file)?.split(/\r?\n/) ?? null,
    getProjectRoot: () => root,
    getAllFiles: () => [...files.keys()],
    getNodesByLowerName: (name) => allNodes.filter((candidate) => candidate.name.toLowerCase() === name),
    getImportMappings: () => [],
  };
}
