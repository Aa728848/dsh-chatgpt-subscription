/**
 * 「进展更新」在 locale 服务里的命名空间。
 *
 * 跟着本插件其余线路的命名习惯走（`dsh-kimi-code`、`dsh-step-code`、`dsh-ollama`
 * ……都是「dsh-<线路>」）：新线路并入本插件的字典体系，而不是另开一个与包名无关
 * 的命名空间。
 */
export const NS_PROGRESS_UPDATES = 'dsh-progress-updates' as const

/**
 * 中文文案。
 *
 * 键名沿用本插件其余字典的扁平驼峰（`hubTitle`、`imageToolRunning` 那一套），
 * 不另起一套点号命名——同一份 index.tsx 里两种命名风格会让「这条键属于哪张表」
 * 变成要靠记忆的事。
 */
export const zh = {
  /** 设置页导航里的那一格，也是侧栏页签的标题。 */
  navTitle: '进展更新',
  progressTitle: '进展更新',
  /** 右侧栏 guide 卡片标题下的一行说明。 */
  progressGuideNote: 'agent 汇报的每一步进展，都收在这里',
  markdownCopy: '复制',
  markdownCopied: '已复制',
  markdownFootnotes: '脚注',
  progressLatest: '最新',
  progressCount: '共 {n} 条',
  progressExpand: '展开这条进展',
  progressCollapse: '收起这条进展',
  progressEmptyTitle: '还没有进展更新',
  progressEmptyHint: 'agent 开始多步任务后，会在这里汇报它进行到哪一步。',
  rowPending: '进展更新',
  rowRunning: '进行中',
  rowDone: '已汇报',
  rowError: '未发出',
  rowExpand: '展开这条进展的详情',
  rowCollapse: '收起这条进展的详情',
  settingsHint: '进展更新会让 agent 在多步任务中主动汇报进度。打开面板可以看它到目前为止的全部汇报。',
  settingsOpen: '打开进展面板',
  settingsEnabledName: '进展更新',
  settingsEnabledNote: '让 agent 在对话中发布进展更新；本插件的所有线路都可用',
  settingsCacheWarmupName: '缓存预热',
  settingsCacheWarmupNote: '按线路配置：投影大型日志结果，原文可通过 ref 按需补读；只影响之后的新结果',
  settingsRetrievalName: '检索结果投影',
  settingsRetrievalNote: '按线路配置：导航任务中投影文件、网页与搜索，编辑审查保留原文；只影响之后的新结果',
  settingsCacheWaitWarmupName: '等待缓存续热',
  settingsCacheWaitWarmupNote: '等待子代理期间按缓存 TTL 轻量续热；默认用于 Kimi，其他线路需明确 TTL 并显式启用',
  settingsCacheAffinityName: '账号缓存亲和',
  settingsCacheAffinityNote: '多账号轮换时优先选前缀仍热的账号，低额度时让位；默认用于 Kimi，其他线路需证明账号级缓存并显式启用',
  settingsPlanModePipelineName: '计划模式管线',
  settingsPlanModePipelineNote: '澄清访谈收敛后自动进入计划模式出计划，再交审批（仅调度模式生效）；关闭后该模式会请用户手动输入 /plan',
  settingsDispatchExecutionGuardName: '调度执行守卫',
  settingsDispatchExecutionGuardNote: '执行期拦截子代理越权调用主控工具及等待子代理时的纯 sleep 空等；不改工具声明面，零损耗保护 Kimi 缓存',
  settingsToolRunawayGuardName: '工具失控治理',
  settingsToolRunawayGuardNote: '同一工具与参数连续重复时分级提醒；Kimi 保留第 12 次强停，其他线路只提醒',
  settingsTeamPolicyCacheGuardName: '智能体团队策略段',
  settingsTeamPolicyCacheGuardNote: '把内置 Agent Teams 的策略段从系统提示词摘掉，改为开启团队协作时以尾部消息投递一次；会话中途切开关不再刷掉整段前缀缓存（默认开启）',
  settingsThresholdName: '催促阈值',
  settingsThresholdNote: '连续这么多轮没有进展时，提醒 agent 汇报一次',
  settingsLanguageName: '输出语言',
  settingsLanguageNote: '进展更新的标题与正文用哪种语言写',
  settingsLanguageAuto: '自动（跟随对话）',
  settingsLanguageZh: '中文',
  settingsLanguageEn: 'English',
  settingsLanguageRu: 'Русский',
  settingsPanelName: '进展面板',
  settingsPanelNote: '在右侧栏查看本次会话的全部进展',
  settingsUnavailable: '这项设置当前不可修改（宿主没有开放配置表单）',
  settingsSaveFailed: '保存失败，请稍后再试',
} as const

