import { accountPoolEn, accountPoolZh } from '../common/account-pool-labels.ts'
import type { GlmAdoptResultDto, GlmAllowanceKind, GlmQuotaWindowKey } from '../../shared/glm-coding-plan-contracts.ts'

/**
 * GLM（ZCode 账号）线路的客户端命名空间。
 *
 * 与其余每条线路一个命名空间：卡片渲染自己的字典，不复用 hub 挂在
 * `settings.section` 上的那张座位（那张座绑定的是 ChatGPT 的键集，
 * 键名重合的会被渲染成 ChatGPT 的措辞，不重合的会把键名本身打印出来）。
 */
export const NS_GLM_CODING_PLAN = 'dsh-glm-coding-plan'

export const zh = {
  // 账号池卡片与其配额条是共享组件，文案统一由 account-pool-labels 提供。
  // 其中 quotaWindow / quotaExhausted / quotaResets（窗口名兜底 / 已用尽 / 重置）
  // 也来自共享标签：窗口名**不在本文件硬编码**，共享配额条按 windowDurationMins
  // 自行本地化（5 小时 / 1 周 / 1 月），本文件只提供兜底名。
  ...accountPoolZh,
  title: 'GLM（ZCode 账号）',
  pageDesc: '用 ZCode 账号授权接入 GLM Coding Plan（国区 bigmodel.cn / 国际区 z.ai），管理账号池、套餐额度与模型勾选。两个区域的凭据各自独立，池内可以同时存在两区账号。',
  loading: '加载中...',

  region: '区域',
  regionCn: '国区（bigmodel.cn）',
  regionIntl: '国际区（z.ai）',
  regionHint: '「导入本机登录态」与「手工粘贴授权码」按这里选定的区域发起；上方两个登录按钮各自固定一个区域。区域是凭据的属性，一区铸造的 Key 会被另一区拒绝，所以两区账号互不串用。',

  addCnAccount: '添加国区账号',
  addIntlAccount: '添加国际区账号',
  authorizing: '授权中…',

  loginSection: '登录授权',
  loginIdle: '尚未开始登录。',
  loginPending: '等待浏览器完成登录与授权，然后本卡片会自动继续。',
  loginComplete: '登录完成，账号已加入号池。',
  // 完成时刻是「成功」这件事唯一的时间证据：账号池那几行会被下一次开流刷新，
  // 而卡片要能说出这次成功是什么时候发生的。
  loginCompletedAt: '完成时间：{time}',
  // host 保留终态直到下一次开流，所以这条成功横幅会一直在。账号若在之后被删掉，
  // 继续说「账号已加入号池」就是谎报——因此把这种情况单独说一句。
  loginCompleteNoAccount: '这次登录完成了，但号池里已经没有这个账号（可能已被删除）。',
  loginError: '登录失败。',
  loginRetryable: '这是可重试的失败，可以直接重新发起一次登录。',
  loginNotRetryable: '这次失败不会自己好：请检查区域是否选对、网络是否可达，然后重新发起登录。',
  authorizeUrl: '授权页面',
  openAuthorizeUrl: '打开授权页面',
  pollEvery: '每 {seconds} 秒查询一次登录结果。',
  loginExpiresAt: '本次授权最长可用到 {time}，过期后需要重新发起。',
  progress: '进度',
  restartLogin: '重新发起登录',
  cancelLogin: '取消登录',
  cancelLoginBusy: '取消中…',

  manualPasteSection: '手工粘贴授权码',
  manualPasteHint: '浏览器回调被拦截、或授权页拿不到 code 时，把 ZCode 回调里的授权码粘贴到下面即可完成兑换——这条兜底通道是回调走不通时唯一能完成登录的地方，所以它一直在，只是没有进行中的流程时默认收起，流程一开始（进行中或失败）就自动展开。',
  manualPastePlaceholder: '粘贴授权码（code=… 或整段回调地址）',
  manualPasteSubmit: '提交授权码',
  manualPasteSubmitting: '兑换中…',
  manualPasteEmpty: '请先粘贴授权码。',

  adopt: '导入本机 ZCode 登录态',
  adopting: '导入中…',
  adoptAdopted: '已导入本机 ZCode 的登录态（{region}），无需重新登录。',
  adoptNoAttempt: '本机没有可导入的 ZCode 登录态。',
  adoptNoCredentialsFile: '没有找到 ZCode 的凭据文件（默认 ~/.zcode/v2/credentials.json）。装过 ZCode 客户端并登录过一次才会有这个文件。',
  adoptSecretUnavailable: '找到了凭据文件，但本机设置了 ZCODE_CREDENTIAL_SECRET，本插件无法推导解密密钥，因此读不出里面的登录态。',
  adoptDecryptFailed: '凭据解密失败，文件可能已被改动或损坏。',
  adoptTokenExpired: 'ZCode 的登录态已经过期，回 ZCode 客户端重新登录后再导入。',
  adoptExchangeFailed: '兑换 Coding Plan Key 失败：这个账号可能没有 Coding Plan 套餐，或没有建 Key 的权限。',
  adoptNotAZcodeLogin: '凭据文件里没有本线路认识的 ZCode 登录态（该文件也可能属于别的工具）。',
  adoptFallback: '导入只是省一次登录的快捷路径，失败不影响使用——请改用上方的浏览器登录。',
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
  modelsHint: '勾选后模型才会出现在对话页的模型选择列表中；目录与能力说明来自本线路的随包目录，**不从模型名推断**（glm-5.3 与 glm-5.3-flash 的图片输入、glm-5.2 与 glm-5.3 的思考档位都不同）。目录按账号所在区域过滤，跨区调用会被上游拒绝。',
  modelsUnavailable: '暂无可显示的模型。',
  refreshCatalog: '刷新模型目录',
  refreshingCatalog: '刷新中...',
  dismiss: '知道了',
  selectAll: '全选',
  unselectAll: '全不选',
  modelChecklistCount: '{count}/{total}',

  contextWindowSection: '模型上下文窗口',
  contextWindowHint: '默认值来自随包目录（每个模型的真实上下文上限）；可覆盖为自定义容量，该值用于 DSH 的压缩与溢出判断，可输入 1M、512K、200K 等容量。',
  contextWindowNoneEnabled: '还没有勾选任何模型。在上方勾选后，这里会出现该模型的上下文窗口设置。',
  contextWindowReset: '恢复默认',
  contextWindowResetAll: '全部恢复默认',
  tokens: 'tokens',
  save: '保存',
  saving: '保存中...',
  saved: '已保存',
  invalidCapacity: '容量格式无效：{value}',

  quotaSection: '用量与配额',
  quotaDesc: '数据来自 Coding Plan 的配额接口（该接口用裸 Key 鉴权，不加 Bearer）。',
  quotaRefresh: '刷新用量',
  quotaRefreshing: '刷新中...',
  quotaSignedOut: '未登录，先在上方完成登录授权。',
  quotaEmpty: '暂无配额数据，点击「刷新用量」重试。',
  quotaPlan: '套餐',
  quotaPlanLevel: '档位',
  quotaRenews: '续费时间',
  quotaReadAt: '读取时间',
  quotaSources: '数据源',
  quotaWindowNames: '窗口名按窗口长度本地化（5 小时 / 1 周 / 1 月），不在本页硬编码；每个账号自己的进度条画在它的账号卡片里。',
  quotaRefreshingNote: '正在后台刷新配额，下方是上一次读到的数字。',
  quotaErrorLabel: '配额读取失败',
  // 额度类型：如实区分「付费套餐」与「免费体验额度」。免费额度**不写成套餐名**——
  // 官方文档写明新用户有 5 天、每天 800 万 token 的免费体验额度，把它说成套餐是谎报。
  quotaAllowance: '额度类型',
  quotaAllowancePlan: '付费套餐',
  quotaAllowanceFreeTrial: '免费体验额度',
  quotaAllowanceUnknown: '未判定',
  quotaAllowanceHint: '登录时探活认定的额度来源。「免费体验额度」按官方文档指新用户注册即自动获得、首次使用起 5 天内每天 800 万 token 的体验额度；额度耗尽时由上游返回 429，本线路不预判。',
} as const

