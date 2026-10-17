/**
 * `extractSearchTerms` must surface terms from ideographic-script queries.
 *
 * Regression for: the ASCII-only `[^a-zA-Z0-9]` word split erased every
 * character of a Chinese/Japanese/Korean query, so it returned `[]` and
 * `explore` reported "No relevant code found" for symbols named in those
 * scripts — even though the FTS index (default unicode61 tokenizer) stores
 * them and `query`/`node` find them. The ASCII path is intentionally left
 * unchanged; these cases are recovered additively.
 */

import { describe, it, expect } from 'vitest';
import { extractSearchTerms } from '../src/search/query-utils';

describe('extractSearchTerms — ideographic (CJK) queries', () => {
  it('surfaces a whole Chinese symbol name (was [] → explore found nothing)', () => {
    expect(extractSearchTerms('寻路服务')).toContain('寻路服务');
  });

  it('keeps a two-character Chinese word (below the ASCII ≥3 floor)', () => {
    expect(extractSearchTerms('寻路')).toContain('寻路');
  });

  it('splits whitespace-separated Chinese terms into separate terms', () => {
    const terms = extractSearchTerms('寻路服务 自动寻路模块');
    expect(terms).toContain('寻路服务');
    expect(terms).toContain('自动寻路模块');
  });

  it('pulls the ideographic run out of a mixed Latin+Han identifier', () => {
    const terms = extractSearchTerms('NavMeshAgent类型');
    expect(terms).toContain('navmeshagent'); // ASCII compound — unchanged
    expect(terms).toContain('类型');          // Han run — previously dropped
  });

  it('supports Japanese (Kanji) and Korean (Hangul) runs', () => {
    expect(extractSearchTerms('経路探索')).toContain('経路探索');
    expect(extractSearchTerms('길찾기')).toContain('길찾기');
  });
});

describe('extractSearchTerms — ASCII behaviour is unchanged', () => {
  it('splits camelCase into its parts', () => {
    const terms = extractSearchTerms('getUserName');
    expect(terms).toContain('user');
    expect(terms).toContain('name');
  });

  it('still drops stop words and sub-3-char tokens', () => {
    const terms = extractSearchTerms('the id of a UserService');
    expect(terms).not.toContain('the');
    expect(terms).not.toContain('of');
    expect(terms).not.toContain('id');
    expect(terms).toContain('service');
  });
});
