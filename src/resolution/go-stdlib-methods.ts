/**
 * The method names of the standard-library types Go code embeds, for Go's
 * implicit interface satisfaction (#584). An embedded type from outside the
 * index (`io.Closer`, `http.ResponseWriter`, `*os.File`) resolves to nothing,
 * so without this an interface embedding `testing.TB` asked only for its own
 * `Run`, and a struct embedding `*os.File` had no `Read`.
 *
 * Keyed by import path, then type name; each value lists the type's method
 * names, space-separated. An interface lists every method, embedded ones
 * included, and so does a struct with those its embedded fields promote.
 * Unexported names are kept where an interface requires one: `testing.TB`'s
 * `private` and `reflect.Type`'s `common` and `uncommon` are why only an
 * embedding satisfies those outside their own package.
 *
 * Read from Go's own source (development tip, October 2026). The interfaces
 * are the ones projects embed; the structs are the commonly embedded ones
 * that implement one of them. A struct whose methods would answer one of
 * these interfaces' names with another signature (`http.Header.Write`,
 * `sync.WaitGroup.Done`) is left out.
 */
const GO_STDLIB_METHODS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  io: {
    Reader: 'Read',
    Writer: 'Write',
    Closer: 'Close',
    Seeker: 'Seek',
    ReadWriter: 'Read Write',
    ReadCloser: 'Close Read',
    WriteCloser: 'Close Write',
    ReadWriteCloser: 'Close Read Write',
    ReadSeeker: 'Read Seek',
    ReadSeekCloser: 'Close Read Seek',
    WriteSeeker: 'Seek Write',
    ReadWriteSeeker: 'Read Seek Write',
    ReaderFrom: 'ReadFrom',
    WriterTo: 'WriteTo',
    ReaderAt: 'ReadAt',
    WriterAt: 'WriteAt',
    ByteReader: 'ReadByte',
    ByteScanner: 'ReadByte UnreadByte',
    ByteWriter: 'WriteByte',
    RuneReader: 'ReadRune',
    RuneScanner: 'ReadRune UnreadRune',
    StringWriter: 'WriteString',
    PipeReader: 'Close CloseWithError Read',
    PipeWriter: 'Close CloseWithError Write',
    SectionReader: 'Outer Read ReadAt Seek Size',
  },
  'io/fs': {
    FS: 'Open',
    File: 'Close Read Stat',
    DirEntry: 'Info IsDir Name Type',
    FileInfo: 'IsDir ModTime Mode Name Size Sys',
    ReadDirFile: 'Close Read ReadDir Stat',
    ReadDirFS: 'Open ReadDir',
    ReadFileFS: 'Open ReadFile',
    StatFS: 'Open Stat',
    SubFS: 'Open Sub',
    GlobFS: 'Glob Open',
  },
  os: {
    File: 'Chdir Chmod Chown Close Fd Name PollFD Read ReadAt ReadDir ReadFrom Readdir Readdirnames Seek SetDeadline SetReadDeadline SetWriteDeadline Stat Sync SyscallConn Truncate Write WriteAt WriteString WriteTo',
    FileInfo: 'IsDir ModTime Mode Name Size Sys',
    DirEntry: 'Info IsDir Name Type',
    Signal: 'Signal String',
  },
  fmt: {
    Stringer: 'String',
    GoStringer: 'GoString',
    Formatter: 'Format',
    State: 'Flag Precision Width Write',
    Scanner: 'Scan',
    ScanState: 'Read ReadRune SkipSpace Token UnreadRune Width',
  },
  sort: {
    Interface: 'Len Less Swap',
  },
  'container/heap': {
    Interface: 'Len Less Pop Push Swap',
  },
  context: {
    Context: 'Deadline Done Err Value',
  },
  sync: {
    Locker: 'Lock Unlock',
    Mutex: 'Lock TryLock Unlock',
    RWMutex: 'Lock RLock RLocker RUnlock TryLock TryRLock Unlock',
  },
  net: {
    Conn: 'Close LocalAddr Read RemoteAddr SetDeadline SetReadDeadline SetWriteDeadline Write',
    PacketConn: 'Close LocalAddr ReadFrom SetDeadline SetReadDeadline SetWriteDeadline WriteTo',
    Listener: 'Accept Addr Close',
    Addr: 'Network String',
    Error: 'Error Temporary Timeout',
    TCPConn: 'Close CloseRead CloseWrite File LocalAddr MultipathTCP Read ReadFrom RemoteAddr SetDeadline SetKeepAlive SetKeepAliveConfig SetKeepAlivePeriod SetLinger SetNoDelay SetReadBuffer SetReadDeadline SetWriteBuffer SetWriteDeadline SyscallConn Write WriteTo',
    UDPConn: 'Close File LocalAddr Read ReadFrom ReadFromUDP ReadFromUDPAddrPort ReadMsgUDP ReadMsgUDPAddrPort RemoteAddr SetDeadline SetReadBuffer SetReadDeadline SetWriteBuffer SetWriteDeadline SyscallConn Write WriteMsgUDP WriteMsgUDPAddrPort WriteTo WriteToUDP WriteToUDPAddrPort',
    UnixConn: 'Close CloseRead CloseWrite File LocalAddr Read ReadFrom ReadFromUnix ReadMsgUnix RemoteAddr SetDeadline SetReadBuffer SetReadDeadline SetWriteBuffer SetWriteDeadline SyscallConn Write WriteMsgUnix WriteTo WriteToUnix',
    TCPListener: 'Accept AcceptTCP Addr Close File SetDeadline SyscallConn',
    UnixListener: 'Accept AcceptUnix Addr Close File SetDeadline SetUnlinkOnClose SyscallConn',
  },
  'net/http': {
    ResponseWriter: 'Header Write WriteHeader',
    Hijacker: 'Hijack',
    Flusher: 'Flush',
    CloseNotifier: 'CloseNotify',
    Pusher: 'Push',
    Handler: 'ServeHTTP',
    RoundTripper: 'RoundTrip',
    File: 'Close Read Readdir Seek Stat',
    FileSystem: 'Open',
    CookieJar: 'Cookies SetCookies',
    ServeMux: 'Handle HandleFunc Handler ServeHTTP',
    Transport: 'CancelRequest Clone CloseIdleConnections NewClientConn RegisterProtocol RoundTrip',
  },
  'net/http/httptest': {
    ResponseRecorder: 'Flush Header Result Write WriteHeader WriteString',
  },
  bufio: {
    Reader: 'Buffered Discard Peek Read ReadByte ReadBytes ReadLine ReadRune ReadSlice ReadString Reset Size UnreadByte UnreadRune WriteTo',
    Writer: 'Available AvailableBuffer Buffered Flush ReadFrom Reset Size Write WriteByte WriteRune WriteString',
    ReadWriter: 'Available AvailableBuffer Buffered Discard Flush Peek Read ReadByte ReadBytes ReadFrom ReadLine ReadRune ReadSlice ReadString Reset Size UnreadByte UnreadRune Write WriteByte WriteRune WriteString WriteTo',
  },
  bytes: {
    Buffer: 'Available AvailableBuffer Bytes Cap Grow Len Next Peek Read ReadByte ReadBytes ReadFrom ReadRune ReadString Reset String Truncate UnreadByte UnreadRune Write WriteByte WriteRune WriteString WriteTo',
    Reader: 'Len Read ReadAt ReadByte ReadRune Reset Seek Size UnreadByte UnreadRune WriteTo',
  },
  strings: {
    Reader: 'Len Read ReadAt ReadByte ReadRune Reset Seek Size UnreadByte UnreadRune WriteTo',
    Builder: 'Cap Grow Len Reset String Write WriteByte WriteRune WriteString',
  },
  testing: {
    TB: 'ArtifactDir Attr Chdir Cleanup Context Error Errorf Fail FailNow Failed Fatal Fatalf Helper Log Logf Name Output Setenv Skip SkipNow Skipf Skipped TempDir private',
    T: 'ArtifactDir Attr Chdir Cleanup Context Deadline Error Errorf Fail FailNow Failed Fatal Fatalf Helper Log Logf Name Output Parallel Run Setenv Skip SkipNow Skipf Skipped TempDir private',
    B: 'ArtifactDir Attr Chdir Cleanup Context Elapsed Error Errorf Fail FailNow Failed Fatal Fatalf Helper Log Logf Loop Name Output ReportAllocs ReportMetric ResetTimer Run RunParallel SetBytes SetParallelism Setenv Skip SkipNow Skipf Skipped StartTimer StopTimer TempDir private',
    F: 'Add ArtifactDir Attr Chdir Cleanup Context Error Errorf Fail FailNow Failed Fatal Fatalf Fuzz Helper Log Logf Name Output Setenv Skip SkipNow Skipf Skipped TempDir private',
  },
  'log/slog': {
    Handler: 'Enabled Handle WithAttrs WithGroup',
    JSONHandler: 'Enabled Handle WithAttrs WithGroup',
    TextHandler: 'Enabled Handle WithAttrs WithGroup',
  },
  encoding: {
    BinaryMarshaler: 'MarshalBinary',
    BinaryUnmarshaler: 'UnmarshalBinary',
    TextMarshaler: 'MarshalText',
    TextUnmarshaler: 'UnmarshalText',
  },
  'encoding/json': {
    Marshaler: 'MarshalJSON',
    Unmarshaler: 'UnmarshalJSON',
    RawMessage: 'MarshalJSON UnmarshalJSON',
  },
  'encoding/xml': {
    Marshaler: 'MarshalXML',
    Unmarshaler: 'UnmarshalXML',
  },
  'encoding/gob': {
    GobEncoder: 'GobEncode',
    GobDecoder: 'GobDecode',
  },
  expvar: {
    Var: 'String',
  },
  hash: {
    Hash: 'BlockSize Reset Size Sum Write',
    Hash32: 'BlockSize Reset Size Sum Sum32 Write',
    Hash64: 'BlockSize Reset Size Sum Sum64 Write',
  },
  crypto: {
    Signer: 'Public Sign',
    Decrypter: 'Decrypt Public',
  },
  'crypto/elliptic': {
    Curve: 'Add Double IsOnCurve Params ScalarBaseMult ScalarMult',
  },
  'crypto/cipher': {
    Block: 'BlockSize Decrypt Encrypt',
    Stream: 'XORKeyStream',
    AEAD: 'NonceSize Open Overhead Seal',
    BlockMode: 'BlockSize CryptBlocks',
  },
  'crypto/tls': {
    Conn: 'Close CloseWrite ConnectionState Handshake HandshakeContext LocalAddr NetConn OCSPResponse Read RemoteAddr SetDeadline SetReadDeadline SetWriteDeadline VerifyHostname Write',
  },
  image: {
    Image: 'At Bounds ColorModel',
    PalettedImage: 'At Bounds ColorIndexAt ColorModel',
  },
  'image/color': {
    Color: 'RGBA',
    Model: 'Convert',
  },
  'database/sql': {
    Scanner: 'Scan',
  },
  'database/sql/driver': {
    Valuer: 'Value',
    Driver: 'Open',
    Conn: 'Begin Close Prepare',
    Stmt: 'Close Exec NumInput Query',
    Tx: 'Commit Rollback',
    Rows: 'Close Columns Next',
    Result: 'LastInsertId RowsAffected',
  },
  flag: {
    Value: 'Set String',
    Getter: 'Get Set String',
  },
  runtime: {
    Error: 'Error RuntimeError',
  },
  reflect: {
    Type: 'Align AssignableTo Bits CanSeq CanSeq2 ChanDir Comparable ConvertibleTo Elem Field FieldAlign FieldByIndex FieldByName FieldByNameFunc Fields Implements In Ins IsVariadic Key Kind Len Method MethodByName Methods Name NumField NumIn NumMethod NumOut Out Outs OverflowComplex OverflowFloat OverflowInt OverflowUint PkgPath Size String common uncommon',
  },
  time: {
    Time: 'Add AddDate After AppendBinary AppendFormat AppendText Before Clock Compare Date Day Equal Format GoString GobDecode GobEncode Hour ISOWeek In IsDST IsZero Local Location MarshalBinary MarshalJSON MarshalText Minute Month Nanosecond Round Second String Sub Truncate UTC Unix UnixMicro UnixMilli UnixNano UnmarshalBinary UnmarshalJSON UnmarshalText Weekday Year YearDay Zone ZoneBounds',
  },
  'compress/gzip': {
    Reader: 'Close Multistream Read Reset',
    Writer: 'Close Flush Reset Write',
  },
};

/** `error`, the one predeclared type with a method. */
const GO_ERROR_METHODS: ReadonlySet<string> = new Set(['Error']);

const parsed = new Map<string, ReadonlySet<string> | null>();

/**
 * The method names of the standard-library type `typeName` that the package
 * at `importPath` declares, or of the predeclared `error` when `importPath`
 * is null. Undefined for a type this table does not know.
 */
export function goStdlibMethods(importPath: string | null, typeName: string): ReadonlySet<string> | undefined {
  if (importPath === null) return typeName === 'error' ? GO_ERROR_METHODS : undefined;
  const key = `${importPath}.${typeName}`;
  let methods = parsed.get(key);
  if (methods === undefined) {
    const names = Object.prototype.hasOwnProperty.call(GO_STDLIB_METHODS, importPath)
      ? GO_STDLIB_METHODS[importPath]![typeName]
      : undefined;
    methods = typeof names === 'string' ? new Set(names.split(' ')) : null;
    parsed.set(key, methods);
  }
  return methods ?? undefined;
}
