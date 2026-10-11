/**
 * GLM（ZCode 账号）线路的逐模型能力表。
 *
 * 存在的原因是一条硬规则：**能力不得从模型名推断**（计划 §1、§7）。本文件只转录逐模型事实，
 * 任何一行都不写「GLM-5.3 所以……」这种推理；拿不出证据的字段宁可留空数组 / 取兜底值，
 * 也不发明一个看起来合理的取值——上游收到不认识的档位直接报错（`ERROR_CODE.INVALID_PARAM` 1214），
 * 编出来的档位代价是一次必然失败的请求。
 *
 * ## 事实来源（逐行标注，不混用）
 *
 * 1. **官方开源版内置配置** `zai-org/ZCode` 的 `config/provider/zcode-builtin.json`（revision 31，
 *    184927 字节）。**路径在仓库根，不在 `apps/zcode-cli/` 下**——后者没有 `config/` 目录，
 *    直连 `apps/zcode-cli/config/provider/zcode-builtin.json` 会 404。本文件下面引用的行号级事实
 *    都出自这一份（读取日期 2026-10-11）：
 *    - `zai-api` / `bigmodel-api` 两个模板（`access.type = zhipu-coding-plan-api-key`）与四个
 *      `account:*-coding-plan` provider 的 `api.type` **全部**是 `anthropic-messages`，
 *      `baseUrl` 就是本线路的 Anthropic 面（`https://api.z.ai/api/anthropic` /
 *      `https://open.bigmodel.cn/api/anthropic`）——这是 `wire` 取 `'anthropic'` 的依据；
 *    - `builtinProviderModelRules`（账号型 provider 的模型启用表）逐条给
 *      `account:{zai,bigmodel}-{individual,team}-coding-plan` 启用**同样四个** id：
 *      `GLM-5.3` / `GLM-5.3-Flash` / `GLM-5.2` / `GLM-5-Turbo`。所以本表是这四个，不多不少；
 *    - `modelConfigRules.modelRules` 给出逐模型事实（见下方每一行的注释）；
 *    - `modelConfigRules.providerSiteRules` 有两条 `modelMatch: ".*"` 的站点规则，分别命中
 *      `https://api\.z\.ai/api/anthropic` 与 `https://open\.bigmodel\.cn/api/anthropic`，
 *      把 `supportsImage/supportsVideo` 打开成 `true`——**这两个地址就是本线路的两个 Coding Plan
 *      基址**，所以本表所有行的 `supportsImages` 都是 `true`（详见各行注释与
 *      {@link GLM_VISION_BRIDGED_BY_PLAN_FACE}）。
 * 2. **本仓库历史转录** `7e40fce:src/host/zhipu/model-catalog.ts`：同一张 Coding Plan 目录的逐模型
 *    转录（上下文窗口、输出上限、思考梯子、收不收图、可不可关思考），来源是 docs.z.ai 的参数表
 *    与「深度思考」说明。本文件沿用它，因为它是本仓库里唯一一份针对 **Coding Plan 面**
 *    （而不是别家网关）逐模型转录过的表。
 * 3. **两区差异与「取小值」规则**：`src/host/workbuddy/model-catalog.ts` 与 `CHANGELOG.md:87`
 *    （一条表同时覆盖两区时取小值——高报会被网关拒绝，低报只是提前压缩）。
 *
 * ## 与 workbuddy 转录的冲突（刻意不采信那一侧）
 *
 * workbuddy 记的是**别家聚合网关**（CodeBuddy）的发布值：`glm-5.3` 输出上限是 48000（intl）/
 * 64000（cn）、`glm-5.2` 的梯子是 `['high','xhigh']`、`glm-5.3-flash` 默认窗口 300000。
 * 那些数字描述的是另一个网关，本线路打不到它，所以它们在本文件里**不作为取值来源**，
 * 只用来提醒复审：两处数字不一样时，先问「哪条证据描述的是本线路这个面」。
 *
 * 输出上限的取值理由：官方 builtin 规则给 `128000`，历史转录的 docs.z.ai 参数表给 `131072`。
 * 按本仓库「取小值」的规则（高报会被网关拒绝，低报只是提前压缩一段对话，见
 * `CHANGELOG.md:87`）取 `128000`；而且 128000 正是**官方客户端自己在 Coding Plan 面上发的那个数**。
 *
 * ## 没有进这张表的 id（以及为什么）
 *
 * workbuddy 目录里还有 `glm-5.1` / `glm-5v-turbo` / `glm-5.0` / `glm-5.0-turbo` /
 * `glm-4.7` / `glm-4.6v` / `glm-4.6`，官方 builtin 配置里也有它们的完整清单——但那一份挂在
 * `zai-standard-api` / `bigmodel-standard-api` 模板上，`baseUrl` 是 `/api/paas/v4`，
 * **通用开放平台面，套餐额度不生效**（计划 §3.3 的 Common mistakes 段）。把它们塞进本线路的目录，
 * 换来的只会是 1311 `MODEL_NOT_IN_PLAN` 或按量计费。真正的兜底是
 * {@link undeclaredGlmModelEntry}：上游 `/models` 里真出现、而本表没有的 id，
 * 以「未声明模型」进入目录（不猜协议、不发思考档位、不认图），而不是凭空补一行能力。
 */

