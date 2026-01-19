/**
 * CodeGraph Type Definitions
 *
 * Core types for the semantic knowledge graph system.
 */

// =============================================================================
// Union Types
// =============================================================================

/**
 * Types of nodes in the knowledge graph
 */
export type NodeKind =
  | 'file'
  | 'module'
  | 'class'
  | 'struct'
  | 'interface'
  | 'trait'
  | 'protocol'
  | 'function'
  | 'method'
  | 'property'
  | 'field'
  | 'variable'
  | 'constant'
  | 'enum'
  | 'enum_member'
  | 'type_alias'
  | 'namespace'
  | 'parameter'
  | 'import'
  | 'export'
  | 'route'
  | 'component';

/**
 * Types of edges (relationships) between nodes
 */
export type EdgeKind =
  | 'contains'        // Parent contains child (file→class, class→method)
  | 'calls'           // Function/method calls another
  | 'imports'         // File imports from another
  | 'exports'         // File exports a symbol
  | 'extends'         // Class/interface extends another
  | 'implements'      // Class implements interface
  | 'references'      // Generic reference to another symbol
  | 'type_of'         // Variable/parameter has type
  | 'returns'         // Function returns type
  | 'instantiates'    // Creates instance of class
  | 'overrides'       // Method overrides parent method
  | 'decorates';      // Decorator applied to symbol

/**
 * Supported programming languages
 */
export type Language =
  | 'typescript'
  | 'javascript'
  | 'tsx'
  | 'jsx'
  | 'python'
  | 'go'
  | 'rust'
  | 'java'
  | 'c'
  | 'cpp'
  | 'csharp'
  | 'php'
  | 'ruby'
  | 'swift'
  | 'kotlin'
  | 'liquid'
  | 'unknown';

// =============================================================================
// Core Graph Types
// =============================================================================

/**
 * A node in the knowledge graph representing a code symbol
 */
export interface Node {
  /** Unique identifier (hash of file path + qualified name) */
  id: string;

  /** Type of code element */
  kind: NodeKind;

  /** Simple name (e.g., "calculateTotal") */
  name: string;

  /** Fully qualified name (e.g., "src/utils.ts::MathHelper.calculateTotal") */
  qualifiedName: string;

  /** File path relative to project root */
  filePath: string;

  /** Programming language */
  language: Language;

  /** Starting line number (1-indexed) */
  startLine: number;

  /** Ending line number (1-indexed) */
  endLine: number;

  /** Starting column (0-indexed) */
  startColumn: number;

  /** Ending column (0-indexed) */
  endColumn: number;

  /** Documentation string if present */
  docstring?: string;

  /** Function/method signature */
  signature?: string;

  /** Visibility modifier */
  visibility?: 'public' | 'private' | 'protected' | 'internal';

  /** Whether symbol is exported */
  isExported?: boolean;

  /** Whether symbol is async */
  isAsync?: boolean;

  /** Whether symbol is static */
  isStatic?: boolean;

  /** Whether symbol is abstract */
  isAbstract?: boolean;

  /** Decorators/annotations applied */
  decorators?: string[];

  /** Generic type parameters */
  typeParameters?: string[];

  /** When the node was last updated */
  updatedAt: number;
}

/**
 * An edge representing a relationship between two nodes
 */
export interface Edge {
  /** Source node ID */
  source: string;

  /** Target node ID */
  target: string;

  /** Type of relationship */
  kind: EdgeKind;

  /** Additional context about the relationship */
  metadata?: Record<string, unknown>;

  /** Line number where relationship occurs (e.g., call site) */
  line?: number;

  /** Column number where relationship occurs */
  column?: number;
}

/**
 * Metadata about a tracked file
 */
export interface FileRecord {
  /** File path relative to project root */
  path: string;

  /** Content hash for change detection */
  contentHash: string;

  /** Detected language */
  language: Language;

  /** File size in bytes */
  size: number;

  /** Last modification timestamp */
  modifiedAt: number;

  /** When last indexed */
  indexedAt: number;

  /** Number of nodes extracted */
  nodeCount: number;

  /** Any extraction errors */
  errors?: ExtractionError[];
}

// =============================================================================
// Extraction Types
// =============================================================================

/**
 * Result from parsing a source file
 */
