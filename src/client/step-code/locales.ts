import { accountPoolEn, accountPoolZh } from '../common/account-pool-labels.ts'
import type {
  StepCodeAdoptResultDto,
  StepCodeProfile,
  StepCodeQuotaCredentialStatusDto,
  StepCodeQuotaSnapshotDto,
  StepCodeQuotaWindowKey,
} from '../../shared/step-code-contracts.ts'

/**
 * Step Code（Step Plan 订阅）线路的客户端命名空间。
 *
 * 与其余每条线路一个命名空间：卡片渲染自己的字典，不复用 hub 挂在
 * 'settings.section' 上的那张座位（那张座绑定的是 ChatGPT 的键集，
 * 键名重合的会被渲染成 ChatGPT 的措辞，不重合的会把键名本身打印出来）。
 */
export const NS_STEP_CODE = 'dsh-step-code'

export const zh = {
  // 账号池卡片与其配额条是共享组件，文案统一由 account-pool-labels 提供；
  // 窗口名（5 小时 / 1 周 / 1 月）也在那里，本文件不重复硬编码一份。
  ...accountPoolZh,
  title: 'Step Code（Step Plan 订阅）',
  pageDesc: '用 StepFun 的 Step Plan 订阅（国区 api.stepfun.com / 国际区 api.stepfun.ai）或开放平台 API Key 接入，管理账号池、套餐额度、缓存用量与模型勾选。区域是凭据的属性，两区凭据互不通用，因此号池里可以同时存在两区账号。',
  loading: '加载中...',
  /** 折叠区的标题：标题下只留一句，其余原句收在这里（折叠不是删除）。 */
  moreNotes: '更多说明',

  profile: '凭据类型',
  profileStepPlan: '国区 Step Plan（订阅，浏览器授权）',
  profileStepPlanOversea: '国际区 Step Plan（订阅，浏览器授权）',
  profilePlatformCn: '国区开放平台（API Key，按量计费）',
  profilePlatformOversea: '国际区开放平台（API Key，按量计费）',
  profileHint: 'profile 一次决定三件事：凭据来源、模型 base 域名、开发者中心读取的区域。',
  profileHintExtra: '四个取值与官方逐字相同，因此卡片不给自由输入；区域交叉的凭据会被上游直接拒绝。',

  region: '区域',
  regionCn: '国区（stepfun.com）',
  regionIntl: '国际区（stepfun.ai）',
  regionHint: '区域由凭据里的 profile 唯一决定，本页只显示当前选择属于哪一区，不能单独改。',

  authorizing: '授权中…',

  loginIdle: '尚未开始登录。',
  /** idle 不是一个状态，而是「本进程还没开过流」。号池里已经有账号时它说的是别的事，
   *  所以另起一句，别让「尚未开始登录」与上面明明列着的账号互相打架。 */
  loginHaveAccounts: '号池里已有 {count} 个账号可用。要再加一个就点上面的「添加账号」。',
  loginPending: '请在浏览器里人工确认授权，然后本卡片会自动继续。云端轮询登录不开本地回调端口，流程跑在 host 上。',
  loginComplete: '登录完成，账号已加入号池。',
  loginCompletedAt: '完成时间：{time}',
  loginCompleteNoAccount: '这次登录完成了，但号池里已经没有这个账号（可能已被删除）。',
  loginError: '登录失败。',
  loginRetryable: '这是可重试的失败（传输错误，或 408/429/5xx），可以直接重新发起一次登录。',
  loginNotRetryable: '这次失败不会自己好（协议不合法或用户拒绝），请检查网络与所选凭据类型后重新发起。',
  authorizeUrl: '授权页面',
  openAuthorizeUrl: '打开授权页面',
  pollEvery: '每 {seconds} 秒查询一次登录结果。',
  loginExpiresAt: '本次授权最长可用到 {time}，过期后需要重新发起。',
  progress: '进度',
  restartLogin: '重新发起登录',
  cancelLogin: '取消登录',
  cancelLoginBusy: '取消中…',

  manualPasteSection: '手工粘贴 Platform API Key',
  manualPasteHint: '没有浏览器、或不想走浏览器授权时，把 Step 开放平台的 API Key 粘贴到下面即可登录（对应两个 platform_* 凭据类型，按量计费）。兜底通道常驻只是收起：它与上面的登录是同一件事的两种做法，随时可以点开。',
  manualPastePlaceholder: '粘贴 Platform API Key（sk-…）',
  manualPasteSubmit: '提交 API Key',
  manualPasteSubmitting: '提交中...',
  manualPasteEmpty: '请先粘贴 API Key。',

  adopt: '导入本机 stepcode 登录态',
  adopting: '导入中...',
  adoptAdopted: '已导入本机 stepcode 的登录态（{profile}），无需重新登录。',
  adoptNoAttempt: '本机没有可导入的 stepcode 登录态。',
  adoptNoCredentialsFile: '没有找到 stepcode 的凭据文件（~/.stepcode/auth.json）。装过 stepcode 客户端并登录过一次才会有这个文件。',
  adoptInvalidCredentials: '凭据文件读不出来或已被损坏，导入中止（导入只读，绝不改写 stepcode 的任何文件）。',
  adoptUnsupportedShape: '读懂了文件但认不出它的形状，可能需要升级本插件后再试。',
  adoptNotAStepcodeLogin: '文件在，但里面不是 Step 的登录态（同一份 auth.json 里可能有别的工具的条目）。请改用浏览器登录，或手工粘贴 Platform API Key。',
  adoptFallback: '导入只是省一次登录的快捷路径，失败不影响使用。',
  adoptedBadge: '导入的登录态',

  connection: '连接',
  testConnection: '测试连接',
  testingConnection: '测试中...',
  testSuccess: '连通正常',
  testSuccessAccount: '连通正常（账号 {account}）',
  testSuccessModel: '连通正常（{model}）',
  testFailed: '连接测试失败',
  testFailedDetail: '连接测试失败：{detail}',
  testLatency: '往返 {ms} 毫秒',
  routeOwned: '本插件正在服务该模型路由。',
  routeConflict: '模型路由已被其他 Provider 占用：{detail}。请在 DSH 设置中移除重复的 Provider 配置后重新加载。',

  modelsSection: '模型',
  modelsHint: '勾选后模型才会出现在对话页的模型选择列表中；能力不从模型名推断，全部取自运行时发现的上游目录字段。',
  modelsHintExtra: '拿不到证据的字段按兜底值显示而不是猜；目录按凭据所在区域过滤，跨区调用会被上游拒绝。',
  modelsUnavailable: '暂无可显示的模型（目录按需发现，登录后或点「刷新模型目录」再试）。',
  refreshCatalog: '刷新模型目录',
  refreshingCatalog: '刷新中...',
  dismiss: '知道了',
  selectAll: '全选',
  unselectAll: '全不选',
  modelChecklistCount: '{count}/{total}',
  enabledModelIdsSemantics: '勾选规则：取消勾选会清空选择，而清空等于不过滤——目录里的模型全部可用（非空才是显式选择）。想真的少用几个模型，就只勾那几个。',

  defaultEffort: '默认思考档位',
  defaultEffortHint: '这是线路级档位表；请求发出前会收敛到目标模型真实支持的档位上，所以列出全表不会给一个只认两档的模型发错档。',
  defaultEffortHintExtra: '收敛逻辑在 host；选「跟随各模型默认」表示各模型用它自己的默认档位。',
  defaultEffortModel: '跟随各模型默认',
  effortMinimal: '最低（minimal）',
  effortLow: '低（low）',
  effortMedium: '中（medium）',
  effortHigh: '高（high）',
  effortXHigh: '很高（xhigh）',
  effortMax: '最高（max）',

  contextWindowSection: '模型上下文窗口',
  contextWindowHint: '默认值来自上游目录（每个模型报的 max_input_tokens），可覆盖为 DSH 用于压缩与溢出判断的容量，支持 1M、512K、200K 等写法。',
  contextWindowHintExtra: '端点不报输出上限，因此输出上限默认等于上下文窗口。',
  contextWindowNoneEnabled: '还没有勾选任何模型。在上方勾选后，这里会出现该模型的上下文窗口设置。',
  contextWindowReset: '恢复默认',
  contextWindowResetAll: '全部恢复默认',
  tokens: 'tokens',
  save: '保存',
  saving: '保存中...',
  saved: '已保存',
  invalidCapacity: '容量格式无效：{value}',

  quotaSection: '用量与配额',
  quotaDesc: '数据来自 Step 开发者中心（非公开接口：先用开放平台账号密码换取 Oasis-Token，再用它读 Dashboard）。这是本线路唯一的合规与稳定性风险点，读取失败不影响模型请求。',
  quotaRefresh: '刷新用量',
  quotaRefreshing: '刷新中...',
  quotaSignedOut: '未登录，先在上方完成登录。',
  quotaEmpty: '暂无配额数据，点击「刷新用量」重试。',
  quotaPlan: '套餐',
  quotaPlanFamily: 'plan_family',
  quotaRenews: '续费时间',
  quotaReadAt: '读取时间',
  quotaSources: '数据源',
  quotaRegion: '读取区域',
  quotaRefreshingNote: '正在后台刷新配额，下方是上一次读到的数字。',
  quotaErrorLabel: '配额读取失败',
  quotaWindowNames: '窗口名按窗口长度本地化（5 小时 / 1 周 / 1 月），不在本页硬编码；每个账号自己的进度条画在它的账号卡片里。',
  quotaUsed: '已用',
  quotaResets: '重置',
  quotaNoReset: '上游没给重置时间',
  quotaUsedUnknown: '上游没给已用百分比',
  quotaKindWindowed: '老式窗口套餐（5 小时 / 周）',
  quotaKindCredit: 'Credit 月池',
  quotaKindUnknown: '认不出的套餐形状',
  quotaKindHint: '上游同时在用两代套餐，判定按载荷形状（老式窗口字段 / credit_buckets）而不是只信 plan_family。认不出来时只显示「认不出」，不画任何进度条。',
  quotaWindowFiveHour: '5 小时窗口',
  quotaWindowWeekly: '周窗口',
  quotaWindowCredit: 'Credit 月池',
  quotaBucketTotal: '总额',
  quotaBucketRemaining: '剩余',
  quotaBucketExpires: '失效时间',
  quotaBucketResets: '重置时间',

  quotaCredentialSection: '额度凭据（开发者中心）',
  quotaCredentialSource: '凭据来源',
  // 原先的 quotaCredentialHint + quotaCredentialRisk 合成这一句：两句说的是同一条边界
  // （凭据只存在于 host、只在点击提交的那一刻过一趟请求体），拆开夹在两个操作块中间
  // 会读成两条互不相干的警告。两边的每一个声明都还在，只是合成一句放在整段最下面。
  quotaCredentialFoot: '额度接口需要 Oasis-Token，这里显示的只是「有没有、从哪来」：凭据本身只存在于 host、永远不下发到前端；账号密码与 Token 也只在你点击提交的那一刻随请求体交给 host——不写入本地存储、不进 URL、不写日志，也没有任何接口能把它们读回来。',
  quotaCredentialNone: '尚未配置额度凭据，额度卡片读不到数据。',
  quotaCredentialAuto: '账号密码自动换取（auto）',
  quotaCredentialManual: '手动粘贴（manual）',
  quotaCredentialAccount: '登录账号',
  quotaCredentialExpires: '过期时间',
  quotaCredentialError: '上次用它读取失败',
  quotaCredentialPasswordSection: '用开放平台账号密码换取 Token',
  quotaCredentialAccountPlaceholder: 'Step 开放平台账号（邮箱或手机号）',
  quotaCredentialPasswordPlaceholder: '密码',
  quotaCredentialPasswordSubmit: '换取 Token',
  quotaCredentialPasswordSubmitting: '换取中...',
  quotaCredentialAccountEmpty: '请先填写 Step 开放平台账号。',
  quotaCredentialPasswordEmpty: '请先填写密码。',
  quotaCredentialManualSection: '手动粘贴 Oasis-Token',
  quotaCredentialTokenPlaceholder: '粘贴 Oasis-Token（浏览器开发者工具里复制）',
  quotaCredentialTokenSubmit: '提交 Token',
  quotaCredentialTokenSubmitting: '提交中...',
  quotaCredentialTokenEmpty: '请先粘贴 Oasis-Token。',
  quotaCredentialClear: '清除额度凭据',
  quotaCredentialClearing: '清除中...',

  // 缓存：本线路的重点。写侧恒为 0 是线路事实而不是故障，因此不画进度条。
  cacheSection: '缓存用量',
  cacheDesc: 'Step 服务端是自动前缀缓存：前缀够了就命中，客户端既没有缓存参数也没有「写入」这个动作。所以这里只有读侧一个维度，写侧恒为 0 并如实标注。',
  cacheStatScope: '以下数字是 DSH 本机对已回报用量的请求做的统计，不是上游账单。',
  cacheFieldOrder: '读侧解析顺序',
  cacheReadTokens: '缓存读入',
  cacheMissedTokens: '未命中输入',
  cacheHitRatio: '缓存命中率',
  cacheRequests: '统计请求数',
  cacheWriteNote: '本线路不报缓存写入',
  cacheWriteNoteValue: '写侧 token',
  cacheWriteNoteHint: '写侧在本线路恒为 0：服务端自动前缀缓存没有「写入」动作，也没有对应的计费项。任何声称这里写过缓存的数字都是编的，因此本页不画写侧进度条。',
  cacheRequestParams: '在请求里发送缓存参数',
  cacheRequestParamsHint: '当前不发缓存参数：Step 服务端是自动前缀缓存，官方对 Step 端点也默认不发。',
  cacheRequestParamsNote: '打开这个能力位会发出未在 Step 文档里说明过的字段（官方客户端把 prompt_cache_key 的发送条件硬绑在 api.openai.com），实测过端点接受度再开。',
  cacheRequestParamsOnHint: '已打开能力位：请求会带上缓存参数。该字段未在 Step 文档中说明，官方对 Step 端点默认也不发。',
  cachePricingNote: '单价未文档化（官方模型表里四个 cost 键全是 0），因此本页只展示 token 维度，不展示任何金额。',
  cacheEmpty: '本进程还没有任何请求回报过用量，跑一次对话后再看。',
  cacheHitRatioUnavailable: '—',
} as const


