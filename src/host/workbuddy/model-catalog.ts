/**
 * Model catalog for the WorkBuddy / CodeBuddy subscription.
 *
 * The subscription exposes no `/v1/models`-style listing on the chat host
 * (that path answers 404), but the gateway does publish an **authoritative
 * catalog** at `GET /v3/config`, which the official CLI reads at startup. That
 * payload carries each model's real context window, output cap, image support,
 * and the exact reasoning ladder it accepts — so this route prefers the live
 * catalog and keeps the table below only as an offline fallback.
 *
 * The fallback transcribes a live `/v3/config` read — merged across regions by
 * the rule below, never guessed: an earlier revision of this file guessed
 * context windows from vendor marketing and was wrong in both directions
 * (`glm-5.3` and `kimi-k3` are 1M, not 200K/256K).
 *
 * One entry serves both regions, so a model the regions disagree about needs a
 * merged figure. The rule is asymmetric on purpose, and every half of it is
 * decided by what happens when the declaration is WRONG.
 *
 * Figures this route only ever *sends* take the conservative side: the **served
 * default window**, the **output cap**, the **reasoning ladder** and the two
 * capability flags are the **intersection** of what the regions publish — the
 * smaller window, the smaller cap, the rungs both backends accept, and `false`
 * for image input or for switching thinking off as soon as one region says no.
 * Only the **maximum** window takes the larger of the two. Over-declaring any of
 * them is a hard failure: DSH would send a request the gateway answers 400 (a
 * context length it will not serve, an `effort` or thinking shape it rejects, an
 * image to a text-only model), while under-declaring only compresses a
 * conversation earlier than needed or hides an option, and every figure stays
 * overridable per model from the settings card.
 *
 * Measured disagreements reconciled that way on the 2026-11-04 read:
 * `glm-5.3-flash` 300000/32000 on intl against 1000000/131072 on cn;
 * `glm-5.3` and `glm-5.2` cap output at 48000 on intl against 64000 on cn;
 * `deepseek-v4.1-flash`, `minimax-m3.1-flash` and `kimi-k3.1-pro` serve 300000
 * by default on intl against 1000000 on cn; `glm-5.3`, `glm-5.3-flash` and
 * `glm-5.2` accept switching thinking off on intl but not on cn; and the two
 * `glm-5.2` ladders share only `high`.
 *
 * The regions also do not serve the same ids. intl keeps the `gpt-6*` and
 * `gpt-5*` families, `grok-4.7`, `gemini-3.8-flash`, `kimi-k3`, `hy4-preview`
 * and the `*-model` aliases to itself; cn keeps Hunyuan 4 proper (`hy4std`,
 * `hy4free`), `hy4-preview-x`, `hunyuan-chat`, `space-bunny`, `step-5-preview`,
 * `mimo-v2.6-pro` and its own `-1`/`-x` variants. Seven ids are served by
 * both; a catalog refresh that moves the boundary must move `regions` with it.
 *
 * `regions` is a routing fact, not a preference: asking a region for a model it
 * does not serve answers 400 `code 11102`.
 *
 * A second `code 11102` source was measured and is deliberately NOT filtered
 * out here: the gateway lists models the *current account* is not entitled to
 * call (on a free plan, `glm-5.0`, `glm-4.7`, `glm-4.6`, `glm-4.6v`,
 * `kimi-k2-thinking`, `hy4-preview-x` and `minimax-m2.5` all advertise a context
 * window and then answer 11102). Those entries are kept because the gating is
 * per-account, not per-model — a paid plan may serve them — and because the
 * shipped default selection excludes them anyway. The adapter's failure message
 * names this case so a user knows to pick another model rather than to retry.
 *
 * `credits` is the consumption multiplier the same payload publishes as a
 * string (`x0.79 credits` on cn, `x6.67` on intl), stored here in the bare
 * numeric form the settings card renders. It is kept per region because the two
 * backends do not always agree — measured 2026-10-09, `deepseek-v4.1-flash`
 * is `0.11` on cn against `0.00` on intl — and a key is written only for a
 * region that actually published one (every `gpt-5.x` and `gpt-6-astra` is
 * intl-only, the `minimax` and `glm-5.0`/`glm-4.x` rows carry no intl key).
 * An empty string (`default-model`) means no rate was declared at all, so that
 * row has no `credits` field rather than a zeroed one: a guessed rate on a
 * spend figure is worse than a missing one.
 *
 * `reasoningEfforts` carries the ladder a model accepts, transcribed from the
 * gateway's own declaration. `/v3/config` uses two shapes and they were once
 * conflated, in opposite directions: a lone `{ effort: 'high' }` (no
 * `supportedEfforts`) first became a one-entry ladder, which rejected a
 * caller's explicit `low`; widening it to every level this route can name then
 * advertised `minimal`/`xhigh` on a model that has three. Such a model accepts
 * exactly `low`/`high`/`max` (measured on `deepseek-v4.1-flash`), the same
 * three the gateway declares explicitly for `glm-5.3-flash` and
 * `kimi-k2.8-preview`, and routes any other value into the nearest of them.
 */

import type { WorkBuddyModelCredits, WorkBuddyRegion } from '../../shared/workbuddy-contracts.ts'
import { DEFAULT_CONTEXT_WINDOW, FALLBACK_MAX_TOKENS } from './types.ts'
import { convergeWorkBuddyEffort } from '../../shared/workbuddy-contracts.ts'