export interface ExtractionResult {
  /** Extracted nodes */
  nodes: Node[];

  /** Extracted edges */
  edges: Edge[];

  /** References that couldn't be resolved yet */
  unresolvedReferences: UnresolvedReference[];

  /** Any errors during extraction */
  errors: ExtractionError[];

  /** Extraction duration in milliseconds */
  durationMs: number;
}

/**
 * Error during code extraction
 */
export interface ExtractionError {
  /** Error message */
  message: string;

  /** Line number if available */
  line?: number;

  /** Column number if available */
  column?: number;

  /** Error severity */
  severity: 'error' | 'warning';

  /** Error code for categorization */
  code?: string;
}

/**
 * A reference that couldn't be resolved during extraction
 */
export interface UnresolvedReference {
  /** ID of the node containing the reference */
  fromNodeId: string;

  /** Name being referenced */
  referenceName: string;

  /** Type of reference (call, type, import, etc.) */
  referenceKind: EdgeKind;

  /** Location of the reference */
  line: number;
  column: number;

  /** Possible qualified names it might resolve to */
  candidates?: string[];
}

// =============================================================================
// Query Types
// =============================================================================

/**
 * A subgraph containing a subset of the knowledge graph
 */
export interface Subgraph {
  /** Nodes in this subgraph */
  nodes: Map<string, Node>;

  /** Edges in this subgraph */
  edges: Edge[];

  /** Root node IDs (entry points) */
  roots: string[];
}

/**
 * Options for graph traversal
 */
export interface TraversalOptions {
  /** Maximum depth to traverse (default: Infinity) */
  maxDepth?: number;

  /** Edge types to follow (default: all) */
  edgeKinds?: EdgeKind[];

  /** Node types to include (default: all) */
  nodeKinds?: NodeKind[];

  /** Direction of traversal */
  direction?: 'outgoing' | 'incoming' | 'both';

  /** Maximum nodes to return */
  limit?: number;

  /** Whether to include the starting node */
  includeStart?: boolean;
}

/**
 * Options for searching the graph
 */
export interface SearchOptions {
  /** Node types to search */
  kinds?: NodeKind[];

  /** Languages to include */
  languages?: Language[];

  /** File path patterns to include */
  includePatterns?: string[];

  /** File path patterns to exclude */
  excludePatterns?: string[];

  /** Maximum results to return */
  limit?: number;

  /** Offset for pagination */
  offset?: number;

  /** Whether search is case-sensitive */
  caseSensitive?: boolean;
}

/**
 * A search result with relevance scoring
 */
export interface SearchResult {
  /** Matching node */
  node: Node;

  /** Relevance score (0-1) */
  score: number;

  /** Matched text snippets for highlighting */
  highlights?: string[];
}

// =============================================================================
// Context Types
// =============================================================================

/**
 * Context information for code understanding
 */
export interface Context {
  /** Primary node being examined */
  focal: Node;

  /** Nodes containing the focal node (file, class, etc.) */
  ancestors: Node[];

  /** Nodes directly contained by focal node */
  children: Node[];

  /** Incoming references (who calls/uses this) */
  incomingRefs: Array<{ node: Node; edge: Edge }>;

  /** Outgoing references (what this calls/uses) */
  outgoingRefs: Array<{ node: Node; edge: Edge }>;

  /** Related type information */
  types: Node[];

  /** Relevant imports */
  imports: Node[];
}

/**
 * A block of code with context
 */
export interface CodeBlock {
  /** The code content */
  content: string;

  /** File path */
  filePath: string;

  /** Starting line */
  startLine: number;

  /** Ending line */
  endLine: number;

  /** Language for syntax highlighting */
  language: Language;

  /** Associated node if extracted */
  node?: Node;
}

// =============================================================================
// Configuration Types
// =============================================================================

/**
 * Framework-specific hints for better extraction
 */
export interface FrameworkHint {
  /** Framework name (react, express, django, etc.) */
  name: string;

  /** Version constraint if relevant */
  version?: string;

  /** Custom patterns for this framework */
  patterns?: {
    /** Component detection patterns */
    components?: string[];
    /** Route detection patterns */
    routes?: string[];
    /** Model detection patterns */
    models?: string[];
  };
}