export const en: Record<keyof typeof zh, string> = {
  ...accountPoolEn,
  title: 'GLM (ZCode account)',
  pageDesc: 'Sign in with a ZCode account to reach GLM Coding Plan (China bigmodel.cn / International z.ai), and manage the account pool, plan quota and model selection. The two regions hold independent credentials, so a pool can carry accounts from both.',
  loading: 'Loading...',

  region: 'Region',
  regionCn: 'China (bigmodel.cn)',
  regionIntl: 'International (z.ai)',
  regionHint: '“Import the local sign-in” and the manual code paste start on the region chosen here; the two sign-in buttons above each pin one region. A region is a property of the credential — a key minted in one region is refused by the other — so the two never share.',

  addCnAccount: 'Add China account',
  addIntlAccount: 'Add international account',
  authorizing: 'Authorizing…',

  loginSection: 'Sign-in',
  loginIdle: 'No sign-in started yet.',
  loginPending: 'Finish sign-in and authorization in the browser; this card then continues on its own.',
  loginComplete: 'Signed in — the account joined the pool.',
  // The completion instant is the only time evidence of that success: the pool rows
  // get replaced by the next sign-in, so the card has to be able to say when it happened.
  loginCompletedAt: 'Signed in at {time}',
  // The host keeps the terminal state until the next sign-in, so this banner stays.
  // If the account is deleted afterwards, still saying "joined the pool" would be a lie.
  loginCompleteNoAccount: 'That sign-in completed, but the account is no longer in the pool (it may have been deleted).',
  loginError: 'Sign-in failed.',
  loginRetryable: 'This failure is retryable: start a fresh sign-in.',
  loginNotRetryable: 'This failure will not resolve itself: check that the region is right and the network is reachable, then start again.',
  authorizeUrl: 'Authorization page',
  openAuthorizeUrl: 'Open the authorization page',
  pollEvery: 'Polling for the result every {seconds}s.',
  loginExpiresAt: 'This authorization is valid until {time}; after that a new one must be started.',
  progress: 'Progress',
  restartLogin: 'Start again',
  cancelLogin: 'Cancel sign-in',
  cancelLoginBusy: 'Cancelling…',

  manualPasteSection: 'Paste the code by hand',
  manualPasteHint: 'When the browser callback is blocked or the page never yields a code, paste the authorization code from the ZCode callback below and the exchange finishes — this fallback is the only way a blocked sign-in can still finish, so it is always here: collapsed while no flow is running, expanded on its own once one starts (pending or failed).',
  manualPastePlaceholder: 'Paste the code (code=… or the whole callback URL)',
  manualPasteSubmit: 'Submit the code',
  manualPasteSubmitting: 'Exchanging…',
  manualPasteEmpty: 'Paste a code first.',

  adopt: 'Import the local ZCode sign-in',
  adopting: 'Importing…',
  adoptAdopted: 'Imported the local ZCode sign-in ({region}); no sign-in needed.',
  adoptNoAttempt: 'There is no local ZCode sign-in to import.',
  adoptNoCredentialsFile: 'No ZCode credentials file found (by default ~/.zcode/v2/credentials.json). It exists once the ZCode client has been installed and signed into.',
  adoptSecretUnavailable: 'The credentials file exists, but this machine sets ZCODE_CREDENTIAL_SECRET, so the decryption key cannot be derived and the sign-in inside it cannot be read.',
  adoptDecryptFailed: 'Decryption failed; the file may have been edited or damaged.',
  adoptTokenExpired: 'The ZCode sign-in has expired — sign in again in the ZCode client and import once more.',
  adoptExchangeFailed: 'Exchanging the Coding Plan key failed: this account may have no Coding Plan, or no permission to create a key.',
  adoptNotAZcodeLogin: 'The credentials file holds no ZCode sign-in this line recognizes (it may belong to another tool).',
  adoptFallback: 'Importing only saves you one sign-in; a failure never blocks the line — use the browser sign-in above instead.',
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
  modelsHint: 'Only checked models appear in the conversation model picker. The catalog and every capability sentence come from this line\'s bundled directory and are never inferred from a model name (GLM-5.3 and GLM-5.3-Flash differ in image input, GLM-5.2 and GLM-5.3 in thinking levels). The catalog is filtered by the account\'s region; the upstream rejects a model asked of the wrong region.',
  modelsUnavailable: 'No model to show yet.',
  refreshCatalog: 'Refresh catalog',
  refreshingCatalog: 'Refreshing...',
  dismiss: 'Dismiss',
  selectAll: 'Select all',
  unselectAll: 'Deselect all',
  modelChecklistCount: '{count}/{total}',

  contextWindowSection: 'Model context windows',
  contextWindowHint: 'Defaults come from the bundled directory (each model\'s real context cap). Override one with the capacity DSH should use for compaction and overflow decisions; 1M, 512K, 200K and similar are accepted.',
  contextWindowNoneEnabled: 'No model is checked yet. Check one above and its context window setting appears here.',
  contextWindowReset: 'Restore default',
  contextWindowResetAll: 'Restore all defaults',
  tokens: 'tokens',
  save: 'Save',
  saving: 'Saving...',
  saved: 'Saved',
  invalidCapacity: 'Invalid capacity: {value}',

  quotaSection: 'Usage & quota',
  quotaDesc: 'Read from the Coding Plan quota endpoint, which authenticates with the bare key and no Bearer prefix.',
  quotaRefresh: 'Refresh usage',
  quotaRefreshing: 'Refreshing...',
  quotaSignedOut: 'Not signed in — finish the sign-in above first.',
  quotaEmpty: 'No quota data yet — use “Refresh usage” to retry.',
  quotaPlan: 'Plan',
  quotaPlanLevel: 'Tier',
  quotaRenews: 'Renews',
  quotaReadAt: 'Read at',
  quotaSources: 'Sources',
  quotaWindowNames: 'Window names are localized from the window length (5 hours / 1 week / 1 month) rather than hardcoded here; each account\'s own progress bar is drawn on its account card.',
  quotaRefreshingNote: 'Quota is refreshing in the background; the figures below are the last read.',
  quotaErrorLabel: 'Quota read failed',
  // Honesty rule: a free trial is never rendered as a paid plan. Official docs describe
  // the trial as 8M tokens/day for 5 days from first use, granted automatically to new users.
  quotaAllowance: 'Allowance',
  quotaAllowancePlan: 'Paid plan',
  quotaAllowanceFreeTrial: 'Free trial allowance',
  quotaAllowanceUnknown: 'Undetermined',
  quotaAllowanceHint: 'The allowance source established by the sign-in probe. \u201cFree trial allowance\u201d is what official docs describe as 8M tokens per day for 5 days from first use, granted automatically to new accounts; once it runs out the upstream answers 429, which this line does not pre-empt.',
}