export interface WorkBuddyModelEntry {
  id: string
  name: string
  /**
   * Context length the gateway serves **by default** for this model.
   *
   * This route sends no explicit context-length parameter, so this is the
   * figure DSH's compaction and overflow decisions must use. It is not always
   * the model's maximum: the gateway reports both (for example
   * `deepseek-v4.1-flash` serves 300000 by default and allows 1000000).
   */
  contextWindow: number
  /** Largest context length the model accepts when one is requested. */
  maxContextWindow: number
  /** Output cap requested when the caller omits one. */
  maxTokens: number
  /** Regions whose backend serves this id. */
  regions: readonly WorkBuddyRegion[]
  /**
   * Consumption multiplier per region, as `/v3/config` publishes it.
   *
   * Optional on purpose: the multiplier is the one field the gateway may omit
   * for a model it otherwise describes (`default-model` ships an empty string),
   * so every catalog literal in this repo — test fixtures and the live parser
   * alike — must stay valid without it. Absent therefore means "nothing usable
   * was published", never "zero": `x0.00` is a real declaration and is kept.
   */
  credits?: WorkBuddyModelCredits
  /** Whether the model accepts image input. */
  supportsImage: boolean
  /** Reasoning ladder the model accepts; empty for a non-reasoning model. */
  reasoningEfforts: readonly string[]
  /** Level this route selects when the caller names none. */
  defaultReasoningEffort: string | null
  /** Whether the model can be asked to skip thinking entirely. */
  canDisableThinking: boolean
  /** One-line note shown beside the model in the settings card. */
  description: string
}

/**
 * Models the gateway serves but does not publish in `/v3/config`.
 *
 * The catalog is a published list, not the served one: measured 2026-10-09 on
 * the international backend, `gpt-6-sol`, `gpt-6-luna` and `gemini-3.8-flash`
 * all answered a normal streaming completion with 200 while being absent from
 * `/v3/config` entirely, and a reachable gateway *replaces* the shipped table
 * with that list — so a row living only in the fallback would drop out of the
 * picker the moment the catalog loaded.
 *
 * The list is empty as of the 2026-11-04 read: all three ids are published now,
 * with figures measured on the wire, and their rows therefore live in
 * {@link FALLBACK_MODELS} like any other. The seam stays rather than being
 * deleted because the gap it covers belongs to the gateway, not to those three
 * models: the next id it serves without listing belongs here, and
 * {@link withUnpublishedModels} is what keeps such a row offered.
 */
export const UNPUBLISHED_MODELS: readonly WorkBuddyModelEntry[] = []

/**
 * Offline fallback catalog, transcribed from a live `/v3/config` read.
 *
 * Last transcribed 2026-11-04 from both backends. Used when the gateway cannot
 * be reached (first run before sign-in, or a network failure); a reachable
 * gateway always wins.
 */