/** 英文对照，键集与 zh 完全一致。 */
export const en: Record<ProgressUpdatesLocaleKey, string> = {
  navTitle: 'Progress updates',
  progressTitle: 'Progress updates',
  progressGuideNote: 'Every step the agent reports, collected here',
  markdownCopy: 'Copy',
  markdownCopied: 'Copied',
  markdownFootnotes: 'Footnotes',
  progressLatest: 'Latest',
  progressCount: '{n} total',
  progressExpand: 'Expand this update',
  progressCollapse: 'Collapse this update',
  progressEmptyTitle: 'No progress updates yet',
  progressEmptyHint: 'Once the agent starts multi-step work, it reports how far it has got right here.',
  rowPending: 'Progress update',
  rowRunning: 'Reporting',
  rowDone: 'Reported',
  rowError: 'Not reported',
  rowExpand: 'Expand this progress update',
  rowCollapse: 'Collapse this progress update',
  settingsHint: 'Progress updates let the agent report how far multi-step work has got. Open the panel to read everything it has reported so far.',
  settingsOpen: 'Open progress panel',
  settingsEnabledName: 'Progress updates',
  settingsEnabledNote: 'Let the agent post progress updates in the conversation; every line of this plugin can use it',
  settingsCacheWarmupName: 'Cache warmup',
  settingsCacheWarmupNote: 'Per-line control: project large log results and read the original through a ref on demand; only new results are affected',
  settingsRetrievalName: 'Retrieval projection',
  settingsRetrievalNote: 'Per-line control: project files, pages, and searches for navigation; keep source verbatim for editing and review; only new results are affected',
  settingsCacheWaitWarmupName: 'Wait-time cache keepalive',
  settingsCacheWaitWarmupNote: 'Keep the prefix warm while subagents run, using the line TTL; on by default for Kimi, other lines need a known TTL and explicit opt-in',
  settingsCacheAffinityName: 'Account cache affinity',
  settingsCacheAffinityNote: 'Prefer the account whose prefix is still warm, but yield when quota runs low; on by default for Kimi, other lines need proven account-scoped caching and explicit opt-in',
  settingsPlanModePipelineName: 'Plan-mode pipeline',
  settingsPlanModePipelineNote: 'After the clarification interview converges, enter plan mode, write the plan and send it for approval (dispatch mode only); turning it off makes that mode ask the user to type /plan',
  settingsDispatchExecutionGuardName: 'Dispatch execution guard',
  settingsDispatchExecutionGuardNote: 'Block subagents from calling dispatcher-only tools at execution time and reject pure sleep waits while child agents run; keeps tool declarations untouched to protect the Kimi prefix cache',
  settingsToolRunawayGuardName: 'Tool runaway guard',
  settingsToolRunawayGuardNote: 'Remind the agent when the same tool call repeats; Kimi keeps its 12th-call handoff, while other lines receive reminders only',
  settingsTeamPolicyCacheGuardName: 'Agent Teams policy section',
  settingsTeamPolicyCacheGuardNote: 'Lift the built-in Agent Teams policy section out of the system prompt and deliver it as one tail message when team collaboration is switched on, so toggling mid-session no longer rebuilds the whole prefix cache (on by default)',
  settingsThresholdName: 'Nudge threshold',
  settingsThresholdNote: 'Remind the agent after this many rounds without an update',
  settingsLanguageName: 'Output language',
  settingsLanguageNote: 'Which language the update titles and bodies are written in',
  settingsLanguageAuto: 'Auto (follow the conversation)',
  settingsLanguageZh: 'Chinese',
  settingsLanguageEn: 'English',
  settingsLanguageRu: 'Russian',
  settingsPanelName: 'Progress panel',
  settingsPanelNote: 'See every update from this session in the right sidebar',
  settingsUnavailable: 'This setting cannot be changed right now (the host serves no config form)',
  settingsSaveFailed: 'Could not save. Try again in a moment.',
}

/** 与其余线路同形的字典包（四个内置语言 id 都指向那两份）。 */
export const dictionaries = {
  zh,
  'zh-CN': zh,
  en,
  'en-US': en,
}

/** 本命名空间的字典键联合，供类型化 `t` 座位使用。 */
export type ProgressUpdatesLocaleKey = keyof typeof zh

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** 「进展更新」的界面文案。 */
    'dsh-progress-updates': ProgressUpdatesLocaleKey
  }
}
