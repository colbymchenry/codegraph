import { Greeter } from '../core/types';

/** Implements the interface from another module, and reuses the name `load`. */
export class Alpha implements Greeter {
  greet(name: string): string {
    return `hello ${name}`;
  }

  load(id: string): string {
    return id;
  }
}

export function makeAlpha(): Alpha {
  return new Alpha();
}
