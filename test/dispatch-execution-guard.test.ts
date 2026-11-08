import { describe, expect, it } from 'vitest'
import {
  DEFAULT_DELEGATED_BLOCKED_TOOLS,
  DEFAULT_SHELL_TOOLS,
  hasRunningChildSubagent,
  installDispatchExecutionGuard,
  isDelegatedCaller,
  isPureSleepCommand,
  resolveDispatchExecutionGuardEnabled,
  validateAskUserQuestionArgs,
} from '../src/host/dispatch-execution-guard.ts'
import { Config } from '../src/index.ts'

/** 一次守卫执行（只带守卫要读的三样东西）。 */
interface Exec {
  name: string
  arguments?: unknown
  agent?: unknown
}

/** 一个子代理：持久会话血缘写着 origin=subagent。 */
function subagentAgent(id = 'child-1'): Record<string, unknown> {
  return { id, session: { header: { id, origin: 'subagent' } } }
}

/** 一个主控 agent：会话血缘里没有 origin。 */
function rootAgent(id = 'root-1'): Record<string, unknown> {
  return { id, session: { header: { id } } }
}

/** 一个只带 id 的裸 agent（没有 session）。 */
function bareAgent(id = 'bare-1'): Record<string, unknown> {
  return { id }
}

/** 造一台记录守卫调用的宿主上下文。 */
function host(options: {
  agents?: unknown
  subagents?: unknown
  enabled?: () => boolean
  hasRunningChildren?: (agent: unknown) => boolean
} = {}) {
  const registered: ((exec: Exec) => string | undefined)[] = []
  let definitionsCalls = 0
  let registerCalls = 0
  const tools = {
    definitions: () => {
      definitionsCalls += 1
      return []
    },
    register: () => {
      registerCalls += 1
      return () => undefined
    },
    guard: (guard: (exec: Exec) => string | undefined) => {
      registered.push(guard)
      return () => undefined
    },
  }
  const ctx = {
    tools,
    get: (name: string) => (name === 'agents' ? options.agents : name === 'subagents' ? options.subagents : undefined),
  }
  const dispose = installDispatchExecutionGuard(ctx, {
    enabled: options.enabled,
    hasRunningChildren: options.hasRunningChildren,
  })
  return {
    ctx,
    tools,
    dispose,
    registered,
    definitionsCalls: () => definitionsCalls,
    registerCalls: () => registerCalls,
    guard: () => registered[0]!,
  }
}

describe('调度执行守卫：子代理越权调用主控专用工具', () => {
  it('七个主控专用工具都在禁用名单里', () => {
    expect([...DEFAULT_DELEGATED_BLOCKED_TOOLS]).toEqual([
      'ask_user_question',
      'exit_plan_mode',
      'enter_plan_mode',
      'leave_plan_mode',
      'create_goal',
      'update_goal',
      'present',
    ])
  })

  it('子代理调用七个工具全部被拒，理由带 DELEGATED_CALLER 与交回约定', () => {
    const { guard } = host()
    for (const toolName of DEFAULT_DELEGATED_BLOCKED_TOOLS) {
      const reason = guard()({ name: toolName, arguments: {}, agent: subagentAgent() })
      expect(reason, toolName).toContain('DELEGATED_CALLER')
      expect(reason, toolName).toContain('status: "hand_back"')
      expect(reason, toolName).toContain('status: "blocked"')
      expect(reason, toolName).toContain(toolName)
    }
  })

  it('主控自己调这些工具不受影响', () => {
    const { guard } = host()
    for (const toolName of DEFAULT_DELEGATED_BLOCKED_TOOLS) {
      expect(guard()({ name: toolName, arguments: {}, agent: rootAgent() }), toolName).toBeUndefined()
    }
  })

  it('非主控专用工具任何调用方都放行', () => {
    const { guard } = host()
    expect(guard()({ name: 'read', arguments: {}, agent: subagentAgent() })).toBeUndefined()
    expect(guard()({ name: 'subagent', arguments: {}, agent: subagentAgent() })).toBeUndefined()
  })
})

