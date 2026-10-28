/**
 * 缓存预热子包（cache-warmup）的公开入口。
 *
 * 三方（核心库 / 宿主集成 / Kimi adapter）只从这里取东西：
 * 预算与用量状态、保守投影、内容寻址的结果存储与分页读取。
 *
 * 这个子包**不改变任何现有文件的行为**：它不被 `src/index.ts` 自动装载，
 * 只有显式 import 它的调用方才会用上，所以引入它本身对现有请求是零影响。
 *
 * @module dsh-chatgpt-subscription/host/cache-warmup
 */

export {
  CACHE_WARMUP_DEFAULTS,
  CacheWarmupStoreError,
  parseStructuredResultRows,
} from './contracts.ts'
export type {
  CacheWarmupErrorCode,
  CacheWarmupUsage,
  PreviewBudget,
  ProjectionMetrics,
  ProjectionResult,
  ProjectionStrategy,
  ProjectToolResultInput,
  ResultPage,
  ResultPageOmitted,
  ResultPageQuery,
  ResultPutInput,
  ResultReferenceStore,
  StoredResultReference,
  StructuredResultRows,
  ToolResultBlock,
  ToolResultContent,
} from './contracts.ts'

export {
  FileResultReferenceStore,
  defaultResultStoreRootDir,
  formatResultRefId,
  parseResultRefId,
  RESULT_REFERENCE_PREFIX,
} from './store.ts'
export type { FileResultReferenceStoreOptions } from './store.ts'

export { projectToolResult, defaultPreviewBudget } from './projection.ts'

export { cacheWarmupBudget, cacheWarmupSnapshot } from './budget.ts'
export type { CacheWarmupSnapshot, CacheWarmupUsageTotals } from './budget.ts'

export {
  cacheWarmupHitRatio,
  cacheWarmupUsageReports,
  cacheWarmupUsageSessions,
  consecutiveWarmupHits,
  recordCacheWarmupUsage,
  resetCacheWarmupForTests,
} from './usage.ts'
export type { CacheWarmupUsageSessionSummary, CacheWarmupUsageState } from './usage.ts'