export const en: Record<keyof typeof zh, string> = {
  ...accountPoolEn,
  title: 'Step Code (Step Plan subscription)',
  pageDesc: 'Reach StepFun with a Step Plan subscription (China api.stepfun.com / international api.stepfun.ai) or an open-platform API key, and manage the account pool, plan quota, cache usage and model selection. A region is a property of the credential and the two never share, so a pool can carry accounts from both.',
  loading: 'Loading...',
  /** The collapsed block's label: one line stays under the heading, the rest folds in here. */
  moreNotes: 'More details',

  profile: 'Credential type',
  profileStepPlan: 'China Step Plan (subscription, browser sign-in)',
  profileStepPlanOversea: 'International Step Plan (subscription, browser sign-in)',
  profilePlatformCn: 'China open platform (API key, pay per token)',
  profilePlatformOversea: 'International open platform (API key, pay per token)',
  profileHint: 'One profile decides three things at once: where the credential comes from, which model base domain is used, and which developer center is read.',
  profileHintExtra: 'The four values are the official ones verbatim, so this page offers no free input; a cross-region credential is refused outright upstream.',

  region: 'Region',
  regionCn: 'China (stepfun.com)',
  regionIntl: 'International (stepfun.ai)',
  regionHint: 'The region is decided by the profile inside the credential; this page only reports which region the current choice belongs to.',

  authorizing: 'Authorizing…',

  loginIdle: 'No sign-in started yet.',
  loginHaveAccounts: 'The pool already holds {count} account(s), ready to use. To add another, choose “Add Account” above.',
  loginPending: 'Confirm the authorization in the browser; this card then continues on its own. The cloud polling sign-in opens no local callback port — the flow runs on the host.',
  loginComplete: 'Signed in — the account joined the pool.',
  loginCompletedAt: 'Signed in at {time}',
  loginCompleteNoAccount: 'That sign-in completed, but the account is no longer in the pool (it may have been deleted).',
  loginError: 'Sign-in failed.',
  loginRetryable: 'This failure is retryable (a transport error, or 408/429/5xx): start a fresh sign-in.',
  loginNotRetryable: 'This failure will not resolve itself (a protocol violation or a user refusal): check the network and the chosen credential type, then start again.',
  authorizeUrl: 'Authorization page',
  openAuthorizeUrl: 'Open the authorization page',
  pollEvery: 'Polling for the result every {seconds}s.',
  loginExpiresAt: 'This authorization is valid until {time}; after that a new one must be started.',
  progress: 'Progress',
  restartLogin: 'Start again',
  cancelLogin: 'Cancel sign-in',
  cancelLoginBusy: 'Cancelling…',

  manualPasteSection: 'Paste a Platform API key',
  manualPasteHint: 'Without a browser, or simply to skip it, paste a Step open-platform API key below (these are the two platform_* credential types, billed per token). The fallback stays in the page but collapsed: it is the other way of doing the same thing, and opens on demand.',
  manualPastePlaceholder: 'Paste the Platform API key (sk-…)',
  manualPasteSubmit: 'Submit the key',
  manualPasteSubmitting: 'Submitting…',
  manualPasteEmpty: 'Paste an API key first.',

  adopt: 'Import the local stepcode sign-in',
  adopting: 'Importing...',
  adoptAdopted: 'Imported the local stepcode sign-in ({profile}); no sign-in needed.',
  adoptNoAttempt: 'There is no local stepcode sign-in to import.',
  adoptNoCredentialsFile: 'No stepcode credentials file found (~/.stepcode/auth.json). It exists once the stepcode client has been installed and signed into.',
  adoptInvalidCredentials: 'The credentials file could not be read or looks damaged, so the import stopped. Importing is read-only: it never rewrites any stepcode file.',
  adoptUnsupportedShape: 'The file was read but its shape is not recognized; upgrading this plugin may be needed.',
  adoptNotAStepcodeLogin: 'The file exists but holds no Step sign-in (the same auth.json may carry entries for another tool). Use the browser sign-in above, or paste a key instead.',
  adoptFallback: 'Importing only saves you one sign-in; a failure never blocks the line.',
  adoptedBadge: 'Imported sign-in',

  connection: 'Connection',
  testConnection: 'Test connection',
  testingConnection: 'Testing...',
  testSuccess: 'Connection OK',
  testSuccessAccount: 'Connection OK (account {account})',
  testSuccessModel: 'Connection OK ({model})',
  testFailed: 'Connection test failed',
  testFailedDetail: 'Connection test failed: {detail}',
  testLatency: '{ms} ms round trip',
  routeOwned: 'This plugin serves the model route.',
  routeConflict: 'Another provider already owns the model route: {detail}. Remove the duplicate provider configuration in DSH settings and reload.',

  modelsSection: 'Models',
  modelsHint: 'Only checked models appear in the conversation model picker. Capabilities are never inferred from a model name: every field comes from the runtime-discovered upstream catalog.',
  modelsHintExtra: 'A field with no evidence falls back to its declared default rather than being guessed; the catalog is filtered by the region of the credential, and the upstream rejects a model asked of the wrong region.',
  modelsUnavailable: 'No model to show yet (the catalog is discovered on demand — sign in, or use “Refresh catalog”).',
  refreshCatalog: 'Refresh catalog',
  refreshingCatalog: 'Refreshing...',
  dismiss: 'Dismiss',
  selectAll: 'Select all',
  unselectAll: 'Deselect all',
  modelChecklistCount: '{count}/{total}',
  enabledModelIdsSemantics: 'How selection works: clearing every row empties the list, and an empty list means no filter — every catalog model stays available (only a non-empty list is an explicit selection). To genuinely use fewer models, check just those.',

  defaultEffort: 'Default thinking level',
  defaultEffortHint: 'This is the line-level vocabulary; a request is converged onto the ladder the target model really accepts before it is sent, so listing the full table cannot send an unsupported level.',
  defaultEffortHintExtra: 'The convergence lives on the host; choosing “each model its own default” leaves every model where it is.',
  defaultEffortModel: 'Each model its own default',
  effortMinimal: 'Minimal',
  effortLow: 'Low',
  effortMedium: 'Medium',
  effortHigh: 'High',
  effortXHigh: 'Very high',
  effortMax: 'Max',

  contextWindowSection: 'Model context windows',
  contextWindowHint: 'Defaults come from the upstream catalog (the max_input_tokens each model reports). Override one with the capacity DSH uses for compaction and overflow decisions; 1M, 512K, 200K and similar are accepted.',
  contextWindowHintExtra: 'The endpoint reports no output cap, so the output cap defaults to the context window.',
  contextWindowNoneEnabled: 'No model is checked yet. Check one above and its context window setting appears here.',
  contextWindowReset: 'Restore default',
  contextWindowResetAll: 'Restore all defaults',
  tokens: 'tokens',
  save: 'Save',
  saving: 'Saving...',
  saved: 'Saved',
  invalidCapacity: 'Invalid capacity: {value}',

  quotaSection: 'Usage & quota',
  quotaDesc: 'Read from the Step developer center — an UNDOCUMENTED endpoint: sign in with the open-platform account and password to obtain an Oasis-Token, then read the Dashboard with it. This is the line’s only compliance/stability risk, and a failed read never affects model requests.',
  quotaRefresh: 'Refresh usage',
  quotaRefreshing: 'Refreshing...',
  quotaSignedOut: 'Not signed in — finish the sign-in above first.',
  quotaEmpty: 'No quota data yet — use “Refresh usage” to retry.',
  quotaPlan: 'Plan',
  quotaPlanFamily: 'plan_family',
  quotaRenews: 'Renews',
  quotaReadAt: 'Read at',
  quotaSources: 'Sources',
  quotaRegion: 'Read in region',
  quotaRefreshingNote: 'Quota is refreshing in the background; the figures below are the last read.',
  quotaErrorLabel: 'Quota read failed',
  quotaWindowNames: 'Window names are localized from the window length (5 hours / 1 week / 1 month) rather than hardcoded here; each account’s own progress is drawn on its account card.',
  quotaUsed: 'used',
  quotaResets: 'Resets',
  quotaNoReset: 'the upstream gave no reset time',
  quotaUsedUnknown: 'the upstream gave no used percentage',
  quotaKindWindowed: 'Legacy window plan (5 hours / week)',
  quotaKindCredit: 'Credit pool',
  quotaKindUnknown: 'Unrecognized plan shape',
  quotaKindHint: 'The upstream uses two plan generations at once, and the generation is decided by the PAYLOAD SHAPE (legacy window fields / credit_buckets) rather than by plan_family alone. When neither is recognized the card says so and draws no progress bar at all.',
  quotaWindowFiveHour: '5-hour window',
  quotaWindowWeekly: 'Weekly window',
  quotaWindowCredit: 'Credit pool',
  quotaBucketTotal: 'Total',
  quotaBucketRemaining: 'Remaining',
  quotaBucketExpires: 'Expires',
  quotaBucketResets: 'Resets',

  quotaCredentialSection: 'Quota credential (developer center)',
  quotaCredentialSource: 'Source',
  // The former quotaCredentialHint + quotaCredentialRisk merged into this one line: both
  // described the same boundary (the credential stays on the host and crosses it only in the
  // request body of the submit you click), and split apart between the two action blocks they
  // read as two unrelated warnings. Every statement survives; only the layout changed.
  quotaCredentialFoot: 'The quota endpoint needs an Oasis-Token, and what is shown here is only whether one exists and where it came from — the credential itself stays on the host and is never sent to the front end. The password and the token reach the host only in the request body of the submit you click: they are never written to local storage, never placed in a URL, never logged, and no endpoint can read them back.',
  quotaCredentialNone: 'No quota credential yet, so the quota card cannot read anything.',
  quotaCredentialAuto: 'Exchanged from account + password (auto)',
  quotaCredentialManual: 'Pasted by hand (manual)',
  quotaCredentialAccount: 'Signed-in account',
  quotaCredentialExpires: 'Expires',
  quotaCredentialError: 'The last read with it failed',
  quotaCredentialPasswordSection: 'Exchange an account + password for a token',
  quotaCredentialAccountPlaceholder: 'Step open-platform account (email or phone)',
  quotaCredentialPasswordPlaceholder: 'Password',
  quotaCredentialPasswordSubmit: 'Exchange for a token',
  quotaCredentialPasswordSubmitting: 'Exchanging…',
  quotaCredentialAccountEmpty: 'Fill in the Step open-platform account first.',
  quotaCredentialPasswordEmpty: 'Fill in the password first.',
  quotaCredentialManualSection: 'Paste an Oasis-Token',
  quotaCredentialTokenPlaceholder: 'Paste the Oasis-Token (copy it from the browser devtools)',
  quotaCredentialTokenSubmit: 'Submit the token',
  quotaCredentialTokenSubmitting: 'Submitting…',
  quotaCredentialTokenEmpty: 'Paste an Oasis-Token first.',
  quotaCredentialClear: 'Clear the quota credential',
  quotaCredentialClearing: 'Clearing…',

  cacheSection: 'Cache usage',
  cacheDesc: 'The Step service runs an AUTOMATIC prefix cache: a long enough prefix hits, and the client has neither cache parameters nor a “write” action. So only the read side is a real dimension here; the write side is always 0 and is labelled as such.',
  cacheStatScope: 'These figures are the local tally DSH keeps over the requests that reported usage on this machine — not an upstream bill.',
  cacheFieldOrder: 'Read-side field order',
  cacheReadTokens: 'Read from cache',
  cacheMissedTokens: 'Missed input',
  cacheHitRatio: 'Cache hit ratio',
  cacheRequests: 'Requests counted',
  cacheWriteNote: 'This route reports no cache writes',
  cacheWriteNoteValue: 'Write tokens',
  cacheWriteNoteHint: 'The write side is always 0 on this route: an automatic prefix cache has no write action and no matching billing item. Any number claiming this route wrote cache would be invented, so no write-side bar is drawn.',
  cacheRequestParams: 'Send cache parameters in requests',
  cacheRequestParamsHint: 'No cache parameters are sent: the Step service uses an automatic prefix cache, and the official client does not send them to Step either.',
  cacheRequestParamsNote: 'Turning this on sends fields Step does not document (the official client hard-binds the prompt_cache_key condition to api.openai.com); enable it only after measuring whether the endpoint accepts them.',
  cacheRequestParamsOnHint: 'The capability is on: requests carry cache parameters. Step does not document them, and the official client does not send them to Step either.',
  cachePricingNote: 'Unit prices are undocumented (all four cost keys are 0 in the official model table), so this page shows TOKENS ONLY and no money figure at all.',
  cacheEmpty: 'No request on this machine has reported usage yet — run a conversation and look again.',
  cacheHitRatioUnavailable: '—',
}

