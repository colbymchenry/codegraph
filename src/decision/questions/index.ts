import type { PointSpec } from '../types';
import { A1, A2, A3, A6 } from './resolution';
import { B1, B2, B3, B5 } from './synthesis';
import { C2, C3, C5 } from './explore';
import { F1 } from './viewer';
import { D1, G1 } from './input';

/** Model questions connected to an index override or a live feature. */
export const POINTS: Readonly<Record<string, PointSpec>> = Object.fromEntries(
  [A1, A2, A3, A6, B1, B2, B3, B5, C2, C3, C5, D1, F1, G1].map((s) => [s.id, s]),
);
