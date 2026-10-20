import type { ModelDirectoryState } from '@deepseek-ai/dsh-client-ui-model-selection/client'
import type { SnapshotStore } from '../store.ts'
import { ComposerQuotaBadge, quotaLevel, type ComposerQuotaFacts } from '../common/ComposerQuotaBadge.tsx'
import type { ClinePassWebStatus } from '../../shared/cline-pass-contracts.ts'
import { ClinePassApi } from './api.ts'
import { zh } from './locales.ts'

const API = new ClinePassApi()

export interface ClinePassComposerQuotaProps {
  directory: SnapshotStore<ModelDirectoryState>
  loadModelDirectory(): void
}

/**
 * The composer badge for this line.
 *
 * Quota follows the ACCOUNT, and a pool has several. The badge therefore shows
 * the most-consumed window across the accounts the host has already read, which
 * is the one that will stop the next request first; it never triggers a quota
 * read of its own, so a poll cannot fan out one upstream call per account.
 */
export function ClinePassComposerQuota(props: ClinePassComposerQuotaProps): React.JSX.Element {
  return <ComposerQuotaBadge
    directory={props.directory}
    loadModelDirectory={props.loadModelDirectory}
    providerId="cline-pass"
    label={zh.composerLabel}
    readStatus={() => API.status()}
    selectFacts={selectClinePassFacts}
  />
}

/** The line's own number picker, exported so a test can pin the rule. */
export function selectClinePassFacts(
  status: ClinePassWebStatus | null,
  _modelId?: string,
): ComposerQuotaFacts | null {
  if (status === null || !status.authenticated || status.usage === null) return null
  const windows = status.usage.accounts
    .filter((account) => account.ok)
    .flatMap((account) => account.windows.map((window) => ({ account: account.alias, window })))
  if (windows.length === 0) return null
  const worst = windows.reduce((left, right) => (
    right.window.percentUsed > left.window.percentUsed ? right : left
  ))
  const remaining = Math.max(0, Math.min(100, 100 - worst.window.percentUsed))
  return {
    text: `${Math.round(remaining)}%`,
    tooltip: `${worst.account} · ${worst.window.label} · 已用 ${Math.round(worst.window.percentUsed)}%${worst.window.resetsAt === '' ? '' : ` · 重置 ${worst.window.resetsAt}`}`,
    level: quotaLevel(remaining),
  }
}