export const dictionaries = {
  zh,
  'zh-CN': zh,
  en,
  'en-US': en,
}

export type StepCodeLocaleKey = keyof typeof zh

/**
 * 把本命名空间登记进框架的 LocaleNamespaceMap。
 *
 * 与 index.tsx 里那张表同款：胶囊的 `t` 来自框架注入，只有登记过命名空间才有类型，
 * 否则 `PropsLocale` 会退化成 `object`（没有 `t`）——那正是这条线路第一次
 * typecheck 报出来的错误。同一个键在同一张表里被两个文件各声明一次是允许的，
 * 因为两处写的类型完全相同。
 */
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'dsh-step-code': StepCodeLocaleKey
  }
}


/** 一个额度窗口的键到「窗口长度（分钟）」的映射。窗口名由共享组件按长度本地化。 */
export const QUOTA_WINDOW_MINUTES: Record<StepCodeQuotaWindowKey, number> = {
  'five-hour': 300,
  weekly: 10_080,
  // Credit 月池按月计；它不是滚动窗口，这里只是为了与另外两个窗口共用窗口名本地化。
  credit: 43_200,
}

/**
 * adopt 的每种 reason 对应一句不同的说明。
 *
 * 契约把「没找到文件」「读不出来」「形状不认识」「里面不是 Step 的登录态」分成四个
 * reason，正是为了让卡片给出不同的下一步（计划 D6、R6：adopt 失败永不阻断，一律回落
 * 浏览器登录）。合成一句「导入失败」会把用户引到错误的操作上。
 */