describe('isDelegatedCaller：两条判定', () => {
  it('持久会话血缘写着 origin=subagent 就是子代理', () => {
    expect(isDelegatedCaller(subagentAgent())).toBe(true)
  })

  it('不在存活根集合里的存活 agent 是子代理', () => {
    const child = bareAgent('child-1')
    const root = bareAgent('root-1')
    const ctx = {
      get: () => ({
        get: (id: string) => (id === 'child-1' ? child : root),
        roots: () => [root],
      }),
    }
    expect(isDelegatedCaller(child, ctx)).toBe(true)
    expect(isDelegatedCaller(root, ctx)).toBe(false)
  })

  it('不是那个 id 当前登记的存活 agent（已过期）不算子代理', () => {
    const stale = bareAgent('child-1')
    const ctx = {
      get: () => ({
        get: () => bareAgent('child-1'),
        roots: () => [],
      }),
    }
    expect(isDelegatedCaller(stale, ctx)).toBe(false)
  })

  it('读不到 agents 服务时判不了就放行', () => {
    expect(isDelegatedCaller(bareAgent(), undefined)).toBe(false)
    expect(isDelegatedCaller(bareAgent(), { get: () => undefined })).toBe(false)
    expect(isDelegatedCaller(bareAgent(), { get: () => { throw new Error('no service') } })).toBe(false)
  })

  it('agents 服务没有 roots 时也判不了就放行', () => {
    const agent = bareAgent()
    expect(isDelegatedCaller(agent, { get: () => ({ get: () => agent }) })).toBe(false)
  })

  it('非对象的调用方一律不是子代理', () => {
    expect(isDelegatedCaller(undefined)).toBe(false)
    expect(isDelegatedCaller(null)).toBe(false)
    expect(isDelegatedCaller('agent')).toBe(false)
    expect(isDelegatedCaller(42)).toBe(false)
  })
})

describe('isPureSleepCommand：纯等待的判据', () => {
  it('各种 sleep/wait 形态都是纯等待', () => {
    expect(isPureSleepCommand('sleep 1')).toBe(true)
    expect(isPureSleepCommand('sleep 30s')).toBe(true)
    expect(isPureSleepCommand('sleep 0.5')).toBe(true)
    expect(isPureSleepCommand('Start-Sleep -Seconds 5')).toBe(true)
    expect(isPureSleepCommand('Start-Sleep 5')).toBe(true)
    expect(isPureSleepCommand('timeout /t 5 /nobreak')).toBe(true)
    expect(isPureSleepCommand('ping -n 4 127.0.0.1 > nul')).toBe(true)
  })

  it('夹着真事的命令不是纯等待，必须放行', () => {
    expect(isPureSleepCommand('sleep 1 && npm test')).toBe(false)
    expect(isPureSleepCommand('git status')).toBe(false)
    expect(isPureSleepCommand('node -e "console.log(1)"')).toBe(false)
    expect(isPureSleepCommand('sleep 1; npm run build')).toBe(false)
    expect(isPureSleepCommand('npm test && sleep 1')).toBe(false)
  })

  it('纯等待加无害空转仍是纯等待', () => {
    expect(isPureSleepCommand('sleep 1 && echo waiting')).toBe(true)
    expect(isPureSleepCommand('echo start; sleep 2')).toBe(true)
    expect(isPureSleepCommand('true && sleep 1')).toBe(true)
    expect(isPureSleepCommand('# just a comment\nsleep 1')).toBe(true)
  })

  it('空串、非字符串、纯回显都不是纯等待', () => {
    expect(isPureSleepCommand('')).toBe(false)
    expect(isPureSleepCommand('   ')).toBe(false)
    expect(isPureSleepCommand(undefined)).toBe(false)
    expect(isPureSleepCommand(42)).toBe(false)
    expect(isPureSleepCommand('echo hi')).toBe(false)
  })
})