export const dictionaries = {
  zh,
  'zh-CN': zh,
  en,
  'en-US': en,
}

export type GlmCodingPlanLocaleKey = keyof typeof zh

/** 一个配额窗口的键到「窗口长度（分钟）」的映射。 */
export const QUOTA_WINDOW_MINUTES: Record<GlmQuotaWindowKey, number> = {
  'five-hour': 300,
  weekly: 10_080,
  monthly: 43_200,
}

/**
 * adopt 的每种 reason 对应一句不同的说明。
 *
 * 契约把「没找到文件」「解不开密钥」「登录态过期」「没有套餐」分成四个 reason，
 * 就是为了让卡片能给出不同的下一步——把四种失败合成一句「导入失败」会把用户
 * 引到错误的操作上（计划 D6、R6：adopt 失败永不阻断，一律回落浏览器登录）。
 */
export type AdoptReason = NonNullable<GlmAdoptResultDto['reason']>

/** reason → 字典键。一个 reason 一种文案，因此这里是封闭映射而不是兜底串。 */
const ADOPT_REASON_KEYS: Record<AdoptReason, GlmCodingPlanLocaleKey> = {
  'no-credentials-file': 'adoptNoCredentialsFile',
  'secret-unavailable': 'adoptSecretUnavailable',
  'decrypt-failed': 'adoptDecryptFailed',
  'token-expired': 'adoptTokenExpired',
  'exchange-failed': 'adoptExchangeFailed',
  'not-a-zcode-login': 'adoptNotAZcodeLogin',
}

export function adoptReasonText(
  reason: AdoptReason,
  dictionary: Record<GlmCodingPlanLocaleKey, string>,
): string {
  return dictionary[ADOPT_REASON_KEYS[reason]]
}

/** 额度类型 → 字典键。三个取值各有各的话，刻意不做兜底串。 */
const ALLOWANCE_KINDS: Record<GlmAllowanceKind, GlmCodingPlanLocaleKey> = {
  plan: 'quotaAllowancePlan',
  'free-trial': 'quotaAllowanceFreeTrial',
  unknown: 'quotaAllowanceUnknown',
}

/**
 * 额度类型的本地化文案。
 *
 * `undefined`（旧 host 没下发这个字段）与 `'unknown'` 都渲染成「未判定」：
 * 读不到就等于不知道，而「不知道」不能被渲染成付费套餐。
 */
export function allowanceKindText(
  allowance: GlmAllowanceKind | undefined,
  dictionary: Record<GlmCodingPlanLocaleKey, string>,
): string {
  return dictionary[ALLOWANCE_KINDS[allowance ?? 'unknown']]
}