export type AdoptReason = NonNullable<StepCodeAdoptResultDto['reason']>

/** reason → 字典键。一个 reason 一种文案，因此这里是封闭映射而不是兜底串。 */
const ADOPT_REASON_KEYS: Record<AdoptReason, StepCodeLocaleKey> = {
  'no-credentials-file': 'adoptNoCredentialsFile',
  'invalid-credentials': 'adoptInvalidCredentials',
  'unsupported-shape': 'adoptUnsupportedShape',
  'not-a-stepcode-login': 'adoptNotAStepcodeLogin',
}

export function adoptReasonText(
  reason: AdoptReason,
  dictionary: Record<StepCodeLocaleKey, string>,
): string {
  return dictionary[ADOPT_REASON_KEYS[reason]]
}

/** profile → 字典键。四个取值各有各的一句话，因为它们的凭据来源与计费方式都不同。 */
const PROFILE_KEYS: Record<StepCodeProfile, StepCodeLocaleKey> = {
  step_plan: 'profileStepPlan',
  step_plan_oversea: 'profileStepPlanOversea',
  platform_cn: 'profilePlatformCn',
  platform_oversea: 'profilePlatformOversea',
}

export function profileText(
  profile: StepCodeProfile,
  dictionary: Record<StepCodeLocaleKey, string>,
): string {
  return dictionary[PROFILE_KEYS[profile]]
}

