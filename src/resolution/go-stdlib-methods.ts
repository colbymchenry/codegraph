/**
 * The methods of the standard-library types Go code embeds, for Go's implicit
 * interface satisfaction (#584). An embedded type from outside the index
 * (`io.Closer`, `http.ResponseWriter`, `*os.File`) resolves to nothing, so
 * without this an interface embedding `testing.TB` asked only for its own
 * `Run`, and a struct embedding `*os.File` had no `Read`.
 *
 * Keyed by import path, then type name; each value lists the type's methods,
 * space-separated, as `name:params/results`: the parameter and result counts
 * goSignatureArity reads off a stored signature, so the arity gate holds a
 * project method answering one to the same counts. An interface lists every
 * method, embedded ones included, and so does a struct with those its embedded
 * fields promote. Unexported names are kept where an interface requires one:
 * `testing.TB`'s `private` and `reflect.Type`'s `common` and `uncommon` are
 * why only an embedding satisfies those outside their own package.
 *
 * Read from Go's own source (go1.27.3) by scripts/gen-go-stdlib-methods.mjs,
 * which regenerates the table for the types it lists. The interfaces are the
 * ones projects embed; the structs are the commonly embedded ones that
 * implement one of them. A struct whose methods would answer one of these
 * interfaces' names with another signature (`http.Header.Write`,
 * `sync.WaitGroup.Done`) is left out.
 */