import type {
  GlmModelOption,
  GlmReasoningEffort,
  GlmRegion,
  GlmWire,
} from '../../shared/glm-coding-plan-contracts.ts'
import { DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_TOKENS } from './types.ts'

/**
 * 目录声明的协议面。
 *
 * `null` = **未声明**（D3：未知模型不猜协议）。只有上游目录里出现、而本表没有转录过的 id
 * 才会是这个值；调用方（适配器）遇到 `null` 必须拒绝该模型并说明原因，
 * 而不是替它挑一个面——挑错的表现是 1212 `WRONG_METHOD`，比直接拒绝更难排查。
 */
export type GlmCatalogWire = GlmWire | null

/** 一行模型能力。与 `GlmModelOption` 同义，去掉的只是「用户设置」那一半（见 {@link catalogModelOptions}）。 */
export interface GlmModelEntry {
  id: string
  name: string
  /** 一句话能力描述：思考形态 / 可选档位 / 输入模态 / 上下文窗口。由 {@link describeGlmModel} 生成。 */
  hint: string
  /** 服务该模型的部署。两区模型 id 不同（计划 R8），这是路由事实不是偏好。 */
  regions: readonly GlmRegion[]
  /**
   * 该模型**真实**接受的思考档位梯子（W6 会把它当 ladder 传给两个 mapper）。
   *
   * **空数组是有意语义**：该模型完全不发思考控制字段（`convergeGlmEffort` 对空梯子返回 `null`，
   * 两个 mapper 据此不发出 `reasoning_effort`）。这不是「忘了填」，是「不发」。
   */
  reasoningEfforts: readonly GlmReasoningEffort[]
  /**
   * 思考能否关闭。与上一条**正交**：档位非空而本项为 false = 恒定开启
   * （上游把 `thinking.type: "disabled"` 当错误拒绝）。
   */
  thinkingDisableable: boolean
  /** 该模型走哪个协议面（D3：逐模型声明）。未声明的行是 `null`。 */
  wire: GlmCatalogWire
  /** 是否接受 image 输入。 */
  supportsImages: boolean
  /** 目录声明的默认上下文窗口（token）。设置页可逐模型覆盖。 */
  defaultContextWindow: number
  /** 调用方不指定输出上限时本线路请求的输出上限。 */
  defaultMaxTokens: number
  /** 官方描述；没有逐字来源时为 null（不编文案）。 */
  description: string | null
}

/** 一行能力去掉 `hint` 的样子：hint 由 {@link withHint} 从其余字段生成，不手写。 */
export type GlmModelFacts = Omit<GlmModelEntry, 'hint'>