export const FALLBACK_MODELS: readonly WorkBuddyModelEntry[] = [
  {
    id: 'default-model',
    name: 'Auto',
    contextWindow: 200000,
    maxContextWindow: 200000,
    maxTokens: 24000,
    regions: ['intl'],
    supportsImage: true,
    reasoningEfforts: [],
    defaultReasoningEffort: null,
    canDisableThinking: false,
    description: '优秀的编码模型，适合日常使用',
  },
  {
    id: 'fast-model',
    name: 'Fast',
    contextWindow: 200000,
    maxContextWindow: 200000,
    maxTokens: 32000,
    regions: ['intl'],
    credits: { intl: '0.34' },
    supportsImage: true,
    reasoningEfforts: ['low', 'high', 'max'],
    defaultReasoningEffort: 'high',
    canDisableThinking: false,
    description: '响应快，适合简单任务',
  },
  {
    id: 'balanced-model',
    name: 'Balanced',
    contextWindow: 256000,
    maxContextWindow: 256000,
    maxTokens: 32000,
    regions: ['intl'],
    credits: { intl: '0.59' },
    supportsImage: true,
    reasoningEfforts: ['low', 'high', 'max'],
    defaultReasoningEffort: 'high',
    canDisableThinking: false,
    description: '速度与质量兼顾，日常工作首选',
  },
  {
    id: 'primary-model',
    name: 'Primary',
    contextWindow: 272000,
    maxContextWindow: 272000,
    maxTokens: 72000,
    regions: ['intl'],
    credits: { intl: '3.31' },
    supportsImage: true,
    reasoningEfforts: ['low', 'high', 'max'],
    defaultReasoningEffort: 'high',
    canDisableThinking: false,
    description: '高质量输出，胜任复杂任务',
  },
    // intl serves 300000 by default and allows 1M; cn serves 1M outright, so
    // the smaller served default is the window both regions honour.
  {
    id: 'deepseek-v4.1-flash',
    name: 'Deepseek-V4.1-Flash',
    contextWindow: 300000,
    maxContextWindow: 1000000,
    maxTokens: 128000,
    regions: ['intl', 'cn'],
    credits: { cn: '0.11', intl: '0.00' },
    supportsImage: true,
    reasoningEfforts: ['low', 'high', 'max'],
    defaultReasoningEffort: 'high',
    canDisableThinking: false,
    description: 'DeepSeek 旗舰模型，支持 1M 上下文窗口，原生多模态',
  },
  {
    id: 'deepseek-v4.1-flash-sg',
    name: 'Deepseek-V4.1-Flash',
    contextWindow: 300000,
    maxContextWindow: 1000000,
    maxTokens: 128000,
    regions: ['intl'],
    credits: { intl: '0.03' },
    supportsImage: true,
    reasoningEfforts: ['low', 'high', 'max'],
    defaultReasoningEffort: 'high',
    canDisableThinking: false,
    description: 'DeepSeek 旗舰模型，支持 1M 上下文窗口，原生多模态',
  },
    // intl serves 300000 by default and caps output at 32000; cn serves 1M and
    // allows 131072. Both figures take the smaller side.
  {
    id: 'glm-5.3-flash',
    name: 'GLM-5.3-Flash',
    contextWindow: 300000,
    maxContextWindow: 1000000,
    maxTokens: 32000,
    regions: ['intl', 'cn'],
    credits: { cn: '0.08', intl: '0.08' },
    supportsImage: true,
    reasoningEfforts: ['low', 'high', 'max'],
    defaultReasoningEffort: 'high',
    canDisableThinking: false,
    description: '原生多模态模型，擅长视觉理解与专业任务',
  },
  {
    id: 'gpt-6-astra',
    name: 'GPT-6-Astra',
    contextWindow: 400000,
    maxContextWindow: 1000000,
    maxTokens: 128000,
    regions: ['intl'],
    credits: { intl: '6.67' },
    supportsImage: true,
    reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    defaultReasoningEffort: 'high',
    canDisableThinking: true,
    description: 'OpenAI 旗舰模型，擅长复杂推理与长程任务',
  },
    // The preview build. cn replaced it with `hy4std`/`hy4free`; intl keeps
    // serving it, so this row is now intl-only and must not be offered to cn.
  {
    id: 'hy4-preview',
    name: 'Hy4 Preview',
    contextWindow: 200000,
    maxContextWindow: 1000000,
    maxTokens: 64000,
    regions: ['intl'],
    credits: { intl: '0.29' },
    supportsImage: true,
    reasoningEfforts: ['high'],
    defaultReasoningEffort: 'high',
    canDisableThinking: false,
    description: '混元思考模型，具有增强的推理能力',
  },
  {
    id: 'hy3',
    name: 'Hy3',
    contextWindow: 192000,
    maxContextWindow: 192000,
    maxTokens: 64000,
    regions: ['intl', 'cn'],
    credits: { cn: '0.00', intl: '0.00' },
    supportsImage: true,
    reasoningEfforts: ['low', 'high'],
    defaultReasoningEffort: 'high',
    canDisableThinking: false,
    description: '混元思考模型，具有增强的推理能力',
  },
  {
    id: 'gpt-5.6-sol',
    name: 'GPT-5.6-Sol',
    contextWindow: 1000000,
    maxContextWindow: 1000000,
    maxTokens: 128000,
    regions: ['intl'],
    credits: { intl: '3.47' },
    supportsImage: true,
    reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    defaultReasoningEffort: 'high',
    canDisableThinking: true,
    description: 'OpenAI 旗舰模型，擅长复杂推理与长程任务',
  },
  {
    id: 'gpt-5.6-terra',
    name: 'GPT-5.6-Terra',
    contextWindow: 1000000,
    maxContextWindow: 1000000,
    maxTokens: 128000,
    regions: ['intl'],
    credits: { intl: '1.39' },
    supportsImage: true,
    reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    defaultReasoningEffort: 'high',
    canDisableThinking: true,
    description: 'OpenAI 均衡模型，兼顾能力、速度与成本',
  },
  {
    id: 'gpt-5.6-luna',
    name: 'GPT-5.6-Luna',
    contextWindow: 1000000,
    maxContextWindow: 1000000,
    maxTokens: 128000,
    regions: ['intl'],
    credits: { intl: '0.14' },
    supportsImage: true,
    reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    defaultReasoningEffort: 'high',
    canDisableThinking: true,
    description: 'OpenAI 轻量模型，响应快速，适合日常任务',
  },
  {
    id: 'gpt-5.5',
    name: 'GPT-5.5',
    contextWindow: 1000000,
    maxContextWindow: 1000000,
    maxTokens: 128000,
    regions: ['intl'],
    credits: { intl: '3.31' },
    supportsImage: true,
    reasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
    defaultReasoningEffort: 'high',
    canDisableThinking: false,
    description: 'OpenAI 旗舰编码模型，擅长长程任务',
  },
  {
    id: 'gpt-5.4',
    name: 'GPT-5.4',
    contextWindow: 272000,
    maxContextWindow: 272000,
    maxTokens: 72000,
    regions: ['intl'],
    credits: { intl: '1.65' },
    supportsImage: true,
    reasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
    defaultReasoningEffort: 'high',
    canDisableThinking: false,
    description: 'OpenAI 旗舰编码模型，擅长长程任务',
  },
    // intl caps output at 48000 where cn allows 64000, and only intl lets the
    // trace be switched off.
  {
    id: 'glm-5.3',
    name: 'GLM-5.3',
    contextWindow: 1000000,
    maxContextWindow: 1000000,
    maxTokens: 48000,
    regions: ['intl', 'cn'],
    credits: { cn: '0.69', intl: '0.69' },
    supportsImage: true,
    reasoningEfforts: ['low', 'high', 'max'],
    defaultReasoningEffort: 'high',
    canDisableThinking: false,
    description: '能力均衡，适合日常使用',
  },
    // intl caps output at 48000 where cn allows 64000, and the two region
    // ladders share exactly the `high` rung.
  {
    id: 'glm-5.2',
    name: 'GLM-5.2',
    contextWindow: 1000000,
    maxContextWindow: 1000000,
    maxTokens: 48000,
    regions: ['intl', 'cn'],
    credits: { cn: '0.79', intl: '0.79' },
    supportsImage: true,
    reasoningEfforts: ['high'],
    defaultReasoningEffort: 'high',
    canDisableThinking: false,
    description: '1M 上下文，擅长长程任务',
  },
    // intl serves 300000 by default and allows 1M; cn serves 1M outright.
  {
    id: 'minimax-m3.1-flash',
    name: 'MiniMax-M3.1-Flash',
    contextWindow: 300000,
    maxContextWindow: 1000000,
    maxTokens: 128000,
    regions: ['intl', 'cn'],
    credits: { cn: '0.08', intl: '0.08' },
    supportsImage: true,
    reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    defaultReasoningEffort: 'max',
    canDisableThinking: false,
    description: '原生多模态，擅长office、agentic、编程任务，推理速度优异',
  },
    // intl serves 300000 by default and allows 1M; cn serves 1M outright.
  {
    id: 'kimi-k3.1-pro',
    name: 'Kimi-K3.1-Pro',
    contextWindow: 300000,
    maxContextWindow: 1000000,
    maxTokens: 32000,
    regions: ['intl', 'cn'],
    credits: { cn: '0.97', intl: '0.97' },
    supportsImage: true,
    reasoningEfforts: ['low', 'high', 'max'],
    defaultReasoningEffort: 'high',
    canDisableThinking: false,
    description: 'Kimi 全新旗舰模型，3万亿级参数。办公、代码、3D 创作与长程 Agent 能力全面升级。',
  },
  {
    id: 'kimi-k3.1-pro-highspeed',
    name: 'Kimi-K3.1-Pro-Highspeed',
    contextWindow: 300000,
    maxContextWindow: 1000000,
    maxTokens: 32000,
    regions: ['intl'],
    credits: { intl: '1.56' },
    supportsImage: true,
    reasoningEfforts: ['low', 'high', 'max'],
    defaultReasoningEffort: 'high',
    canDisableThinking: false,
    description: 'K3.1 Pro 高速版本，响应速度提升至 K3.1 Pro 的 2–3 倍，交互更流畅。',
  },
  {
    id: 'kimi-k3',
    name: 'Kimi-K3',
    contextWindow: 1000000,
    maxContextWindow: 1000000,
    maxTokens: 32000,
    regions: ['intl'],
    credits: { intl: '1.62' },
    supportsImage: true,
    reasoningEfforts: ['low', 'high', 'max'],
    defaultReasoningEffort: 'high',
    canDisableThinking: false,
    description: '擅长处理复杂的长程自主任务，前端开发能力突出，同时在知识工作与科研推理上表现出色。',
  },
  {
    id: 'grok-4.7',
    name: 'Grok-4.7',
    contextWindow: 200000,
    maxContextWindow: 500000,
    maxTokens: 128000,
    regions: ['intl'],
    credits: { intl: '1.90' },
    supportsImage: true,
    reasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
    defaultReasoningEffort: 'high',
    canDisableThinking: false,
    description: 'SpaceXAI 打造的前沿模型，专为编程、智能体任务及知识型工作而设计。',
  },
    // Served but unpublished on the 2026-10-09 read, published by 2026-11-04;
    // the window inherited from `gemini-3.5-flash` is replaced by the real one.
  {
    id: 'gemini-3.8-flash',
    name: 'Gemini-3.8-Flash',
    contextWindow: 300000,
    maxContextWindow: 1000000,
    maxTokens: 65536,
    regions: ['intl'],
    credits: { intl: '0.95' },
    supportsImage: true,
    reasoningEfforts: ['low', 'medium', 'high'],
    defaultReasoningEffort: 'medium',
    canDisableThinking: false,
    description: '能力均衡，适合日常使用',
  },
  {
    id: 'gpt-6-sol',
    name: 'GPT-6-Sol',
    contextWindow: 1000000,
    maxContextWindow: 1000000,
    maxTokens: 128000,
    regions: ['intl'],
    credits: { intl: '1.33' },
    supportsImage: true,
    reasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
    defaultReasoningEffort: 'high',
    canDisableThinking: false,
    description: '专为复杂编码和智能体工作流构建的模型',
  },
  {
    id: 'gpt-6-luna',
    name: 'GPT-6-Luna',
    contextWindow: 1000000,
    maxContextWindow: 1000000,
    maxTokens: 128000,
    regions: ['intl'],
    credits: { intl: '0.07' },
    supportsImage: true,
    reasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
    defaultReasoningEffort: 'high',
    canDisableThinking: false,
    description: '专为单一聚焦、高吞吐量任务打造的高效模型',
  },
  {
    id: 'gpt-6.1-sol',
    name: 'GPT-6.1-Sol',
    contextWindow: 272000,
    maxContextWindow: 1000000,
    maxTokens: 128000,
    regions: ['intl'],
    credits: { intl: '1.33' },
    supportsImage: true,
    reasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
    defaultReasoningEffort: 'high',
    canDisableThinking: false,
    description: '专为复杂编码和智能体工作流构建的模型',
  },
  {
    id: 'default',
    name: 'Default',
    contextWindow: 56000,
    maxContextWindow: 56000,
    maxTokens: 24000,
    regions: ['cn'],
    credits: { cn: '2.00' },
    supportsImage: false,
    reasoningEfforts: [],
    defaultReasoningEffort: null,
    canDisableThinking: false,
    description: '',
  },
  {
    id: 'deepseek-v4-pro',
    name: 'DeepSeek-V4-Pro',
    contextWindow: 1000000,
    maxContextWindow: 1000000,
    maxTokens: 128000,
    regions: ['cn'],
    credits: { cn: '0.51' },
    supportsImage: true,
    reasoningEfforts: ['low', 'high', 'max'],
    defaultReasoningEffort: 'high',
    canDisableThinking: false,
    description: '',
  },
  {
    id: 'deepseek-v4-flash',
    name: 'Deepseek-V4-Flash',
    contextWindow: 1000000,
    maxContextWindow: 1000000,
    maxTokens: 50000,
    regions: ['cn'],
    credits: { cn: '0.17' },
    supportsImage: true,
    reasoningEfforts: ['low', 'high', 'max'],
    defaultReasoningEffort: 'high',
    canDisableThinking: false,
    description: '',
  },
  {
    id: 'deepseek-v3-2-volc',
    name: 'DeepSeek-V3.2',
    contextWindow: 96000,
    maxContextWindow: 96000,
    maxTokens: 32000,
    regions: ['cn'],
    credits: { cn: '0.29' },
    supportsImage: false,
    reasoningEfforts: ['low', 'high', 'max'],
    defaultReasoningEffort: 'high',
    canDisableThinking: false,
    description: '',
  },
  {
    id: 'minimax-m2.5',
    name: 'MiniMax-M2.5',
    contextWindow: 200000,
    maxContextWindow: 200000,
    maxTokens: 48000,
    regions: ['cn'],
    credits: { cn: '0.18' },
    supportsImage: false,
    reasoningEfforts: ['low', 'high', 'max'],
    defaultReasoningEffort: 'high',
    canDisableThinking: false,
    description: '',
  },
  {
    id: 'minimax-m2.7',
    name: 'MiniMax-M2.7',
    contextWindow: 200000,
    maxContextWindow: 200000,
    maxTokens: 48000,
    regions: ['cn'],
    credits: { cn: '0.19' },
    supportsImage: true,
    reasoningEfforts: ['low', 'high', 'max'],
    defaultReasoningEffort: 'high',
    canDisableThinking: false,
    description: '',
  },
  {
    id: 'glm-5.0',
    name: 'GLM-5.0',
    contextWindow: 200000,
    maxContextWindow: 200000,
    maxTokens: 48000,
    regions: ['cn'],
    credits: { cn: '0.80' },
    supportsImage: false,
    reasoningEfforts: [],
    defaultReasoningEffort: null,
    canDisableThinking: false,
    description: '',
  },
  {
    id: 'glm-5.0-turbo',
    name: 'GLM-5.0-Turbo',
    contextWindow: 200000,
    maxContextWindow: 200000,
    maxTokens: 48000,
    regions: ['cn'],
    credits: { cn: '0.95' },
    supportsImage: false,
    reasoningEfforts: ['low', 'high', 'max'],
    defaultReasoningEffort: 'high',
    canDisableThinking: false,
    description: '',
  },
  {
    id: 'glm-4.7',
    name: 'GLM-4.7',
    contextWindow: 200000,
    maxContextWindow: 200000,
    maxTokens: 48000,
    regions: ['cn'],
    credits: { cn: '0.23' },
    supportsImage: false,
    reasoningEfforts: [],
    defaultReasoningEffort: null,
    canDisableThinking: false,
    description: '',
  },
  {
    id: 'glm-4.6',
    name: 'GLM-4.6',
    contextWindow: 168000,
    maxContextWindow: 168000,
    maxTokens: 32000,
    regions: ['cn'],
    credits: { cn: '0.23' },
    supportsImage: false,
    reasoningEfforts: [],
    defaultReasoningEffort: null,
    canDisableThinking: false,
    description: '',
  },
  {
    id: 'glm-4.6v',
    name: 'GLM-4.6V',
    contextWindow: 128000,
    maxContextWindow: 128000,
    maxTokens: 32000,
    regions: ['cn'],
    credits: { cn: '0.11' },
    supportsImage: true,
    reasoningEfforts: ['low', 'high', 'max'],
    defaultReasoningEffort: 'high',
    canDisableThinking: false,
    description: '',
  },
  {
    id: 'kimi-k3-1',
    name: 'Kimi-K3',
    contextWindow: 1000000,
    maxContextWindow: 1000000,
    maxTokens: 32000,
    regions: ['cn'],
    credits: { cn: '1.62' },
    supportsImage: true,
    reasoningEfforts: ['low', 'high', 'max'],
    defaultReasoningEffort: 'high',
    canDisableThinking: false,
    description: '擅长处理复杂的长程自主任务，前端开发能力突出，同时在知识工作与科研推理上表现出色。',
  },
  {
    id: 'kimi-k2.8-preview',
    name: 'Kimi-K2.8-Preview',
    contextWindow: 1000000,
    maxContextWindow: 1000000,
    maxTokens: 64000,
    regions: ['cn'],
    credits: { cn: '0.77' },
    supportsImage: true,
    reasoningEfforts: ['low', 'high', 'max'],
    defaultReasoningEffort: 'high',
    canDisableThinking: true,
    description: 'Moonshot AI · 擅长复杂长程自主任务、知识工作与科研推理，前端开发突出',
  },
  {
    id: 'kimi-k2.5',
    name: 'Kimi-K2.5',
    contextWindow: 164000,
    maxContextWindow: 164000,
    maxTokens: 32000,
    regions: ['cn'],
    credits: { cn: '0.45' },
    supportsImage: true,
    reasoningEfforts: ['low', 'high', 'max'],
    defaultReasoningEffort: 'high',
    canDisableThinking: false,
    description: '',
  },
  {
    id: 'kimi-k2-thinking',
    name: 'Kimi-K2-Thinking',
    contextWindow: 164000,
    maxContextWindow: 164000,
    maxTokens: 32000,
    regions: ['cn'],
    credits: { cn: '0.54' },
    supportsImage: false,
    reasoningEfforts: ['low', 'high', 'max'],
    defaultReasoningEffort: 'high',
    canDisableThinking: false,
    description: '',
  },
  {
    id: 'hy3-x',
    name: 'Hy3',
    contextWindow: 192000,
    maxContextWindow: 192000,
    maxTokens: 64000,
    regions: ['cn'],
    credits: { cn: '0.05' },
    supportsImage: true,
    reasoningEfforts: ['low', 'high', 'max'],
    defaultReasoningEffort: 'high',
    canDisableThinking: false,
    description: '混元思考模型，具有增强的推理能力',
  },
  {
    id: 'hy4-preview-x',
    name: 'Hy4 preview',
    contextWindow: 1000000,
    maxContextWindow: 1000000,
    maxTokens: 64000,
    regions: ['cn'],
    credits: { cn: '0.29' },
    supportsImage: true,
    reasoningEfforts: ['high'],
    defaultReasoningEffort: 'high',
    canDisableThinking: false,
    description: '混元思考模型，具有增强的推理能力',
  },
  {
    id: 'hunyuan-chat',
    name: 'Hunyuan-Turbos',
    contextWindow: 200000,
    maxContextWindow: 200000,
    maxTokens: 8192,
    regions: ['cn'],
    credits: { cn: '0.10' },
    supportsImage: false,
    reasoningEfforts: [],
    defaultReasoningEffort: null,
    canDisableThinking: false,
    description: '',
  },
  {
    id: 'space-bunny',
    name: 'Space-Bunny',
    contextWindow: 1000000,
    maxContextWindow: 1000000,
    maxTokens: 128000,
    regions: ['cn'],
    credits: { cn: '0.08' },
    supportsImage: true,
    reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    defaultReasoningEffort: 'max',
    canDisableThinking: false,
    description: '推理速度极快，编码能力强劲，并支持原生多模态输入的匿名大模型',
  },
  {
    id: 'step-5-preview',
    name: 'Step-5-Preview',
    contextWindow: 1000000,
    maxContextWindow: 1000000,
    maxTokens: 64000,
    regions: ['cn'],
    credits: { cn: '0.33' },
    supportsImage: true,
    reasoningEfforts: ['low', 'medium', 'high'],
    defaultReasoningEffort: 'high',
    canDisableThinking: false,
    description: '阶跃 StepFun 面向真实任务的新一代旗舰基模',
  },
  {
    id: 'mimo-v2.6-pro',
    name: 'Xiaomi MiMo-V2.6-Pro',
    contextWindow: 1000000,
    maxContextWindow: 1000000,
    maxTokens: 128000,
    regions: ['cn'],
    credits: { cn: '0.13' },
    supportsImage: true,
    reasoningEfforts: ['low', 'high', 'max'],
    defaultReasoningEffort: 'high',
    canDisableThinking: false,
    description: 'Xiaomi · 旗舰推理模型，面向专业、复杂长程工作流，兼顾高阶科研与网络安全',
  },
    // Hunyuan 4 proper, cn-only. Both GA ids are spelled `Hy4` on the wire and
    // share one shape (1M context, 64K output, image input, a lone `high` rung);
    // they differ only in what they cost, so the free tier's label spells that
    // out — two rows reading `Hy4` would be indistinguishable in the card.
  {
    id: 'hy4free',
    name: 'Hy4 Free',
    contextWindow: 1000000,
    maxContextWindow: 1000000,
    maxTokens: 64000,
    regions: ['cn'],
    credits: { cn: '0.00' },
    supportsImage: true,
    reasoningEfforts: ['high'],
    defaultReasoningEffort: 'high',
    canDisableThinking: false,
    description: '最新旗舰模型，Agent与多模专长',
  },
  {
    id: 'hy4std',
    name: 'Hy4',
    contextWindow: 1000000,
    maxContextWindow: 1000000,
    maxTokens: 64000,
    regions: ['cn'],
    credits: { cn: '0.29' },
    supportsImage: true,
    reasoningEfforts: ['high'],
    defaultReasoningEffort: 'high',
    canDisableThinking: false,
    description: '最新旗舰模型，Agent与多模专长',
  },
]