describe('hasRunningChildSubagent：还有没有在跑的子代理', () => {
  it('subagents.list 里有一条 running 就是有', () => {
    const ctx = {
      get: (name: string) => name === 'subagents'
        ? { list: () => [{ id: 'c1', status: 'running' }] }
        : undefined,
    }
    expect(hasRunningChildSubagent(bareAgent(), ctx)).toBe(true)
  })

  it('subagents.list 里没有 running 就是没有', () => {
    const ctx = {
      get: (name: string) => name === 'subagents'
        ? { list: () => [{ id: 'c1', status: 'inactive' }] }
        : undefined,
    }
    expect(hasRunningChildSubagent(bareAgent(), ctx)).toBe(false)
  })

  it('agents.list 里 parent 指回本调用方且 running 的那条算数', () => {
    const ctx = {
      get: (name: string) => name === 'agents'
        ? {
            list: () => [
              { id: 'c1', status: 'running', parent: 'root-1' },
              { id: 'c2', status: 'running', parent: 'other-root' },
            ],
          }
        : undefined,
    }
    expect(hasRunningChildSubagent(bareAgent('root-1'), ctx)).toBe(true)
    expect(hasRunningChildSubagent(bareAgent('nobody'), ctx)).toBe(false)
  })

  it('会话头 id 也算 parent 的一种写法', () => {
    const ctx = {
      get: (name: string) => name === 'agents'
        ? { list: () => [{ id: 'c1', status: 'running', parent: 'session-9' }] }
        : undefined,
    }
    const agent = { id: 'root-1', session: { header: { id: 'session-9' } } }
    expect(hasRunningChildSubagent(agent, ctx)).toBe(true)
  })

  it('注入口优先于宿主探测', () => {
    const ctx = {
      get: (name: string) => name === 'subagents'
        ? { list: () => [{ id: 'c1', status: 'running' }] }
        : undefined,
    }
    expect(hasRunningChildSubagent(bareAgent(), ctx)).toBe(true)
    const injected = { hasRunningChildren: () => false }
    expect(hasRunningChildSubagent(bareAgent(), injected)).toBe(false)
  })

  it('宿主服务缺席时判不了就当没有', () => {
    expect(hasRunningChildSubagent(bareAgent(), undefined)).toBe(false)
    expect(hasRunningChildSubagent(bareAgent(), { get: () => undefined })).toBe(false)
    expect(hasRunningChildSubagent(bareAgent(), { get: () => { throw new Error('boom') } })).toBe(false)
    expect(hasRunningChildSubagent(undefined, {})).toBe(false)
  })
})

describe('调度执行守卫：等待子代理期间的纯 sleep 空等', () => {
  it('三个 shell 工具都在名单里', () => {
    expect([...DEFAULT_SHELL_TOOLS]).toEqual(['bash', 'pwsh', 'win_bash'])
  })

  it('有在跑的子代理时，纯 sleep 被拒，理由带 ACTIVE_CHILD_SLEEP_FORBIDDEN', () => {
    for (const shell of DEFAULT_SHELL_TOOLS) {
      const { guard } = host({ hasRunningChildren: () => true })
      const reason = guard()({ name: shell, arguments: { command: 'sleep 5' }, agent: rootAgent() })
      expect(reason, shell).toContain('ACTIVE_CHILD_SLEEP_FORBIDDEN')
      expect(reason, shell).toContain('completion notification')
    }
  })

  it('没有在跑的子代理时，纯 sleep 放行', () => {
    const { guard } = host({ hasRunningChildren: () => false })
    expect(guard()({ name: 'bash', arguments: { command: 'sleep 5' }, agent: rootAgent() })).toBeUndefined()
  })

  it('命令里有真活时一律放行', () => {
    const { guard } = host({ hasRunningChildren: () => true })
    expect(guard()({ name: 'bash', arguments: { command: 'sleep 1 && npm test' }, agent: rootAgent() })).toBeUndefined()
    expect(guard()({ name: 'bash', arguments: { command: 'git status' }, agent: rootAgent() })).toBeUndefined()
  })

  it('后台跑的 sleep 不拦', () => {
    const { guard } = host({ hasRunningChildren: () => true })
    expect(guard()({
      name: 'win_bash',
      arguments: { command: 'sleep 30', run_in_background: true },
      agent: rootAgent(),
    })).toBeUndefined()
  })

  it('有在跑的子代理这件事由宿主探测得出时同样拦得住', () => {
    const { guard } = host({
      agents: {
        list: () => [{ id: 'c1', status: 'running', parent: 'root-1' }],
      },
    })
    expect(guard()({ name: 'bash', arguments: { command: 'sleep 5' }, agent: bareAgent('root-1') }))
      .toContain('ACTIVE_CHILD_SLEEP_FORBIDDEN')
  })
})

