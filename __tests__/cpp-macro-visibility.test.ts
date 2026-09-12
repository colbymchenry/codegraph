import { it, expect } from 'vitest';
import { isVisibleCppMacro } from '../src/resolution/cpp-macro-visibility';
import type { ResolutionContext } from '../src/resolution/types';
function context(files: Record<string, string>): ResolutionContext {
  return {
    getNodesByName: () => [{ kind: 'constant', signature: '#define TRACE(x) (x)' }],
    readFile: (file: string) => files[file], fileExists: (file: string) => file in files,
    getAllFiles: () => Object.keys(files),
  } as unknown as ResolutionContext;
}
function visible(ctx: ResolutionContext, filePath: string, line: number): boolean {
  return isVisibleCppMacro({fromNodeId:'test',referenceName:'TRACE',referenceKind:'calls',language:'c',filePath,line,column:0},ctx);
}
it('keeps a possible macro when an unknown conditional include undefines it', () => {
  const ctx=context({'main.c':'#define TRACE(x) (x)\n#if UNKNOWN_FLAG\n#include "undef.h"\n#endif\nvoid run(){TRACE(1);}', 'undef.h':'#undef TRACE'});
  expect(visible(ctx,'main.c',5)).toBe(true);
});
it.each([['a.c','b.c'],['b.c','a.c']])('include cycle does not depend on query order: %s first', (first,second) => {
  const ctx=context({'a.h':'#ifndef A_H\n#define A_H\n#include "b.h"\n#define TRACE(x) (x)\n#endif','b.h':'#ifndef B_H\n#define B_H\n#include "a.h"\n#endif','a.c':'#include "a.h"\nvoid run(){TRACE(1);}','b.c':'#include "b.h"\nvoid run(){TRACE(1);}'});
  expect(visible(ctx,first,2)).toBe(true);
  expect(visible(ctx,second,2)).toBe(true);
});
it('passes a known parent flag into the included header', () => {
  const ctx=context({'main.c':'#define ENABLE_TRACE 0\n#include "trace.h"\nvoid run(){TRACE(1);}','trace.h':'#if ENABLE_TRACE\n#define TRACE(x) (x)\n#endif'});
  expect(visible(ctx,'main.c',3)).toBe(false);
});
it('does not let a later definition affect a preceding call', () => {
  const ctx=context({'main.c':'void first(){TRACE(1);}\n#define TRACE(x) (x)\nvoid last(){TRACE(1);}'});
  expect(visible(ctx,'main.c',1)).toBe(false);
  expect(visible(ctx,'main.c',3)).toBe(true);
});

it('keeps local header facts within a hypothetical include path', () => {
  const ctx=context({'main.c':'#ifdef OPTIONAL\n#include "maths.h"\n#endif\n#include "maths.h"\nvoid run(){TRACE(1);}',
    'maths.h':'#pragma once\n#define FAST_MATH\n#if defined(FAST_MATH)\nvoid TRACE(int);\n#else\n#define TRACE(x) (x)\n#endif'});
  expect(visible(ctx,'main.c',5)).toBe(false);
});

it('does not turn an unknown definition into absence after an unknown undef', () => {
  const ctx=context({'main.c':'#if ENABLE_TRACE\n#define TRACE(x) ((void)(x))\n#endif\n#if CLEAR_TRACE\n#undef TRACE\n#endif\nvoid run(){TRACE(1);}'});
  expect(visible(ctx,'main.c',7)).toBe(true);
});
it('a definite undef still removes a possible definition', () => {
  const ctx=context({'main.c':'#if ENABLE_TRACE\n#define TRACE(x) ((void)(x))\n#endif\n#undef TRACE\nvoid run(){TRACE(1);}'});
  expect(visible(ctx,'main.c',5)).toBe(false);
});
