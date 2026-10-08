/** Only points with demonstrated improvements in persisted edges or the real prompt hook. */
export const AUTO_POLICY: Readonly<Record<string, { cfModel: 'clef' | 'clef-flash' | null; floor: number }>> = {
  A1: { cfModel: 'clef-flash', floor: .6 },
  A2: { cfModel: null, floor: .6 }, // JEV-only, even with free Cloudflare allowance.
  A6: { cfModel: 'clef-flash', floor: .7 },
  D1: { cfModel: 'clef', floor: .8 },
};

// Cloudflare bills these two models on input only. Reserve the full advertised
// context before sending, then settle reported usage; unknown failures keep it.
export const CF_INPUT_LIMIT = 65_536;
export const CF_NEURONS_PER_M = { clef: 21_818, 'clef-flash': 8_182 };
export const CF_DAILY_FREE_NEURONS = 10_000;
