/**
 * Overlay Module
 *
 * Provides the remote graph overlay system for team-friendly code
 * intelligence. Combines a centrally-built base graph (main branch)
 * with local feature branch diffs for seamless, merged queries.
 */

export { RemoteGraphClient } from './remote-client';
export { BranchDiffIndexer } from './branch-diff';
export { OverlayQueryEngine } from './overlay-engine';
export type { RemoteGraphConfig, BranchDiffResult } from './types';
