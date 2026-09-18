/** Shared JS/TS built-ins for direct references and inferred receiver types. */
export const JS_BUILT_INS = new Set([
  'console', 'window', 'document', 'global', 'process',
  'Promise', 'Array', 'Object', 'String', 'Number', 'Boolean',
  'Date', 'Math', 'JSON', 'RegExp', 'Error', 'Map', 'Set', 'WeakMap', 'WeakSet',
  'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval',
  'fetch', 'require', 'module', 'exports', '__dirname', '__filename',
]);

/**
 * TypeScript primitive type names. Distinct from JS_BUILT_INS on purpose: those
 * are runtime globals a receiver can be constructed from, these only ever come
 * from a type annotation. A receiver typed `string` calls a built-in string
 * method — never a project method — so the resolver declines rather than
 * guessing a same-named one (#1840).
 */
export const TS_PRIMITIVE_TYPES = new Set([
  'string', 'number', 'boolean', 'bigint', 'symbol',
  'void', 'undefined', 'null', 'never', 'unknown', 'any', 'object',
]);
