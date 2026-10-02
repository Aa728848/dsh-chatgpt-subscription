import { accountPoolEn, accountPoolZh } from '../common/account-pool-labels.ts'

export const NS_OLLAMA = 'dsh-ollama'

export const zh = {
  // The account-management card is shared with every other provider tab, so its
  // labels come from one place instead of drifting per provider. Only the two
  // entries that are wrong for a pasted key are overridden below.
  ...accountPoolZh,
  // Two overrides, and both are factual rather than cosmetic: an Ollama key
  // never expires and is replaced rather than re-signed-in, so the shared
  // wording would state something untrue about this line.
  relogin: '更换 Key',
  needsRelogin: 'Key 已失效',
  addAccount: '添加 API Key',
  noAccounts: '暂无 API Key。点击「添加 API Key」粘贴 ollama.com 创建的 Key。',
  storageNotice: 'API Key 由 Host 保存于本地安全存储，不会进入浏览器。',

  title: 'Ollama',
  pageDesc: '接入 Ollama Cloud，用多个 API Key 组成号池，自动轮换与故障转移。',
  provider: 'Provider',
  providerValue: 'Ollama · ollama',
  routeOwned: '模型路由由本插件提供',
  routeConflict: '模型路由已被其他 Provider 占用：{detail}。请在 DSH 设置中移除重复的 Provider 配置后重试。',

  // Sign-in is a paste, not a flow: the service issues a static key and there
  // is nothing to authorize.
  keySection: '添加 API Key',
  keyHint: '在 https://ollama.com/settings/keys 创建 API Key 后粘贴到此处。Key 不会过期，可随时在设置页吊销。',
  keyPlaceholder: '粘贴 Ollama API Key',
  keyAliasLabel: '备注名（可选）',
  keyAliasPlaceholder: '例如：主号、备用号',
  keyAliasHint: 'Ollama 不返回账号信息，多个 Key 靠备注名区分。',
  keySave: '添加',
  keySaving: '添加中...',

  modelsSection: '模型',
  modelsHint: '模型列表来自 Ollama 的 /api/tags，随服务更新，无需手动维护。',
  catalogSync: '同步模型列表',
  catalogSyncing: '同步中...',
  catalogNeverSynced: '尚未同步模型列表。',
  catalogEmpty: 'Ollama 未返回任何模型。',
  catalogNeedKey: '请先添加一个 API Key，再同步模型列表。',
  catalogFailed: '无法从 Ollama 读取模型列表。',
  modelCount: '{count} 个模型',
  noModels: '暂无可用模型。',

  // Stated plainly, because these are documented service limits and a user who
  // hits them deserves to know they are not a bug here.
  limitsSection: '能力边界',
  limitsHint: '以下为 Ollama Cloud 官方文档列出的限制，本线路不会绕过：',
  limitNoStateful: '不支持 Responses 的有状态会话（仅无状态形式）。',
  limitNoWebSearch: '不支持通过 /v1/responses 使用内置联网搜索。',
  limitNoToolReplay: '不支持自定义工具调用的重放（replay）。',
  limitUsage: 'Ollama 没有配额/剩余额度 API（上游 issue #15132、#15663 均已关闭），所以只能显示「已消耗」，无法显示「剩余多少」。',
  wireNote: '请求默认走 OpenAI 兼容面（/v1），必要时回落到原生面（/api/chat）。',

  lastModel: '最近模型',
  keyCreated: '添加于',
  error: '操作失败：{detail}',
  usageTitle: '累计消耗',
  usageInput: '输入 {tokens}',
  usageOutput: '输出 {tokens}',
  usageRequests: '{count} 次请求',
  usageNone: '尚无请求',
  usageHint: '按 Ollama 每次响应自带的 token 计数本地累加。',
} as const

export const en = {
  ...accountPoolEn,
  relogin: 'Replace Key',
  needsRelogin: 'Key rejected',
  addAccount: 'Add API Key',
  noAccounts: 'No API keys yet. Click "Add API Key" to paste one from ollama.com.',
  storageNotice: 'API keys are stored locally by the Host and never sent to the browser.',

  title: 'Ollama',
  pageDesc: 'Connect Ollama Cloud with several API keys pooled for rotation and failover.',
  provider: 'Provider',
  providerValue: 'Ollama · ollama',
  routeOwned: 'Model route served by this plugin',
  routeConflict: 'The model route is already owned by another provider: {detail}',

  keySection: 'Add an API key',
  keyHint: 'Create a key at https://ollama.com/settings/keys and paste it here. Keys do not expire and can be revoked from that page.',
  keyPlaceholder: 'Paste an Ollama API key',
  keyAliasLabel: 'Label (optional)',
  keyAliasPlaceholder: 'e.g. primary, backup',
  keyAliasHint: 'Ollama reports no account identity, so labels are what tell several keys apart.',
  keySave: 'Add',
  keySaving: 'Adding...',

  modelsSection: 'Models',
  modelsHint: 'The list comes from Ollama \'/api/tags\' and tracks the service, so there is nothing to maintain by hand.',
  catalogSync: 'Sync model list',
  catalogSyncing: 'Syncing...',
  catalogNeverSynced: 'The model list has not been synced yet.',
  catalogEmpty: 'Ollama returned no models.',
  catalogNeedKey: 'Add an API key before syncing the model list.',
  catalogFailed: 'Could not read the model list from Ollama.',
  modelCount: '{count} model(s)',
  noModels: 'No models available.',

  limitsSection: 'Documented limits',
  limitsHint: 'Ollama Cloud documents these limits; this line does not work around them:',
  limitNoStateful: 'No stateful Responses (stateless only).',
  limitNoWebSearch: 'No built-in web search through /v1/responses.',
  limitNoToolReplay: 'No replay of custom tool calls.',
  limitUsage: 'Ollama has no quota or remaining-balance API (upstream issues #15132 and #15663 were both closed), so this card can show what has been consumed but not what is left.',
  wireNote: 'Requests use the OpenAI-compatible surface (/v1) and fall back to the native surface (/api/chat) when needed.',

  lastModel: 'Last model',
  keyCreated: 'Added',
  error: 'Action failed: {detail}',
  usageTitle: 'Consumed so far',
  usageInput: 'in {tokens}',
  usageOutput: 'out {tokens}',
  usageRequests: '{count} request(s)',
  usageNone: 'No requests yet',
  usageHint: 'Summed locally from the token counts Ollama returns on each response.',
} as const

// Same shape every other provider locale exports: the host selects the active
// locale and the section reads the flat dictionary through it.
export const dictionaries = {
  zh,
  'zh-CN': zh,
  en,
  'en-US': en,
}

export type OllamaLocaleKey = keyof typeof zh

