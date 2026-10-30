/**
 * The names Delphi's compiler and System unit give meaning to, lowercased:
 * intrinsics (`SizeOf`, `TypeInfo`, `High`, `Inc`, `Assigned`, `Exit`), the
 * System and SysUtils routines everyone calls (`Move`, `FillChar`, `Copy`,
 * `Format`, `WriteLn`), and the built-in types a typecast names (`Pointer(P)`,
 * `Integer(X)`). Pascal names ignore case: `length(S)` is `Length(S)`. A call
 * to one is the System unit's unless a declaration in its scope shadows it
 * (see resolution/pascal-scope).
 */
export const PASCAL_SYSTEM_NAMES: ReadonlySet<string> = new Set([
  // Intrinsics and System routines
  'abs', 'addr', 'arctan', 'assert', 'assigned', 'assignfile', 'atomiccmpexchange', 'atomicdecrement',
  'atomicexchange', 'atomicincrement', 'blockread', 'blockwrite', 'break', 'chdir', 'chr', 'closefile', 'concat',
  'continue', 'copy', 'cos', 'dec', 'default', 'delete', 'dispose', 'eof', 'eoln', 'exclude', 'exit', 'exp',
  'fail', 'filepos', 'filesize', 'fillchar', 'finalize', 'frac', 'freemem', 'getdir', 'getmem', 'gettypekind',
  'halt', 'hasweakref', 'hi', 'high', 'inc', 'include', 'initialize', 'insert', 'int', 'ioresult',
  'isconstvalue', 'ismanagedtype', 'length', 'ln', 'lo', 'low', 'mkdir', 'move', 'new', 'odd', 'ord',
  'paramcount', 'paramstr', 'pi', 'pred', 'ptr', 'random', 'randomize', 'read', 'readln', 'reallocmem',
  'returnaddress', 'rmdir', 'round', 'runerror', 'setlength', 'setstring', 'sin', 'sizeof', 'slice', 'sqr',
  'sqrt', 'str', 'succ', 'swap', 'trunc', 'typehandle', 'typeinfo', 'typeof', 'uniquestring', 'upcase', 'val',
  'vararrayredim', 'write', 'writeln',
  // SysUtils routines the resolver has always taken for the RTL's
  'abort', 'date', 'datetostr', 'floattostr', 'format', 'freeandnil', 'inttostr', 'lowercase', 'now', 'pos',
  'strtodate', 'strtofloat', 'strtoint', 'time', 'trim', 'uppercase',
  // Built-in types, called as typecasts
  'ansichar', 'ansistring', 'boolean', 'byte', 'bytebool', 'cardinal', 'char', 'comp', 'currency', 'double',
  'extended', 'int16', 'int32', 'int64', 'int8', 'integer', 'longbool', 'longint', 'longword', 'nativeint',
  'nativeuint', 'olevariant', 'pansichar', 'pchar', 'pointer', 'pwidechar', 'rawbytestring', 'real',
  'shortint', 'shortstring', 'single', 'smallint', 'string', 'uint16', 'uint32', 'uint64', 'uint8',
  'unicodestring', 'utf8string', 'variant', 'widechar', 'widestring', 'word', 'wordbool',
]);
