/**
 * Table-driven gate for `flowTokens` — the token budget's admission rules.
 *
 * The PR #1337 rewrite switched flowTokens from whole-word validation (split
 * on `[\s,()[\]]+`, then one regex per word) to match-based discovery so it
 * could keep Haskell primes, Unicode identifiers, and qualified operators.
 * Discovery without the old edge discipline mined fragments out of ordinary
 * prose: `work.` yielded `work`, `don't` became a "precise" token, a bare `->`
 * canonicalized to `(->)`. These tables pin BOTH sides of the contract: the
 * prose noise stays out, and every Haskell capability the rewrite added stays
 * in. If a change to the tokenizer moves a row, it is a behavior change to
 * `codegraph_explore`'s seeding, not a local refactor.
 */
import { describe, expect, it } from 'vitest';
import { flowTokens } from '../src/graph/named-symbol-flow';

describe('flowTokens rejects prose fragments (the old whole-word contract)', () => {
  it.each([
    // Trailing-edge punctuation: the old tokenizer validated the whole
    // whitespace-delimited word, so `work.` / `renderScene.` failed the regex
    // and dropped entirely — never mined for the identifier inside.
    ['how does the app route work.', ['how', 'does', 'the', 'app', 'route']],
    ['renderScene.', []],
    // English contractions must not ride the Haskell-prime continuation —
    // including the sentence-capitalized and possessive spellings, which are
    // the common ones in agent prose (`Don't`, `It's`, `Parser's`).
    ["how does the app's router work don't break it", ['how', 'does', 'the', 'router', 'work', 'break']],
    ["we're seeing they've queued what you'll render", ['seeing', 'queued', 'what', 'render']],
    ["Don't break it mutateElement", ['break', 'mutateElement']],
    ["It's I'm the Parser's output renderScene", ['the', 'output', 'renderScene']],
    ["CAN'T WON'T renderScene", ['renderScene']],
    // Bare ASCII operators as prose punctuation — canonicalizing `->` into
    // `(->)` would waste the token budget and hijack Haskell-project queries.
    ['how does A -> B work', ['how', 'does', 'work']],
    ['check a >= b', ['check']],
    ['a => b', []],
    ['x <= y', []],
    ['p == q', []],
    ['a && b', []],
    ['a || b', []],
    ['mod :: sig', ['mod', 'sig']],
    ['what does $ do', ['what', 'does']],
    // The same prose shapes in Unicode: arrows, comparison glyphs, typographic
    // dashes, ellipsis, and markdown heads between two symbol names.
    ['mutateElement → renderScene', ['mutateElement', 'renderScene']],
    ['mutateElement ⇒ renderScene', ['mutateElement', 'renderScene']],
    ['mutateElement – renderScene', ['mutateElement', 'renderScene']],
    ['mutateElement — renderScene', ['mutateElement', 'renderScene']],
    ['mutateElement … renderScene', ['mutateElement', 'renderScene']],
    ['A ➜ B', []],
    ['check a ≥ b', ['check']],
    ['x ≤ y', []],
    ['### Installation steps', ['Installation', 'steps']],
    // A URL is not a symbol bag.
    ['fetch from https://example.com then parseResponse', ['fetch', 'from', 'then', 'parseResponse']],
    // Semicolon/colon glue: neither side is a named symbol.
    ['foo;bar key:value mutateElement', ['mutateElement']],
    // A digit immediately before an identifier means a fragment.
    ['1stToken renderScene', ['renderScene']],
    ['123abc', []],
    // A dot run that trails into whitespace, another dot, or a colon is a
    // dangling spelling, not a qualified name (`work.`, `foo..`, `e.g.:`).
    ['work.: fix renderScene', ['fix', 'renderScene']],
    ['foo.. bar', ['bar']],
    ['e.g.: fix renderScene', ['fix', 'renderScene']],
  ])('%s', (query, expected) => {
    expect(flowTokens(query)).toEqual(expected);
  });
});

describe('flowTokens keeps the capabilities the rewrite added', () => {
  it.each([
    // Plain cross-language symbol bags.
    ['mutateElement renderScene', ['mutateElement', 'renderScene']],
    ['GraphTraverser BFS impact traversal.ts', ['GraphTraverser', 'BFS', 'impact', 'traversal']],
    // Unicode identifiers below the ASCII length floor are deliberate.
    ['函数 λ finish', ['函数', 'λ', 'finish']],
    // Haskell primes — including a trailing prime, which is not a contraction.
    ["hover' xs' request", ["hover'", "xs'", 'request']],
    // Qualified operators, parenthesized operators, backtick spellings.
    ['M::(<+>) request', ['M::(<+>)', 'request']],
    ['(=<<) request finish', ['(=<<)', 'request', 'finish']],
    ['(<+>) request finish', ['(<+>)', 'request', 'finish']],
    ['<+> request finish', ['(<+>)', 'request', 'finish']],
    ['Ops.<+> request', ['Ops::(<+>)', 'request']],
    ['Data.Ops.. request', ['Data.Ops::(.)', 'request']],
    ['`⊕` request', ['(⊕)', 'request']],
    ['⊗ request', ['(⊗)', 'request']],
    // A dot whose continuation IS an operator body is a qualified-operator
    // spelling: the module half stays a token even when the module casing is
    // not Haskell-legal (the operator half belongs to the operator passes).
    ['notOps.<+> request', ['notOps', 'request']],
    ['fooData.Ops.<+> request', ['fooData.Ops', 'request']],
    // `::` inside a qualified identifier is consumed by the match, not glue.
    ['A.B::foo request', ['A.B::foo', 'request']],
    // Dollar identifiers, dollar-only operators.
    ['foo$bar render$ Module.foo$bar $foo$bar', ['foo$bar', 'render$', 'Module.foo$bar', '$foo$bar']],
    ['$$$ finish', ['$$$', 'finish']],
    ['$$ haskellFinish', ['$$', 'haskellFinish']],
  ])('%s', (query, expected) => {
    expect(flowTokens(query)).toEqual(expected);
  });
});

describe('flowTokens preserves whole backticked identifiers', () => {
  it.each([
    ['`mapMaybe` `request`', ['mapMaybe', 'request']],
    ["`hover'` `Module'.run'`", ["hover'", "Module'.run'"]],
    ["`item's` finish", ["item's", 'finish']],
    ['`$fetch` `Module.render$`', ['$fetch', 'Module.render$']],
    ['[`mapMaybe`],(`request`)', ['mapMaybe', 'request']],
  ])('%s', (query, expected) => {
    expect(flowTokens(query)).toEqual(expected);
  });

  it.each([
    ['`src/Foo.bar` finish', ['finish']],
    ['`user@example.com` finish', ['finish']],
    ['`foo;bar` finish', ['finish']],
    ['`foo-bar` finish', ['finish']],
    ['`1bad` finish', ['finish']],
    ["`Module.'name` finish", ['finish']],
    ['prefix`hover` finish', ['finish']],
    ['`hover`tail finish', ['finish']],
    ['"`hover`" finish', ['finish']],
  ])('does not mine a quoted fragment: %s', (query, expected) => {
    expect(flowTokens(query)).toEqual(expected);
  });
});
