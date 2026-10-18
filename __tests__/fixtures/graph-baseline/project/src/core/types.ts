/**
 * Fixture for the end-to-end graph baseline.
 *
 * Small on purpose, but shaped so every relationship the baseline has to get right is present:
 * an interface and an implementation of it, two same-named methods that must not be confused,
 * a cross-module re-export, a callback reached only through a parameter, and a file of things that
 * merely look like calls. Changing anything here invalidates the committed golden and it must be
 * regenerated — the line numbers are part of the snapshot.
 */

/** Implemented by `Alpha`, so `implements` has a target. */
export interface Greeter {
  greet(name: string): string;
}
