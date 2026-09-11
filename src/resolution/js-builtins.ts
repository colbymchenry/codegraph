import type { UnresolvedRef } from './types';

/** Shared JS/TS built-ins for direct references and inferred receiver types. */
export const JS_BUILT_INS = new Set([
  'console', 'window', 'document', 'global', 'process',
  'Promise', 'Array', 'Object', 'String', 'Number', 'Boolean',
  'Date', 'Math', 'JSON', 'RegExp', 'Error', 'Map', 'Set', 'WeakMap', 'WeakSet',
  'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval',
  'fetch', 'require', 'module', 'exports', '__dirname', '__filename',
]);

/** Nested property calls need framework evidence, not a last-name guess. */
export function isTsJsNestedCall(ref: UnresolvedRef): boolean {
  if (ref.referenceKind !== 'calls' ||
      !['typescript', 'tsx', 'javascript', 'jsx'].includes(ref.language)) return false;
  const receiver = ref.referenceName.slice(0, ref.referenceName.lastIndexOf('.')).trim();
  // Call-result chains have their own validated store/factory resolution.
  if (receiver.endsWith('()')) return false;
  // The extractors preserve compound receiver text, including brackets,
  // optional access and comments. A simple receiver is just the root itself.
  const root = receiver.split(/[.\[?\s]/, 1)[0];
  return receiver !== root && root !== 'this' && root !== 'window';
}