/**
 * 给一行能力补上生成的 hint。
 *
 * hint 刻意**不**写进表里的字面量：那张表的每个字段都要被两个 mapper 当成事实使用，
 * 而文案是给人看的派生值。手写文案与能力表漂移过一次（写着「三个档位」的模型实际只有两档），
 * 生成则让那种漂移在结构上不可能发生。
 */
function withHint(facts: GlmModelFacts): GlmModelEntry {
  const entry: GlmModelEntry = { ...facts, hint: '' }
  return { ...entry, hint: describeGlmModel(entry) }
}

/** 两个部署都服务的模型。 */
const BOTH: readonly GlmRegion[] = ['cn', 'intl']

/**
 * **能力随端点变化的那一处**：本线路的两个 Coding Plan 基址上，视觉输入由套餐端桥接打开。
 *
 * 逐字证据（`config/provider/zcode-builtin.json` revision 31 的
 * `modelConfigRules.providerSiteRules`），两条规则的 `modelMatch` 都是 `.*`：
 *
 * | baseUrlMatch | config |
 * |---|---|
 * | `https://api\.z\.ai/api/anthropic/?` | `{ properties: { inputFormat: { supportsImage: true, supportsVideo: true } } }` |
 * | `https://open\.bigmodel\.cn/api/anthropic/?` | `{ properties: { inputFormat: { supportsImage: true, supportsVideo: true } } }` |
 *
 * 这两个地址正是本线路 `./types.ts` 的 `CHAT_PATH_ANTHROPIC` 拼在
 * `apiBaseForRegion()` 之后的两个基址，所以**规则集在本线路所打的端点上解析出来的结果**是收图。
 *
 * 为什么必须把这件事写死在这里：基础 `modelRules` 里 `.*glm-5\.3(...)?` 明写
 * `supportsImage: false`，而规则集的叠加顺序（`model` → `model-api` → `provider-site` →
 * `template-model` → `provider-model`，后层覆盖前层）会让后一条站点规则把它改成 true。
 * 计划 §7 那个反例「`glm-5.3-flash` 收图而 `glm-5.3` 不收」描述的是**基础规则那一层**，
 * 在 Coding Plan 面上不成立。日后若有人照基础规则把 `supportsImages` 改回 false，
 * 后果是 DSH 在一个接受图片的端点上拒绝用户发图——不是报错，是功能凭空消失。
 *
 * 所以本表 `supportsImages` 一律读作「**经本线路这两个 Anthropic 端点时**是否收图」，
 * 而不是「模型本身是否多模态」。要拿基础能力，请回官方规则集的 `modelRules`。
 */
export const GLM_VISION_BRIDGED_BY_PLAN_FACE: readonly string[] = [
  'https://api.z.ai/api/anthropic',
  'https://open.bigmodel.cn/api/anthropic',
]

/**
 * 同一批站点规则还开了两项能力，本线路**具备但本轮不做**。
 *
 * 逐字证据（同上两条 `baseUrlMatch`，`apiTypeMatch: 'anthropic-messages'`）：
 * `{ properties: { supportsNativeWebSearch: true, supportsMidConversationSystem: true } }`。
 * 对照组是闲时端点 `https://zcode\.z\.ai/api/v1/off-peak/anthropic`，那里
 * `supportsNativeWebSearch` 是 false——可见这一项确实是**按端点**定的，不是按模型定的。
 *
 * 为什么不落到代码里：本轮的工作范围是线路层（计划 D7），不做 Agent 行为层与工具生态配置，
 * 而原生联网搜索属于后者。把「本线路的上游支持它」记在这里，是为了让后续轮次不必再去翻
 * 一次官方规则集，也免得有人误以为本线路的上游**不**支持而另找一路。
 *
 * 注意：这里说的是**上游具备该能力**，不是 DSH 已经接上——DSH 侧目前没有对应的工具声明。
 */

