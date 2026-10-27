import { accountPoolEn, accountPoolZh } from '../common/account-pool-labels.ts'
import type {
  QoderAdoptResultDto,
  QoderQuotaBucketKind,
  QoderRegion,
} from '../../shared/qoder-contracts.ts'

/**
 * Qoder（订阅）线路的客户端命名空间。
 *
 * 与其余每条线路一个命名空间：卡片渲染自己的字典，不复用 hub 挂在
 * 'settings.section' 上的那张座位（那张座绑定的是 ChatGPT 的键集）。
 */
export const NS_QODER = 'dsh-qoder'

export const zh = {
  // 模型行的一句话能力（与 OpenDesign 卡同一习惯：数据，不是散文）。
  modelRowEfforts: '档位 {list}',
  modelRowNoEfforts: '无档位',
  modelRowOutput: '输出 {cap}',
  // 账号池卡片与其配额条是共享组件，文案统一由 account-pool-labels 提供，本文件不重复硬编码。
  ...accountPoolZh,
  title: 'Qoder（订阅）',
  pageDesc: '用 Qoder 订阅接入（全球区 qoder.com / 中国站 qoder.com.cn），管理账号池、套餐额度、缓存用量与模型勾选。区域是凭据的属性，两区凭据互不通用，因此号池里可以同时存在两区账号。',
  loading: '加载中...',
  /** 折叠区的标题：标题下只留一句，其余原句收在这里（折叠不是删除）。 */
  moreNotes: '更多说明',

  region: '区域',
  regionGlobal: '全球区（qoder.com）',
  regionCn: '中国站（qoder.com.cn）',
  regionHint: '区域由凭据唯一决定，本页只决定「下一次登录」落在哪一区；两区端点互不通用。',
  regionHintExtra: '全球区支持浏览器设备流登录与 PAT；中国站没有设备流，只支持 PAT 粘贴或导入本机 qodercli 登录态。粘贴 PAT 时不用纠结区域：一个区拒了，插件会自动改试另一个区，落盘的是真正认这把 PAT 的那一区。',

  authorizing: '授权中…',

  loginIdle: '尚未开始登录。',
  /** idle 不是「你没登录」：host 的流程状态是进程内变量，重启后回到 idle 而号池里的账号还在。 */
  loginHaveAccounts: '号池里已有 {count} 个账号可用。要再加一个就点上面的「添加账号」。',
  loginPending: '请在浏览器里人工确认授权，然后本卡片会自动继续。设备流登录不开本地回调端口，流程跑在 host 上。',
  loginComplete: '登录完成，账号已加入号池。',
  loginCompletedAt: '完成时间：{time}',
  loginCompleteNoAccount: '这次登录完成了，但号池里已经没有这个账号（可能已被删除）。',
  loginError: '登录失败。',
  loginRetryable: '这是可重试的失败（传输错误或超时），可以直接重新发起一次登录。',
  loginNotRetryable: '这次失败不会自己好（协议不合法或被拒绝），请检查网络与所选区域后重新发起。',
  authorizeUrl: '授权页面',
  openAuthorizeUrl: '打开授权页面',
  pollEvery: '每 {seconds} 秒查询一次登录结果。',
  loginExpiresAt: '本次授权最长可用到 {time}，过期后需要重新发起。',
  progress: '进度',
  cancelLogin: '取消登录',
  cancelLoginBusy: '正在取消…',

  adopt: '导入本机 qodercli 登录态',
  adopting: '导入中…',
  adoptAdopted: '已导入本机 qodercli 的登录态（区域：{region}）。',
  adoptNoAttempt: '没有执行导入。',
  adoptFallback: '可以改用浏览器登录（全球区）或粘贴 PAT。',
  adoptNoCredentialsFile: '本机没有找到 qodercli 的登录态文件。',
  adoptInvalidCredentials: 'qodercli 的登录态文件读不出来（空、损坏或解密失败）。',
  adoptUnsupportedShape: '这份登录态的字段组合不认识（上游可能改版）。',
  adoptNotAQoderLogin: '这个文件里没有可用的 Qoder 登录态（没有 access_token）。',
  adoptRegionUnresolved: '登录态解密成功，但两个区域的 userinfo 都不认这把 token（可能已过期）。',
  dismiss: '知道了',

  manualPasteSection: '手动粘贴 PAT',
  manualPasteHint: '在 Qoder 账号的 Integrations 页生成一个 Personal Access Token（pt-...），粘贴到这里。它会被兑换成短期 job token 使用；PAT 本体只存在 host 的加密存储里，用于过期后重新兑换。',
  manualPastePlaceholder: 'pt-...',
  manualPasteSubmit: '粘贴并登录',
  manualPasteSubmitting: '兑换中…',
  manualPasteEmpty: '请先粘贴一个 PAT。',

  connection: '连接',
  routeOwned: '本插件正在服务该 Provider 路由。',
  routeConflict: '该 Provider 路由被别的适配器占用：{detail}',
  testConnection: '测试连接',
  testingConnection: '测试中…',
  testSuccess: '连接成功',
  testLatency: '耗时 {ms} ms',
  testFailedDetail: '连接失败：{detail}',

  modelsSection: '模型',
  modelsHint: '目录在登录后从上游实时发现；还没登录时显示的是随包的能力兜底表。',
  modelsHintExtra: '能力（上下文窗口 / 图片输入 / 思考档位）全部来自目录端点的字段，不从模型名推断；目录里的 max_input_tokens 是上游的陈旧地板值，本线路不信它，窗口取 context_config 的最大档。',
  modelsUnavailable: '暂无模型目录。登录后点右上角「刷新目录」。',
  refreshCatalog: '刷新目录',
  refreshingCatalog: '刷新中…',
  selectAll: '全选',
  unselectAll: '全不选',
  modelChecklistCount: '已选 {count} / {total}',
  enabledModelIdsSemantics: '勾选全清 = 全部模型都不可用（不是「不过滤」）；要恢复全部请点「全选」。',

  defaultEffort: '默认思考档位',
  defaultEffortHint: '会话没指定档位时用的档位；各模型有自己的默认时以模型为准。',
  defaultEffortHintExtra: '上游的档位是逐模型声明的（目录 thinking_config 的键集）；这里选的一档会先收敛到该模型真实接受的梯子上再发出去，模型不认的档位永远不会被发出。',
  defaultEffortModel: '跟随各模型默认',
  effortMinimal: 'minimal',
  effortLow: 'low',
  effortMedium: 'medium',
  effortHigh: 'high',
  effortXHigh: 'xhigh',
  effortMax: 'max',

  contextWindowSection: '上下文窗口',
  contextWindowHint: '默认值来自目录（context_config 的最大档）；这里给单个模型设置覆盖值。',
  contextWindowHintExtra: '覆盖值只影响本地规划（何时压缩会话），不改变上游模型的真实窗口。',
  contextWindowReset: '恢复默认',
  contextWindowResetAll: '全部恢复默认',
  contextWindowNoneEnabled: '没有已勾选的模型。',
  tokens: 'tokens',
  save: '保存',
  saving: '保存中…',
  invalidCapacity: '无效的容量：{value}',

  quotaSection: '额度',
  quotaDesc: '额度来自 Qoder 的账号额度接口（非公开的个人端点，上游可能改版）。它按账号周期给出个人额度、加购 Credits 与组织资源包三只桶的总量 / 已用 / 剩余。',
  quotaBucketPersonal: '个人额度',
  quotaBucketAddOn: '加购 Credits',
  quotaBucketOrg: '组织资源包',
  quotaRemaining: '剩余',
  quotaUsed: '已用',
  quotaTotal: '总额',
  quotaExpiresAt: '周期截止',
  quotaReadAt: '读取时间',
  quotaRegion: '区域',
  quotaRefresh: '刷新额度',
  quotaRefreshing: '刷新中…',
  quotaRefreshingNote: '正在后台刷新额度…',
  quotaEmpty: '还没有读到额度。',
  quotaSignedOut: '登录后这里显示账号的额度。',
  quotaErrorLabel: '额度读取失败',
  quotaNoUnit: '',
  /** 上游明说额度用尽：它是账号层面的事实，三只桶全是 0 时只有它能说清为什么被拒。 */
  quotaExceeded: '额度已用尽',
  quotaExceededHint: '上游说这个账号的额度已经用尽，请求会被拒。额度恢复之前发消息会失败：可以等周期重置，或在额度页升级套餐。',
  quotaUpgradeLink: '打开升级页面',

  cacheSection: '缓存用量',
  cacheStatScope: '本机统计（token 维度，自本进程启动累计）：它回答「缓存帮了多少忙」，不是上游账单。',
  cacheDesc: 'Qoder 服务端自动做前缀缓存；命中量从响应的 usage.prompt_tokens_details.cached_tokens 读出（缺失时读顶层 cached_tokens）。本线路订阅没有公开的 token 单价，整页只显示 token 数字，不显示金额。',
  cacheEmpty: '还没有样本。发一条消息后这里会出现统计。',
  cacheHitRatio: '缓存命中率',
  cacheHitRatioUnavailable: '—',
  cacheReadTokens: '缓存读入',
  cacheMissedTokens: '未命中输入',
  cacheWriteTokens: '缓存写入',
  cacheRequests: '样本请求数',

  composerLabel: '剩余额度',
  quotaWindow: '额度窗口',
}

