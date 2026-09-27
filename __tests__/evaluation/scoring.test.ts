import { expect, it } from 'vitest';
import { scoreSearchNodes } from './scoring.js';

it('scores the first matching result regardless of expected symbol order', () => {
  const results = [
    { node: { name: 'Beta' }, score: 1 },
    { node: { name: 'Alpha' }, score: 0.5 },
  ];

  expect(scoreSearchNodes('case', ['Alpha', 'Beta'], results, 0).mrr).toBe(1);
  expect(scoreSearchNodes('case', ['Beta', 'Alpha'], results, 0).mrr).toBe(1);
});
