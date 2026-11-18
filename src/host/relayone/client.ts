import type { RelayOneConnectionDto } from '../../shared/relayone-contracts.ts'
import type { RelayOneCatalogManager } from './catalog-manager.ts'

/** Explicit connectivity check: authenticates through the real model listing, never a paid generation. */
export async function testRelayOneConnection(catalog: RelayOneCatalogManager): Promise<RelayOneConnectionDto> {
  const startedAt = Date.now()
  await catalog.refresh(true)
  const snapshot = catalog.snapshot()
  const groups = catalog.dto().groups
  return {
    connected: snapshot.error === null && snapshot.state === 'ready',
    latencyMs: Date.now() - startedAt,
    checkedAt: Date.now(),
    modelCount: snapshot.entries.filter(entry => entry.kind === 'chat').length,
    groups,
    ...(snapshot.error === null ? {} : { error: snapshot.error }),
  }
}
