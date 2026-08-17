import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'

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
export const DSH_SUBAGENT_REPORT_DEDUP_COMPAT_MARKER =
  '__dshChatgptSubscriptionSubagentReportDedupCompatV1' as const

type Delivery = Agent['followup']
type Message = Parameters<Delivery>[0]
type DeliveryName = 'followup' | 'steer' | 'inject'

interface SharedPatchRecord {
  originals: Record<DeliveryName, Delivery>
  wrappers: Record<DeliveryName, Delivery>
  owners: number
}

type MarkedDelivery = Delivery & {
  [DSH_SUBAGENT_REPORT_DEDUP_COMPAT_MARKER]?: SharedPatchRecord
}

interface SourceLike {
  kind?: unknown
  senderSessionId?: unknown
}

function sourceOf(message: Message): SourceLike {
  return message.source as SourceLike
}

function isTextBlock(value: unknown, text: string): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { type?: unknown }).type === 'text' &&
    (value as { text?: unknown }).text === text
  )
}

function sameValue(left: unknown, right: unknown): boolean {
  if (left === right) return true
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => sameValue(value, right[index]))
    )
  }
  if (typeof left !== 'object' || left === null || typeof right !== 'object' || right === null) return false

  const leftRecord = left as Record<string, unknown>
  const rightRecord = right as Record<string, unknown>
  const leftKeys = Object.keys(leftRecord).sort()
  const rightKeys = Object.keys(rightRecord).sort()
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every((key, index) => key === rightKeys[index] && sameValue(leftRecord[key], rightRecord[key]))
  )
}

function duplicatePendingReports(agent: Agent, settlement: Message): Message[] {
  const settlementSource = sourceOf(settlement)
  if (settlementSource.kind !== 'subagent-settled' || settlementSource.senderSessionId === undefined) return []
  if (settlement.content.length < 2 || !isTextBlock(settlement.content[1], 'Its closing message:')) return []

  const closingContent = settlement.content.slice(2)
  return [...agent.inbox.nextStep, ...agent.inbox.nextTurn].filter((pending) => {
    const pendingSource = sourceOf(pending)
    return (
      pendingSource.kind === 'subagent-report' &&
      pendingSource.senderSessionId === settlementSource.senderSessionId &&
      sameValue(pending.content.slice(1), closingContent)
    )
  })
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Discard only an exact, same-child report duplicate immediately before DSH
 * delivers the corresponding settlement notice. Partial reports, reports with
 * different content, and all unrelated inbox work remain untouched.
 */
export function installSubagentReportDedupCompat(ctx: Context): () => void {
  const patches = new Map<Agent, SharedPatchRecord>()

  const patch = (agent: Agent): void => {
    if (patches.has(agent)) return

    const shared = (agent.followup as MarkedDelivery)[DSH_SUBAGENT_REPORT_DEDUP_COMPAT_MARKER]
    if (
      shared?.wrappers.followup === agent.followup &&
      shared.wrappers.steer === agent.steer &&
      shared.wrappers.inject === agent.inject
    ) {
      shared.owners += 1
      patches.set(agent, shared)
      return
    }

    const originals = {
      followup: agent.followup,
      steer: agent.steer,
      inject: agent.inject,
    }
    let record: SharedPatchRecord
    const deliver = (name: DeliveryName, message: Message): void => {
      for (const duplicate of duplicatePendingReports(agent, message)) {
        try {
          agent.inbox.remove(duplicate.id)
        } catch (error) {
          ctx.logger.warn(
            '[dsh-chatgpt-subscription] Could not discard a duplicate DSH subagent report: ' +
              errorMessage(error),
          )
        }
      }
      originals[name].call(agent, message)
    }
    const wrappers: Record<DeliveryName, MarkedDelivery> = {
      followup(message) {
        deliver('followup', message)
      },
      steer(message) {
        deliver('steer', message)
      },
      inject(message) {
        deliver('inject', message)
      },
    }
    record = { originals, wrappers, owners: 1 }
    for (const wrapper of Object.values(wrappers)) {
      Object.defineProperty(wrapper, DSH_SUBAGENT_REPORT_DEDUP_COMPAT_MARKER, { value: record })
    }

    try {
      agent.followup = wrappers.followup
      agent.steer = wrappers.steer
      agent.inject = wrappers.inject
      patches.set(agent, record)
    } catch (error) {
      record.owners = 0
      for (const name of ['followup', 'steer', 'inject'] as const) {
        if (agent[name] === wrappers[name]) {
          try {
            agent[name] = originals[name]
          } catch {
            // Best-effort rollback; an inactive wrapper delegates to the original.
          }
        }
      }
      ctx.logger.warn(
        '[dsh-chatgpt-subscription] Could not install temporary DSH subagent dedup compatibility: ' +
          errorMessage(error),
      )
    }
  }

  const unpatch = (agent: Agent): void => {
    const record = patches.get(agent)
    if (!record) return
    patches.delete(agent)
    record.owners -= 1
    if (record.owners > 0) return

    for (const name of ['followup', 'steer', 'inject'] as const) {
      // Do not overwrite a wrapper installed by another plugin after ours.
      if (agent[name] !== record.wrappers[name]) continue
      try {
        agent[name] = record.originals[name]
      } catch (error) {
        ctx.logger.warn(
          '[dsh-chatgpt-subscription] Could not remove temporary DSH subagent dedup compatibility: ' +
            errorMessage(error),
        )
      }
    }
  }

  for (const agent of ctx.agents.list()) patch(agent)
  const disposeCreated = ctx.on('agent/created', ({ agent }) => patch(agent))
  const disposeDisposed = ctx.on('agent/disposed', ({ agent }) => unpatch(agent))

  return () => {
    disposeDisposed()
    disposeCreated()
    for (const agent of [...patches.keys()]) unpatch(agent)
  }
}
