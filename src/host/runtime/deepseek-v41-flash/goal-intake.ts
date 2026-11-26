/**
 * 状态锚的目标采集：判定一条消息能否改写 GOAL，并维护最近几个回合的目标。
 *
 * 用白名单而非黑名单：DSH 会持续新增自动消息（目标续跑、子代理通知、定时提醒……），
 * 黑名单每漏一种，锚点就会把那段自动文字当成用户目标反复注入。
 * 无来源字段的用户消息按真人输入处理，兼容不写 `source` 的旧代宿主。
 *
 * @module @eddyskywalker/dsh-chatgpt-subscription/host/deepseek-v41-flash/goal-intake
 */

/** 目标摘要最大字符数，保持锚点紧凑（工程预算，非模型硬上限）。 */
const MAX_GOAL_CHARS = 120
/** 保留的目标回合数，兼顾连续任务与旧任务消退。 */
export const MAX_GOAL_TURNS = 3
/** 纯接续短句归一化后的最大长度；更长的消息一律视为带实际要求。 */
const MAX_CONTINUATION_CHARS = 24

const REMINDER_START = /<system-reminder\b|Current runtime context\./
const ANCHOR_TEXT = /^\[(?:V4\.1-Flash|Open-Model) State Anchor\b/
/** 子代理消息正文前缀（DSH `createAgentMessage`）。 */
const AGENT_MESSAGE_PREFIX = /^Agent\s+\S.*?\s+sent a message:\s*/
/** 目标续跑提示里的 `Objective: "…"`（JSON 字符串）。 */
const GOAL_OBJECTIVE = /Objective:\s*("(?:[^"\\]|\\.)*")/

/**
 * 只表示“接着做”的词。消息归一化后能被这些词完整拼出时，不替换原目标。
 * 刻意不收“不”“改成”之类带方向的词：那是新要求。
 */
const CONTINUATION_TOKENS: readonly string[] = [
  // zh
  '继续', '繼續', '接着', '接著', '往下', '下一步', '然后呢', '开始', '開始', '执行', '執行', '就这样', '就這樣',
  '照做', '照此', '按你的方案', '按方案', '同意', '确认', '確認', '收到', '明白', '了解', '没问题', '沒問題',
  '好的', '好滴', '好', '行', '可以', '嗯', '对', '對', '是的', '是', '请', '請', '麻烦', '吧', '啊', '呀', '哈',
  '做', '干', '改',
  // en（已去空格）
  'continue', 'cont', 'keepgoing', 'carryon', 'goahead', 'goon', 'go', 'proceed', 'resume', 'next',
  'okay', 'ok', 'yes', 'yep', 'yeah', 'sure', 'please', 'pls', 'doit', 'lgtm', 'sounds', 'good', 'fine',
  // ru
  'продолжай', 'продолжи', 'продолжить', 'продолжаем', 'дальше', 'далее', 'давай', 'хорошо', 'да', 'ок',
].slice().sort((a, b) => b.length - a.length)

/** 一条消息对 GOAL 的作用。 */
export type GoalIntake =
  /** 真人输入：可设定新目标。 */
  | { readonly kind: 'instruction'; readonly text: string }
  /** 真人的纯接续短句（“继续”“ok”）：保留原目标，只开启新回合。 */
  | { readonly kind: 'continue' }
  /** 对提问的回答：并入当前目标。 */
  | { readonly kind: 'reply'; readonly text: string }
  /** 代理间消息：子代理的任务说明就是这种来源，只在尚无目标时采用。 */
  | { readonly kind: 'agent'; readonly text: string }
  /** DSH 目标续跑轮次：取其中的 Objective。 */
  | { readonly kind: 'objective'; readonly text: string }
  /** 运行时通知、提醒、锚点及一切未知来源。 */
  | { readonly kind: 'ignore' }

const IGNORE: GoalIntake = Object.freeze({ kind: 'ignore' })
const CONTINUE: GoalIntake = Object.freeze({ kind: 'continue' })

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** 拼接消息里的全部文本块。 */
export function messageText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (isRecord(block) && block['type'] === 'text' && typeof block['text'] === 'string') parts.push(block['text'])
  }
  return parts.join('\n')
}

function stripReminders(raw: string): string {
  const at = raw.search(REMINDER_START)
  return (at < 0 ? raw : raw.slice(0, at)).trim()
}

/** 把原始用户目标清洗成紧凑的一行摘要，去除附带 reminder。 */
export function compactGoalSummary(raw: string): string {
  const stripped = stripReminders(raw).replace(/\s+/g, ' ').trim()
  if (stripped.length <= MAX_GOAL_CHARS) return stripped
  return stripped.slice(0, MAX_GOAL_CHARS - 3).trimEnd() + '...'
}

/** 合并用户补充时保留原目标开头和最新消息，避免总长度截断把新约束吃掉。 */
export function mergeGoalUpdate(current: string, update: string): string {
  if (current.length === 0) return compactGoalSummary(update)
  const compactedUpdate = compactGoalSummary(update)
  if (compactedUpdate.length === 0) return current
  const combined = compactGoalSummary(`${current} | ${compactedUpdate}`)
  if (combined.endsWith(compactedUpdate)) return combined

  const suffix = ` | ${compactedUpdate}`
  const prefixBudget = combined.length - suffix.length
  if (prefixBudget < 4) return compactedUpdate
  const prefix = current.slice(0, prefixBudget - 3).trimEnd()
  return prefix.length > 0 ? `${prefix}...${suffix}` : compactedUpdate
}

