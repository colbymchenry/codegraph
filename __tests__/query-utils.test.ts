/**
 * Search query-utils tests
 *
 * Focused coverage for term extraction, especially the non-ASCII path that
 * keeps context working for Korean/CJK queries.
 */

import { describe, it, expect } from 'vitest';
import { extractSearchTerms } from '../src/search/query-utils';

describe('extractSearchTerms', () => {
  describe('ASCII behavior (must not regress)', () => {
    it('splits camelCase and keeps the compound', () => {
      const terms = extractSearchTerms('getUserName');
      expect(terms).toContain('getusername');
      expect(terms).toContain('user');
      expect(terms).toContain('name');
    });

    it('drops <3-char ASCII tokens and stop words', () => {
      const terms = extractSearchTerms('is a to ok payment');
      expect(terms).toContain('payment');
      expect(terms).not.toContain('is');
      expect(terms).not.toContain('ok'); // 2 chars
      expect(terms).not.toContain('to');
    });

    it('splits snake_case and dot.notation', () => {
      const terms = extractSearchTerms('user_service app.isPackaged');
      expect(terms).toContain('user_service');
      expect(terms).toContain('service');
      expect(terms).toContain('packaged');
    });
  });

  describe('non-ASCII (Korean) extraction', () => {
    it('extracts a single Korean token', () => {
      expect(extractSearchTerms('로그인')).toContain('로그인');
    });

    it('splits a multi-word Korean query on whitespace', () => {
      const terms = extractSearchTerms('사용자 로그인 처리');
      expect(terms).toContain('사용자');
      expect(terms).toContain('로그인');
      expect(terms).toContain('처리');
    });

    it('keeps 2-char Korean tokens (lower floor than ASCII)', () => {
      expect(extractSearchTerms('인증')).toContain('인증');
    });

    it('handles mixed ASCII + Korean queries', () => {
      const terms = extractSearchTerms('login 로그인 handler');
      expect(terms).toContain('login');
      expect(terms).toContain('로그인');
    });
  });
});