/**
 * Models the picker offers on a fresh install.
 *
 * Deliberately short: the catalog holds every id the subscription serves, and
 * the picker is far more usable with the handful of general-purpose models. The
 * card lets a user add the rest, and a first-run default expands to everything
 * the account's region can actually call.
 */
export const DEFAULT_VISIBLE_MODEL_IDS: readonly string[] = [
  'glm-5.3',
  'deepseek-v4.1-flash',
  'hy4std',
  'kimi-k3.1-pro',
]

/**
 * Default selections this table used to ship.
 *
 * "Never edited" is recognised by matching the CURRENT shipped set, so replacing
 * the set outright would turn every existing install into what looks like a user
 * who hand-picked a short list — and the picker would quietly narrow to it,
 * because the 2026-11-04 refresh dropped two of the retired ids outright
 * (`kimi-k2.6` is gone from both regions, `hy4-preview` is intl-only now).
 * Keeping the retired sets here is what lets the default move without that.
 */
const RETIRED_DEFAULT_SELECTIONS: readonly (readonly string[])[] = [
  ['glm-5.3', 'deepseek-v4.1-flash', 'hy4-preview', 'kimi-k2.6'],
]

/**
 * Whether a stored selection is still a shipped default, i.e. the user never
 * touched the picker.
 *
 * Same size and same members, not order-sensitive: the card writes the list in
 * catalog order, which one default can spell two ways.
 */
