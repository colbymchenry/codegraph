/**
 * Method names of each language's standard library (collections, strings,
 * options/results, iterators, I/O, sync primitives) that a member call on an
 * untyped receiver almost always means — `v.iter().all()`, `name.len()`,
 * `list.isEmpty()`, `d.setdefault(k, [])`. The name-only fallbacks must not
 * bind such a call to a project method that happens to share the name
 * unless the receiver's own words name the method's type
 * (see `isUnevidencedLibraryCall` in name-matcher.ts).
 *
 * Kept deliberately to names the library itself defines; names a project is
 * as likely to define (`start`, `run`, `info`, `show`) stay out.
 * JS/TS has its own list (js-builtins.ts).
 */
const RUST = [
  // iterators / slices / collections
  'len', 'is_empty', 'iter', 'iter_mut', 'into_iter', 'map', 'filter', 'filter_map', 'flat_map',
  'all', 'any', 'collect', 'fold', 'for_each', 'find', 'position', 'count', 'sum', 'min', 'max',
  'rev', 'next', 'peek', 'skip', 'chain', 'zip', 'enumerate', 'cloned', 'copied', 'first', 'last',
  'nth', 'push', 'push_str', 'pop', 'insert', 'remove', 'get', 'get_mut', 'contains', 'contains_key',
  'entry', 'or_insert', 'or_insert_with', 'or_default', 'keys', 'values', 'values_mut', 'drain',
  'retain', 'truncate', 'extend', 'clear', 'sort', 'sort_by', 'sort_by_key', 'sort_unstable', 'dedup',
  'join', 'concat', 'split_at', 'split_off', 'windows', 'chunks', 'resize', 'reserve', 'swap', 'to_vec',
  // Option / Result
  'unwrap', 'unwrap_or', 'unwrap_or_else', 'unwrap_or_default', 'expect', 'ok', 'ok_or', 'ok_or_else',
  'err', 'map_err', 'and_then', 'or_else', 'is_some', 'is_none', 'is_ok', 'is_err', 'as_ref', 'as_mut',
  'as_deref', 'take', 'replace',
  // strings / conversions
  'clone', 'to_string', 'to_owned', 'into', 'try_into', 'as_str', 'as_bytes', 'as_slice',
  'to_lowercase', 'to_uppercase', 'trim', 'trim_start', 'trim_end', 'split', 'splitn', 'lines',
  'chars', 'bytes', 'starts_with', 'ends_with', 'parse',
  // sync / threads / channels
  'lock', 'try_lock', 'borrow', 'borrow_mut', 'load', 'store', 'fetch_add', 'fetch_sub', 'send',
  'recv', 'try_recv', 'spawn', 'wait', 'notify_one', 'notify_all',
  // io / fs / net / time
  'open', 'create', 'read', 'write', 'read_to_string', 'read_to_end', 'read_exact', 'write_all',
  'flush', 'seek', 'sync_all', 'metadata', 'exists', 'is_dir', 'is_file', 'display', 'file_name',
  'extension', 'parent', 'to_path_buf', 'canonicalize', 'port', 'ip', 'local_addr', 'peer_addr',
  'shutdown', 'kill', 'elapsed', 'as_secs', 'as_millis', 'duration_since',
  // std traits
  'eq', 'ne', 'cmp', 'partial_cmp', 'hash', 'fmt', 'add', 'sub',
];

const GO = [
  'String', 'Error', 'Write', 'Read', 'Close', 'WriteString', 'ReadString', 'Flush', 'Seek',
  'Wait', 'Add', 'Done', 'Lock', 'Unlock', 'RLock', 'RUnlock', 'Load', 'Store', 'Swap',
  'CompareAndSwap', 'Len', 'Bytes', 'Reset', 'Get', 'Set', 'Del', 'Encode', 'Decode',
  'Header', 'WriteHeader', 'Err', 'Value', 'Deadline', 'Stop', 'Before', 'After', 'Sub', 'Unix',
  'Format', 'Printf', 'Println', 'Sprintf', 'Errorf', 'Fprintf', 'Marshal', 'Unmarshal',
];