/** 消息是否只表示“接着做”（“继续”“好的，继续”“ok go on”）。 */
export function isContinuationOnly(text: string): boolean {
  let rest = text.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '')
  if (rest.length > MAX_CONTINUATION_CHARS) return false
  while (rest.length > 0) {
    const token = CONTINUATION_TOKENS.find(candidate => rest.startsWith(candidate))
    if (token === undefined) return false
    rest = rest.slice(token.length)
  }
  return true
}

function goalObjective(text: string): string | undefined {
  const match = GOAL_OBJECTIVE.exec(text)
  if (match === null) return undefined
  try {
    const objective: unknown = JSON.parse(match[1]!)
    return typeof objective === 'string' && objective.trim().length > 0 ? objective : undefined
  } catch {
    return undefined
  }
}

/** 判定一条消息对 GOAL 的作用。 */
export function classifyGoalIntake(message: unknown): GoalIntake {
  if (!isRecord(message) || message['role'] !== 'user') return IGNORE
  const source = isRecord(message['source']) ? message['source'] : undefined
  if (source?.['form'] === 'notice') return IGNORE
  const text = stripReminders(messageText(message['content']))
  if (text.length === 0 || ANCHOR_TEXT.test(text)) return IGNORE
  const kind = typeof source?.['kind'] === 'string' ? source['kind'] : undefined
  if (kind === undefined || kind === 'user' || kind === 'webhook') {
    return isContinuationOnly(text) ? CONTINUE : { kind: 'instruction', text }
  }
  if (kind === 'goal') {
    const objective = goalObjective(text)
    return objective === undefined ? IGNORE : { kind: 'objective', text: objective }
  }
  if (kind === 'user-question-reply') {
    return isContinuationOnly(text) ? CONTINUE : { kind: 'reply', text }
  }
  if (kind === 'agent-message') {
    const body = text.replace(AGENT_MESSAGE_PREFIX, '').trim()
    return body.length === 0 ? IGNORE : { kind: 'agent', text: body }
  }
  return IGNORE
}

/** 是否为人（或上级代理）发来的新信息；DSH 自动续跑、通知与提醒都不算。 */
export function isRealUserMessage(message: unknown): boolean {
  const kind = classifyGoalIntake(message).kind
  return kind === 'instruction' || kind === 'continue' || kind === 'reply' || kind === 'agent'
}

/** 最近几个回合的目标，最新的在最后。 */
export interface GoalLedger {
  turns: Array<{ turn: number; goal: string; merged: boolean }>
  /** 宿主不提供回合号时，为每批新消息分配的负数回合号。 */
  syntheticTurn: number
}

export function createGoalLedger(): GoalLedger {
  return { turns: [], syntheticTurn: 0 }
}

/**
 * 吸收一批进入本步的消息。
 * @returns 是否有非 ignore 的消息（调用方据此开启新回合计数）。
 */
export function absorbGoalMessages(ledger: GoalLedger, messages: readonly unknown[], turn: number | undefined): boolean {
  const intakes = messages.map(classifyGoalIntake).filter(intake => intake.kind !== 'ignore')
  if (intakes.length === 0) return false
  const batchTurn = turn ?? (ledger.syntheticTurn -= 1)
  for (const intake of intakes) {
    const latest = ledger.turns[ledger.turns.length - 1]
    switch (intake.kind) {
      case 'instruction':
        if (latest !== undefined && latest.turn === batchTurn) {
          latest.goal = mergeGoalUpdate(latest.goal, intake.text)
          latest.merged = true
        } else {
          ledger.turns.push({ turn: batchTurn, goal: compactGoalSummary(intake.text), merged: false })
        }
        break
      case 'reply':
        if (latest !== undefined) {
          latest.goal = mergeGoalUpdate(latest.goal, intake.text)
          latest.merged = true
        } else {
          ledger.turns.push({ turn: batchTurn, goal: compactGoalSummary(intake.text), merged: false })
        }
        break
      case 'agent':
        // 子代理汇报也是这种来源：只有还没有目标时（子代理收到任务说明）才采用。
        if (latest === undefined) ledger.turns.push({ turn: batchTurn, goal: compactGoalSummary(intake.text), merged: false })
        break
      case 'objective': {
        const goal = compactGoalSummary(intake.text)
        if (latest?.goal !== goal) ledger.turns.push({ turn: batchTurn, goal, merged: false })
        break
      }
      case 'continue':
        break
    }
  }
  if (ledger.turns.length > MAX_GOAL_TURNS) ledger.turns.splice(0, ledger.turns.length - MAX_GOAL_TURNS)
  return true
}

/** 当前目标（最新回合）。 */
export function currentGoal(ledger: GoalLedger): string {
  return ledger.turns[ledger.turns.length - 1]?.goal ?? ''
}

/** 更早回合的目标，仅作参考。 */
export function earlierGoals(ledger: GoalLedger): string {
  return ledger.turns.slice(0, -1).reduce((goal, entry) => mergeGoalUpdate(goal, entry.goal), '')
}

/** 中途接管会话时，从历史事件里找回最近一个可作目标的消息。 */
export function recoverGoalFromEvents(
  ledger: GoalLedger,
  events: readonly { readonly type?: unknown; readonly data?: unknown }[],
  turn: number | undefined,
): void {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]
    if (event?.type !== 'user/message' || !isRecord(event.data)) continue
    const data = event.data
    const message = isRecord(data['message']) ? data['message'] : { role: 'user', content: data['content'] ?? data['text'] }
    const intake = classifyGoalIntake(message)
    if (intake.kind === 'instruction' || intake.kind === 'objective' || intake.kind === 'agent') {
      ledger.turns = [{ turn: turn ?? 0, goal: compactGoalSummary(intake.text), merged: false }]
      return
    }
  }
}