/**
 * Configuration for a CodeGraph project
 */
export interface CodeGraphConfig {
  /** Schema version for migrations */
  version: number;

  /** Root directory of the project */
  rootDir: string;

  /** Glob patterns for files to include */
  include: string[];

  /** Glob patterns for files to exclude */
  exclude: string[];

  /** Languages to process (auto-detected if empty) */
  languages: Language[];

  /** Framework hints for better extraction */
  frameworks: FrameworkHint[];

  /** Maximum file size to process (in bytes) */
  maxFileSize: number;

  /** Whether to extract docstrings */
  extractDocstrings: boolean;

  /** Whether to track call sites */
  trackCallSites: boolean;

  /** Whether to compute embeddings for semantic search */
  enableEmbeddings: boolean;

  /** Custom symbol patterns to extract */
  customPatterns?: {
    /** Name for this pattern group */
    name: string;
    /** Regex pattern to match */
    pattern: string;
    /** Node kind to assign */
    kind: NodeKind;
  }[];
}

/**
 * Default configuration values
 */
export const DEFAULT_CONFIG: CodeGraphConfig = {
  version: 1,
  rootDir: '.',
  include: [
    // TypeScript/JavaScript
    '**/*.ts',
    '**/*.tsx',
    '**/*.js',
    '**/*.jsx',
    // Python
    '**/*.py',
    // Go
    '**/*.go',
    // Rust
    '**/*.rs',
    // Java
    '**/*.java',
    // C/C++
    '**/*.c',
    '**/*.h',
    '**/*.cpp',
    '**/*.hpp',
    '**/*.cc',
    '**/*.cxx',
    // C#
    '**/*.cs',
    // PHP
    '**/*.php',
    // Ruby
    '**/*.rb',
    // Liquid (Shopify themes)
    '**/*.liquid',
  ],
  exclude: [
    // Version control
    '**/.git/**',

    // Dependencies
    '**/node_modules/**',
    '**/vendor/**',
    '**/Pods/**',

    // Generic build outputs
    '**/dist/**',
    '**/build/**',
    '**/out/**',
    '**/bin/**',
    '**/obj/**',
    '**/target/**',

    // JavaScript/TypeScript
    '**/*.min.js',
    '**/*.bundle.js',
    '**/.next/**',
    '**/.nuxt/**',
    '**/.svelte-kit/**',
    '**/.output/**',
    '**/.turbo/**',
    '**/.cache/**',
    '**/.parcel-cache/**',
    '**/.vite/**',
    '**/.astro/**',
    '**/.docusaurus/**',
    '**/.gatsby/**',
    '**/.webpack/**',
    '**/.nx/**',
    '**/.yarn/cache/**',
    '**/.pnpm-store/**',
    '**/storybook-static/**',

    // React Native / Expo
    '**/.expo/**',
    '**/web-build/**',
    '**/ios/Pods/**',
    '**/ios/build/**',
    '**/android/build/**',
    '**/android/.gradle/**',

    // Python
    '**/__pycache__/**',
    '**/.venv/**',
    '**/venv/**',
    '**/.pytest_cache/**',
    '**/.mypy_cache/**',
    '**/.ruff_cache/**',
    '**/.tox/**',
    '**/.nox/**',
    '**/*.egg-info/**',
    '**/.eggs/**',

    // Go
    '**/go/pkg/mod/**',

    // Rust
    '**/target/debug/**',
    '**/target/release/**',

    // Java/Kotlin/Gradle
    '**/.gradle/**',
    '**/.m2/**',
    '**/generated-sources/**',
    '**/.kotlin/**',

    // C#/.NET
    '**/.vs/**',
    '**/.nuget/**',
    '**/artifacts/**',
    '**/publish/**',

    // C/C++
    '**/cmake-build-*/**',
    '**/CMakeFiles/**',
    '**/bazel-*/**',
    '**/vcpkg_installed/**',
    '**/.conan/**',
    '**/Debug/**',
    '**/Release/**',
    '**/x64/**',

    // Electron
    '**/release/**',
    '**/*.app/**',
    '**/*.asar',

    // Swift/iOS/Xcode
    '**/DerivedData/**',
    '**/.build/**',
    '**/.swiftpm/**',
    '**/xcuserdata/**',
    '**/Carthage/Build/**',
    '**/SourcePackages/**',

    // PHP
    '**/.composer/**',
    '**/storage/framework/**',
    '**/bootstrap/cache/**',

    // Ruby
    '**/.bundle/**',
    '**/tmp/cache/**',
    '**/public/assets/**',
    '**/public/packs/**',
    '**/.yardoc/**',

    // Testing/Coverage
    '**/coverage/**',
    '**/htmlcov/**',
    '**/.nyc_output/**',
    '**/test-results/**',
    '**/.coverage/**',

    // IDE/Editor
    '**/.idea/**',

    // Logs and temp
    '**/logs/**',
    '**/tmp/**',
    '**/temp/**',

    // Documentation build output
    '**/_build/**',
    '**/docs/_build/**',
    '**/site/**',
  ],
  languages: [],
  frameworks: [],
  maxFileSize: 1024 * 1024, // 1MB
  extractDocstrings: true,
  trackCallSites: true,
  enableEmbeddings: false,
};