const PYTHON = [
  'get', 'setdefault', 'pop', 'popitem', 'update', 'items', 'keys', 'values', 'copy', 'clear',
  'append', 'extend', 'insert', 'remove', 'index', 'count', 'sort', 'reverse', 'add', 'discard',
  'union', 'intersection', 'difference', 'split', 'rsplit', 'join', 'strip', 'lstrip', 'rstrip',
  'replace', 'startswith', 'endswith', 'lower', 'upper', 'format', 'encode', 'decode', 'find',
  'rfind', 'splitlines', 'read', 'readline', 'readlines', 'write', 'writelines', 'close', 'seek',
  'flush', 'group', 'groups', 'match', 'search', 'sub', 'findall', 'fullmatch',
];

/** Kotlin stdlib + the java.* classes Kotlin code calls every day. */
const KOTLIN = [
  'let', 'also', 'apply', 'run', 'takeIf', 'takeUnless', 'use', 'isEmpty', 'isNotEmpty',
  'isNullOrEmpty', 'isNullOrBlank', 'isBlank', 'isNotBlank', 'orEmpty', 'map', 'mapNotNull',
  'mapIndexed', 'flatMap', 'filter', 'filterNot', 'filterIsInstance', 'filterNotNull', 'forEach',
  'forEachIndexed', 'onEach', 'first', 'firstOrNull', 'last', 'lastOrNull', 'single', 'singleOrNull',
  'find', 'findLast', 'any', 'all', 'none', 'count', 'sum', 'sumOf', 'maxOf', 'minOf', 'maxByOrNull',
  'minByOrNull', 'sorted', 'sortedBy', 'sortedByDescending', 'reversed', 'distinct', 'groupBy',
  'associate', 'associateBy', 'associateWith', 'partition', 'zip', 'chunked', 'windowed', 'take',
  'drop', 'joinToString', 'toList', 'toMutableList', 'toSet', 'toMutableSet', 'toMap', 'toMutableMap',
  'toTypedArray', 'toByteArray', 'toString', 'toInt', 'toLong', 'toDouble', 'toFloat', 'toIntOrNull',
  'toLongOrNull', 'get', 'getOrNull', 'getOrElse', 'getOrDefault', 'getOrPut', 'put', 'putAll',
  'remove', 'removeAll', 'removeIf', 'add', 'addAll', 'clear', 'contains', 'containsKey',
  'containsValue', 'indexOf', 'substring', 'split', 'trim', 'startsWith', 'endsWith', 'replace',
  'lowercase', 'uppercase', 'format', 'padStart', 'padEnd', 'equals', 'hashCode', 'compareTo',
  'iterator', 'hasNext', 'next', 'close', 'join', 'interrupt', 'cancel', 'send', 'poll', 'offer',
  'submit', 'execute', 'post', 'postDelayed', 'await', 'launch', 'async', 'collect', 'emit',
  'matches', 'read', 'write', 'flush', 'lock', 'unlock', 'tryLock', 'withLock', 'connect',
];

/** Scala collections / Option / Future + the java.* calls Scala code makes. */
const SCALA = [
  'map', 'flatMap', 'filter', 'filterNot', 'foreach', 'fold', 'foldLeft', 'foldRight', 'reduce',
  'collect', 'collectFirst', 'find', 'exists', 'forall', 'count', 'get', 'getOrElse', 'orElse',
  'orNull', 'isEmpty', 'nonEmpty', 'isDefined', 'contains', 'headOption', 'head', 'tail', 'last',
  'lastOption', 'take', 'drop', 'groupBy', 'sortBy', 'sorted', 'mkString', 'toList', 'toSeq',
  'toSet', 'toMap', 'toVector', 'toArray', 'zip', 'zipWithIndex', 'size', 'length', 'update',
  'updated', 'recover', 'recoverWith', 'transform', 'andThen', 'compose', 'onComplete', 'asScala',
  'asJava', 'getOrElseUpdate', 'put', 'remove', 'add', 'append', 'replace', 'split', 'trim',
  'startsWith', 'endsWith', 'format', 'equals', 'hashCode', 'toString', 'set', 'build', 'execute',
  'of', 'encode', 'decode', 'max', 'min',
];

