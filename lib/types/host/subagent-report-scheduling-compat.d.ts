import type { Context } from '@deepseek-ai/cordis';
/**
 * DSH_COMPAT_REMOVE(subagent-report-settlement-dedup)
 *
 * Temporary compatibility shim for DSH 0.1.0-rc.6. A continuable child is told
 * to report its result before finishing, while DSH also unconditionally sends
 * the same closing output in a `subagent-settled` notice. The report is often
 * still queued when the settlement reaches the parent, so the parent sees the
 * result once and the equivalent report remains as duplicate next-turn work.
 *
 * Remove this module, its installation in `src/index.ts`, and its focused test
 * once upstream coalesces an equivalent final report with settlement delivery.
 */
export declare const DSH_SUBAGENT_REPORT_DEDUP_COMPAT_MARKER: "__dshChatgptSubscriptionSubagentReportDedupCompatV1";
/**
 * Discard only an exact, same-child report duplicate immediately before DSH
 * delivers the corresponding settlement notice. Partial reports, reports with
 * different content, and all unrelated inbox work remain untouched.
 */
export declare function installSubagentReportDedupCompat(ctx: Context): () => void;
//# sourceMappingURL=subagent-report-scheduling-compat.d.ts.map