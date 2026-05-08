import type { EvalTestCase } from './types.js';

export const testCases: EvalTestCase[] = [
  // === searchNodes: Symbol Lookup Precision ===

  {
    id: 'search-class-exact',
    query: 'TransportService',
    api: 'searchNodes',
    expectedSymbols: ['TransportService'],
    kinds: ['class'],
  },
  {
    id: 'search-method-qualified',
    query: 'TransportService sendRequest',
    api: 'searchNodes',
    expectedSymbols: ['sendRequest'],
    kinds: ['method'],
  },
  {
    id: 'search-interface',
    query: 'ActionListener',
    api: 'searchNodes',
    expectedSymbols: ['ActionListener'],
    kinds: ['interface'],
  },
  {
    id: 'search-enum',
    query: 'RestStatus',
    api: 'searchNodes',
    expectedSymbols: ['RestStatus'],
    kinds: ['enum'],
  },
  {
    id: 'search-exception',
    query: 'SearchPhaseExecutionException',
    api: 'searchNodes',
    expectedSymbols: ['SearchPhaseExecutionException'],
    kinds: ['class'],
  },
  {
    id: 'search-nested-class',
    query: 'Engine Index',
    api: 'searchNodes',
    expectedSymbols: ['Index'],
    kinds: ['class'],
  },

  // === findRelevantContext: Exploration Quality ===

  {
    id: 'explore-rest-layer',
    query: 'How does the REST layer handle HTTP requests?',
    api: 'findRelevantContext',
    expectedSymbols: ['RestController', 'RestHandler', 'BaseRestHandler', 'RestRequest'],
    options: { searchLimit: 8, traversalDepth: 3, maxNodes: 80, minScore: 0.2 },
  },
  {
    id: 'explore-search-execution',
    query: 'How does search execution work from request to shard?',
    api: 'findRelevantContext',
    expectedSymbols: ['ShardSearchRequest', 'SearchShardsRequest', 'SearchShardsGroup'],
    options: { searchLimit: 8, traversalDepth: 3, maxNodes: 80, minScore: 0.2 },
  },
  {
    id: 'explore-bulk-indexing',
    query: 'How does bulk indexing work?',
    api: 'findRelevantContext',
    expectedSymbols: ['TransportBulkAction', 'BulkRequest', 'BulkResponse'],
    options: { searchLimit: 8, traversalDepth: 3, maxNodes: 80, minScore: 0.2 },
  },
  {
    id: 'explore-shard-allocation',
    query: 'How does shard rebalancing and allocation work?',
    api: 'findRelevantContext',
    expectedSymbols: ['AllocationService', 'BalancedShardsAllocator'],
    options: { searchLimit: 8, traversalDepth: 3, maxNodes: 80, minScore: 0.2 },
  },
  {
    id: 'explore-transport-search',
    query: 'How does TransportService connect to SearchTransportService?',
    api: 'findRelevantContext',
    expectedSymbols: ['TransportService', 'SearchTransportService'],
    options: { searchLimit: 8, traversalDepth: 3, maxNodes: 80, minScore: 0.2 },
  },
  {
    id: 'explore-engine-implementations',
    query: 'What are the Engine implementations for indexing?',
    api: 'findRelevantContext',
    expectedSymbols: ['InternalEngine', 'ReadOnlyEngine', 'Engine'],
    options: { searchLimit: 8, traversalDepth: 3, maxNodes: 80, minScore: 0.2 },
  },
];
