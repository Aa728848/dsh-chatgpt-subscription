/**
 * 系统提示词引导：让模型知道「多步任务里要主动汇报进展」这件事该怎么用。
 *
 * 文本用函数形式提供（而不是静态字符串）：开关关闭时返回空串，装配期就地
 * 抹掉引导，不需要重启会话、也不需要重挂插件行。
 *
 * ## 为什么是英文
 *
 * 提示词是写给模型看的，不是写给用户看的：同一段要求在英文下最短、歧义最少，
 * 也和工具描述（`tool.ts` 的 `PROGRESS_UPDATE_DESCRIPTION`，本来就是英文）保持
 * 同一套措辞。用户看到的语言由 {@link progressLanguageDirective} 单独钉住——
 * 「指令用英文」与「输出用中文」是两件事，不要混在一起。
 *
 * ## 分节恒定，语言覆盖走尾部消息
 *
 * 这一段分节属于**缓存前缀的第一段**：会话中途改一个字，harness 就会就地替换
 * 最早那条 system 消息，整段前缀作废——在按内容前缀计费的线路上（Kimi Code），
 * 一次改写就是一次全价重建。所以：
 *
 * - 分节文本**恒为通用档位**（跟随用户语言），与任何设置无关，逐字节不变；
 * - zh/en 的固定语言要求、以及切回 auto 的撤销，都由 {@link resolveLanguageNotice}
 *   判定成一条**尾部用户消息**投递：末尾追加不改已发前缀。
 *
 * @module dsh-chatgpt-subscription/host/progress-updates/prompt
 */
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'

/**
 * 本模块提示词分节的名称，全局唯一（重复注册会抛错）。
 *
 * 保留原插件的 `plugin:progress-updates` 拼写：会话里已有的分节名不能因为搬家
 * 而变成第二个分节。
 */
export const PROGRESS_SECTION_NAME = 'plugin:progress-updates'

/**
 * 引导词在提示词里的排序位。插件族占用的区间在部署人设之后、SDK 的
 * PLAN_POLICY(500) 之前；这里取 220，紧跟 ssh(150) 与 task-board(200) 之后，
 * 不与它们并列。
 */
export const PROGRESS_SECTION_ORDER = 220

/**
 * 进展更新的输出语言。
 *
 * - `auto`：跟随对话语言（默认）；
 * - `zh`：一律中文；
 * - `en`：一律英文。
 *
 * 只管 `progress_update` 的标题与正文，不影响会话里其它任何输出。
 */
export type ProgressUpdateLanguage = 'auto' | 'zh' | 'en'

/** 允许的取值，供设置解析做白名单校验（配置里写错就等于没写）。 */
export const PROGRESS_UPDATE_LANGUAGES: readonly ProgressUpdateLanguage[] = ['auto', 'zh', 'en']

/**
 * 引导词正文。写法对齐 Kimi 的「进展更新」：先说清多步任务早期的思路，再报
 * 有意义的结论、阶段判断、长等待与阻塞；每条给一行标题，细节放正文；不重复
 * 没有变化的状态。开头与结尾两条被提成硬要求——没有它们，面板在任务的两端
 * 都是空的。
 */
export const PROGRESS_GUIDANCE = [
  '## Progress updates',
  '',
  'During multi-step work you can call `progress_update` to report progress without ending your turn and without spending a question: report, then keep working.',
  '',
  '**Two updates are mandatory — missing either one means the job is not finished:**',
  '',
  '- **Opening**: before the first tool call of the task, send one update stating the plan (which steps, what you touch first). The user must be able to redirect you before you disappear into execution.',
  '- **Closing**: after the work is done and before your final answer, send one update stating the result (what changed, what was verified, what is left). The panel and the conversation both close on this line.',
  '',
  'Beyond those two, these moments are worth a report:',
  '- **Early planning**: the opening update covers it; report again only when the plan really changes (different approach, smaller scope, a broken premise).',
  '- **A meaningful conclusion**: a key fact, a root cause, a verified assumption — report the conclusion itself, not "I just read a file".',
  '- **A stage judgement**: one phase ends and the next begins — one line on where things stand and what happens next.',
  '- **Before a long wait**: a test run, an install, a build — say what you are waiting for and roughly how long.',
  '- **When blocked**: missing information, missing permission, an external failure — say where you are stuck, what you will try next, or what you need from the user.',
  '',
  'How to write one:',
  '- One short title line (plain text, no Markdown, no trailing period); the details go in the message body.',
  '- The body uses light Markdown: one paragraph of prose plus a few bullets. **When several rows share fields, use a GFM pipe table** (header row plus a `| --- |` separator row) instead of one item per line.',
  '- Do not repeat a status that has not changed: if the last update already said it is running, it needs no second report.',
  '- A progress update is for the user, not for the log: write it in human words, do not restate tool arguments.',
  '',
  'When you run as a subagent: describe only your own subtask progress. Finishing your subtask is not the same as finishing the overall task — do not report the overall progress as done.',
].join('\n')

/**
 * 每个语言档位对应的一句指令。
 *
 * 只约束输出的标题与正文，不约束引导词本身；三条都必须自洽——`auto` 不许在
 * 用户说中文时滑回英文，`zh`/`en` 则明确压过对话语言。
 */
export const PROGRESS_LANGUAGE_DIRECTIVES: Readonly<Record<ProgressUpdateLanguage, string>> = {
  auto: 'Write the title and the message of every progress update in the language the user is writing in, whatever it is. Follow the conversation; do not fall back to English unless the user does.',
  zh: 'Write the title and the message of every progress update in Simplified Chinese, even when the conversation is in another language.',
  en: 'Write the title and the message of every progress update in English, even when the conversation is in another language.',
}