describe('调度执行守卫：volatile 开关与零缓存漂移', () => {
  it('开关读成 false 时立刻停手，不用重挂，也不碰工具声明面', () => {
    let enabled = true
    const { guard, definitionsCalls, registerCalls } = host({ enabled: () => enabled })
    const agent = subagentAgent()
    expect(guard()({ name: 'ask_user_question', arguments: {}, agent })).toContain('DELEGATED_CALLER')
    enabled = false
    expect(guard()({ name: 'ask_user_question', arguments: {}, agent })).toBeUndefined()
    // 工具声明面一个字节都没动过：definitions 与 register 都没被调用。
    expect(definitionsCalls()).toBe(0)
    expect(registerCalls()).toBe(0)
  })

  it('resolveDispatchExecutionGuardEnabled 缺省为开，只有明确的 false 才关', () => {
    expect(resolveDispatchExecutionGuardEnabled()).toBe(true)
    expect(resolveDispatchExecutionGuardEnabled({})).toBe(true)
    expect(resolveDispatchExecutionGuardEnabled({ dispatchExecutionGuard: undefined })).toBe(true)
    expect(resolveDispatchExecutionGuardEnabled({ dispatchExecutionGuard: true })).toBe(true)
    expect(resolveDispatchExecutionGuardEnabled({ dispatchExecutionGuard: false })).toBe(false)
    expect(resolveDispatchExecutionGuardEnabled({ dispatchExecutionGuard: { get: () => true } })).toBe(true)
    expect(resolveDispatchExecutionGuardEnabled({ dispatchExecutionGuard: { get: () => false } })).toBe(false)
    expect(resolveDispatchExecutionGuardEnabled({ dispatchExecutionGuard: { get: () => undefined } })).toBe(true)
    expect(resolveDispatchExecutionGuardEnabled({
      dispatchExecutionGuard: { get: () => { throw new Error('read failed') } },
    })).toBe(true)
  })

  it('宿主没有 guard 接缝时装不上，但不抛错', () => {
    const dispose = installDispatchExecutionGuard({ tools: {} })
    expect(() => dispose()).not.toThrow()
    expect(() => installDispatchExecutionGuard(undefined)).not.toThrow()
  })

  it('Config 的开关默认开，显式 false 才关', () => {
    expect(Config({}).dispatchExecutionGuard?.get()).toBe(true)
    expect(Config({ dispatchExecutionGuard: false }).dispatchExecutionGuard?.get()).toBe(false)
  })

  it('Config 解析共享治理、预览线路与缓存策略覆盖', () => {
    expect(Config({}).toolRunawayGuard?.get()).toBe(true)
    expect(Config({ toolRunawayGuard: false }).toolRunawayGuard?.get()).toBe(false)
    expect(Config({ cacheWarmupProviders: ['kimi-code'] }).cacheWarmupProviders?.get()).toEqual(['kimi-code'])
    expect(Config({
      promptCacheOverrides: { 'step-code': { scope: 'account', affinity: true, ttlMs: 300_000 } },
    }).promptCacheOverrides).toEqual({ 'step-code': { scope: 'account', affinity: true, ttlMs: 300_000 } })
  })
})