export function isUntouchedModelSelection(stored: readonly string[]): boolean {
  if (stored.length === 0) return false
  return [DEFAULT_VISIBLE_MODEL_IDS, ...RETIRED_DEFAULT_SELECTIONS].some((shipped) => {
    const known = new Set(shipped)
    return stored.length === known.size && stored.every((id) => known.has(id))
  })
}

/** Every id the fallback knows, in declaration order. */
export const WORKBUDDY_MODEL_IDS: readonly string[] = FALLBACK_MODELS.map((model) => model.id)

/**
 * Add the served-but-unpublished models to a live `/v3/config` catalog.
 *
 * A reachable gateway replaces the shipped table with the list it publishes, so
 * a model it serves without listing ({@link UNPUBLISHED_MODELS}) would drop out
 * of the picker the moment the catalog loads. Merging here keeps it offered.
 *
 * A published entry always wins: the gateway is the authority on anything it
 * does describe, so these rows only fill ids the payload is silent about.
 */
export function withUnpublishedModels(
  catalog: readonly WorkBuddyModelEntry[],
  region: WorkBuddyRegion,
): WorkBuddyModelEntry[] {
  const known = new Set(catalog.map((model) => model.id))
  const extra = UNPUBLISHED_MODELS.filter(
    (model) => model.regions.includes(region) && !known.has(model.id),
  )
  return extra.length > 0 ? [...catalog, ...extra] : [...catalog]
}

