/**
 * The two pieces of Symbol-view state that more than one pane has to agree on.
 *
 * `hot` is the hover link: the callee rail, the gutter port, the call site in
 * the body and the connector between them are four renderings of ONE edge, and
 * lighting all four from whichever the pointer happens to be over is what makes
 * the screen read as a single object rather than three lists side by side.
 *
 * `railFocus` is the keyboard's place in the rails (↑/↓ move, ←/→ switch,
 * Enter follows). It is separate from `hot` on purpose: the keyboard's position
 * must survive the mouse moving across the screen, and a hover must not steal
 * the place the reader is arrowing through.
 */

export type RailSide = 'left' | 'right';

let hotTarget = $state<string | null>(null);
let focusedRail = $state<RailSide>('right');
let focusedIndex = $state(-1);

export const hot = {
  get target(): string | null {
    return hotTarget;
  },
  /** True when `id` is the edge currently lit — the test every pane runs. */
  is(id: string | null | undefined): boolean {
    return id != null && hotTarget === id;
  },
  set(id: string | null): void {
    hotTarget = id;
  },
  /** Clear only if `id` is still the lit one — a stale mouseout must not win. */
  clear(id: string | null): void {
    if (id == null || hotTarget === id) hotTarget = null;
  },
};

export const railFocus = {
  get rail(): RailSide {
    return focusedRail;
  },
  get index(): number {
    return focusedIndex;
  },
  /** True when this row is the keyboard's current position. */
  at(rail: RailSide, index: number): boolean {
    return focusedRail === rail && focusedIndex === index;
  },
  move(rail: RailSide, index: number): void {
    focusedRail = rail;
    focusedIndex = index;
  },
  /** Step within the active rail, clamped to its length. */
  step(delta: number, length: number): void {
    if (length === 0) return;
    focusedIndex = Math.max(0, Math.min(length - 1, focusedIndex + delta));
  },
  /** Switch rails, landing on the first row rather than an unrelated index. */
  switchTo(rail: RailSide): void {
    focusedRail = rail;
    if (focusedIndex < 0) focusedIndex = 0;
  },
  reset(): void {
    focusedRail = 'right';
    focusedIndex = -1;
  },
};