/** 一道结构规整的候选方案题。 */
function canonicalArgs(): Record<string, unknown> {
  return {
    questions: [
      {
        id: 'palette-choice',
        header: '配色',
        question: '桌宠配色要不要换成暖色？',
        options: [
          { label: '暖色 (Recommended)', description: '主色换成暖橙' },
          { label: '保持冷色', description: '不改配色' },
        ],
      },
    ],
  }
}

/**
 * 生产里真实出现过的畸形载荷（会话 session-ab0f77e6 的 seq 350 / 355）。
 *
 * 三个问题问的是**同一件事**，选项字段全摊在问题对象上，还带着被截断的键名
 * `"options [{"` 与全角冒号键名 `"options："`；`id` 分别是 `":"` 与空串。
 *
 * @returns 那份载荷的结构副本。
 */
function productionMalformedArgs(): Record<string, unknown> {
  const question = '#2021 推荐重绘左右跑动帧……你希望采用哪种方案？'
  return {
    questions: [
      {
        header: '桌宠修复方案',
        id: 'issue-2021-art-direction',
        question,
        'options [{': '',
        label: '重绘左右跑动帧 (Recommended)',
        description: '仅调整左右跑动帧',
      },
      {
        id: ':',
        question,
        'options：': '',
        label: '工具时改播正面站姿',
        description: '不重绘',
      },
      {
        id: '',
        question,
        'options：': '',
        label: '先等待报告人标注',
        description: '暂缓',
      },
    ],
  }
}

