/**
 * 「调度账本」的**纯**策略与提示词引用描述符。
 *
 * ## 为什么这里只有纯函数
 *
 * 账本要在两处被用到，而两处的"策略"来源不同：
 *
 * - **守卫**（后续实现）在执行期拿当前会话的路由策略与工具清单，拒绝一份
 *   过期或伪造的授权快照；
 * - **只读工具**（后续实现）把同一份描述符交给模型，让模型照抄。
 *
 * 两边必须算出**逐字相同**的摘要，否则模型抄回去的 sha256 会被自己拒。
 * 所以这里只提供纯函数：输入一份描述符的**内容**，输出它的**规范化 JSON**
 * 与 sha256。没有任何 IO、没有全局状态、没有宿主依赖。
 *
 * ## 规范化 JSON 为什么按键排序
 *
 * 摘要必须只依赖**内容**，不依赖对象的键插入顺序。`JSON.stringify` 按插入
 * 顺序输出，所以这里的对象字面量按**字母序**写字段，数组按内容排序。
 * 这样"同一份策略"在任何进程、任何代次宿主上都得到同一个摘要。
 *
 * @module dsh-chatgpt-subscription/host/dispatch-ledger/policy
 */

import { createHash } from 'node:crypto'

/** 策略描述符的 id：模型抄进头部的 `policy.id`。 */
export const DISPATCH_POLICY_ID = 'dsh-dispatch-ledger'

/** 策略版本。语义变化时 +1，旧描述符随即被判为过期。 */
export const DISPATCH_POLICY_VERSION = 1

/** sha256 前缀的最小长度：模型抄 64 位容易出错，12 位足够区分一次策略变更。 */
export const DISPATCH_POLICY_SHA_PREFIX_LENGTH = 12

/** 一条被授权的子代理路由。 */
export interface DispatchPolicyRoute {
  /** 提供方 id。 */
  readonly provider: string
  /** 模型 id。 */
  readonly model: string
}

/** 策略描述符的输入：工具清单与路由清单。 */
export interface DispatchPolicyInputs {
  /** 本部署承认的派发工具名。 */
  readonly tools?: readonly string[]
  /** 会话记录的允许路由。 */
  readonly routes?: readonly DispatchPolicyRoute[]
}

/** 策略描述符：模型原样抄进头部的那一份。 */
export interface DispatchPolicyDescriptor {
  /** 策略 id。 */
  readonly id: string
  /** 策略版本（字符串形态，与头部里的字段类型一致）。 */
  readonly version: string
  /** 规范化策略 JSON 的 sha256（小写十六进制）。 */
  readonly sha256: string
}

/** 提示词引用的描述符。 */
export interface DispatchPromptRefDescriptor {
  /** 版本号形态的引用（≤64 字符，可直接抄进头部）。 */
  readonly ref: string
  /** 被引用提示词的 sha256。 */
  readonly sha256: string
}

/**
 * 算一段文本的 sha256（小写十六进制）。
 * @param text - 原文。
 * @returns 64 位十六进制摘要。
 */
export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/**
 * 算出策略的规范化 JSON。
 *
 * 字段按字母序写出（`id`、`routes`、`tools`、`version`），数组按内容
 * 排序：同一份策略内容在任何机器上都得到逐字相同的字符串。
 * @param inputs - 工具清单与路由清单。
 * @returns 规范化 JSON 文本。
 */
export function canonicalPolicyJson(inputs: DispatchPolicyInputs): string {
  const routes = [...(inputs.routes ?? [])]
    .map(route => ({ model: route.model, provider: route.provider }))
    .sort((left, right) => left.provider.localeCompare(right.provider)
      || left.model.localeCompare(right.model))
  const tools = [...(inputs.tools ?? [])].sort()
  return JSON.stringify({
    id: DISPATCH_POLICY_ID,
    routes,
    tools,
    version: DISPATCH_POLICY_VERSION,
  })
}

/**
 * 算出一份策略描述符。
 * @param inputs - 工具清单与路由清单。
 * @returns 可直接抄进头部的描述符。
 */
export function dispatchPolicyDescriptor(inputs: DispatchPolicyInputs): DispatchPolicyDescriptor {
  return {
    id: DISPATCH_POLICY_ID,
    version: String(DISPATCH_POLICY_VERSION),
    sha256: sha256Hex(canonicalPolicyJson(inputs)),
  }
}

/**
 * 判断两份策略描述符是否指同一份策略。
 *
 * 比较用**前缀**：模型只抄 sha256 的前若干位，前缀相同即视为同一份策略。
 * @param left - 一份描述符。
 * @param right - 另一份描述符。
 * @returns 是否指同一份策略。
 */
export function policyDescriptorsMatch(
  left: DispatchPolicyDescriptor,
  right: DispatchPolicyDescriptor,
): boolean {
  if (left.id !== right.id) return false
  if (left.version !== right.version) return false
  const length = Math.min(
    DISPATCH_POLICY_SHA_PREFIX_LENGTH,
    left.sha256.length,
    right.sha256.length,
  )
  if (length < DISPATCH_POLICY_SHA_PREFIX_LENGTH) return false
  return left.sha256.slice(0, length) === right.sha256.slice(0, length)
}

/**
 * 算出一份提示词引用描述符。
 *
 * `ref` 是内容寻址的短版本号（`p-` + 摘要前 16 位，18 字符 ≤64）；`sha256`
 * 是完整摘要。账本只存 `ref`，不存提示词正文。
 * @param promptText - 被引用的提示词原文。
 * @returns 提示词引用描述符。
 */
export function promptRefDescriptor(promptText: string): DispatchPromptRefDescriptor {
  const digest = sha256Hex(promptText)
  return { ref: 'p-' + digest.slice(0, 16), sha256: digest }
}