/**
 * GLM-5.3 家族的思考梯子：`low` / `high` / `max`。
 *
 * 来源：历史转录里 GLM-5.3 / GLM-5.3-Flash / GLM-5.3-Highspeed 三行都取 `CODING_EFFORTS`，
 * 而 `7e40fce:src/host/zhipu/types.ts` 里那个常量逐字就是 `['low','high','max']`。
 * 与 `./types.ts` 的 `GLM_CODING_EFFORTS`（线路级词汇表）内容相同，这里再写一遍是为了让
 * 「模型真实梯子」与「线路级词汇表」在代码上就是两件事：前者允许更窄。
 */
const GLM53_EFFORTS: readonly GlmReasoningEffort[] = ['low', 'high', 'max']

/**
 * GLM-5.2 在 Coding Plan 下的真实梯子：**两档**，`high` / `max`。
 *
 * 来源：历史转录的 `GLM52_EFFORTS` —— 模型自己的页面列的是更宽的词汇
 * （`xhigh`/`medium`/`minimal`/`none`），但它同时写明套餐如何映射：`low`/`medium` → `high`，
 * `xhigh` → `max`，`none`/`minimal` → 停止思考。所以真正能上线缆的只有这两级。
 * 这正是计划 §7 记录的反例：「glm-5.2 暴露两个档位而 glm-5.3 暴露三个」。
 */
const GLM52_EFFORTS: readonly GlmReasoningEffort[] = ['high', 'max']

/**
 * GLM-5.3 家族与 GLM-5.2 的输出上限：128000。
 *
 * 来源（等级 A，逐字）：官方 `config/provider/zcode-builtin.json` revision 31 的
 * `modelConfigRules.modelRules`——
 *
 * - `.*glm-5\.3(?:-flash)?(?:[.\-:/\[].*)?` → `optionSpecs.maxOutputTokens.max = 128000`
 * - `.*GLM-5\.2(?:[.\-:/\[].*)?`          → `optionSpecs.maxOutputTokens.max = 128000`
 *
 * 这不是文档里的一句话，而是**官方客户端自己在 Coding Plan 面上会发出的那个数**，所以它比
 * 历史转录引用的 docs.z.ai 通用参数表（默认 65536 / 最大 131072）更贴近本线路实际所打的端点。
 * 两个来源不一致时按 `CHANGELOG.md:87` 的规则取小者：128000 < 131072，
 * 高报会被网关拒（1214），低报只是少请求一些 token。
 *
 * 本插件按上限请求（`max_tokens` 是天花板而不是预留），但它**不是** `./types.ts` 的
 * `DEFAULT_MAX_TOKENS`——那个冻结值只留给「目录没声明」的未知模型。
 */
const GLM5_MAX_OUTPUT = 128_000

/**
 * GLM-5-Turbo 的输出上限：64000。
 *
 * 来源同上逐字：`.*GLM-5-Turbo(?:[.\-:/\[].*)?` → `optionSpecs.maxOutputTokens.max = 64000`。
 *
 * 它与 GLM-5.3 家族**不同**，正是「输出上限不得按家族名推」的又一处证据——同一代、同一份
 * 规则集里，两者的上限差了一倍。上一版这里用的是 `DEFAULT_MAX_TOKENS`（32768）并注明
 * 「未验证、缺官方输出上限」；那条证据是有的，现已按来源替换。
 */
const GLM5_TURBO_MAX_OUTPUT = 64_000

/**
 * 逐模型事实表（不含 hint，见 {@link withHint}）。
 *
 * 四行都取「两区都服务」，依据是官方 builtin 规则集里 `zai-*` 与 `bigmodel-*` 两个家族
 * 的 Coding Plan 账号规则启用的是**同一个 id 集合**（见
 * {@link GLM_START_PLAN_EXCLUDED_MODEL_IDS} 的证据表）——所以这份表没有需要「取小值」的
 * 跨区分歧。取小值规则本身记在 `CHANGELOG.md:87`，写在这里以备日后两区真的分歧时照做。
 *
 * 每一行只写「本线路这条端点上的能力」：`supportsImages` 含了套餐端的站点规则覆盖
 * （{@link GLM_VISION_BRIDGED_BY_PLAN_FACE}），`defaultMaxTokens` 用的是官方客户端自己在
 * Coding Plan 面上发的那个数。两个口径的来源都写在对应常量的注释里。
 */
