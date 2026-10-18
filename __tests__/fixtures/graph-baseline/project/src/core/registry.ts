/**
 * Shares the method name `load` with `Alpha` in another module, so a resolver that matched by bare
 * name would attach `beta.ts`'s `registry.load(...)` to the wrong class.
 */
export class Registry {
  load(id: string): string {
    return id;
  }
}
