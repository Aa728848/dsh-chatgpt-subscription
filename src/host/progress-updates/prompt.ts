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
 * @module dsh-chatgpt-subscription/host/progress-updates/prompt
 */

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
 * 生成提示词分节的文本提供者。
 * @param isEnabled - 读取当前开关状态的函数（每次装配重新求值）。
 * @param language - 读取当前输出语言的函数；缺省按 `auto` 处理。
 * @returns 开关打开时返回引导词加语言指令，关闭时返回空串。
 */
export function progressSectionText(
  isEnabled: () => boolean,
  language: () => ProgressUpdateLanguage = () => 'auto',
): () => string {
  return () => (isEnabled() ? PROGRESS_GUIDANCE + '\n\n' + progressLanguageDirective(language()) : '')
}