const GLM_MODEL_FACTS: readonly GlmModelFacts[] = [
  {
    id: 'GLM-5.3',
    name: 'GLM-5.3',
    regions: BOTH,
    reasoningEfforts: GLM53_EFFORTS,
    // 官方深度思考说明逐字记着：GLM-5.3 / GLM-5.3-FLASH / GLM-4.7 把
    // thinking.type: "disabled" 当错误拒绝。
    thinkingDisableable: false,
    wire: 'anthropic',
    // true，但**不是因为模型多模态**：基础 modelRules 对 glm-5.3 写的是 false，
    // 是 Coding Plan 端点上的站点规则把它打开的（见 GLM_VISION_BRIDGED_BY_PLAN_FACE）。
    supportsImages: true,
    defaultContextWindow: 1_000_000,
    defaultMaxTokens: GLM5_MAX_OUTPUT,
    description: '旗舰模型，1M 上下文，强制思考。',
  },
  {
    id: 'GLM-5.3-Flash',
    name: 'GLM-5.3-Flash',
    regions: BOTH,
    reasoningEfforts: GLM53_EFFORTS,
    thinkingDisableable: false,
    wire: 'anthropic',
    // 收图，且这一次**基础规则本身就是 true**（`.*glm-5\.3-flash(...)?` 直接写
    // supportsImage/supportsVideo: true），与 GLM-5.3 那种「靠站点规则救回来」的情况不同。
    supportsImages: true,
    defaultContextWindow: 1_000_000,
    defaultMaxTokens: GLM5_MAX_OUTPUT,
    description: '多模态快速模型，1M 上下文，支持图片输入。',
  },
  {
    id: 'GLM-5.2',
    name: 'GLM-5.2',
    regions: BOTH,
    // 两档，不是三档：见 GLM52_EFFORTS 的来源说明。
    reasoningEfforts: GLM52_EFFORTS,
    // GLM-5.2 是仍接受关闭值的那一批之一（官方规则集的 values 里多一个 `disabled`）。
    thinkingDisableable: true,
    wire: 'anthropic',
    // 同 GLM-5.3：基础规则 false，Coding Plan 端点的站点规则打开成 true。
    supportsImages: true,
    defaultContextWindow: 1_000_000,
    defaultMaxTokens: GLM5_MAX_OUTPUT,
    description: '上一代旗舰，1M 上下文（新套餐会把请求路由到 GLM-5.3）。',
  },
  {
    id: 'GLM-5-Turbo',
    name: 'GLM-5-Turbo',
    regions: BOTH,
    // 开关型推理模型：它不收档位，所以梯子为空——两个 mapper 因此**不发**思考控制字段。
    reasoningEfforts: [],
    thinkingDisableable: true,
    wire: 'anthropic',
    // 同样是站点规则打开的（基础规则对 GLM-5-Turbo 写 false）。
    supportsImages: true,
    // 上下文窗口来自历史转录的 GLM-5-Turbo 行（200000），与 GLM-5.3 家族的 1M 不同——
    // 这正是「窗口不得按名字推」的又一处证据。
    defaultContextWindow: 200_000,
    // 逐字证据见 GLM5_TURBO_MAX_OUTPUT 的注释：64000，不是 GLM-5.3 家族的 128000。
    defaultMaxTokens: GLM5_TURBO_MAX_OUTPUT,
    description: '面向快速推理与 agent 流程的高效模型。',
  },
]

/**
 * 随包发布的目录（每一行的 `hint` 已生成）。
 *
 * 导出的是生成结果而不是上面那张字面量表：这样目录的每一行——包括调用方自己
 * `parseCatalogListing` 拼出来的行——都保证 `hint` 非空且与能力一致。
 */
export const GLM_MODEL_CATALOG: readonly GlmModelEntry[] = GLM_MODEL_FACTS.map(withHint)