describe('validateAskUserQuestionArgs：主控提问载荷的结构校验', () => {
  it('结构规整的候选方案题通过', () => {
    expect(validateAskUserQuestionArgs(canonicalArgs())).toBeUndefined()
  })

  it('多题、多选与既有键（header/detail/intent/timeout/multiSelect）都放行', () => {
    expect(validateAskUserQuestionArgs({
      questions: [
        {
          id: 'q1',
          question: '第一题',
          header: 'H',
          multi_select: true,
          options: [{ label: 'A' }, { label: 'B' }],
        },
        {
          id: 'q2',
          question: '第二题',
          detail: '补充说明',
          intent: 'confirm',
          timeout: 30,
          multiSelect: false,
        },
      ],
    })).toBeUndefined()
  })

  it('开放题必须继续放行：options 缺省与 options: [] 都算开放题', () => {
    expect(validateAskUserQuestionArgs({
      questions: [{ id: 'free-form', question: '还有别的想补充的吗？' }],
    })).toBeUndefined()
    expect(validateAskUserQuestionArgs({
      questions: [{ id: 'free-form', question: '还有别的想补充的吗？', options: [] }],
    })).toBeUndefined()
  })

  it('非对象载荷、缺 questions、非数组、空数组都交给底层工具自己判', () => {
    expect(validateAskUserQuestionArgs(undefined)).toBeUndefined()
    expect(validateAskUserQuestionArgs(null)).toBeUndefined()
    expect(validateAskUserQuestionArgs('questions')).toBeUndefined()
    expect(validateAskUserQuestionArgs({})).toBeUndefined()
    expect(validateAskUserQuestionArgs({ questions: 'nope' })).toBeUndefined()
    expect(validateAskUserQuestionArgs({ questions: [] })).toBeUndefined()
  })

  it('生产里那份畸形载荷被拒，且指引它写成一道题多个选项', () => {
    const reason = validateAskUserQuestionArgs(productionMalformedArgs())
    expect(reason).toBeDefined()
    expect(reason).toContain('INVALID_USER_QUESTION')
    // 摊平的选项字段要点名：错位键名是模型改对它的唯一线索。
    expect(reason).toContain('collapsed into the question object')
    expect(reason).toContain('"options": [{"label"')
  })

  it('选项整段 JSON 糊进键名的三种形态都被拒', () => {
    const question = { id: 'id-1', question: '问题正文', header: 'H' }
    for (const key of ['options [{', 'options：', 'options:']) {
      const reason = validateAskUserQuestionArgs({
        questions: [{ ...question, [key]: '' }],
      })
      expect(reason, key).toBeDefined()
      expect(reason, key).toContain('INVALID_USER_QUESTION')
      expect(reason, key).toContain(JSON.stringify(key))
    }
  })

  it('选项字段摊在问题对象上（label / description）被拒', () => {
    for (const key of ['label', 'description']) {
      const reason = validateAskUserQuestionArgs({
        questions: [{ id: 'id-1', question: '问题正文', [key]: '重绘左右跑动帧' }],
      })
      expect(reason, key).toBeDefined()
      expect(reason, key).toContain('INVALID_USER_QUESTION')
      expect(reason, key).toContain(key)
    }
  })

  it('退化 id（空串、冒号、破折号、空白、缺省、非字符串）被拒', () => {
    for (const bad of ['', '   ', ':', '---', '？！']) {
      const reason = validateAskUserQuestionArgs({
        questions: [{ id: bad, question: '问题正文', options: [{ label: 'A' }] }],
      })
      expect(reason, JSON.stringify(bad)).toBeDefined()
      expect(reason, JSON.stringify(bad)).toContain('INVALID_USER_QUESTION')
      expect(reason, JSON.stringify(bad)).toContain('"id"')
    }
    for (const bad of [undefined, 42, null, {}]) {
      const reason = validateAskUserQuestionArgs({
        questions: [{ id: bad, question: '问题正文', options: [{ label: 'A' }] }],
      })
      expect(reason, String(bad)).toContain('INVALID_USER_QUESTION')
    }
  })

  it('同一批里 id 重复（含首尾空白差异）被拒', () => {
    const reason = validateAskUserQuestionArgs({
      questions: [
        { id: 'scheme', question: '第一题', options: [{ label: 'A' }] },
        { id: '  scheme  ', question: '第二题', options: [{ label: 'B' }] },
      ],
    })
    expect(reason).toBeDefined()
    expect(reason).toContain('INVALID_USER_QUESTION')
    expect(reason).toContain('"scheme"')
    expect(reason).toContain('distinct stable id')
  })

  it('同一批里问题正文重复（含空白差异）被拒，并指向 options', () => {
    const text = '#2021 推荐重绘左右跑动帧……你希望采用哪种方案？'
    // 只换了空白（换行 / 尾部空格），归一化后仍是同一道题。
    const variant = '#2021\n推荐重绘左右跑动帧……你希望采用哪种方案？  '
    const reason = validateAskUserQuestionArgs({
      questions: [
        { id: 'a', question: text, options: [{ label: 'A' }] },
        { id: 'b', question: variant, options: [{ label: 'B' }] },
      ],
    })
    expect(reason).toBeDefined()
    expect(reason).toContain('INVALID_USER_QUESTION')
    expect(reason).toContain('repeats the question text')
    expect(reason).toContain('"options" array')
  })

  it('question 不是非空字符串时被拒', () => {
    for (const bad of ['', '   ', undefined, 42]) {
      const reason = validateAskUserQuestionArgs({
        questions: [{ id: 'id-1', question: bad, options: [{ label: 'A' }] }],
      })
      expect(reason, String(bad)).toContain('INVALID_USER_QUESTION')
      expect(reason, String(bad)).toContain('"question"')
    }
  })

  it('questions 里混进非对象条目时被拒', () => {
    const reason = validateAskUserQuestionArgs({ questions: ['把选项写成字符串'] })
    expect(reason).toBeDefined()
    expect(reason).toContain('INVALID_USER_QUESTION')
    expect(reason).toContain('questions[0]')
    expect(reason).toContain('must be a question object')
  })

  it('options 不是数组时被拒，并说明开放题该怎么办', () => {
    const reason = validateAskUserQuestionArgs({
      questions: [{ id: 'id-1', question: '问题正文', options: { label: 'A' } }],
    })
    expect(reason).toBeDefined()
    expect(reason).toContain('INVALID_USER_QUESTION')
    expect(reason).toContain('must be an array')
    expect(reason).toContain('Omit "options"')
  })

  it('选项条目坏掉的各种形态都被拒', () => {
    const question = (options: unknown): Record<string, unknown> => ({
      questions: [{ id: 'id-1', question: '问题正文', options }],
    })

    const notRecord = validateAskUserQuestionArgs(question(['重绘左右跑动帧']))
    expect(notRecord).toContain('INVALID_USER_QUESTION')
    expect(notRecord).toContain('options[0]')
    expect(notRecord).toContain('must be an object')

    const emptyLabel = validateAskUserQuestionArgs(question([{ label: '   ', description: 'x' }]))
    expect(emptyLabel).toContain('INVALID_USER_QUESTION')
    expect(emptyLabel).toContain('non-empty "label"')

    const missingLabel = validateAskUserQuestionArgs(question([{ description: 'x' }]))
    expect(missingLabel).toContain('INVALID_USER_QUESTION')
    expect(missingLabel).toContain('non-empty "label"')

    const duplicateLabel = validateAskUserQuestionArgs(question([
      { label: '重绘左右跑动帧' },
      { label: '  重绘左右跑动帧  ' },
    ]))
    expect(duplicateLabel).toContain('INVALID_USER_QUESTION')
    expect(duplicateLabel).toContain('repeats inside')
    expect(duplicateLabel).toContain('distinct label')

    const nestedQuestion = validateAskUserQuestionArgs(question([{ label: 'A', question: '问题正文' }]))
    expect(nestedQuestion).toContain('INVALID_USER_QUESTION')
    expect(nestedQuestion).toContain('misplaced key "question"')

    const nestedOptions = validateAskUserQuestionArgs(question([{ label: 'A', 'options：': '' }]))
    expect(nestedOptions).toContain('INVALID_USER_QUESTION')
    expect(nestedOptions).toContain('misplaced key')
  })
})

