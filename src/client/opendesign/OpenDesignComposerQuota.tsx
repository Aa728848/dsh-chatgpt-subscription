import type { ModelDirectoryState } from '@deepseek-ai/dsh-client-ui-model-selection/client'
import type { SnapshotStore } from '../store.ts'
import { ComposerQuotaBadge, type ComposerQuotaFacts } from '../common/ComposerQuotaBadge.tsx'
import type { OpenDesignWebStatus } from '../../shared/opendesign-contracts.ts'
import { OpenDesignApi } from './api.ts'
import { zh } from './locales.ts'

const API = new OpenDesignApi()

export interface OpenDesignComposerQuotaProps {
  directory: SnapshotStore<ModelDirectoryState>
  loadModelDirectory(): void
}

/**
 * The composer badge for this line.
 *
 * Only OAuth accounts carry a control key, so only they have a wallet reading
 * at all; the badge shows the primary (else first) readable account's latest
 * balance and never triggers a read of its own — a poll must not fan out one
 * upstream call per account. A pasted-key-only pool renders nothing.
 */
export function OpenDesignComposerQuota(props: OpenDesignComposerQuotaProps): React.JSX.Element {
  return <ComposerQuotaBadge
    directory={props.directory}
    loadModelDirectory={props.loadModelDirectory}
    providerId="opendesign"
    label={zh.composerLabel}
    readStatus={() => API.status()}
    selectFacts={selectOpenDesignFacts}
  />
}

/** The line's own number picker, exported so a test can pin the rule. */
export function selectOpenDesignFacts(
  status: OpenDesignWebStatus | null,
  _modelId?: string,
): ComposerQuotaFacts | null {
  if (status === null || !status.authenticated || status.usage === null) return null
  const readings = status.usage.accounts.filter((account) => account.ok && account.balanceUsd !== null)
  if (readings.length === 0) return null
  const primaryId = status.pool.activeAccountId ?? status.pool.accounts.find((account) => account.isPrimary)?.id
  const reading = readings.find((account) => account.accountId === primaryId) ?? readings[0]!
  const amount = reading.balanceUsd!
  const zero = Number(amount) === 0
  return {
    text: `$${amount}`,
    tooltip: `${reading.alias} · ${zh.usageReadAt.replace('{time}', new Date(reading.fetchedAt).toLocaleTimeString())}`,
    // An exactly-zero wallet fails the next request outright; anything else is
    // a balance, not a warning threshold this line gets to invent.
    level: zero ? 'danger' : 'normal',
  }
}