/**
 * 本线路四个模型**全部**是 Coding Plan 模型；反倒是 Start Plan 缺 `GLM-5.3`。
 *
 * 逐字证据（`config/provider/zcode-builtin.json` revision 31 的
 * `modelConfigRules.builtinProviderModelRules`，「账号型 provider 的模型启用表」）：
 *
 * - `account:zai-individual-coding-plan` / `account:zai-team-coding-plan` /
 *   `account:bigmodel-individual-coding-plan` / `account:bigmodel-team-coding-plan`
 *   都逐条启用 **`GLM-5.3`、`GLM-5.3-Flash`、`GLM-5.2`、`GLM-5-Turbo` 四个**；
 * - `account:{zai,bigmodel}-start-plan` 只启用 `GLM-5.3-Flash` / `GLM-5.2` /
 *   `GLM-5-Turbo`——**没有 `GLM-5.3`**。
 *
 * 这一条曾被写反过（旧的 `GLM_START_PLAN_ONLY_MODEL_IDS = ['GLM-5.2','GLM-5-Turbo']`
 * 断言「这两个是 Start Plan 独有、Coding Plan 请求它们会拿到 1311」）。写反的代价是 W6 会把
 * 两个**确实在套餐里**的模型判成未订阅，用户连试都不能试。留着这份对照，是为了让复审知道
 * 「模型 id 反推不出账号套餐」：同一个 id 在不同 provider 规则下被启用的集合是不同的，
 * 而套餐归属是**账号**的属性，不是模型的属性。
 */
export const GLM_START_PLAN_EXCLUDED_MODEL_IDS: readonly string[] = ['GLM-5.3']

/** 目录里全部 id，声明顺序即设置页的默认顺序。 */
export const GLM_MODEL_IDS: readonly string[] = GLM_MODEL_CATALOG.map((model) => model.id)

/**
 * 首次安装默认勾选的模型。
 *
 * 刻意是全部四行：这张表已经是 Coding Plan 面的模型全集（官方 builtin 配置公布的那一份），
 * 藏掉任何一行都等于不给用户开启它的办法——与其如此，不如让用户在设置页里自己取消。
 */
export const DEFAULT_VISIBLE_MODEL_IDS: readonly string[] = [...GLM_MODEL_IDS]

/**
 * 按 id 找一行能力，**大小写不敏感**。
 *
 * 官方内置配置写的是 `GLM-5.3`，workbuddy 目录与历史转录用的是 `glm-5.3`，
 * 而 `/models` 返回哪一种**没有实测样本**（本轮无实机账号，计划 D9）。
 * 与其赌一种拼写能被上游接受，查找侧宽松；发出侧保持目录里那份规范拼写，
 * 这样设置里存下的 id 与上游返回的 id 不会因为大小写不同而对不上。
 */
function findEntry(id: string, catalog: readonly GlmModelEntry[]): GlmModelEntry | undefined {
  const wanted = id.trim()
  if (wanted === '') return undefined
  return catalog.find((model) => model.id === wanted)
    ?? catalog.find((model) => model.id.toLowerCase() === wanted.toLowerCase())
}

/** 目录里有没有这个 id（大小写不敏感）。 */
export function isGlmModelId(
  id: unknown,
  catalog: readonly GlmModelEntry[] = GLM_MODEL_CATALOG,
): id is string {
  return typeof id === 'string' && findEntry(id, catalog) !== undefined
}

/** 该模型真实接受的思考档位；不在目录里时是空数组（即「不发任何思考控制字段」）。 */
export function glmReasoningEfforts(
  id: string,
  catalog: readonly GlmModelEntry[] = GLM_MODEL_CATALOG,
): readonly GlmReasoningEffort[] {
  return findEntry(id, catalog)?.reasoningEfforts ?? []
}

/** 该模型是否接受图片输入；不在目录里时为 false（不认图比乱认图安全）。 */
export function glmModelSupportsImages(
  id: string,
  catalog: readonly GlmModelEntry[] = GLM_MODEL_CATALOG,
): boolean {
  return findEntry(id, catalog)?.supportsImages ?? false
}

