import { Registry } from '../core/registry';
import { Alpha } from './alpha';

/** `registry.load` must resolve to `Registry.load`, not to the same-named `Alpha.load`. */
export function run(registry: Registry, alpha: Alpha): string {
  const loaded = registry.load('id');
  return `${alpha.greet(loaded)}:${loaded}`;
}

/** The callback is reachable only through the parameter, so the call has no static receiver. */
export function withCallback(cb: (value: string) => string): string {
  return cb('x');
}

/** Reaches `run` twice, so the call edge is not accidentally a one-off. */
export function twice(registry: Registry, alpha: Alpha): string {
  return run(registry, alpha) + run(registry, alpha);
}
