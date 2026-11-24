/**
 * Russian language pack for this plugin's own settings surface.
 *
 * `@deepseek-ai/dsh-client-locale` has one registration form for a whole
 * namespace-bilingual dictionary (`register(ns, { zh, en })`, both shipped
 * locales required) and a single-locale form for everything a language pack
 * contributes. Russian goes through the second path: the language definition
 * first, then one dictionary per namespace.
 *
 * The declared fallback is `en`, so a key this pack misses reads as English
 * rather than as a raw key name. DSH 0.2.2 ships its own Russian UI locale;
 * this pack remains responsible only for the plugin-owned namespaces below.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { NS_CLAUDE } from '../providers/claude/locales.ts'
import { NS_CLINE_PASS } from '../providers/cline-pass/locales.ts'
import { NS_COMMAND_CODE } from '../providers/command-code/locales.ts'
import { NS_GLM_CODING_PLAN } from '../providers/glm-coding-plan/locales.ts'
import { NS_KIMI_CODE } from '../providers/kimi-code/locales.ts'
import { NS_MINIMAX_CODE } from '../providers/minimax-code/locales.ts'
import { NS_OLLAMA } from '../providers/ollama/locales.ts'
import { NS_ANTIGRAVITY_ACP } from '../providers/antigravity-acp/locales.ts'
import { NS_OPENDESIGN } from '../providers/opendesign/locales.ts'
import { NS_DISPATCH_LEDGER } from '../features/dispatch-ledger/locales.ts'
import { NS_PROGRESS_UPDATES } from '../features/progress-updates/locales.ts'
import { NS_QODER } from '../providers/qoder/locales.ts'
import { NS_STEP_CODE } from '../providers/step-code/locales.ts'
import { NS_WORKBUDDY } from '../providers/workbuddy/locales.ts'
import { NS_QIANWEN } from '../providers/qianwen-token-plan/locales.ts'
import { NS_RELAYONE } from '../providers/relayone/locales.ts'
import { NS_CLAUDE_API } from '../providers/claude-api/locales.ts'
import { NS_AWS_QUICK } from '../providers/aws-quick/locales.ts'
import { NS_COMPACT_AFTER_TURN } from '../features/compact-after-turn/locales.ts'
import { NS_SESSION_QUOTA } from '../features/session-quota/locales.ts'
import { NS } from '../providers/codex-chatgpt/locales.ts'
import { NS_MODEL_CHECKLIST } from '../common/model-checklist-labels.ts'
import { dictionary as claude } from './claude.ts'
import { dictionary as clinePass } from './cline-pass.ts'
import { dictionary as commandCode } from './command-code.ts'
import { dictionary as glmCodingPlan } from './glm-coding-plan.ts'
import { dictionary as hub } from './hub.ts'
import { dictionary as kimiCode } from './kimi-code.ts'
import { dictionary as minimaxCode } from './minimax-code.ts'
import { dictionary as ollama } from './ollama.ts'
import { dictionary as antigravityAcp } from './antigravity-acp.ts'
import { dictionary as openDesign } from './opendesign.ts'
import { dictionary as dispatchLedger } from './dispatch-ledger.ts'
import { dictionary as progressUpdates } from './progress-updates.ts'
import { dictionary as qoder } from './qoder.ts'
import { dictionary as stepCode } from './step-code.ts'
import { dictionary as workbuddy } from './workbuddy.ts'
import { dictionary as qianwen } from './qianwen-token-plan.ts'
import { dictionary as relayOne } from './relayone.ts'
import { dictionary as claudeApi } from './claude-api.ts'
import { dictionary as awsQuick } from './aws-quick.ts'
import { dictionary as compactAfterTurn } from './compact-after-turn.ts'
import { dictionary as sessionQuota } from './session-quota.ts'
import { dictionary as modelChecklist } from './model-checklist.ts'

/** Language id of this pack: the value stored as `locale.preference`. */
export const RU_LOCALE = 'ru'

/**
 * Register the Russian language and every dictionary it covers.
 *
 * The runtime lives in `locale`, which the client plugin already injects, so
 * this cannot be mounted without it.
 *
 * @param ctx - client plugin context owning the locale service.
 */
export function installRussianLocale(ctx: ClientContext): void {
  // `addLanguage` arrived with the language-pack half of the locale contract. A
  // harness generation without it cannot offer the language at all, so the
  // dictionaries would be unreachable — skip the pack instead of failing the
  // whole client plugin on a service that simply lacks the seam.
  if (typeof ctx.locale?.addLanguage !== 'function') return

  ctx.effect(
    () => {
      try {
        return ctx.locale.addLanguage({ id: RU_LOCALE, label: 'Русский', fallback: 'en' })
      } catch {
        // DSH 0.2.2 or another language pack may already have registered Russian;
        // keep going so our provider dictionaries still attach.
        return () => {}
      }
    },
    'dsh-chatgpt-subscription: ru language',
  )

  // Namespace to dictionary. Order follows the hub card order so a gap in one
  // line is easy to spot next to its neighbours.
  const dictionaries: Array<readonly [string, Record<string, string>]> = [
    [NS, hub],
    [NS_CLAUDE, claude],
    [NS_COMMAND_CODE, commandCode],
    [NS_KIMI_CODE, kimiCode],
    [NS_MINIMAX_CODE, minimaxCode],
    [NS_GLM_CODING_PLAN, glmCodingPlan],
    [NS_OLLAMA, ollama],
    [NS_STEP_CODE, stepCode],
    [NS_CLINE_PASS, clinePass],
    [NS_QODER, qoder],
    [NS_OPENDESIGN, openDesign],
    [NS_PROGRESS_UPDATES, progressUpdates],
    // Appended, never inserted: a new line joins the end of the list so the
    // registration order of the lines that were already shipped never moves.
    [NS_WORKBUDDY, workbuddy],
    [NS_DISPATCH_LEDGER, dispatchLedger],
    // Antigravity（ACP）：追加在末尾，既有命名空间的注册顺序一律不动。
    [NS_ANTIGRAVITY_ACP, antigravityAcp],
    [NS_QIANWEN, qianwen],
    [NS_RELAYONE, relayOne],
    [NS_CLAUDE_API, claudeApi],
    [NS_AWS_QUICK, awsQuick],
    [NS_COMPACT_AFTER_TURN, compactAfterTurn],
    [NS_SESSION_QUOTA, sessionQuota],
    [NS_MODEL_CHECKLIST, modelChecklist],
  ]

  for (const [ns, dictionary] of dictionaries) {
    ctx.effect(
      () => {
        try {
          return ctx.locale.register(ns, RU_LOCALE, dictionary)
        } catch {
          // In case another pack already contributed this namespace's Russian text.
          return () => {}
        }
      },
      `dsh-chatgpt-subscription: ru dictionary ${ns}`,
    )
  }
}