/**
 * Resolve one entry from a catalog.
 *
 * An unknown id resolves to a synthetic text-only entry rather than the first
 * catalog row: reporting a real model's capabilities for an id it does not
 * describe would mis-declare image support and route a request to a 400.
 */
export function resolveWorkBuddyModel(
  id: string,
  catalog: readonly WorkBuddyModelEntry[] = FALLBACK_MODELS,
): WorkBuddyModelEntry {
  const found = catalog.find((model) => model.id === id)
  if (found !== undefined) {
    // Normalize on read rather than editing the transcribed table: the gateway
    // names a default from a wider vocabulary than the ladder it publishes for
    // the same model (`medium` for entries that expose only `low`/`high`/`max`).
    // Left as-is, that value is dropped by the level-resolution step, no
    // `reasoning_effort` is sent, and the model returns empty reasoning.
    const ladder = found.reasoningEfforts
    const declared = found.defaultReasoningEffort
    if (declared === null || ladder.includes(declared)) return found
    return { ...found, defaultReasoningEffort: convergeWorkBuddyEffort(declared, ladder) }
  }
  return {
    id,
    name: id,
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxContextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: FALLBACK_MAX_TOKENS,
    regions: ['cn', 'intl'],
    // Nothing is published for an id no catalog describes, so no rate is.
    credits: {},
    supportsImage: false,
    reasoningEfforts: [],
    defaultReasoningEffort: null,
    canDisableThinking: false,
    description: '',
  }
}

