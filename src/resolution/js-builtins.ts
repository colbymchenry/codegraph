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

/**
 * Methods on the JS/TS built-in prototypes (Array, Map/Set, String, Promise,
 * RegExp, Object) that project classes also commonly declare. A call such as
 * `lines.map(...)` or `seen.has(k)` whose receiver type is unknown is far more
 * likely the built-in than whichever project class happens to declare the
 * only `map`/`has`, so the name-only method fallback needs receiver evidence
 * before it binds one of these names to a project method.
 */
export const JS_BUILTIN_METHOD_NAMES = new Set([
  // Array
  'map', 'filter', 'forEach', 'reduce', 'reduceRight', 'find', 'findIndex',
  'findLast', 'findLastIndex', 'some', 'every', 'includes', 'indexOf',
  'lastIndexOf', 'join', 'slice', 'splice', 'concat', 'push', 'pop', 'shift',
  'unshift', 'sort', 'reverse', 'flat', 'flatMap', 'fill', 'at',
  'keys', 'values', 'entries',
  // Map / Set
  'get', 'set', 'has', 'delete', 'clear', 'add',
  // String
  'split', 'trim', 'trimStart', 'trimEnd', 'replace', 'replaceAll',
  'startsWith', 'endsWith', 'toLowerCase', 'toUpperCase', 'padStart', 'padEnd',
  'substring', 'match', 'matchAll', 'charAt', 'charCodeAt', 'localeCompare',
  'repeat',
  // Promise
  'then', 'catch', 'finally',
  // RegExp
  'exec', 'test',
  // Object
  'toString', 'valueOf', 'hasOwnProperty',
]);
