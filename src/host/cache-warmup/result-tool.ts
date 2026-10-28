/**
 * 模型可见的 `cache_warmup_result` 工具：对一条被投影过的结果做**精确补读**。
 *
 * 投影把超大结果换成预览，预览里带一个 `ref://<session>/<sha256>` 引用。这个
 * 工具就是那条引用的唯一读法，两个动作：
 *
 * - `page`：读一段。参数与共享的 `ResultReferenceStore.page` 逐字对齐
 *   （`sessionId` / `refId` / `offset` / `limit` / `maxBytes` / `fields` /
 *   `equals`），回来的永远是一页带 `complete` / `nextOffset` / `omitted` 的结构
 *   —— 模型必须能从返回值本身看出「读完了没有」，而不是猜。
 * - `release`：丢掉服务端的那份存储。释放之后历史里的 preview 与 refId **不变**
 *   （它们是历史的一部分），变的只是"补读不到了"。
 *
 * 三条不变量写在这个文件里：
 *
 * 1. **越权拒绝**：执行时再校验一次当前 provider 与 session。会话变了（换了线路、
 *    子会话拿到了父会话的引用）就返回结构化错误，**不去问存储**——一条被拒绝的
 *    调用不该在别人的引用上留下任何痕迹。
 * 2. **错误是值，不是异常**：开关关闭、存储缺席、引用不存在，全都返回 `ok:false`
 *    的规范值。一次「补读不到」不该变成一次失败的工具调用。存储自己抛的错误码
 *    （`SESSION_MISMATCH` / `REFERENCE_INVALID` / …）原样透传，别压成一个笼统的
 *    "读失败"，模型按码能自己纠正参数。
 * 3. **不手写模型消息**：输出走 `defineTool` 的 `output.schema` + `render`，
 *    由宿主决定怎么落到对话里。
 *
 * @module dsh-chatgpt-subscription/host/cache-warmup/result-tool
 */

import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ResultReferenceStore } from './index.ts'
import type { CacheWarmupRoute } from './install.ts'
import type { CacheWarmupLogEvent } from './logging.ts'

/** 注册的工具名。冻结契约的一部分，不要改动。 */
export const CACHE_WARMUP_RESULT_TOOL = 'cache_warmup_result'

/** 工具认识的两个动作。 */
export type CacheWarmupResultAction = 'page' | 'release'

/**
 * 页请求的形状，从共享存储的方法签名上**推导**出来。
 *
 * 不在本文件里抄一份：核心侧调参时编译期就会在这里报错，而不是等到运行时才
 * 发现少传了一个 `maxBytes`。字段名本身来自共享约定，不随实现漂移。
 */
type PageRequest = Parameters<NonNullable<ResultReferenceStore['page']>>[0]

/** 释放请求的形状，同样从存储签名推导。 */
type ReleaseRequest = Parameters<NonNullable<ResultReferenceStore['release']>>[0]

/** 工具返回的规范值。 */
export interface CacheWarmupResultValue {
  /** 这次调用是否成功。失败的细节在 `error` 里。 */
  ok: boolean
  /** 回显动作，便于模型确认自己调的是哪一个。 */
  action: CacheWarmupResultAction
  /** 被读/被释放的引用。 */
  refId: string
  /** 引用所属会话（执行时校验过）。 */
  sessionId: string
  /** page：这一次是否已经读到结尾。 */
  complete?: boolean
  /** page：本页实际的起始位置（与请求同一单位）。 */
  offset?: number
  /** page：下一次应继续的位置；`complete` 为真时不出现。 */
  nextOffset?: number
  /** page：本页之外还剩多少字符没给出。 */
  omitted?: number
  /** page：本页正文的字符数。 */
  chars?: number
  /** page：原文总字符数（模型据此知道还剩多少要看）。 */
  totalChars?: number
  /** release：是否真的释放掉了。 */
  released?: boolean
  /** page：本页正文。 */
  text?: string
  /** 失败时的结构化错误。 */
  error?: {
    /** 稳定的错误码，调用方按它分支。 */
    code: string
    /** 给模型看的一句话说明（不含原文）。 */
    message: string
  }
}