/** Whether one catalog knows this exact id. */
export function isWorkBuddyModelId(
  id: unknown,
  catalog: readonly WorkBuddyModelEntry[] = FALLBACK_MODELS,
): id is string {
  return typeof id === 'string' && catalog.some((model) => model.id === id)
}

/**
 * Vendor families, resolved from a model id.
 *
 * The gateway orders `/v3/config` the way it feels like, which interleaves
 * vendors: a DeepSeek row, then a GPT row, then two Hunyuan rows, then a Kimi
 * row, then three more GPT rows. In a picker that reads as noise — the eye
 * cannot tell that the GPT entries belong together — so the list is grouped by
 * family before it is shown.
 *
 * The rules are ordered, first match wins. Only families this subscription
 * actually serves are listed: a rule for a model that cannot appear would be a
 * guess about a future catalog.
 *
 * An id no rule claims is its own family rather than a shared `other` bucket, so
 * an unrecognised model keeps its place in the order instead of being swept into
 * a pile of models it has nothing to do with.
 */
const WORKBUDDY_VENDOR_RULES: ReadonlyArray<{ re: RegExp; family: string }> = [
  // WorkBuddy's own routing aliases, which are not a vendor at all — they
  // forward to whichever model the subscription points them at today.
  { re: /^(default|fast|balanced|primary|deep)(-model)?$/, family: 'alias' },
  { re: /^gpt-/, family: 'openai' },
  { re: /^gemini-/, family: 'google' },
  { re: /^glm-/, family: 'zhipu' },
  { re: /^kimi-/, family: 'moonshot' },
  { re: /^deepseek-/, family: 'deepseek' },
  // Tencent's own family: `hy3`/`hy4std`/`hy4free` are Hunyuan (`hy` is the
  // vendor's own short spelling) and `hunyuan-chat` is the same vendor spelled
  // out, so both must land in one group.
  { re: /^hy[0-9]/, family: 'tencent' },
  { re: /^hunyuan/, family: 'tencent' },
  { re: /^minimax-/, family: 'minimax' },
  { re: /^mimo-/, family: 'xiaomi' },
  { re: /^step-/, family: 'stepfun' },
  { re: /^grok-/, family: 'xai' },
  { re: /^space-bunny$/, family: 'space-bunny' },
]