export type QoderLocaleKey = keyof typeof zh

export const en: Record<QoderLocaleKey, string> = {
  modelRowEfforts: 'efforts {list}',
  modelRowNoEfforts: 'no efforts',
  modelRowOutput: 'out {cap}',
  ...accountPoolEn,
  title: 'Qoder (Subscription)',
  pageDesc: 'Connect your Qoder subscription (Global qoder.com / China qoder.com.cn): manage the account pool, plan quota, cache usage and model selection. Region is a property of the credential; the two regions do not accept each other\'s tokens, so the pool may hold accounts from both.',
  loading: 'Loading...',
  moreNotes: 'More notes',

  region: 'Region',
  regionGlobal: 'Global (qoder.com)',
  regionCn: 'China (qoder.com.cn)',
  regionHint: 'Region is a property of the credential; this picker only decides where the NEXT sign-in lands.',
  regionHintExtra: 'Global supports browser device sign-in and PAT; the China site has no device flow — paste a PAT or import the local qodercli session. When pasting a PAT you need not get the region right: if one region rejects it, the plugin retries the other and stores whichever region actually accepts it.',

  authorizing: 'Authorizing…',

  loginIdle: 'No sign-in has been started yet.',
  loginHaveAccounts: 'The pool already holds {count} account(s). Add another with the button above.',
  loginPending: 'Confirm the authorization in your browser; this card continues automatically. The device flow opens no local callback port; the flow runs on the host.',
  loginComplete: 'Sign-in complete; the account joined the pool.',
  loginCompletedAt: 'Completed at {time}',
  loginCompleteNoAccount: 'The sign-in completed, but the account is no longer in the pool (it may have been deleted).',
  loginError: 'Sign-in failed.',
  loginRetryable: 'This failure is retryable (transport error or timeout); you can simply start the sign-in again.',
  loginNotRetryable: 'This failure will not fix itself (protocol violation or rejection); check the network and the chosen region, then try again.',
  authorizeUrl: 'Authorization page',
  openAuthorizeUrl: 'Open authorization page',
  pollEvery: 'Polling the sign-in result every {seconds} s.',
  loginExpiresAt: 'This authorization stays valid until {time}; start over after it expires.',
  progress: 'Progress',
  cancelLogin: 'Cancel sign-in',
  cancelLoginBusy: 'Cancelling…',

  adopt: 'Import local qodercli session',
  adopting: 'Importing…',
  adoptAdopted: 'Imported the local qodercli session (region: {region}).',
  adoptNoAttempt: 'No import was attempted.',
  adoptFallback: 'You can sign in with the browser (Global) or paste a PAT instead.',
  adoptNoCredentialsFile: 'No qodercli credential file found on this machine.',
  adoptInvalidCredentials: 'The qodercli credential file could not be read (empty, corrupted, or decrypt failed).',
  adoptUnsupportedShape: 'The session decrypted but its field set is not recognized (the upstream may have changed).',
  adoptNotAQoderLogin: 'This file holds no usable Qoder session (no access_token).',
  adoptRegionUnresolved: 'The session decrypted, but neither region\'s userinfo accepts the token (it may be expired).',
  dismiss: 'Dismiss',

  manualPasteSection: 'Paste a PAT',
  manualPasteHint: 'Create a Personal Access Token (pt-...) on your Qoder account\'s Integrations page and paste it here. It is exchanged for a short-lived job token; the PAT itself stays in the host\'s encrypted store and is re-exchanged on expiry.',
  manualPastePlaceholder: 'pt-...',
  manualPasteSubmit: 'Paste & sign in',
  manualPasteSubmitting: 'Exchanging…',
  manualPasteEmpty: 'Paste a PAT first.',

  connection: 'Connection',
  routeOwned: 'This plugin is serving the provider route.',
  routeConflict: 'The provider route is claimed by another adapter: {detail}',
  testConnection: 'Test connection',
  testingConnection: 'Testing…',
  testSuccess: 'Connected',
  testLatency: '{ms} ms',
  testFailedDetail: 'Connection failed: {detail}',

  modelsSection: 'Models',
  modelsHint: 'The catalog is discovered live after sign-in; before that the bundled capability fallback table is shown.',
  modelsHintExtra: 'Capabilities (context window / image input / thinking efforts) come from catalog fields only, never from the model name; the catalog\'s max_input_tokens is a stale floor value upstream and is NOT trusted — the window is the largest context_config option.',
  modelsUnavailable: 'No model catalog yet. Sign in, then use "Refresh catalog" above.',
  refreshCatalog: 'Refresh catalog',
  refreshingCatalog: 'Refreshing…',
  selectAll: 'All',
  unselectAll: 'None',
  modelChecklistCount: '{count} / {total} selected',
  enabledModelIdsSemantics: 'Clearing every checkbox makes every model unavailable (it is not "no filter"); to bring them all back, use "All".',

  defaultEffort: 'Default thinking effort',
  defaultEffortHint: 'Used when the session does not name one; a model\'s own default wins when it has one.',
  defaultEffortHintExtra: 'Upstream efforts are declared per model (the catalog\'s thinking_config keys); the level chosen here is first snapped onto the ladder the model actually accepts, so a value the model rejects is never sent.',
  defaultEffortModel: 'Model default',
  effortMinimal: 'minimal',
  effortLow: 'low',
  effortMedium: 'medium',
  effortHigh: 'high',
  effortXHigh: 'xhigh',
  effortMax: 'max',

  contextWindowSection: 'Context window',
  contextWindowHint: 'Defaults come from the catalog (the largest context_config option); set a per-model override here.',
  contextWindowHintExtra: 'An override only changes local planning (when to compact the conversation); it does not change the model\'s real window upstream.',
  contextWindowReset: 'Reset',
  contextWindowResetAll: 'Reset all',
  contextWindowNoneEnabled: 'No models are enabled.',
  tokens: 'tokens',
  save: 'Save',
  saving: 'Saving…',
  invalidCapacity: 'Invalid capacity: {value}',

  quotaSection: 'Quota',
  quotaDesc: 'Quota is read from Qoder\'s account usage endpoint (a non-public personal endpoint; it may change upstream). It reports three buckets per account period: personal quota, add-on Credits, and the organization resource package.',
  quotaBucketPersonal: 'Personal quota',
  quotaBucketAddOn: 'Add-on Credits',
  quotaBucketOrg: 'Org package',
  quotaRemaining: 'remaining',
  quotaUsed: 'used',
  quotaTotal: 'total',
  quotaExpiresAt: 'Period ends',
  quotaReadAt: 'Read at',
  quotaRegion: 'Region',
  quotaRefresh: 'Refresh quota',
  quotaRefreshing: 'Refreshing…',
  quotaRefreshingNote: 'Refreshing quota in the background…',
  quotaEmpty: 'No quota has been read yet.',
  quotaSignedOut: 'Sign in to see the account\'s quota here.',
  quotaErrorLabel: 'Quota read failed',
  quotaNoUnit: '',
  quotaExceeded: 'Quota exhausted',
  quotaExceededHint: 'Upstream says this account\'s quota is exhausted, so requests get rejected. Sending a message fails until the quota resets: wait for the period to reset, or upgrade the plan on the quota page.',
  quotaUpgradeLink: 'Open the upgrade page',

  cacheSection: 'Cache usage',
  cacheStatScope: 'Local statistics (tokens, accumulated since this process started): it answers "how much the cache helped", not the upstream bill.',
  cacheDesc: 'Qoder caches prefixes automatically server-side; hits are read from usage.prompt_tokens_details.cached_tokens (falling back to a top-level cached_tokens). There is no public per-token price for the subscription, so this page shows token counts only, never money.',
  cacheEmpty: 'No samples yet. Send a message and the statistics appear here.',
  cacheHitRatio: 'Cache hit ratio',
  cacheHitRatioUnavailable: '—',
  cacheReadTokens: 'Cache read',
  cacheMissedTokens: 'Uncached input',
  cacheWriteTokens: 'Cache write',
  cacheRequests: 'Sampled requests',

  composerLabel: 'quota left',
  quotaWindow: 'Limit window',
}