/** 工具依赖。 */
export interface CacheWarmupResultToolDeps {
  /** 本工具只为这一条线路服务（由安装方注入，工具自己不认识 provider 名字）。 */
  readonly provider: string
  /** 读一次执行所属的线路；每次执行重读，不缓存。 */
  readonly routeOf: (exec: unknown) => CacheWarmupRoute
  /** 结果引用存储；缺席时工具照常存在，只是每次都返回结构化错误。 */
  readonly store: () => ResultReferenceStore | undefined
  /** 指标日志出口（由安装方接上 logger；测试里可以换成断言用的收集器）。 */
  readonly log?: (event: CacheWarmupLogEvent) => unknown
}

/** 是不是一个可用的非负整数。 */
function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/** 读一个未知值为有限数字（`null` 不算：契约用 `null` 表示"没有下一页"）。 */
function numberOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** 读一个未知值为布尔。 */
function booleanOf(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

/** 读一个未知值为非空字符串。 */
function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/**
 * 从存储交回来的 `omitted` 里读出省略字符数。
 *
 * 契约给的是一个结构化对象（`{ reason, chars, lines, rows, bytes }`，`reason: 'none'`
 * 表示这一页就是全部）；这里同时容忍一个裸数字，因为"省略了多少字符"是唯一
 * 模型真正需要的那个数，而形状变化不该让整页读取失败。
 * @param value - 存储返回的 `omitted`。
 * @returns 省略的字符数；读不到时 undefined。
 */
function omittedCharsOf(value: unknown): number | undefined {
  const direct = numberOf(value)
  if (direct !== undefined) return direct
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as { chars?: unknown }
  return numberOf(record.chars)
}

/**
 * 造一个失败值。
 * @param action - 回显的动作。
 * @param refId - 被拒绝的引用。
 * @param sessionId - 当前会话（拿不到时为空串）。
 * @param code - 稳定错误码。
 * @param message - 一句话说明。
 * @returns 规范值。
 */
function failure(
  action: CacheWarmupResultAction,
  refId: string,
  sessionId: string,
  code: string,
  message: string,
): CacheWarmupResultValue {
  return { ok: false, action, refId, sessionId, error: { code, message } }
}

/**
 * 把未知异常压成一句不含原文的话。
 *
 * 异常消息里可能带着被读取内容的片段（解析错误最常见），所以只取消息的第一行，
 * 长度也截断——工具输出不该成为原文的第二条出口。
 * @param error - 捕获到的值。
 * @returns 一句话描述。
 */
function describe(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  const firstLine = message.split('\n', 1)[0] ?? ''
  return firstLine.length > 160 ? firstLine.slice(0, 157) + '...' : firstLine
}

/**
 * 取结构化错误码：存储自己的码优先，否则用本工具给的兜底码。
 * @param error - 捕获到的值。
 * @param fallback - 兜底码。
 * @returns 错误码。
 */
function errorCodeOf(error: unknown, fallback: string): string {
  const code = (error as { code?: unknown } | null | undefined)?.code
  return typeof code === 'string' && code !== '' ? code : fallback
}

/**
 * 把共享存储交回来的页读成规范值。
 *
 * 字段一律按「读得到就用、读不到就不出现」处理：核心侧多给字段不会让这里报错，
 * 少给字段也不会伪造一个 `complete:true`——「不确定是否读完」必须表现成
 * `complete:false`，把 partial 伪装成完整是这条路线上最贵的一种错。
 * @param raw - 存储的返回值（`ResultPage`，按共享约定结构化读取）。
 * @param refId - 引用。
 * @param sessionId - 会话。
 * @returns 规范值。
 */
function pageValue(raw: unknown, refId: string, sessionId: string): CacheWarmupResultValue {
  const page = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  // 契约把正文放在 `content`；`text` 是宽松读法，兼容一个只给正文的实现。
  const text = stringOf(page.content) ?? stringOf(page.text)
  const complete = booleanOf(page.complete) === true
  const offset = numberOf(page.offset)
  // 契约用 `null` 表示"没有下一页"：`numberOf(null)` 是 undefined，正好落成"不出现"。
  const nextOffset = complete ? undefined : numberOf(page.nextOffset)
  const omitted = omittedCharsOf(page.omitted)
  const totalChars = numberOf(page.totalChars)
  return {
    ok: true,
    action: 'page',
    refId,
    sessionId,
    complete,
    ...(offset === undefined ? {} : { offset }),
    ...(nextOffset === undefined ? {} : { nextOffset }),
    ...(omitted === undefined ? {} : { omitted }),
    ...(totalChars === undefined ? {} : { totalChars }),
    ...(text === undefined ? {} : { text, chars: text.length }),
  }
}

/**
 * 造 `cache_warmup_result` 工具。
 * @param deps - 依赖：线路校验、存储读取、指标日志。
 * @returns 可注册的工具定义。
 */
export function createCacheWarmupResultTool(deps: CacheWarmupResultToolDeps): ToolDefinition {
  /** 发一条日志；安装方没接线时什么也不做。 */
  const log = (event: CacheWarmupLogEvent): void => {
    try {
      deps.log?.(event)
    } catch {
      // 日志失败不该影响一次读取。
    }
  }

  return defineTool({
    name: CACHE_WARMUP_RESULT_TOOL,
    description: [
      'Read back a result that was replaced by a preview, using the `ref://<session>/<sha256>` handle written in that preview.',
      'Use `action: "page"` to read a slice: pass `offset`, and optionally `limit`, `maxBytes`, `fields` and `equals`.',
      'Every page reports `complete`, `nextOffset`, `omitted` and `totalChars`, so you can see whether more remains instead of assuming a slice is the whole thing.',
      'Use `action: "release"` when the stored copy is no longer needed.',
    ].join(' '),
    parameters: {
      action: {
        type: 'string',
        required: true,
        description: 'page reads a slice of the stored result; release drops the stored copy.',
        enum: ['page', 'release'],
      },
      refId: {
        type: 'string',
        required: true,
        description: 'The `ref://<session>/<sha256>` handle exactly as written in the preview.',
      },
      offset: {
        type: 'integer',
        description: 'Where to start: a UTF-8 byte offset for text results, a row index for structured ones.',
      },
      limit: {
        type: 'integer',
        description: 'Maximum number of rows for a structured result.',
      },
      maxBytes: {
        type: 'integer',
        description: 'Byte budget for this page; the store returns less when the budget is smaller.',
      },
      fields: {
        type: 'array',
        items: { type: 'string' },
        description: 'Restrict a structured result to these fields.',
      },
      equals: {
        type: 'object',
        additionalProperties: true,
        description: 'Keep only structured rows whose named field equals the given string.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', description: 'Whether the call succeeded.' },
          action: { type: 'string', enum: ['page', 'release'], description: 'The action that ran.' },
          refId: { type: 'string', description: 'The handle this call addressed.' },
          sessionId: { type: 'string', description: 'The session that owns the handle.' },
          complete: { type: 'boolean', description: 'Whether this page reached the end of the stored result.' },
          offset: { type: 'number', description: 'Where this page actually started.' },
          nextOffset: { type: 'number', description: 'Where the next page should start.' },
          omitted: { type: 'number', description: 'Characters still not returned after this page.' },
          chars: { type: 'number', description: 'Characters in this page.' },
          totalChars: { type: 'number', description: 'Characters in the whole stored result.' },
          released: { type: 'boolean', description: 'Whether a stored copy was actually released.' },
          text: { type: 'string', description: 'This page of the stored result.' },
          error: {
            type: 'object',
            additionalProperties: false,
            properties: {
              code: { type: 'string', description: 'Stable error code.' },
              message: { type: 'string', description: 'One-line explanation.' },
            },
          },
        },
      },
      render(_args, value): ContentBlock[] {
        if (value.ok !== true) {
          const code = value.error?.code ?? 'FAILED'
          const message = value.error?.message ?? 'the request was refused'
          return [{ type: 'text', text: 'cache_warmup_result ' + value.action + ' refused (' + code + '): ' + message }]
        }
        if (value.action === 'release') {
          return [{
            type: 'text',
            text: value.released === true
              ? 'Released ' + value.refId + '. The preview in your history is unchanged; it can no longer be read back.'
              : 'Nothing stored for ' + value.refId + '; nothing to release.',
          }]
        }
        const at = value.offset ?? 0
        const span = typeof value.chars === 'number' ? value.chars + ' chars' : 'no content'
        const total = typeof value.totalChars === 'number' ? ' of ' + value.totalChars : ''
        const tail = value.complete === true
          ? 'complete'
          : 'more remains'
            + (typeof value.nextOffset === 'number' ? ', continue at offset ' + value.nextOffset : '')
            + (typeof value.omitted === 'number' ? ', ' + value.omitted + ' chars omitted' : '')
        const body = typeof value.text === 'string' && value.text !== '' ? value.text : '(empty page)'
        return [{ type: 'text', text: value.refId + ' from offset ' + at + ' — ' + span + total + ', ' + tail + '\n\n' + body }]
      },
    },
    async execute(args, exec): Promise<CacheWarmupResultValue> {
      const route = deps.routeOf(exec)
      const refId = args.refId
      const action: CacheWarmupResultAction = args.action

      // 1. 线路校验：这个引用只属于本线路的会话。换了线路就不再问存储。
      if (route.provider !== deps.provider) {
        return failure(
          action,
          refId,
          route.sessionId ?? '',
          'WRONG_PROVIDER',
          'ref handles belong to the ' + deps.provider + ' line; this session is routed to "' + (route.provider ?? 'unknown') + '"',
        )
      }
      // 2. 会话校验：拿不到会话时**不猜**。refId 里的会话归属是唯一的越权边界，
      //    猜一个空串等于把校验让给了存储。
      const sessionId = route.sessionId
      if (sessionId === undefined) {
        return failure(action, refId, '', 'NO_SESSION', 'the current session could not be resolved, so the handle cannot be checked')
      }
      const store = deps.store()
      if (store === undefined) {
        return failure(action, refId, sessionId, 'NO_STORE', 'the result store is unavailable on this host')
      }

      if (action === 'release') {
        let released = false
        try {
          const raw: unknown = await store.release({ sessionId, refId } as unknown as ReleaseRequest)
          released = booleanOf(raw)
            ?? booleanOf((raw as { released?: unknown } | null | undefined)?.released)
            ?? false
        } catch (error) {
          return failure(action, refId, sessionId, errorCodeOf(error, 'STORE_FAILED'), 'releasing the stored copy failed: ' + describe(error))
        }
        log({ event: 'ref-release', session: sessionId, refId, released })
        return { ok: true, action, refId, sessionId, released }
      }

      // 3. page：只把调用方真的给了的参数传下去，其余交给共享存储的默认值。
      for (const [name, value] of [['offset', args.offset], ['limit', args.limit], ['maxBytes', args.maxBytes]] as const) {
        if (value !== undefined && !isCount(value)) {
          return failure(action, refId, sessionId, 'BAD_ARGUMENT', name + ' must be a non-negative integer')
        }
      }
      const request: Record<string, unknown> = { sessionId, refId }
      if (args.offset !== undefined) request.offset = args.offset
      if (args.limit !== undefined) request.limit = args.limit
      if (args.maxBytes !== undefined) request.maxBytes = args.maxBytes
      if (args.fields !== undefined) request.fields = args.fields
      if (args.equals !== undefined) request.equals = args.equals

      let raw: unknown
      try {
        raw = await store.page(request as unknown as PageRequest)
      } catch (error) {
        return failure(action, refId, sessionId, errorCodeOf(error, 'STORE_FAILED'), 'reading the stored copy failed: ' + describe(error))
      }
      const value = pageValue(raw, refId, sessionId)
      log({
        event: 'ref-page',
        session: sessionId,
        refId,
        offset: value.offset ?? args.offset ?? 0,
        returnedChars: value.chars ?? 0,
        complete: value.complete === true,
        ...(value.nextOffset === undefined ? {} : { nextOffset: value.nextOffset }),
      })
      return value
    },
  })
}