/** 该模型走哪个协议面；不在目录里时是 `null`（D3：不猜协议）。 */
export function glmModelWire(
  id: string,
  catalog: readonly GlmModelEntry[] = GLM_MODEL_CATALOG,
): GlmCatalogWire {
  return findEntry(id, catalog)?.wire ?? null
}

/** 该模型的输出上限；不在目录里时取 `./types.ts` 的兜底值（那里已标注未验证）。 */
export function maxOutputTokensFor(
  id: string,
  catalog: readonly GlmModelEntry[] = GLM_MODEL_CATALOG,
): number {
  return findEntry(id, catalog)?.defaultMaxTokens ?? DEFAULT_MAX_TOKENS
}

/** 该模型的上下文窗口；不在目录里时取 `./types.ts` 的兜底值（那里已标注未验证）。 */
export function defaultContextWindowFor(
  id: string,
  catalog: readonly GlmModelEntry[] = GLM_MODEL_CATALOG,
): number {
  return findEntry(id, catalog)?.defaultContextWindow ?? DEFAULT_CONTEXT_WINDOW
}

/**
 * 目录没有转录过的 id 的**未声明**行。
 *
 * 什么时候会有：上游 `/models` 返回了本表没有的模型（发了新模型，或本轮清单已过期）。
 * 这时最诚实的做法是什么都不主张：
 *
 * - `wire: null` → 适配器拒绝该模型（D3），而不是猜一个面；
 * - `reasoningEfforts: []` → `convergeGlmEffort` 返回 null，两个 mapper 一个字段都不发；
 * - `supportsImages: false` → 请求里的图片按「读不出来」明说，而不是发一个上游会拒的 image_url；
 * - `thinkingDisableable: true` → 目录没声明「恒定开启」，那就永远不发关闭值（发关闭值才会被拒）。
 *
 * 上下文窗口只有在上游明确报了的时候才用它的值（运行时是窗口的权威），否则用兜底值。
 */
export function undeclaredGlmModelEntry(
  id: string,
  options: { region?: GlmRegion; contextWindow?: number } = {},
): GlmModelEntry {
  const name = id.trim()
  const contextWindow = typeof options.contextWindow === 'number'
    && Number.isFinite(options.contextWindow)
    && options.contextWindow > 0
    ? Math.round(options.contextWindow)
    : DEFAULT_CONTEXT_WINDOW
  const entry: GlmModelEntry = {
    id: name,
    name,
    hint: '',
    regions: options.region === undefined ? BOTH : [options.region],
    reasoningEfforts: [],
    thinkingDisableable: true,
    wire: null,
    supportsImages: false,
    defaultContextWindow: contextWindow,
    defaultMaxTokens: DEFAULT_MAX_TOKENS,
    description: null,
  }
  return { ...entry, hint: describeGlmModel(entry, '未声明模型') }
}

/**
 * 查一行模型能力；目录里没有时返回**未声明行**而不是 undefined。
 *
 * 返回未声明行而不是空，是为了让调用方只需要处理一种东西：每个 id 都有一份「不主张什么」的声明，
 * 适配器据 `wire === null` 拒绝它即可，不必另开一条「找不到模型」的分支。
 */
export function resolveGlmModel(
  id: string,
  catalog: readonly GlmModelEntry[] = GLM_MODEL_CATALOG,
): GlmModelEntry {
  return findEntry(id, catalog) ?? undeclaredGlmModelEntry(id)
}

/** 一个部署能调的模型（`regions` 是路由事实：向不服务的部署问会得到 400）。 */
export function modelsForRegion(
  region: GlmRegion,
  catalog: readonly GlmModelEntry[] = GLM_MODEL_CATALOG,
): GlmModelEntry[] {
  return catalog.filter((model) => model.regions.includes(region))
}