/** The vendor family one model belongs to. */
export function workBuddyModelVendor(id: string): string {
  const value = id.toLowerCase()
  for (const rule of WORKBUDDY_VENDOR_RULES) {
    if (rule.re.test(value)) return rule.family
  }
  return id
}

/**
 * Numeric segments of a model id, e.g. `gpt-6-astra` → [6].
 *
 * Version numbers are compared as numbers, so GPT-6.0 sorts below GPT-6.6 rather
 * than above it as it would if the strings were compared.
 */
function versionSegments(id: string): number[] {
  return [...id.toLowerCase().matchAll(/\d+/g)].map((match) => Number(match[0]))
}

/**
 * Order two models of one family, newest generation first.
 *
 * Catalog order alone is not good enough. The models served but not published
 * are appended after the published list, which left `gpt-6-sol` below
 * `gpt-5.4` — the newest models at the bottom of their own group. Comparing the
 * numeric segments puts every GPT-6 row together and ahead of every GPT-5 one,
 * and leaves an id whose version cannot be read (an alias, a nickname) in the
 * catalog's own order rather than guessing where it belongs.
 *
 * Ties keep catalog order, so `deepseek-v4.1-flash` still leads its
 * `-flash-sg` sibling.
 */
function compareWithinFamily(a: { id: string }, b: { id: string }): number {
  const left = versionSegments(a.id)
  const right = versionSegments(b.id)
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const x = left[index]
    const y = right[index]
    // One id runs out of segments: the longer one names a refinement of it
    // (`gpt-5.6` vs `gpt-5.6-sol`), so it follows.
    if (x === undefined) return 1
    if (y === undefined) return -1
    if (x !== y) return y - x
  }
  return 0
}

/**
 * Group a list so every vendor's models sit together.
 *
 * Families appear in the order their first model does — the catalog decides
 * which vendor leads, not this function — and each family is ordered newest
 * generation first.
 */
export function groupWorkBuddyModelsByVendor<T extends { id: string }>(models: readonly T[]): T[] {
  const families = new Map<string, T[]>()
  for (const model of models) {
    const family = workBuddyModelVendor(model.id)
    const bucket = families.get(family)
    if (bucket === undefined) families.set(family, [model])
    else bucket.push(model)
  }
  return [...families.values()]
    .map((bucket) => [...bucket].sort(compareWithinFamily))
    .flat()
}

/**
 * Models an account in `region` can actually call, grouped by vendor.
 *
 * Grouped here rather than in the settings card because this is also what the
 * request path resolves against: one ordering rule, so the picker and the
 * adapter can never disagree about which models a region offers.
 */
export function modelsForRegion(
  region: WorkBuddyRegion,
  catalog: readonly WorkBuddyModelEntry[] = FALLBACK_MODELS,
): WorkBuddyModelEntry[] {
  return groupWorkBuddyModelsByVendor(catalog.filter((model) => model.regions.includes(region)))
}

/** Whether one model accepts image input. */
export function workBuddyModelSupportsImage(
  id: string,
  catalog: readonly WorkBuddyModelEntry[] = FALLBACK_MODELS,
): boolean {
  return resolveWorkBuddyModel(id, catalog).supportsImage
}

/**
 * Reasoning ladder one model accepts, plus `none` when its trace can be turned off.
 *
 * The ladder in the catalog is what the model ACCEPTS, so `none` never appears
 * in it; `canDisableThinking` is the separate statement that switching thinking
 * off is allowed, and this is the single place that turns it into the one level
 * the picker can offer. Callers that need the ladder alone read the entry.
 */
export function workBuddyReasoningEfforts(
  id: string,
  catalog: readonly WorkBuddyModelEntry[] = FALLBACK_MODELS,
): readonly string[] {
  const entry = resolveWorkBuddyModel(id, catalog)
  if (!entry.canDisableThinking || entry.reasoningEfforts.length === 0) return entry.reasoningEfforts
  return entry.reasoningEfforts.includes('none') ? entry.reasoningEfforts : ['none', ...entry.reasoningEfforts]
}

/**
 * Consumption multiplier per region one model publishes.
 *
 * Read through {@link resolveWorkBuddyModel} like the other accessors, so an id
 * no catalog describes reports `{}` — "no rate published" rather than a rate
 * of zero.
 */
export function workBuddyModelCredits(
  id: string,
  catalog: readonly WorkBuddyModelEntry[] = FALLBACK_MODELS,
): WorkBuddyModelCredits {
  return resolveWorkBuddyModel(id, catalog).credits ?? {}
}

/** Output cap requested when the caller omits one. */
export function maxOutputTokensFor(
  id: string,
  catalog: readonly WorkBuddyModelEntry[] = FALLBACK_MODELS,
): number {
  return resolveWorkBuddyModel(id, catalog).maxTokens || FALLBACK_MAX_TOKENS
}

/** Context window assumed when no override is saved. */
export function defaultContextWindowFor(
  id: string,
  catalog: readonly WorkBuddyModelEntry[] = FALLBACK_MODELS,
): number {
  return resolveWorkBuddyModel(id, catalog).contextWindow || DEFAULT_CONTEXT_WINDOW
}
