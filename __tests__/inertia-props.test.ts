/**
 * Inertia prop-boundary name math.
 *
 * The contract between an Inertia server and its page component is the prop map
 * itself, written twice — and when the server camelizes, the two halves do not
 * share a spelling, so a grep for either name finds exactly one side.
 *
 * The transform below is pinned case-by-case against the behaviour of the real
 * `Phoenix.Naming.camelize/2` rather than derived from the rule, because every
 * divergence produces a plausible-LOOKING client name: a mismatch reads as
 * "this field is never drawn" instead of "the transform is wrong". A test is
 * the only thing that makes those cases visible.
 */

import { describe, it, expect } from 'vitest';
import {
  phoenixCamelizeLower,
  phoenixCamelizeUpper,
  clientPropName,
  stripPreserveCase,
  isPropConsumer,
} from '../src/resolution/inertia-props';

describe('phoenixCamelizeLower — measured against the real camelize/2', () => {
  // Each row is an observed input/output pair. The third column records what a
  // naive snake→camel would have produced, which is what makes the divergent
  // rows worth pinning.
  const cases: Array<[input: string, expected: string, note: string]> = [
    ['user_display_name', 'userDisplayName', 'agrees with the naive rule'],
    ['_internal', 'internal', 'leading underscore is STRIPPED'],
    ['a__b', 'aB', 'consecutive underscores COLLAPSE'],
    ['foo_', 'foo', 'trailing underscore is DROPPED'],
    ['HTTP_status', 'hTTPStatus', 'only the FIRST character is lowercased'],
    ['a_B', 'a_B', 'underscore before an UPPERCASE letter stays LITERAL'],
    ['item_90x', 'item90x', 'underscore before a DIGIT is dropped'],
    ['year_2024', 'year2024', 'digits again'],
    ['a_coverage90', 'aCoverage90', 'digit inside a word is untouched'],
    ['already_camelCase', 'alreadyCamelCase', 'an existing camel hump survives'],
  ];

  for (const [input, expected, note] of cases) {
    it(`${JSON.stringify(input)} → ${JSON.stringify(expected)} — ${note}`, () => {
      expect(phoenixCamelizeLower(input)).toBe(expected);
    });
  }

  it('is not the naive rule, on exactly the rows where that matters', () => {
    const naive = (s: string) => s.replace(/_(\w)/g, (_, c: string) => c.toUpperCase());
    // These four are where a regex-based implementation would silently disagree.
    for (const input of ['_internal', 'a__b', 'foo_', 'HTTP_status']) {
      expect(phoenixCamelizeLower(input)).not.toBe(naive(input));
    }
    // And this one, where the naive rule over-eagerly joins across a capital.
    expect(naive('a_B')).toBe('aB');
    expect(phoenixCamelizeLower('a_B')).toBe('a_B');
  });

  it('handles the degenerate inputs without throwing', () => {
    expect(phoenixCamelizeLower('')).toBe('');
    expect(phoenixCamelizeLower('_')).toBe('');
    expect(phoenixCamelizeLower('___')).toBe('');
    expect(phoenixCamelizeLower('a')).toBe('a');
  });
});

describe('phoenixCamelizeUpper — the module-name form', () => {
  it('upper-cases the first character and otherwise agrees', () => {
    expect(phoenixCamelizeUpper('user_display_name')).toBe('UserDisplayName');
    expect(phoenixCamelizeUpper('_internal')).toBe('Internal');
  });

  it('turns a slash into a dotted module path', () => {
    expect(phoenixCamelizeUpper('my_app/some_module')).toBe('MyApp.SomeModule');
  });
});

describe('clientPropName — the configured transform', () => {
  it('camelizes when the adapter is configured to', () => {
    expect(clientPropName('user_display_name', 'camelize')).toBe('userDisplayName');
  });

  it('leaves the key alone when it is not', () => {
    // Laravel and Rails adapters emit keys verbatim by default.
    expect(clientPropName('user_display_name', 'preserve')).toBe('user_display_name');
  });
});

describe('preserve_case — the per-key opt-out', () => {
  it('unwraps a preserved key and flags it', () => {
    expect(stripPreserveCase('preserve_case(:some_key)')).toEqual({ key: 'some_key', preserved: true });
    expect(stripPreserveCase('preserve_case("some_key")')).toEqual({ key: 'some_key', preserved: true });
  });

  it('leaves an ordinary key untouched', () => {
    expect(stripPreserveCase('some_key')).toEqual({ key: 'some_key', preserved: false });
  });

  it('means the key must NOT be transformed', () => {
    const { key, preserved } = stripPreserveCase('preserve_case(:HTTP_status)');
    expect(preserved).toBe(true);
    // Transforming it anyway would produce `hTTPStatus` and mis-link the field,
    // with nothing going red — the same invisible failure as a wrong transform.
    expect(clientPropName(key, preserved ? 'preserve' : 'camelize')).toBe('HTTP_status');
  });
});

describe('isPropConsumer — "used" is a per-SYMBOL question, not per-file', () => {
  it('counts runtime symbols as consumers', () => {
    for (const kind of ['function', 'method', 'variable', 'constant', 'component']) {
      expect(isPropConsumer(kind)).toBe(true);
    }
  });

  it('does NOT count a type-level declaration as a consumer', () => {
    // A shared types module declares the payload AND exports runtime helpers
    // over it. If its declarations counted, every correctly typed field would
    // be "used" by its own declaration and nothing could ever be reported
    // orphaned — the failure that hides the finding completely.
    for (const kind of ['interface', 'type_alias', 'trait', 'protocol']) {
      expect(isPropConsumer(kind)).toBe(false);
    }
  });

  it('lets one file be both, which is the case that breaks path-based rules', () => {
    // The same module can hold 74 declarations and 37 runtime exports. Any
    // rule that has to classify the FILE gets it wrong in one direction; both
    // directions are silent.
    expect(isPropConsumer('interface')).toBe(false);
    expect(isPropConsumer('function')).toBe(true);
  });
});
