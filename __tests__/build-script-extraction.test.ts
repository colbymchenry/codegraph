import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { detectLanguage } from '../src/extraction/grammars';
import { extractFromSource } from '../src/extraction/tree-sitter';

describe('build-script extraction', () => {
  it('indexes CMake shader variants and function/variable declarations', () => {
    expect(detectLanguage('CMakeLists.txt')).toBe('cmake');
    const result = extractFromSource('CMakeLists.txt', `
function(add_pathtrace_variant name)
  set(SHADER "shaders/pathtrace.rgen")
endfunction()
add_pathtrace_variant(default)
`);
    expect(result.nodes.some((node) => node.kind === 'function' && node.name === 'add_pathtrace_variant')).toBe(true);
    expect(result.nodes.some((node) => node.kind === 'variable' && node.name === 'SHADER')).toBe(true);
    expect(result.unresolvedReferences.some((ref) => ref.referenceName === 'shaders/pathtrace.rgen')).toBe(true);
  });

  it('indexes PowerShell shader build helpers and shader paths', () => {
    expect(detectLanguage('tools/CompileShaders.ps1')).toBe('powershell');
    const result = extractFromSource('tools/CompileShaders.ps1', `
function Build-Shader {
  & "glslc.exe" "shaders/pathtrace.rgen" -o "pathtrace.rgen.spv"
}
$ShaderRoot = "shaders"
`);
    expect(result.nodes.some((node) => node.kind === 'function' && node.name === 'Build-Shader')).toBe(true);
    expect(result.nodes.some((node) => node.kind === 'variable' && node.name === 'ShaderRoot')).toBe(true);
    expect(result.unresolvedReferences.some((ref) => ref.referenceName === 'shaders/pathtrace.rgen')).toBe(true);
  });

  it('builds PowerShell call references, preserves declaration lines, and deduplicates assignments', () => {
    const result = extractFromSource('run_game_stability_diagnostics.ps1', `
\$ErrorActionPreference = 'Stop'
\$ErrorActionPreference = 'Stop'
function Resolve-SceneList {
  return @()
}
function Invoke-Validation {
  Resolve-SceneList
}
\$resolved = Resolve-SceneList
`);
    const resolve = result.nodes.find((node) => node.kind === 'function' && node.name === 'Resolve-SceneList');
    expect(resolve?.startLine).toBe(4);
    expect(result.nodes.filter((node) => node.kind === 'variable' && node.name === 'ErrorActionPreference')).toHaveLength(1);
    expect(result.unresolvedReferences.some((ref) =>
      ref.fromNodeId === result.nodes.find((node) => node.name === 'Invoke-Validation')?.id &&
      ref.referenceKind === 'calls' && ref.referenceName === 'Resolve-SceneList' && ref.line === 8
    )).toBe(true);
    expect(result.unresolvedReferences.some((ref) =>
      ref.fromNodeId === result.nodes.find((node) => node.kind === 'file')?.id &&
      ref.referenceName === 'Resolve-SceneList' && ref.line === 10
    )).toBe(true);
  });

  it('does not report exported functions as callers or executable launches as imports', () => {
    const result = extractFromSource('scripts/EditorToolingCommon.psm1', `
function Read-EditorJson { return @{} }
function Get-EntityCount { Read-EditorJson }
Export-ModuleMember -Function Read-EditorJson, Get-EntityCount
& "$BuildDir\\rtvulkan.exe"
`);
    const file = result.nodes.find((node) => node.kind === 'file')!;
    expect(result.unresolvedReferences.some((ref) =>
      ref.fromNodeId === file.id && ref.referenceKind === 'calls' &&
      (ref.referenceName === 'Read-EditorJson' || ref.referenceName === 'Get-EntityCount')
    )).toBe(false);
    expect(result.unresolvedReferences.some((ref) => ref.referenceKind === 'imports' && ref.referenceName.includes('rtvulkan.exe'))).toBe(false);
    expect(result.unresolvedReferences.some((ref) =>
      ref.fromNodeId === result.nodes.find((node) => node.name === 'Get-EntityCount')?.id &&
      ref.referenceKind === 'calls' && ref.referenceName === 'Read-EditorJson'
    )).toBe(true);
  });

  it('resolves Import-Module dependencies and calls to exported module functions', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-powershell-module-'));
    fs.mkdirSync(path.join(dir, 'scripts'));
    fs.writeFileSync(path.join(dir, 'scripts', 'EditorToolingCommon.psm1'), `function Read-EditorJson { param([string]\$Path) return @{} }
Export-ModuleMember -Function Read-EditorJson
`);
    fs.writeFileSync(path.join(dir, 'scripts', 'audit.ps1'), `Import-Module (Join-Path \$PSScriptRoot 'EditorToolingCommon.psm1') -Force
function Get-Block { return '\\{' }
\$manifest = Read-EditorJson -Path 'manifest.json'
`);
    const cg = CodeGraph.initSync(dir);
    try {
      await cg.indexAll();
      const moduleFile = cg.getNodesInFile('scripts/EditorToolingCommon.psm1').find((node) => node.kind === 'file')!;
      const readJson = cg.getNodesInFile('scripts/EditorToolingCommon.psm1').find((node) => node.name === 'Read-EditorJson')!;
      expect(cg.getIncomingEdges(moduleFile.id).some((edge) => edge.kind === 'imports')).toBe(true);
      expect(cg.getCallers(readJson.id).some((caller) => caller.node.kind === 'file' && caller.node.filePath === 'scripts/audit.ps1' && caller.edge.line === 3)).toBe(true);
    } finally {
      cg.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('resolves dot-sourced script dependencies and their shared functions', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-powershell-dot-source-'));
    fs.mkdirSync(path.join(dir, 'scripts'));
    fs.writeFileSync(path.join(dir, 'scripts', 'restir_reference_common.ps1'), `function Write-RestirJsonAndCsv { param([string]\$Path) }
function Invoke-PrivateRestirHelper { }
`);
    fs.writeFileSync(path.join(dir, 'scripts', 'restir_reference_quality_matrix.ps1'), `. (Join-Path \$PSScriptRoot "restir_reference_common.ps1")
Write-RestirJsonAndCsv -Path 'quality.json'
Invoke-PrivateRestirHelper
`);
    const cg = CodeGraph.initSync(dir);
    try {
      await cg.indexAll();
      const commonFile = cg.getNodesInFile('scripts/restir_reference_common.ps1').find((node) => node.kind === 'file')!;
      const writer = cg.getNodesInFile('scripts/restir_reference_common.ps1').find((node) => node.name === 'Write-RestirJsonAndCsv')!;
      const privateHelper = cg.getNodesInFile('scripts/restir_reference_common.ps1').find((node) => node.name === 'Invoke-PrivateRestirHelper')!;
      expect(cg.getIncomingEdges(commonFile.id).some((edge) => edge.kind === 'imports')).toBe(true);
      expect(cg.getCallers(writer.id).some((caller) => caller.node.filePath === 'scripts/restir_reference_quality_matrix.ps1' && caller.edge.line === 2)).toBe(true);
      expect(cg.getCallers(privateHelper.id).some((caller) => caller.node.filePath === 'scripts/restir_reference_quality_matrix.ps1' && caller.edge.line === 3)).toBe(true);
    } finally {
      cg.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