/**
 * 取一个语言档位的指令文本；未知取值按 `auto` 处理。
 * @param language - 配置里读到的语言档位。
 * @returns 追加到引导词末尾的一句指令。
 */
export function progressLanguageDirective(language: ProgressUpdateLanguage): string {
  return PROGRESS_LANGUAGE_DIRECTIVES[language] ?? PROGRESS_LANGUAGE_DIRECTIVES.auto
}

/**
 * 系统提示词分节里**恒定**的那条语言指令。
 *
 * 分节文本属于缓存前缀的第一段：会话中途改一个字，harness 就会就地替换最早那条
 * system 消息，整段前缀作废（Kimi Code 按内容前缀命中，一次改写就是一次全价
 * 重建）。所以分节里只放**跟随用户语言**这一条通用指令——它与设置无关，逐字节
 * 恒定。zh/en 的固定语言要求改由**尾部消息**投递（见
 * {@link languageOverrideNoticeText}）：末尾追加不改已发前缀。
 */
export const FIXED_LANGUAGE_DIRECTIVE = PROGRESS_LANGUAGE_DIRECTIVES.auto

/**
 * 生成提示词分节的文本提供者。
 *
 * **不接受任何开关或语言参数**：分节文本必须在整个会话里逐字节恒定。开关的语义
 * 只留给工具自己（关闭时 `execute` 直接返回 `displayed:false`）；语言档位
 * （zh/en）走尾部消息，不进分节。
 * @returns 引导词加通用语言指令。
 */
export function progressSectionText(): () => string {
  return () => PROGRESS_GUIDANCE + '\n\n' + FIXED_LANGUAGE_DIRECTIVE
}

/**
 * 语言覆盖通知的消息来源 kind。
 *
 * 与本插件其它注入的用户消息同形（`plan-mode-notice` / `progress-updates-nudge`），
 * 便于客户端与日志把「这是一条通知」与「这是一条真人输入」分开。
 */
export const LANGUAGE_NOTICE_SOURCE_KIND = 'progress-updates-language'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** 进展更新的输出语言覆盖通知（切到 zh/en，或切回 auto）。 */
    'progress-updates-language': { kind: 'progress-updates-language' } & { form?: 'notice', summary?: string }
  }
}

/**
 * 「固定语言」覆盖通知的正文。
 *
 * 覆盖的是分节里那条通用指令（跟随用户语言），所以正文里明确写了「压过它」。
 * @param language - 要覆盖成的语言档位（zh/en）。
 * @returns 通知正文。
 */
export function languageOverrideNoticeText(language: ProgressUpdateLanguage): string {
  return 'Progress update output language override: ' + progressLanguageDirective(language)
    + ' This overrides the default instruction to write progress updates in the language the user is writing in;'
    + ' it applies to every progress update from now on.'
}

/**
 * 撤销覆盖、切回「跟随用户语言」的通知正文。
 *
 * 必须单独通知：模型还记得「一律用中文」，不撤销它就会一直用中文。
 * @returns 通知正文。
 */
export function languageDefaultNoticeText(): string {
  return 'Progress update output language override ended: write the title and the message of every progress update'
    + ' in the language the user is writing in again (any earlier instruction to always use one fixed language'
    + ' no longer applies).'
}

/**
 * 造一条语言通知消息。
 *
 * 用 DSH 自己的消息工厂而不是手写字面量：DSH 对每条被接纳的消息都校验 id 与
 * source，手写字面量会在第一次被追加时同步抛错。
 * @param text - 通知正文。
 * @param summary - 通知摘要（写进消息来源，便于日志辨认）。
 * @returns 用户角色的通知消息。
 */
export function createLanguageNotice(text: string, summary: string): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: LANGUAGE_NOTICE_SOURCE_KIND, form: 'notice', summary },
  })
}

/**
 * 一次语言通知判定的结果。
 */
export interface LanguageNoticeOutcome {
  /** 要追加的通知；undefined 表示这一步不需要通知。 */
  readonly notice?: { readonly text: string, readonly summary: string }
  /** 判定之后模型应当记住的语言档位。 */
  readonly remembered: ProgressUpdateLanguage
}

/**
 * 判定这一轮要不要追加一条语言通知。
 *
 * 规则只有一条：**模型当前知道的语言档位与设置里的不一致时才通知**。
 *
 * - 模型起始只知道分节里的通用档位（跟随用户语言），所以第一次设成 zh/en 时
 *   通知一次；
 * - 同一个档位重复设置不重复通知（每一步都重读设置，但只在**变化**时投递）；
 * - 切回 auto 也要通知：模型还记得「一律用中文」，不撤销它就会一直用中文。
 *
 * @param current - 设置里当前的语言档位。
 * @param remembered - 模型已经知道的语言档位；undefined 表示只知道通用档位。
 * @returns 通知与新的「已知档位」。
 */
export function resolveLanguageNotice(
  current: ProgressUpdateLanguage,
  remembered: ProgressUpdateLanguage | undefined,
): LanguageNoticeOutcome {
  const known = remembered ?? 'auto'
  if (current === known) return { remembered: current }
  if (current === 'auto') {
    return {
      notice: { text: languageDefaultNoticeText(), summary: 'progress update language: auto' },
      remembered: 'auto',
    }
  }
  return {
    notice: { text: languageOverrideNoticeText(current), summary: `progress update language: ${current}` },
    remembered: current,
  }
}