const GO_STDLIB_METHODS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  io: {
    Reader: 'Read:1/2',
    Writer: 'Write:1/2',
    Closer: 'Close:0/1',
    Seeker: 'Seek:2/2',
    ReadWriter: 'Read:1/2 Write:1/2',
    ReadCloser: 'Close:0/1 Read:1/2',
    WriteCloser: 'Close:0/1 Write:1/2',
    ReadWriteCloser: 'Close:0/1 Read:1/2 Write:1/2',
    ReadSeeker: 'Read:1/2 Seek:2/2',
    ReadSeekCloser: 'Close:0/1 Read:1/2 Seek:2/2',
    WriteSeeker: 'Seek:2/2 Write:1/2',
    ReadWriteSeeker: 'Read:1/2 Seek:2/2 Write:1/2',
    ReaderFrom: 'ReadFrom:1/2',
    WriterTo: 'WriteTo:1/2',
    ReaderAt: 'ReadAt:2/2',
    WriterAt: 'WriteAt:2/2',
    ByteReader: 'ReadByte:0/2',
    ByteScanner: 'ReadByte:0/2 UnreadByte:0/1',
    ByteWriter: 'WriteByte:1/1',
    RuneReader: 'ReadRune:0/3',
    RuneScanner: 'ReadRune:0/3 UnreadRune:0/1',
    StringWriter: 'WriteString:1/2',
    PipeReader: 'Close:0/1 CloseWithError:1/1 Read:1/2',
    PipeWriter: 'Close:0/1 CloseWithError:1/1 Write:1/2',
    SectionReader: 'Outer:0/3 Read:1/2 ReadAt:2/2 Seek:2/2 Size:0/1',
  },
  'io/fs': {
    FS: 'Open:1/2',
    File: 'Close:0/1 Read:1/2 Stat:0/2',
    DirEntry: 'Info:0/2 IsDir:0/1 Name:0/1 Type:0/1',
    FileInfo: 'IsDir:0/1 ModTime:0/1 Mode:0/1 Name:0/1 Size:0/1 Sys:0/1',
    ReadDirFile: 'Close:0/1 Read:1/2 ReadDir:1/2 Stat:0/2',
    ReadDirFS: 'Open:1/2 ReadDir:1/2',
    ReadFileFS: 'Open:1/2 ReadFile:1/2',
    StatFS: 'Open:1/2 Stat:1/2',
    SubFS: 'Open:1/2 Sub:1/2',
    GlobFS: 'Glob:1/2 Open:1/2',
  },
  os: {
    File: 'Chdir:0/1 Chmod:1/1 Chown:2/1 Close:0/1 Fd:0/1 Name:0/1 PollFD:0/1 Read:1/2 ReadAt:2/2 ReadDir:1/2 ReadFrom:1/2 Readdir:1/2 Readdirnames:1/2 Seek:2/2 SetDeadline:1/1 SetReadDeadline:1/1 SetWriteDeadline:1/1 Stat:0/2 Sync:0/1 SyscallConn:0/2 Truncate:1/1 Write:1/2 WriteAt:2/2 WriteString:1/2 WriteTo:1/2',
    FileInfo: 'IsDir:0/1 ModTime:0/1 Mode:0/1 Name:0/1 Size:0/1 Sys:0/1',
    DirEntry: 'Info:0/2 IsDir:0/1 Name:0/1 Type:0/1',
    Signal: 'Signal:0/0 String:0/1',
  },
  fmt: {
    Stringer: 'String:0/1',
    GoStringer: 'GoString:0/1',
    Formatter: 'Format:2/0',
    State: 'Flag:1/1 Precision:0/2 Width:0/2 Write:1/2',
    Scanner: 'Scan:2/1',
    ScanState: 'Read:1/2 ReadRune:0/3 SkipSpace:0/0 Token:2/2 UnreadRune:0/1 Width:0/2',
  },
  sort: {
    Interface: 'Len:0/1 Less:2/1 Swap:2/0',
  },
  'container/heap': {
    Interface: 'Len:0/1 Less:2/1 Pop:0/1 Push:1/0 Swap:2/0',
  },
  context: {
    Context: 'Deadline:0/2 Done:0/1 Err:0/1 Value:1/1',
  },
  sync: {
    Locker: 'Lock:0/0 Unlock:0/0',
    Mutex: 'Lock:0/0 TryLock:0/1 Unlock:0/0',
    RWMutex: 'Lock:0/0 RLock:0/0 RLocker:0/1 RUnlock:0/0 TryLock:0/1 TryRLock:0/1 Unlock:0/0',
  },
  net: {
    Conn: 'Close:0/1 LocalAddr:0/1 Read:1/2 RemoteAddr:0/1 SetDeadline:1/1 SetReadDeadline:1/1 SetWriteDeadline:1/1 Write:1/2',
    PacketConn: 'Close:0/1 LocalAddr:0/1 ReadFrom:1/3 SetDeadline:1/1 SetReadDeadline:1/1 SetWriteDeadline:1/1 WriteTo:2/2',
    Listener: 'Accept:0/2 Addr:0/1 Close:0/1',
    Addr: 'Network:0/1 String:0/1',
    Error: 'Error:0/1 Temporary:0/1 Timeout:0/1',
    TCPConn: 'Close:0/1 CloseRead:0/1 CloseWrite:0/1 File:0/2 LocalAddr:0/1 MultipathTCP:0/2 Read:1/2 ReadFrom:1/2 RemoteAddr:0/1 SetDeadline:1/1 SetKeepAlive:1/1 SetKeepAliveConfig:1/1 SetKeepAlivePeriod:1/1 SetLinger:1/1 SetNoDelay:1/1 SetReadBuffer:1/1 SetReadDeadline:1/1 SetWriteBuffer:1/1 SetWriteDeadline:1/1 SyscallConn:0/2 Write:1/2 WriteTo:1/2',
    UDPConn: 'Close:0/1 File:0/2 LocalAddr:0/1 Read:1/2 ReadFrom:1/3 ReadFromUDP:1/3 ReadFromUDPAddrPort:1/3 ReadMsgUDP:2/5 ReadMsgUDPAddrPort:2/5 RemoteAddr:0/1 SetDeadline:1/1 SetReadBuffer:1/1 SetReadDeadline:1/1 SetWriteBuffer:1/1 SetWriteDeadline:1/1 SyscallConn:0/2 Write:1/2 WriteMsgUDP:3/3 WriteMsgUDPAddrPort:3/3 WriteTo:2/2 WriteToUDP:2/2 WriteToUDPAddrPort:2/2',
    UnixConn: 'Close:0/1 CloseRead:0/1 CloseWrite:0/1 File:0/2 LocalAddr:0/1 Read:1/2 ReadFrom:1/3 ReadFromUnix:1/3 ReadMsgUnix:2/5 RemoteAddr:0/1 SetDeadline:1/1 SetReadBuffer:1/1 SetReadDeadline:1/1 SetWriteBuffer:1/1 SetWriteDeadline:1/1 SyscallConn:0/2 Write:1/2 WriteMsgUnix:3/3 WriteTo:2/2 WriteToUnix:2/2',
    TCPListener: 'Accept:0/2 AcceptTCP:0/2 Addr:0/1 Close:0/1 File:0/2 SetDeadline:1/1 SyscallConn:0/2',
    UnixListener: 'Accept:0/2 AcceptUnix:0/2 Addr:0/1 Close:0/1 File:0/2 SetDeadline:1/1 SetUnlinkOnClose:1/0 SyscallConn:0/2',
  },
  'net/http': {
    ResponseWriter: 'Header:0/1 Write:1/2 WriteHeader:1/0',
    Hijacker: 'Hijack:0/3',
    Flusher: 'Flush:0/0',
    CloseNotifier: 'CloseNotify:0/1',
    Pusher: 'Push:2/1',
    Handler: 'ServeHTTP:2/0',
    RoundTripper: 'RoundTrip:1/2',
    File: 'Close:0/1 Read:1/2 Readdir:1/2 Seek:2/2 Stat:0/2',
    FileSystem: 'Open:1/2',
    CookieJar: 'Cookies:1/1 SetCookies:2/0',
    ServeMux: 'Handle:2/0 HandleFunc:2/0 Handler:1/2 ServeHTTP:2/0',
    Transport: 'CancelRequest:1/0 Clone:0/1 CloseIdleConnections:0/0 NewClientConn:3/2 RegisterProtocol:2/0 RoundTrip:1/2',
  },
  'net/http/httptest': {
    ResponseRecorder: 'Flush:0/0 Header:0/1 Result:0/1 Write:1/2 WriteHeader:1/0 WriteString:1/2',
  },
  bufio: {
    Reader: 'Buffered:0/1 Discard:1/2 Peek:1/2 Read:1/2 ReadByte:0/2 ReadBytes:1/2 ReadLine:0/3 ReadRune:0/3 ReadSlice:1/2 ReadString:1/2 Reset:1/0 Size:0/1 UnreadByte:0/1 UnreadRune:0/1 WriteTo:1/2',
    Writer: 'Available:0/1 AvailableBuffer:0/1 Buffered:0/1 Flush:0/1 ReadFrom:1/2 Reset:1/0 Size:0/1 Write:1/2 WriteByte:1/1 WriteRune:1/2 WriteString:1/2',
    ReadWriter: 'Available:0/1 AvailableBuffer:0/1 Buffered:0/1 Discard:1/2 Flush:0/1 Peek:1/2 Read:1/2 ReadByte:0/2 ReadBytes:1/2 ReadFrom:1/2 ReadLine:0/3 ReadRune:0/3 ReadSlice:1/2 ReadString:1/2 Reset:1/0 Size:0/1 UnreadByte:0/1 UnreadRune:0/1 Write:1/2 WriteByte:1/1 WriteRune:1/2 WriteString:1/2 WriteTo:1/2',
  },
  bytes: {
    Buffer: 'Available:0/1 AvailableBuffer:0/1 Bytes:0/1 Cap:0/1 Grow:1/0 Len:0/1 Next:1/1 Peek:1/2 Read:1/2 ReadByte:0/2 ReadBytes:1/2 ReadFrom:1/2 ReadRune:0/3 ReadString:1/2 Reset:0/0 String:0/1 Truncate:1/0 UnreadByte:0/1 UnreadRune:0/1 Write:1/2 WriteByte:1/1 WriteRune:1/2 WriteString:1/2 WriteTo:1/2',
    Reader: 'Len:0/1 Read:1/2 ReadAt:2/2 ReadByte:0/2 ReadRune:0/3 Reset:1/0 Seek:2/2 Size:0/1 UnreadByte:0/1 UnreadRune:0/1 WriteTo:1/2',
  },
  strings: {
    Reader: 'Len:0/1 Read:1/2 ReadAt:2/2 ReadByte:0/2 ReadRune:0/3 Reset:1/0 Seek:2/2 Size:0/1 UnreadByte:0/1 UnreadRune:0/1 WriteTo:1/2',
    Builder: 'Cap:0/1 Grow:1/0 Len:0/1 Reset:0/0 String:0/1 Write:1/2 WriteByte:1/1 WriteRune:1/2 WriteString:1/2',
  },
  testing: {
    TB: 'ArtifactDir:0/1 Attr:2/0 Chdir:1/0 Cleanup:1/0 Context:0/1 Error:1/0 Errorf:2/0 Fail:0/0 FailNow:0/0 Failed:0/1 Fatal:1/0 Fatalf:2/0 Helper:0/0 Log:1/0 Logf:2/0 Name:0/1 Output:0/1 Setenv:2/0 Skip:1/0 SkipNow:0/0 Skipf:2/0 Skipped:0/1 TempDir:0/1 private:0/0',
    T: 'ArtifactDir:0/1 Attr:2/0 Chdir:1/0 Cleanup:1/0 Context:0/1 Deadline:0/2 Error:1/0 Errorf:2/0 Fail:0/0 FailNow:0/0 Failed:0/1 Fatal:1/0 Fatalf:2/0 Helper:0/0 Log:1/0 Logf:2/0 Name:0/1 Output:0/1 Parallel:0/0 Run:2/1 Setenv:2/0 Skip:1/0 SkipNow:0/0 Skipf:2/0 Skipped:0/1 TempDir:0/1 private:0/0',
    B: 'ArtifactDir:0/1 Attr:2/0 Chdir:1/0 Cleanup:1/0 Context:0/1 Elapsed:0/1 Error:1/0 Errorf:2/0 Fail:0/0 FailNow:0/0 Failed:0/1 Fatal:1/0 Fatalf:2/0 Helper:0/0 Log:1/0 Logf:2/0 Loop:0/1 Name:0/1 Output:0/1 ReportAllocs:0/0 ReportMetric:2/0 ResetTimer:0/0 Run:2/1 RunParallel:1/0 SetBytes:1/0 SetParallelism:1/0 Setenv:2/0 Skip:1/0 SkipNow:0/0 Skipf:2/0 Skipped:0/1 StartTimer:0/0 StopTimer:0/0 TempDir:0/1 private:0/0',
    F: 'Add:1/0 ArtifactDir:0/1 Attr:2/0 Chdir:1/0 Cleanup:1/0 Context:0/1 Error:1/0 Errorf:2/0 Fail:0/0 FailNow:0/0 Failed:0/1 Fatal:1/0 Fatalf:2/0 Fuzz:1/0 Helper:0/0 Log:1/0 Logf:2/0 Name:0/1 Output:0/1 Setenv:2/0 Skip:1/0 SkipNow:0/0 Skipf:2/0 Skipped:0/1 TempDir:0/1 private:0/0',
  },
  'log/slog': {
    Handler: 'Enabled:2/1 Handle:2/1 WithAttrs:1/1 WithGroup:1/1',
    JSONHandler: 'Enabled:2/1 Handle:2/1 WithAttrs:1/1 WithGroup:1/1',
    TextHandler: 'Enabled:2/1 Handle:2/1 WithAttrs:1/1 WithGroup:1/1',
  },
  encoding: {
    BinaryMarshaler: 'MarshalBinary:0/2',
    BinaryUnmarshaler: 'UnmarshalBinary:1/1',
    TextMarshaler: 'MarshalText:0/2',
    TextUnmarshaler: 'UnmarshalText:1/1',
  },
  'encoding/json': {
    Marshaler: 'MarshalJSON:0/2',
    Unmarshaler: 'UnmarshalJSON:1/1',
    RawMessage: 'MarshalJSON:0/2 UnmarshalJSON:1/1',
  },
  'encoding/xml': {
    Marshaler: 'MarshalXML:2/1',
    Unmarshaler: 'UnmarshalXML:2/1',
  },
  'encoding/gob': {
    GobEncoder: 'GobEncode:0/2',
    GobDecoder: 'GobDecode:1/1',
  },
  expvar: {
    Var: 'String:0/1',
  },
  hash: {
    Hash: 'BlockSize:0/1 Reset:0/0 Size:0/1 Sum:1/1 Write:1/2',
    Hash32: 'BlockSize:0/1 Reset:0/0 Size:0/1 Sum:1/1 Sum32:0/1 Write:1/2',
    Hash64: 'BlockSize:0/1 Reset:0/0 Size:0/1 Sum:1/1 Sum64:0/1 Write:1/2',
  },
  crypto: {
    Signer: 'Public:0/1 Sign:3/2',
    Decrypter: 'Decrypt:3/2 Public:0/1',
  },
  'crypto/elliptic': {
    Curve: 'Add:4/2 Double:2/2 IsOnCurve:2/1 Params:0/1 ScalarBaseMult:1/2 ScalarMult:3/2',
  },
  'crypto/cipher': {
    Block: 'BlockSize:0/1 Decrypt:2/0 Encrypt:2/0',
    Stream: 'XORKeyStream:2/0',
    AEAD: 'NonceSize:0/1 Open:4/2 Overhead:0/1 Seal:4/1',
    BlockMode: 'BlockSize:0/1 CryptBlocks:2/0',
  },
  'crypto/tls': {
    Conn: 'Close:0/1 CloseWrite:0/1 ConnectionState:0/1 Handshake:0/1 HandshakeContext:1/1 LocalAddr:0/1 NetConn:0/1 OCSPResponse:0/1 Read:1/2 RemoteAddr:0/1 SetDeadline:1/1 SetReadDeadline:1/1 SetWriteDeadline:1/1 VerifyHostname:1/1 Write:1/2',
  },
  image: {
    Image: 'At:2/1 Bounds:0/1 ColorModel:0/1',
    PalettedImage: 'At:2/1 Bounds:0/1 ColorIndexAt:2/1 ColorModel:0/1',
  },
  'image/color': {
    Color: 'RGBA:0/4',
    Model: 'Convert:1/1',
  },
  'database/sql': {
    Scanner: 'Scan:1/1',
  },
  'database/sql/driver': {
    Valuer: 'Value:0/2',
    Driver: 'Open:1/2',
    Conn: 'Begin:0/2 Close:0/1 Prepare:1/2',
    Stmt: 'Close:0/1 Exec:1/2 NumInput:0/1 Query:1/2',
    Tx: 'Commit:0/1 Rollback:0/1',
    Rows: 'Close:0/1 Columns:0/1 Next:1/1',
    Result: 'LastInsertId:0/2 RowsAffected:0/2',
  },
  flag: {
    Value: 'Set:1/1 String:0/1',
    Getter: 'Get:0/1 Set:1/1 String:0/1',
  },
  runtime: {
    Error: 'Error:0/1 RuntimeError:0/0',
  },
  reflect: {
    Type: 'Align:0/1 AssignableTo:1/1 Bits:0/1 CanSeq:0/1 CanSeq2:0/1 ChanDir:0/1 Comparable:0/1 ConvertibleTo:1/1 Elem:0/1 Field:1/1 FieldAlign:0/1 FieldByIndex:1/1 FieldByName:1/2 FieldByNameFunc:1/2 Fields:0/1 Implements:1/1 In:1/1 Ins:0/1 IsVariadic:0/1 Key:0/1 Kind:0/1 Len:0/1 Method:1/1 MethodByName:1/2 Methods:0/1 Name:0/1 NumField:0/1 NumIn:0/1 NumMethod:0/1 NumOut:0/1 Out:1/1 Outs:0/1 OverflowComplex:1/1 OverflowFloat:1/1 OverflowInt:1/1 OverflowUint:1/1 PkgPath:0/1 Size:0/1 String:0/1 common:0/1 uncommon:0/1',
  },
  time: {
    Time: 'Add:1/1 AddDate:3/1 After:1/1 AppendBinary:1/2 AppendFormat:2/1 AppendText:1/2 Before:1/1 Clock:0/3 Compare:1/1 Date:0/3 Day:0/1 Equal:1/1 Format:1/1 GoString:0/1 GobDecode:1/1 GobEncode:0/2 Hour:0/1 ISOWeek:0/2 In:1/1 IsDST:0/1 IsZero:0/1 Local:0/1 Location:0/1 MarshalBinary:0/2 MarshalJSON:0/2 MarshalText:0/2 Minute:0/1 Month:0/1 Nanosecond:0/1 Round:1/1 Second:0/1 String:0/1 Sub:1/1 Truncate:1/1 UTC:0/1 Unix:0/1 UnixMicro:0/1 UnixMilli:0/1 UnixNano:0/1 UnmarshalBinary:1/1 UnmarshalJSON:1/1 UnmarshalText:1/1 Weekday:0/1 Year:0/1 YearDay:0/1 Zone:0/2 ZoneBounds:0/2',
  },
  'compress/gzip': {
    Reader: 'Close:0/1 Multistream:1/0 Read:1/2 Reset:1/1',
    Writer: 'Close:0/1 Flush:0/1 Reset:1/0 Write:1/2',
  },
};

/** A standard-library type's methods: each name and its `params/results`. */
export type GoStdlibMethods = ReadonlyMap<string, string>;

/** `error`, the one predeclared type with a method. */
const GO_ERROR_METHODS: GoStdlibMethods = new Map([['Error', '0/1']]);

const parsed = new Map<string, GoStdlibMethods | null>();

/**
 * The methods of the standard-library type `typeName` that the package at
 * `importPath` declares, or of the predeclared `error` when `importPath` is
 * null. Undefined for a type this table does not know.
 */
export function goStdlibMethods(importPath: string | null, typeName: string): GoStdlibMethods | undefined {
  if (importPath === null) return typeName === 'error' ? GO_ERROR_METHODS : undefined;
  const key = `${importPath}.${typeName}`;
  let methods = parsed.get(key);
  if (methods === undefined) {
    const listed = Object.prototype.hasOwnProperty.call(GO_STDLIB_METHODS, importPath)
      ? GO_STDLIB_METHODS[importPath]![typeName]
      : undefined;
    methods = typeof listed === 'string'
      ? new Map(listed.split(' ').map((entry) => entry.split(':') as [string, string]))
      : null;
    parsed.set(key, methods);
  }
  return methods ?? undefined;
}