const CSHARP = [
  'ToString', 'Equals', 'GetHashCode', 'GetType', 'Dispose', 'DisposeAsync', 'Add', 'AddRange',
  'Remove', 'Clear', 'Contains', 'ContainsKey', 'TryGetValue', 'Where', 'Select', 'SelectMany',
  'First', 'FirstOrDefault', 'Single', 'SingleOrDefault', 'Any', 'All', 'Count', 'ToList', 'ToArray',
  'ToDictionary', 'OrderBy', 'GroupBy', 'Aggregate', 'Run', 'Wait', 'WaitAsync', 'ConfigureAwait',
  'GetAwaiter', 'GetResult', 'Write', 'WriteLine', 'WriteAsync', 'WriteLineAsync', 'Read',
  'ReadLine', 'ReadAsync', 'Flush', 'Close', 'Append', 'AppendLine', 'Split', 'Trim', 'Replace',
  'Substring', 'StartsWith', 'EndsWith', 'Format', 'Join',
];

/**
 * java.lang / java.util / java.util.stream + the Android framework calls
 * (`Handler`, `Context`, `View`) Java code makes on values whose type the
 * resolver cannot see — a lambda parameter, a `var`, a call result, an
 * inherited field. Names Java projects commonly declare themselves (`post`,
 * `of`, `apply`, `run`, `start`, `getId`, `getWidth`) stay out.
 */
const JAVA = [
  // java.lang.Object / Comparable
  'equals', 'hashCode', 'toString', 'getClass', 'compareTo',
  // collections / maps / iterators
  'get', 'put', 'add', 'remove', 'contains', 'containsKey', 'containsValue', 'size', 'isEmpty',
  'clear', 'iterator', 'hasNext', 'next', 'stream', 'forEach', 'keySet', 'values', 'entrySet',
  'addAll', 'removeAll', 'putAll', 'putIfAbsent', 'getOrDefault', 'computeIfAbsent', 'indexOf',
  'toArray', 'subList',
  // String
  'length', 'charAt', 'substring', 'trim', 'split', 'startsWith', 'endsWith', 'equalsIgnoreCase',
  'toLowerCase', 'toUpperCase', 'replace', 'format', 'valueOf',
  // Optional / Stream
  'map', 'filter', 'orElse', 'orElseGet', 'orElseThrow', 'ifPresent', 'isPresent', 'collect',
  'findFirst', 'anyMatch', 'allMatch',
  // Android framework
  'postDelayed', 'removeCallbacks', 'obtainMessage', 'getResources', 'getSystemService',
  'findViewById', 'setVisibility', 'startActivity',
];

/**
 * java.lang / java.util classes Java code calls statically — `Objects.hash(…)`,
 * `Collections.emptyMap()`, `String.valueOf(…)` — which a wildcard
 * `import java.util.*` (or no import at all, for java.lang) brings into scope
 * without naming them. A call on one is a library call whatever the method
 * is named, unless the project declares a type of that name.
 */
export const JAVA_STD_CLASSES: ReadonlySet<string> = new Set([
  'Objects', 'Arrays', 'Collections', 'Optional', 'List', 'Map', 'Set', 'UUID', 'String', 'Integer',
  'Long', 'Short', 'Byte', 'Boolean', 'Double', 'Float', 'Character', 'Math', 'System', 'Thread',
]);

export const LIBRARY_METHOD_NAMES: Readonly<Record<string, ReadonlySet<string>>> = {
  rust: new Set(RUST),
  go: new Set(GO),
  python: new Set(PYTHON),
  kotlin: new Set(KOTLIN),
  scala: new Set(SCALA),
  csharp: new Set(CSHARP),
  java: new Set(JAVA),
};
