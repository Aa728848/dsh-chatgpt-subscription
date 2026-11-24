/**
 * The observable a model-directory store exposes to a composer badge.
 *
 * Harness 0.1.1 and earlier declared this shape in
 * `@deepseek-ai/dsh-client-runtime`; 0.1.2 replaced that package with
 * `@deepseek-ai/dsh-client-store`. A badge reads only the observable members,
 * so the two it needs are declared here instead of imported from either home.
 */
export interface SnapshotStore<T> {
  /** Read the cached snapshot reference. */
  getSnapshot(): T
  /**
   * Subscribe to snapshot invalidation.
   * @param listener - invalidation callback.
   * @returns unsubscribe function.
   */
  subscribe(listener: () => void): () => void
}