// =============================================================================
// Database Types
// =============================================================================

/**
 * Database schema version info
 */
export interface SchemaVersion {
  /** Current schema version */
  version: number;

  /** When schema was created/updated */
  appliedAt: number;

  /** Description of this version */
  description?: string;
}

/**
 * Statistics about the knowledge graph
 */
export interface GraphStats {
  /** Total number of nodes */
  nodeCount: number;

  /** Total number of edges */
  edgeCount: number;

  /** Number of tracked files */
  fileCount: number;

  /** Node counts by kind */
  nodesByKind: Record<NodeKind, number>;

  /** Edge counts by kind */
  edgesByKind: Record<EdgeKind, number>;

  /** File counts by language */
  filesByLanguage: Record<Language, number>;

  /** Database size in bytes */
  dbSizeBytes: number;

  /** Last update timestamp */
  lastUpdated: number;
}

// =============================================================================
// Task Context Types (for buildContext)
// =============================================================================

/**
 * Input for building task context
 */
export type TaskInput = string | { title: string; description?: string };

/**
 * Options for building task context
 */
export interface BuildContextOptions {
  /** Maximum number of nodes to include (default: 50) */
  maxNodes?: number;

  /** Maximum number of code blocks to include (default: 10) */
  maxCodeBlocks?: number;

  /** Maximum characters per code block (default: 2000) */
  maxCodeBlockSize?: number;

  /** Whether to include code blocks (default: true) */
  includeCode?: boolean;

  /** Output format (default: 'markdown') */
  format?: 'markdown' | 'json';

  /** Number of semantic search results (default: 5) */
  searchLimit?: number;

  /** Graph traversal depth from entry points (default: 2) */
  traversalDepth?: number;

  /** Minimum semantic similarity score (default: 0.3) */
  minScore?: number;
}

/**
 * Full context for a task, ready for Claude
 */
export interface TaskContext {
  /** The original query/task */
  query: string;

  /** Subgraph of relevant nodes and edges */
  subgraph: Subgraph;

  /** Entry point nodes (from semantic search) */
  entryPoints: Node[];

  /** Code blocks extracted from key nodes */
  codeBlocks: CodeBlock[];

  /** Files involved in this context */
  relatedFiles: string[];

  /** Brief summary of the context */
  summary: string;

  /** Statistics about the context */
  stats: {
    /** Number of nodes included */
    nodeCount: number;
    /** Number of edges included */
    edgeCount: number;
    /** Number of files touched */
    fileCount: number;
    /** Number of code blocks included */
    codeBlockCount: number;
    /** Total characters in code blocks */
    totalCodeSize: number;
  };
}

/**
 * Options for finding relevant context
 */
export interface FindRelevantContextOptions {
  /** Number of semantic search results (default: 5) */
  searchLimit?: number;

  /** Graph traversal depth (default: 2) */
  traversalDepth?: number;

  /** Maximum nodes in result (default: 50) */
  maxNodes?: number;

  /** Minimum semantic similarity score (default: 0.3) */
  minScore?: number;

  /** Edge types to follow in traversal */
  edgeKinds?: EdgeKind[];

  /** Node types to include */
  nodeKinds?: NodeKind[];
}
