/**
 * 「子智能体」设置卡片的文案与命名空间。
 *
 * ## 为什么这里另起一个命名空间
 *
 * 宿主自带的子智能体设置页有自己的 `settings.subagent` 命名空间，而本卡是
 * **替换**它（同 id、更低 priority 遮蔽），不是与它并存。文案表因此归本插件所有：
 * 键名沿用本插件其余线路的扁平驼峰（`hubTitle`、`settingsEnabledName` 那一套），
 * 不引入宿主的点号风格。
 *
 * ## 键集是契约
 *
 * `SubagentLocaleKey` 由中文表反推，英文表用 `Record<SubagentLocaleKey, string>`
 * 钉死——少一条键编译期就报，而不是等到界面上渲染出键名本身。
 */

/** 本卡片在 locale 服务里的命名空间。 */
export const NS_SUBAGENT = 'dsh-subagent-settings' as const

/** 中文文案（键集的唯一定义处）。 */
export const zh = {
  overridden: '已覆盖',
  reset: '恢复默认',
  readOnly: '本部署的设置为只读。',
  unavailable: '该插件当前未加载，暂时无法配置。',
  save: '保存',
  saving: '保存中…',
  saveFailed: '本部署没有接受这些值，已保留供你修改。',
  discard: '放弃修改',

  subagentTitle: '子智能体',
  subagentDescription: '设置子智能体的递归层级、数量和模型。',
  subagentLimitsTitle: '运行限制',
  subagentMaxDepth: '最大递归深度',
  subagentDepthHelpLabel: '最大递归深度说明',
  subagentDepthHelp: '限制 Agent 创建子智能体的递归层级。',
  subagentDepthZero: '禁用子智能体',
  subagentDepthOne: '仅允许主 Agent 创建子智能体',
  subagentDepthOverride: '如果某个工具单独设置了最大递归深度，以该工具的设置为准。',
  subagentMaxActive: '子智能体并行数量上限',
  subagentCapacityHelpLabel: '子智能体并行数量上限说明',
  subagentCapacityHelp: '同一主 Agent 下，所有递归层级同时存活的子智能体总数，主 Agent 不计入。达到上限时，新的启动请求会被拒绝。',
  subagentDepthInvalid: '请输入不小于 0 的整数。',
  subagentCapacityInvalid: '请输入不小于 1 的整数。',

  subagentModelSelectionTitle: '模型选择',
  subagentModelSelectionToggle: '允许 Agent 为子智能体选择模型',
  subagentModelSelectionChoose: '开启后，Agent 可以从下方授权模型中，为每个子智能体选择提供方、模型和推理强度。仅影响新会话。',
  subagentModelSelectionAllowed: 'Agent 可选择的模型',
  subagentModelSelectionLoading: '正在加载模型…',
  subagentModelSelectionLoadFailed: '无法加载模型。',
  subagentModelSelectionRetry: '重试',
  subagentModelSelectionPartial: '部分模型提供方暂时无法加载；已保存的选择仍可移除。',
  subagentModelSelectionUnavailable: '当前不可用',
  subagentModelSelectionUnavailableGroup: '已保存但当前不可用',
  subagentModelSelectionEmpty: '当前没有模型提供方公布模型。',
  subagentModelSelectionRequired: '保存前请至少选择一个模型。',
  subagentModelSelectionOff: '关闭后，子智能体使用配置的默认模型或继承父 Agent 的模型；已选模型会保留。',

  subagentMainModelLabel: '主代理模型配置栏',
  subagentMainModelGlobalOption: '全局默认（未单独配置的主代理使用）',
  subagentMainModelQuickSwitch: '快捷切换',
  subagentChipGlobal: '全局默认 ({count})',
  subagentTargetGlobalHint: '正在编辑全局默认子代理模型列表；未单独配置专属列表的主代理将使用此列表。',
  subagentTargetOverrideStatus: '已为该主代理单独配置 {count} 个子代理模型',
  subagentTargetFollowGlobalStatus: '当前跟随全局默认列表（勾选或取消下方模型即可为该主代理创建专属列表）',
  subagentResetToGlobal: '恢复跟随全局默认',
  subagentOverrideBadge: '（已覆盖）',
  subagentPreferencesLoadFailed: '无法读取已保存的子代理模型偏好；保存时将以当前界面为准。',
  subagentModelPerTargetRequired: '保存前请至少选择一个模型（或点击「恢复跟随全局默认」）。',
} as const