/** 目录里的全部 id。 */
export function listModelIds(catalog: readonly GlmModelEntry[] = GLM_MODEL_CATALOG): string[] {
  return catalog.map((model) => model.id)
}

/** 目录条目数，供 hub 概览显示「M 个模型可用」。 */
export function catalogSize(catalog: readonly GlmModelEntry[] = GLM_MODEL_CATALOG): number {
  return catalog.length
}

/**
 * 从一行能力生成设置卡上的一句话描述（计划 §7 的四个要素：思考形态 / 档位 / 输入模态 / 上下文窗口）。
 *
 * 由数据生成而不是逐行手写，是为了让文案**不可能与能力表漂移**：手写文案出过
 * 「三个档位」的模型实际只有两档这种事故，而这张表的每个字段都要被两个 mapper 当成事实使用。
 *
 * @param entry - 能力行。
 * @param prefix - 可选前缀（未声明行用「未声明模型」点明这不是已核实的声明）。
 */
export function describeGlmModel(entry: GlmModelEntry, prefix?: string): string {
  const thinking = entry.thinkingDisableable ? '思考可关闭' : '思考恒开'
  const effort = entry.reasoningEfforts.length === 0
    ? '无档位字段'
    : '档位 ' + entry.reasoningEfforts.join('/')
  const modality = entry.supportsImages ? '输入 text + image' : '输入仅 text'
  const head = prefix === undefined || prefix === '' ? '' : prefix + '：'
  return head + [thinking, effort, modality, '上下文 ' + entry.defaultContextWindow].join('｜')
}

/** 目录 + 用户设置 → 设置面下发的 `GlmModelOption[]`。 */
export interface GlmCatalogOptionOverrides {
  /** 用户勾选的 id；缺省表示全选。 */
  enabledModelIds?: readonly string[]
  /** 逐模型上下文窗口覆盖；null / 非正数表示用目录默认值。 */
  contextWindowOverrides?: Readonly<Record<string, number | null | undefined>>
}

/**
 * 把目录装配成设置面的模型行。
 *
 * `hint` 在这里生成（而不是写死在表里），所以「文案与能力表一致」是结构保证的：
 * 表里改一次档位或图片支持，卡片上的那句话就跟着变。
 *
 * 两条与「未声明行」有关的规矩：
 *
 * - `wire` 为 null 时落到封闭联合上只能填一个占位值（契约的 `GlmModelOption.wire` 没有 null）。
 *   真正的拦截点在适配器：它必须先用 {@link glmModelWire} 拿到 null 并拒绝该模型（D3），
 *   所以这里填什么都不会变成一次猜协议的请求。
 * - 未声明行**默认不勾选**。目录里出现一个新模型不等于它能被安全调用；
 *   让它默认出现在「已启用」里，等于让用户在没读过任何声明的情况下就用上它。
 */
export function catalogModelOptions(
  catalog: readonly GlmModelEntry[] = GLM_MODEL_CATALOG,
  overrides: GlmCatalogOptionOverrides = {},
): GlmModelOption[] {
  const enabled = overrides.enabledModelIds
  return catalog.map((entry) => {
    const override = overrides.contextWindowOverrides?.[entry.id]
    const contextWindow = typeof override === 'number' && Number.isFinite(override) && override > 0
      ? Math.round(override)
      : entry.defaultContextWindow
    return {
      id: entry.id,
      name: entry.name,
      hint: entry.hint === '' ? describeGlmModel(entry) : entry.hint,
      // 未声明行默认不勾选：目录里多出一个 id 不等于它可以被安全调用。
      enabled: enabled === undefined ? entry.wire !== null : enabled.includes(entry.id),
      defaultContextWindow: entry.defaultContextWindow,
      contextWindow,
      defaultMaxTokens: entry.defaultMaxTokens,
      reasoningEfforts: entry.reasoningEfforts,
      thinkingDisableable: entry.thinkingDisableable,
      wire: entry.wire ?? 'anthropic',
      supportsImages: entry.supportsImages,
      regions: entry.regions,
      description: entry.description,
    }
  })
}
