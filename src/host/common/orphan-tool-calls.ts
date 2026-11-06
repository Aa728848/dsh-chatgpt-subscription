/**
 * 丢掉没有配对的工具调用块，让 Anthropic Messages 形状的请求体始终自洽。
 *
 * 这类端点对工具消息序列是**强校验**的：`tool_result` 必须紧跟在发出对应 `tool_use` 的
 * assistant 消息之后，且每个 `tool_use` 都要有结果。少一个配对，整个请求就是
 * `400 invalid params`（MiniMax 上是错误码 2013），而且不可重试——同一份请求体再发一次还是
 * 400，整段会话就此卡死，只能换 provider 或新开会话。
 *
 * 孤儿从哪来都有：
 *
 * - 模型叫了一个**它工具清单里根本没有**的名字。Code Mode 下 progress-update 的催促文案
 *   触发过这条：催促点名 `progress_update`，而那个名字不在模型的工具清单里，调用没有被
 *   派发，历史就此留下一个没有结果的 `tool_use`（issue #89）。
 * - 一个工具调用还没派发，会话就断了。
 * - 一段历史在压缩或换 provider 时只剩结果、没了调用。
 *
 * 这里只做**配对**，不做别的判断：配不上的 `tool_use` 与 `tool_result` 一起丢掉，消息因此
 * 空掉的就整条去掉。
 *
 * ## 为什么折叠是参数，不是本模块的一部分
 *
 * 各线的「相邻同角色折叠」语义并不一致（Claude 的 system 轮永不合并，见
 * `claude/mapper.ts` 的 `mergeClaudeMessages`）。把折叠写死在这里，等于用一套语义去改另一
 * 条线的请求体。所以本模块只负责配对，折叠由调用方把自己的那一份传进来——清理可能让某条
 * 消息整个消失，于是原本不相邻的两条同角色消息会贴到一起，必须再折一次。
 *
 * @module dsh-chatgpt-subscription/host/common/orphan-tool-calls
 */

/** 一条 wire 形状的消息：角色 + Anthropic 内容块。 */
export interface ToolPairingTurn {
  /** `assistant` 发起调用，其余角色应答。 */
  role: string
  /** Anthropic 内容块（线上就是普通 JSON 对象）。 */
  content: Array<Record<string, unknown>>
}

/** 一个还没被应答的调用：所属消息在结果里的下标、块下标、id。 */
interface PendingCall {
  messageIndex: number
  blockIndex: number
  id: string
}

/**
 * 读一个未知字段为字符串。
 * @param value - 候选值。
 * @returns 字符串，或任何其它类型的 undefined。
 */
function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/**
 * 清掉没有配对的工具调用。
 *
 * 配对规则只有一条：`tool_use` 必须被**后面第一条** user 轮里的同名 `tool_result` 应答；
 * 到了下一条 assistant 轮还没被应答，它就是孤儿。反向也一样——`tool_result` 找不到仍在
 * 等待的同名调用，它就是无主结果（线上报的是「tool call result does not follow tool call」）。
 *
 * @param messages - 已折叠过的消息列表。
 * @param refold - 调用方自己的相邻同角色折叠，清理后需要再折一次。
 * @returns 配对完整、且没有空消息的消息列表；清理会把整段历史清空时原样返回。
 */
export function cleanOrphanedToolCalls<T extends ToolPairingTurn>(
  messages: T[],
  refold: (entries: T[]) => T[],
): T[] {
  const result: T[] = []
  // 待应答的调用：所属 assistant 消息在 result 里的下标 + 块下标 + id。
  let pending: PendingCall[] = []

  /**
   * 丢掉没有被结果应答的调用。
   * @param answered - 已经被结果应答的 id 集合。
   */
  const dropUnanswered = (answered: ReadonlySet<string>): void => {
    const byMessage = new Map<number, number[]>()
    for (const call of pending) {
      if (answered.has(call.id)) continue
      const indices = byMessage.get(call.messageIndex)
      if (indices === undefined) byMessage.set(call.messageIndex, [call.blockIndex])
      else indices.push(call.blockIndex)
    }
    for (const [messageIndex, indices] of byMessage) {
      const message = result[messageIndex]
      if (message === undefined) continue
      // 下标是相对这条消息的原始内容算的，而一条消息在一次清理里最多被删一次（每次清理
      // 都会把 pending 清空），所以这里不会因为前一次删除而错位。
      message.content = message.content.filter((_block, index) => !indices.includes(index))
    }
    pending = []
  }

  for (const message of messages) {
    if (message.role === 'assistant') {
      // 上一条 assistant 的调用如果到这里还没人应答，它就是孤儿：新的 assistant 轮次
      // 不会替它作答。
      dropUnanswered(new Set())
      const messageIndex = result.length
      for (let blockIndex = 0; blockIndex < message.content.length; blockIndex += 1) {
        const block = message.content[blockIndex]
        if (block.type !== 'tool_use') continue
        const id = asString(block.id)
        if (id === undefined) continue
        pending.push({ messageIndex, blockIndex, id })
      }
      result.push({ ...message, content: [...message.content] })
      continue
    }
    // user 轮：只有还在等待的同名调用才算数。配不上的结果丢掉——留着它，线上报的就是
    // 「tool call result does not follow tool call」。
    const answered = new Set<string>()
    const content: Array<Record<string, unknown>> = []
    for (const block of message.content) {
      if (block.type === 'tool_result') {
        const id = asString(block.tool_use_id)
        if (id === undefined || !pending.some((call) => call.id === id)) continue
        answered.add(id)
        content.push(block)
        continue
      }
      content.push(block)
    }
    dropUnanswered(answered)
    result.push({ ...message, content })
  }
  // 历史以 assistant 轮次收尾时，它那些没人应答的调用同样是孤儿。
  dropUnanswered(new Set())

  const nonEmpty = result.filter((message) => message.content.length > 0)
  // 清空之后一条都不剩时，宁可原样发出去：空消息列表是另一种失败。
  return nonEmpty.length === 0 ? messages : refold(nonEmpty)
}