/** 额度窗口键 → 字典键。契约是封闭联合，所以这里也就没有兜底串：认不出的窗口不下发。 */
const QUOTA_WINDOW_KEYS: Record<StepCodeQuotaWindowKey, StepCodeLocaleKey> = {
  'five-hour': 'quotaWindowFiveHour',
  weekly: 'quotaWindowWeekly',
  credit: 'quotaWindowCredit',
}

export function quotaWindowKeyText(
  key: StepCodeQuotaWindowKey,
  dictionary: Record<StepCodeLocaleKey, string>,
): string {
  return dictionary[QUOTA_WINDOW_KEYS[key]]
}

/**
 * 额度快照的套餐形态 → 字典键。
 *
 * 三种取值各有各的话，刻意不做兜底串：unknown 说的是「认不出」，
 * 而不是「额度为 0」——后者是谎报。
 */
export type QuotaKind = StepCodeQuotaSnapshotDto['kind']

const QUOTA_KIND_KEYS: Record<QuotaKind, StepCodeLocaleKey> = {
  windowed: 'quotaKindWindowed',
  credit: 'quotaKindCredit',
  unknown: 'quotaKindUnknown',
}

export function quotaKindText(
  kind: QuotaKind,
  dictionary: Record<StepCodeLocaleKey, string>,
): string {
  return dictionary[QUOTA_KIND_KEYS[kind]]
}

/** 额度凭据来源 → 字典键。 */
export type QuotaCredentialSource = StepCodeQuotaCredentialStatusDto['source']

const QUOTA_CREDENTIAL_SOURCE_KEYS: Record<'auto' | 'manual', StepCodeLocaleKey> = {
  auto: 'quotaCredentialAuto',
  manual: 'quotaCredentialManual',
}

/**
 * 额度凭据来源的本地化文案。
 *
 * null（没有凭据）与 undefined（旧 host 没下发这个字段）都回落到「手动粘贴」这一支：
 * 卡片只在确实有凭据的那一行调用它，而「没有」另有 quotaCredentialNone 一句话，
 * 所以这里回落到哪一支都不会被读成「这是手动粘贴来的」。
 */
export function quotaCredentialSourceText(
  source: QuotaCredentialSource,
  dictionary: Record<StepCodeLocaleKey, string>,
): string {
  return dictionary[QUOTA_CREDENTIAL_SOURCE_KEYS[source ?? 'manual']]
}
