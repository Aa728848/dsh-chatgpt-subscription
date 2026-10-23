/**
 * 模型可见的 progress_update 工具。
 *
 * 这是一个**不结束回合**的工具：它只把一条进展推给用户界面，随后模型继续
 * 干活。开关关闭时工具照常注册（否则工具清单会在会话中途变化），但 execute
 * 直接返回 `displayed:false` 而不是抛错——一条被关掉的汇报不该变成一次失败
 * 的工具调用。
 *
 * @module dsh-chatgpt-subscription/host/progress-updates/tool
 */

import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { nextUpdateId, type ProgressUpdate } from './store.ts'

/** 注册的工具名。冻结契约的一部分，不要改动。 */
export const NOTIFY_USER_TOOL = 'progress_update'

/** 工具关闭时返回给模型的文本（canonical 输出的 render，而不是抛错）。 */
export const DISABLED_OUTPUT_TEXT = 'Progress updates are disabled; the update was not displayed.'

/** 工具描述的最终全文。 */
export const PROGRESS_UPDATE_DESCRIPTION = [
  'Report progress to the user without ending your turn.',
  'Two updates are part of the job, not optional narration: send one BEFORE your first tool call of a multi-step task (the plan),'
    + ' and one BEFORE your final answer (what was done and what was verified).',
  'Use it during the rest of the work so the user can follow along and correct course early:',
  'state your plan near the beginning of the task (what you will do, and in what order);',
  'report a meaningful conclusion the moment you have it (a key fact, the root cause, a verified assumption) rather than narrating every step;',
  'give a stage judgement when one phase ends and the next begins (where things stand, what happens next);',
  'explain what you are waiting for before a long wait such as a test run, an install, or a build;',
  'and say what blocks you — and what you will try next, or what you need from the user — when you are stuck.',
  'Each update has one short title line (plain text, no Markdown, no trailing period) with the details in the message body.',
  'Do not repeat a status that has not changed.',
  'When you run as a subagent, describe only your own subtask: finishing your subtask is not the same as finishing the overall task.',
].join(' ')

/** 一条进展被接受之后，宿主侧要把新状态往回推（路由与面板据此渲染）。 */
export interface ProgressUpdateSink {
  /** 追加一条进展；返回它是否被真正展示。 */
  push(update: ProgressUpdate): boolean
}

/** 工具执行结果：canonical JSON，冻结契约的一部分。 */
export interface ProgressUpdateResult {
  /** 这条进展是否真的展示给了用户。 */
  displayed: boolean
}

/**
 * 构造 progress_update 工具。
 * @param deps - 依赖：当前开关与进展接收端。
 * @returns 可注册的工具定义。
 */
export function createProgressUpdateTool(deps: {
  /** 读取当前开关状态（每次调用重新求值）。 */
  isEnabled: () => boolean
  /** 进展接收端；未接线时返回 undefined，此时报告不会展示。 */
  sink?: () => ProgressUpdateSink | undefined
  /** 当前会话标识，写进进展的 source 字段。 */
  sourceOf?: (exec: unknown) => string | undefined
}): ToolDefinition {
  return defineTool({
    name: NOTIFY_USER_TOOL,
    description: PROGRESS_UPDATE_DESCRIPTION,
    parameters: {
      title: {
        type: 'string',
        description: 'One line, about 60 characters at most, in the user\'s language: plain text, no Markdown, no trailing period.',
      },
      message: {
        type: 'string',
        required: true,
        description: 'The details, about 1000 characters at most, in light Markdown: one paragraph of prose plus a few bullets. Tables are supported: when several items share fields, use a GFM pipe table (header row plus a | --- | separator row) instead of one item per line.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          displayed: { type: 'boolean', description: 'Whether the update was actually shown to the user.' },
        },
      },
      render(_args, value): ContentBlock[] {
        return [{
          type: 'text',
          text: value.displayed
            ? 'Progress update displayed.'
            : DISABLED_OUTPUT_TEXT,
        }]
      },
    },
    async execute(args, exec): Promise<ProgressUpdateResult> {
      if (!deps.isEnabled()) return { displayed: false }
      const sink = deps.sink?.()
      if (sink === undefined) return { displayed: false }
      const at = Date.now()
      const source = deps.sourceOf?.(exec)
      const update: ProgressUpdate = {
        id: nextUpdateId(at),
        message: args.message,
        at,
        ...(args.title === undefined || args.title.trim() === '' ? {} : { title: args.title.trim() }),
        ...(source === undefined ? {} : { source }),
      }
      return { displayed: sink.push(update) }
    },
  })
}
