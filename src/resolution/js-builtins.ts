/** Shared JS/TS built-ins for direct references and inferred receiver types. */
export const JS_BUILT_INS = new Set([
  'console', 'window', 'document', 'global', 'process',
  'Promise', 'Array', 'Object', 'String', 'Number', 'Boolean',
  'Date', 'Math', 'JSON', 'RegExp', 'Error', 'Map', 'Set', 'WeakMap', 'WeakSet',
  'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval',
  'fetch', 'require', 'module', 'exports', '__dirname', '__filename',
]);

/** Method names that require receiver evidence before linking to project code. */
export const JS_BUILTIN_METHODS = new Set([
  // Array / typed arrays and collections.
  'at', 'concat', 'copyWithin', 'entries', 'every', 'fill', 'filter', 'find',
  'findIndex', 'findLast', 'findLastIndex', 'flat', 'flatMap', 'forEach',
  'includes', 'indexOf', 'join', 'keys', 'lastIndexOf', 'map', 'pop', 'push',
  'reduce', 'reduceRight', 'reverse', 'shift', 'slice', 'some', 'sort', 'splice',
  'toReversed', 'toSorted', 'toSpliced', 'unshift', 'values', 'with', 'subarray',
  'get', 'set', 'has', 'add', 'delete', 'clear',
  // String.
  'charAt', 'charCodeAt', 'codePointAt', 'endsWith', 'localeCompare', 'match',
  'matchAll', 'normalize', 'padEnd', 'padStart', 'repeat', 'replace', 'replaceAll',
  'search', 'split', 'startsWith', 'substring', 'substr', 'toLowerCase',
  'toUpperCase', 'toLocaleLowerCase', 'toLocaleUpperCase', 'trim', 'trimStart',
  'trimEnd', 'trimLeft', 'trimRight', 'toString', 'toLocaleString', 'valueOf',
  // Promise, Function, EventTarget / EventEmitter and iterators.
  'then', 'catch', 'finally', 'call', 'apply', 'bind',
  'addEventListener', 'removeEventListener', 'dispatchEvent', 'on', 'once',
  'off', 'emit', 'addListener', 'removeListener', 'removeAllListeners',
  'prependListener', 'prependOnceListener', 'listeners', 'rawListeners',
  'listenerCount', 'eventNames', 'setMaxListeners', 'getMaxListeners',
  'next', 'return', 'throw', 'drop', 'take', 'toArray',
  // fetch's Response / Request / Blob bodies.
  'text', 'json', 'arrayBuffer', 'blob', 'formData',
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
