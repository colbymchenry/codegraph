/**
 * Foundation's enum macros declare most enums in Objective-C code and in the
 * C and C++ headers that live beside it:
 *
 *   typedef NS_ENUM(NSInteger, SDImageCacheType) { SDImageCacheTypeNone, … };
 *   typedef NS_OPTIONS(NSUInteger, SDWebImageOptions) { … };
 *   typedef CF_ENUM(CFIndex, KSCrashMonitorType) { … };
 *
 * The parser reads the macro as a broken typedef, so the enum and its values
 * were never indexed (SDWebImage had no enum at all), and a junk type alias
 * named after the first value took its place. Objective-C, C and C++ now
 * rewrite the macro as `enum SDImageCacheType {` before parsing, at the same
 * offsets. Runs the C and C++ cases against the native kernel (when built)
 * and the wasm extractor, which must agree.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { extractFromSource } from '../src/extraction';
import { initGrammars, loadGrammarsForLanguages } from '../src/extraction/grammars';
import { tryKernelExtract, resetKernelForTests } from '../src/extraction/kernel';
import { rewriteFoundationEnumMacros } from '../src/extraction/languages/c-cpp';
import type { ExtractionResult, Language } from '../src/types';

const KERNEL_PATH = path.join(
  __dirname,
  '..',
  'codegraph-kernel',
  'prebuilds',
  `${process.platform}-${process.arch}`,
  'codegraph-kernel.node'
);
const kernelAvailable = fs.existsSync(KERNEL_PATH) || process.env.CODEGRAPH_KERNEL_EXPECT === '1';

const ENV_KEYS = ['CODEGRAPH_KERNEL', 'CODEGRAPH_KERNEL_LANGS'] as const;

/** `<kind> <qualifiedName>` for every symbol, file and imports aside. */
function symbols(result: ExtractionResult): string[] {
  return result.nodes
    .filter((n) => n.kind !== 'file' && n.kind !== 'import')
    .map((n) => `${n.kind} ${n.qualifiedName}`);
}

describe('Foundation enum macros', () => {
  let savedEnv: Record<string, string | undefined> = {};

  beforeAll(async () => {
    await initGrammars();
    await loadGrammarsForLanguages(['objc', 'c', 'cpp']);
  });

  beforeEach(() => {
    savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    resetKernelForTests();
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    resetKernelForTests();
  });

  function extract(backend: 'kernel' | 'wasm', file: string, source: string, language: Language): ExtractionResult {
    if (backend === 'wasm') {
      process.env.CODEGRAPH_KERNEL = '0';
      return extractFromSource(file, source, language);
    }
    delete process.env.CODEGRAPH_KERNEL;
    process.env.CODEGRAPH_KERNEL_LANGS = 'all';
    const result = tryKernelExtract(file, source, language);
    expect(result, `kernel extraction of ${file}`).not.toBeNull();
    return result!;
  }

  const backends = kernelAvailable ? (['kernel', 'wasm'] as const) : (['wasm'] as const);

  for (const crlf of [false, true]) {
    const eol = (s: string) => (crlf ? s.replace(/\n/g, '\r\n') : s);
    const label = crlf ? ' (CRLF)' : '';

    it(`declare enums and their values in Objective-C${label}`, () => {
      const source = [
        '#import <Foundation/Foundation.h>',
        '',
        '/// Where an image came from.',
        'typedef NS_ENUM(NSInteger, SDImageCacheType) {',
        '    SDImageCacheTypeNone,',
        '    SDImageCacheTypeDisk,',
        '};',
        '',
        'typedef NS_OPTIONS(NSUInteger, SDWebImageOptions) {',
        '    SDWebImageRetryFailed = 1 << 0,',
        '};',
        '',
        'typedef NS_ERROR_ENUM(SDWebImageErrorDomain, SDWebImageError) {',
        '    SDWebImageErrorInvalidURL = 1000,',
        '};',
        '',
        'typedef NS_ENUM(NSInteger, SDForwardDeclared);',
        '',
        '@interface SDImageCache : NSObject',
        '@end',
        '',
      ].join('\n');
      const result = extractFromSource('src/SDImageCacheDefine.h', eol(source), 'objc');
      expect(symbols(result)).toEqual([
        'enum SDImageCacheType',
        'enum_member SDImageCacheType::SDImageCacheTypeNone',
        'enum_member SDImageCacheType::SDImageCacheTypeDisk',
        'enum SDWebImageOptions',
        'enum_member SDWebImageOptions::SDWebImageRetryFailed',
        'enum SDWebImageError',
        'enum_member SDWebImageError::SDWebImageErrorInvalidURL',
        'class SDImageCache',
      ]);
      expect(result.nodes.find((n) => n.name === 'SDImageCacheType')?.docstring).toBe('Where an image came from.');
    });

    it.each(backends)(`declare enums in C and C++ headers: %s${label}`, (backend) => {
      const c = [
        '#include <CoreFoundation/CoreFoundation.h>',
        '',
        'typedef CF_ENUM(CFIndex, KSCrashMonitorType) {',
        '    KSCrashMonitorTypeNone = 0,',
        '    KSCrashMonitorTypeSignal = 1,',
        '} CF_SWIFT_NAME(CrashMonitorType);',
        '',
      ].join('\n');
      expect(symbols(extract(backend, 'src/KSCrashMonitorType.h', eol(c), 'c'))).toEqual([
        'enum KSCrashMonitorType',
        'enum_member KSCrashMonitorType::KSCrashMonitorTypeNone',
        'enum_member KSCrashMonitorType::KSCrashMonitorTypeSignal',
      ]);
      const cpp = [
        '#include <memory>',
        '',
        'namespace facebook { class Report {}; }',
        '',
        'typedef NS_ENUM(NSInteger, RCTSchedulerMode) {',
        '    RCTSchedulerModeSync,',
        '};',
        '',
      ].join('\n');
      expect(symbols(extract(backend, 'src/RCTScheduler.h', eol(cpp), 'cpp'))).toEqual([
        'class facebook::Report',
        'enum RCTSchedulerMode',
        'enum_member RCTSchedulerMode::RCTSchedulerModeSync',
      ]);
    });

    it(`are rewritten in place, and the macro's own #define is left alone${label}`, () => {
      const source = eol([
        '#define NS_ENUM(_type, _name) enum _name : _type _name; enum _name : _type',
        '// typedef NS_ENUM(NSInteger, InAComment) {',
        'typedef NS_ENUM(NSInteger, SDImageCacheType) {',
        '    SDImageCacheTypeNone,',
        '};',
        '',
      ].join('\n'));
      const rewritten = rewriteFoundationEnumMacros(source);
      expect(rewritten.length).toBe(source.length);
      expect(rewritten.split(/\r?\n/)).toEqual([
        '#define NS_ENUM(_type, _name) enum _name : _type _name; enum _name : _type',
        '// typedef NS_ENUM(NSInteger, InAComment) {',
        '        enum               SDImageCacheType  {',
        '    SDImageCacheTypeNone,',
        '};',
        '',
      ]);
    });
  }
});
