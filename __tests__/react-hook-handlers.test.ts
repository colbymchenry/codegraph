/**
 * React handler hooks name the function they wrap.
 *
 * `const handleSubmit = useCallback(() => {…}, [])` is how nearly every
 * handler in a React / React Native component is written, and the arrow is
 * anonymous only syntactically — the declarator is the name every
 * `onPress={handleSubmit}` and `addListener('x', handleSubmit)` uses. Without
 * a node the handler's calls attribute to the component and the trigger of a
 * flow (the tap, the native event) has nothing to resolve to.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { extractFromSource } from '../src/extraction';
import { initGrammars, loadAllGrammars } from '../src/extraction/grammars';

beforeAll(async () => {
  await initGrammars();
  await loadAllGrammars();
});

const refsFrom = (result: ReturnType<typeof extractFromSource>, id: string) =>
  result.unresolvedReferences.filter((r) => r.fromNodeId === id).map((r) => r.referenceName);

describe('useCallback handlers', () => {
  it('extracts the wrapped arrow as a function named by the declarator, inside the component', () => {
    const code = `
      import { useCallback, useMemo, useEffect } from 'react'
      import { finalize, upload, log } from './api'
      export default function ReviewScreen() {
        const handleApprove = useCallback(() => {
          finalize()
        }, [])
        const handleZip = useCallback(async (data: { uri: string }) => {
          await upload(data.uri)
        }, [])
        const total = useMemo(() => 1 + 1, [])
        useEffect(() => {
          log('mounted')
        }, [])
        return <Button onPress={handleApprove} />
      }
    `;
    const result = extractFromSource('src/app/review.tsx', code);
    const fns = result.nodes.filter((n) => n.kind === 'function');
    const names = fns.map((n) => n.name);
    expect(names).toEqual(expect.arrayContaining(['ReviewScreen', 'handleApprove', 'handleZip']));
    // A memo is a value and an effect is anonymous: neither becomes a function.
    expect(names).not.toContain('total');
    expect(names.filter((n) => n === '<anonymous>')).toEqual([]);

    const screen = fns.find((n) => n.name === 'ReviewScreen')!;
    const handleZip = fns.find((n) => n.name === 'handleZip')!;
    expect(handleZip.qualifiedName).toBe('ReviewScreen::handleZip');
    expect(handleZip.startLine).toBe(8);

    // The handler's calls are its own; the component keeps only what it does itself.
    expect(refsFrom(result, handleZip.id)).toContain('upload');
    expect(refsFrom(result, screen.id)).not.toContain('upload');
    expect(refsFrom(result, screen.id)).toContain('log');

    // Containment: the component contains its handlers.
    expect(
      result.edges.some((e) => e.kind === 'contains' && e.source === screen.id && e.target === handleZip.id)
    ).toBe(true);

    // `onPress={handleApprove}` is a function-as-value site: the tap's handler
    // is referenced from the component, which is how a Steps picture knows
    // the handler is a trigger.
    const handleApprove = fns.find((n) => n.name === 'handleApprove')!;
    expect(
      result.unresolvedReferences.some(
        (r) => r.fromNodeId === screen.id && r.referenceKind === 'function_ref' && r.referenceName === 'handleApprove'
      )
    ).toBe(true);
    expect(handleApprove.startLine).toBe(5);
  });

  it('accepts React.useCallback, function expressions, and useEffectEvent', () => {
    const code = `
      import React from 'react'
      export function Screen() {
        const onOpen = React.useCallback(function () { open() }, [])
        const onLog = useEffectEvent((url: string) => { track(url) })
        return null
      }
    `;
    const result = extractFromSource('src/screen.tsx', code);
    const names = result.nodes.filter((n) => n.kind === 'function').map((n) => n.name);
    expect(names).toEqual(expect.arrayContaining(['Screen', 'onOpen', 'onLog']));
  });

  it('leaves a hook whose first argument is not the bound function alone', () => {
    const code = `
      export function Screen() {
        const value = useState(() => compute())
        const cb = useCallback(existingHandler, [])
        const [x] = useReducer((s) => s, 0)
        return null
      }
    `;
    const result = extractFromSource('src/screen.tsx', code);
    const names = result.nodes.filter((n) => n.kind === 'function').map((n) => n.name);
    expect(names).toEqual(['Screen']);
  });

  it('a handler a hook returns in an object is a function-as-value of the hook', () => {
    const code = `
      import { useCallback } from 'react'
      export function useReviewHandlers() {
        const handleApprove = useCallback(() => { finalize() }, [])
        const handleRetake = useCallback(() => { retake() }, [])
        const count = 1
        return { handleApprove, handleRetake, count, extra: helper }
      }
      function helper() {}
    `;
    const result = extractFromSource('src/hooks.ts', code);
    const hook = result.nodes.find((n) => n.name === 'useReviewHandlers')!;
    const fnRefs = result.unresolvedReferences
      .filter((r) => r.fromNodeId === hook.id && r.referenceKind === 'function_ref')
      .map((r) => r.referenceName)
      .sort();
    // `count` is a value, not a function defined here: gated out.
    expect(fnRefs).toEqual(['handleApprove', 'handleRetake', 'helper']);
  });

  it('does nothing outside the JS family', () => {
    const code = `
      func screen() {
        let handle = useCallback({ () in finalize() }, [])
      }
    `;
    const result = extractFromSource('Screen.swift', code);
    const names = result.nodes.filter((n) => n.kind === 'function').map((n) => n.name);
    expect(names).toEqual(['screen']);
  });
});
