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
 * rather than as a raw key name, and the harness's own UI (which ships only
 * `zh`/`en`) keeps speaking English underneath — a native Russian DSH locale
 * would be a separate pack of its own.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { NS_ANTIGRAVITY } from '../antigravity/locales.ts'
import { NS_CLAUDE } from '../claude/locales.ts'
import { NS_CLINE_PASS } from '../cline-pass/locales.ts'
import { NS_COMMAND_CODE } from '../command-code/locales.ts'
import { NS_GLM_CODING_PLAN } from '../glm-coding-plan/locales.ts'
import { NS_KIMI_CODE } from '../kimi-code/locales.ts'
import { NS_MINIMAX_CODE } from '../minimax-code/locales.ts'
import { NS_OLLAMA } from '../ollama/locales.ts'
import { NS_OPENDESIGN } from '../opendesign/locales.ts'
import { NS_PROGRESS_UPDATES } from '../progress-updates/locales.ts'
import { NS_QODER } from '../qoder/locales.ts'
import { NS_STEP_CODE } from '../step-code/locales.ts'
import { NS_WORKBUDDY } from '../workbuddy/locales.ts'
import { NS } from '../locales.ts'
import { dictionary as antigravity } from './antigravity.ts'
import { dictionary as claude } from './claude.ts'
import { dictionary as clinePass } from './cline-pass.ts'
import { dictionary as commandCode } from './command-code.ts'
import { dictionary as glmCodingPlan } from './glm-coding-plan.ts'
import { dictionary as hub } from './hub.ts'
import { dictionary as kimiCode } from './kimi-code.ts'
import { dictionary as minimaxCode } from './minimax-code.ts'
import { dictionary as ollama } from './ollama.ts'
import { dictionary as openDesign } from './opendesign.ts'
import { dictionary as progressUpdates } from './progress-updates.ts'
import { dictionary as qoder } from './qoder.ts'
import { dictionary as stepCode } from './step-code.ts'
import { dictionary as workbuddy } from './workbuddy.ts'

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
        // Another language pack (such as @linxin666/dsh-i18n) may have already
        // registered Russian; keep going so our provider dictionaries still attach.
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
    [NS_ANTIGRAVITY, antigravity],
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
