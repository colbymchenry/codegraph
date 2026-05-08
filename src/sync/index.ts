/**
 * Sync Module
 *
 * Provides synchronization functionality for keeping the code graph
 * up-to-date with file system changes.
 *
 * Components:
 * - FileWatcher: Debounced fs.watch that auto-triggers sync on file changes
 * - Content hashing for change detection (in extraction module)
 * - Incremental reindexing (in extraction module)
 */

export { FileWatcher, WatchOptions } from './watcher';
