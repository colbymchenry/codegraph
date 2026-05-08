/**
 * Type declarations for @clack/prompts
 *
 * The package ships ESM-only (.d.mts) which TypeScript can't resolve
 * with moduleResolution "node". We declare the subset we use here.
 */

declare module '@clack/prompts' {
  export function intro(title?: string): void;
  export function outro(message?: string): void;
  export function cancel(message?: string): void;
  export function isCancel(value: unknown): value is symbol;

  export function confirm(opts: {
    message: string;
    active?: string;
    inactive?: string;
    initialValue?: boolean;
  }): Promise<boolean | symbol>;

  export function select<Value>(opts: {
    message: string;
    options: { value: Value; label: string; hint?: string }[];
    initialValue?: Value;
  }): Promise<Value | symbol>;

  export function spinner(): {
    start(message?: string): void;
    stop(message?: string): void;
    message(message?: string): void;
  };

  export function note(message: string, title?: string): void;

  export const log: {
    message(message: string): void;
    info(message: string): void;
    success(message: string): void;
    step(message: string): void;
    warn(message: string): void;
    error(message: string): void;
  };
}