describe('调度执行守卫：主控提问载荷在执行期被拦下', () => {
  it('主控自己带着畸形载荷提问时，拒绝理由带 INVALID_USER_QUESTION', () => {
    const { guard } = host()
    const reason = guard()({
      name: 'ask_user_question',
      arguments: productionMalformedArgs(),
      agent: rootAgent(),
    })
    expect(reason).toContain('INVALID_USER_QUESTION')
    expect(reason).not.toContain('DELEGATED_CALLER')
  })

  it('主控的合法提问与开放题都放行', () => {
    const { guard } = host()
    expect(guard()({ name: 'ask_user_question', arguments: canonicalArgs(), agent: rootAgent() }))
      .toBeUndefined()
    expect(guard()({
      name: 'ask_user_question',
      arguments: { questions: [{ id: 'free-form', question: '还有别的想补充的吗？' }] },
      agent: rootAgent(),
    })).toBeUndefined()
  })

  it('越权判定排在载荷校验之前：子代理拿到的仍是原样的 DELEGATED_CALLER', () => {
    const { guard } = host()
    const reason = guard()({
      name: 'ask_user_question',
      arguments: productionMalformedArgs(),
      agent: subagentAgent(),
    })
    expect(reason).toContain('DELEGATED_CALLER')
    expect(reason).not.toContain('INVALID_USER_QUESTION')
    expect(reason).toContain('status: "hand_back"')
  })

  it('载荷校验不碰工具声明面：definitions 与 register 都没被调用', () => {
    const { guard, definitionsCalls, registerCalls } = host()
    guard()({ name: 'ask_user_question', arguments: productionMalformedArgs(), agent: rootAgent() })
    expect(definitionsCalls()).toBe(0)
    expect(registerCalls()).toBe(0)
  })

  it('开关读成 false 时载荷校验也停手', () => {
    const { guard } = host({ enabled: () => false })
    expect(guard()({
      name: 'ask_user_question',
      arguments: productionMalformedArgs(),
      agent: rootAgent(),
    })).toBeUndefined()
  })
})
