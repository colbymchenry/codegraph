/** Shared JS/TS built-ins for direct references and inferred receiver types. */
export const JS_BUILT_INS = new Set([
  'console', 'window', 'document', 'global', 'process',
  'Promise', 'Array', 'Object', 'String', 'Number', 'Boolean',
  'Date', 'Math', 'JSON', 'RegExp', 'Error', 'Map', 'Set', 'WeakMap', 'WeakSet',
  'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval',
  'fetch', 'require', 'module', 'exports', '__dirname', '__filename',
]);