/** 两套字典。 */
export const dictionaries = { zh, en }

/** adopt 的失败原因（冻结契约的联合）。 */
export type AdoptReason = NonNullable<QoderAdoptResultDto['reason']>

/** reason → 字典键。一个 reason 一种文案，因此这里是封闭映射而不是兜底串。 */
const ADOPT_REASON_KEYS: Record<AdoptReason, QoderLocaleKey> = {
  'no-credentials-file': 'adoptNoCredentialsFile',
  'invalid-credentials': 'adoptInvalidCredentials',
  'unsupported-shape': 'adoptUnsupportedShape',
  'not-a-qoder-login': 'adoptNotAQoderLogin',
  'region-unresolved': 'adoptRegionUnresolved',
}

export function adoptReasonText(
  reason: AdoptReason,
  dictionary: Record<QoderLocaleKey, string>,
): string {
  return dictionary[ADOPT_REASON_KEYS[reason]]
}

/** 区域 → 字典键。 */
const REGION_KEYS: Record<QoderRegion, QoderLocaleKey> = {
  global: 'regionGlobal',
  cn: 'regionCn',
}

export function regionText(
  region: QoderRegion,
  dictionary: Record<QoderLocaleKey, string>,
): string {
  return dictionary[REGION_KEYS[region]]
}

/** 额度桶 → 字典键。契约是封闭联合，认不出的桶不下发，所以没有兜底串。 */
const QUOTA_BUCKET_KEYS: Record<QoderQuotaBucketKind, QoderLocaleKey> = {
  personal: 'quotaBucketPersonal',
  'add-on': 'quotaBucketAddOn',
  org: 'quotaBucketOrg',
}

export function quotaBucketText(
  kind: QoderQuotaBucketKind,
  dictionary: Record<QoderLocaleKey, string>,
): string {
  return dictionary[QUOTA_BUCKET_KEYS[kind]]
}