/** 本命名空间的字典键联合。 */
export type SubagentLocaleKey = keyof typeof zh

/** 英文对照，键集与中文完全一致。 */
export const en: Record<SubagentLocaleKey, string> = {
  overridden: 'Overridden',
  reset: 'Reset to default',
  readOnly: 'This deployment stores settings read-only.',
  unavailable: 'This plugin is not loaded, so it cannot be configured right now.',
  save: 'Save',
  saving: 'Saving…',
  saveFailed: 'The deployment did not accept these values; they were left for you to correct.',
  discard: 'Discard changes',

  subagentTitle: 'Subagent',
  subagentDescription: 'Set Subagent recursion depth, count, and models.',
  subagentLimitsTitle: 'Limits',
  subagentMaxDepth: 'Maximum recursion depth',
  subagentDepthHelpLabel: 'About maximum recursion depth',
  subagentDepthHelp: 'Limits how many levels of Subagents an Agent can create.',
  subagentDepthZero: 'Disable Subagents',
  subagentDepthOne: 'Only the main Agent can create Subagents',
  subagentDepthOverride: 'If a tool defines its own maximum recursion depth, that setting takes precedence.',
  subagentMaxActive: 'Subagent parallelism limit',
  subagentCapacityHelpLabel: 'About the Subagent parallelism limit',
  subagentCapacityHelp: 'Total live Subagents under the same main Agent, across all recursion levels. The main Agent is excluded. New start requests are rejected when the limit is reached.',
  subagentDepthInvalid: 'Enter a whole number of 0 or more.',
  subagentCapacityInvalid: 'Enter a whole number of 1 or more.',

  subagentModelSelectionTitle: 'Model selection',
  subagentModelSelectionToggle: 'Allow agents to choose models for Subagents',
  subagentModelSelectionChoose: 'When enabled, agents can choose a provider, model, and reasoning effort for each Subagent from the authorized models below. Applies only to new sessions.',
  subagentModelSelectionAllowed: 'Models agents may choose',
  subagentModelSelectionLoading: 'Loading models…',
  subagentModelSelectionLoadFailed: 'Models could not be loaded.',
  subagentModelSelectionRetry: 'Retry',
  subagentModelSelectionPartial: 'Some model providers could not be loaded; saved choices remain removable.',
  subagentModelSelectionUnavailable: 'Currently unavailable',
  subagentModelSelectionUnavailableGroup: 'Saved but currently unavailable',
  subagentModelSelectionEmpty: 'No model provider currently advertises a model.',
  subagentModelSelectionRequired: 'Select at least one model before saving.',
  subagentModelSelectionOff: "Subagents use configured defaults or inherit the parent agent's model. Saved model choices are retained.",

  subagentMainModelLabel: 'Main agent model',
  subagentMainModelGlobalOption: 'Global default (used by main agents without their own list)',
  subagentMainModelQuickSwitch: 'Quick switch',
  subagentChipGlobal: 'Global default ({count})',
  subagentTargetGlobalHint: 'Editing the global default subagent model list; main agents without their own list use it.',
  subagentTargetOverrideStatus: 'This main agent has {count} dedicated subagent models',
  subagentTargetFollowGlobalStatus: 'Currently following the global default list (tick or untick a model below to create a dedicated list for this main agent)',
  subagentResetToGlobal: 'Follow the global default again',
  subagentOverrideBadge: ' (overridden)',
  subagentPreferencesLoadFailed: 'Saved subagent model preferences could not be read; saving will use what this page shows.',
  subagentModelPerTargetRequired: 'Select at least one model before saving (or choose "Follow the global default again").',
}

/** 与其余线路同形的字典包（四个内置语言 id 都指向那两份）。 */
export const dictionaries = {
  zh,
  'zh-CN': zh,
  en,
  'en-US': en,
}
