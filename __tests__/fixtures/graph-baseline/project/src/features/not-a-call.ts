import { Registry } from '../core/registry';

/**
 * Everything here LOOKS like a call to `Registry.load` and none of it is one.
 *
 * The point of the file is the negative assertion: an index that records any of these as a call
 * edge is wrong in a way a "did the edge count go up" test would never catch.
 */

/** A string that reads like a call site. */
export const MENTION = 'registry.load("id")';

/** A comment that reads like a call site: registry.load("id") */
export function fromComment(): string {
  return MENTION;
}

/** A local binding with the same name as the method — not the class member. */
export function shadowed(): number {
  const load = 1;
  return load;
}

/** A receiver whose type the index cannot know, so no edge may be invented for it. */
export function unknownReceiver(value: unknown): string {
  const callable = value as { load(identifier: string): string };
  return callable.load('id');
}

/** The declared type is used, but no member of `Registry` is called through it. */
export function heldOnly(registry: Registry): Registry {
  return registry;
}

/** A parameter reference is not a member call either. */
export function passedAlong(registry: Registry): unknown {
  return registry;
}
