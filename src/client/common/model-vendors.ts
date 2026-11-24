/**
 * Resolves which vendor made a model, from its id alone, so any provider's
 * model checklist can group a mixed catalog into the split vendor view.
 *
 * Order of evidence: a known `vendor/` prefix, then the model family of the
 * last path segment (`qwen3.8-max`, `hy4`, `llama3.1:8b`), then an unknown
 * prefix title-cased as its own vendor, and finally the caller's "other" bucket.
 */
import type { ModelChecklistGroup } from './ModelChecklist.tsx'
import type { ProviderMarkKey } from '../hub/brand-icons.tsx'

interface VendorSpec {
  key: string
  label: string
  mark: ProviderMarkKey | null
}

function vendor(key: string, label: string, mark: ProviderMarkKey | null = null): VendorSpec {
  return { key, label, mark }
}

const ANTHROPIC = vendor('anthropic', 'Anthropic', 'claude')
const OPENAI = vendor('openai', 'OpenAI', 'openai')
const DEEPSEEK = vendor('deepseek', 'DeepSeek', 'deepseek')
const MOONSHOT = vendor('moonshot', 'Moonshot', 'kimi')
const ZAI = vendor('zai', 'Z.ai', 'glm')
const MINIMAX = vendor('minimax', 'MiniMax', 'minimax')
const QWEN = vendor('qwen', 'Qwen', 'qwen')
const GOOGLE = vendor('google', 'Google', 'gemini')
const XAI = vendor('xai', 'xAI', 'grok')
const STEPFUN = vendor('stepfun', 'StepFun', 'step-code')
const META = vendor('meta', 'Meta')
const XIAOMI = vendor('xiaomi', 'Xiaomi')
const TENCENT = vendor('tencent', 'Tencent')
const MISTRAL = vendor('mistral', 'Mistral')
const NVIDIA = vendor('nvidia', 'NVIDIA')
const MEITUAN = vendor('meituan', 'Meituan')
const MICROSOFT = vendor('microsoft', 'Microsoft')
const IBM = vendor('ibm', 'IBM')
const COHERE = vendor('cohere', 'Cohere')

const PREFIX_VENDORS: Readonly<Record<string, VendorSpec>> = {
  anthropic: ANTHROPIC,
  openai: OPENAI,
  deepseek: DEEPSEEK,
  'deepseek-ai': DEEPSEEK,
  moonshotai: MOONSHOT,
  moonshot: MOONSHOT,
  kimi: MOONSHOT,
  'z-ai': ZAI,
  'zai-org': ZAI,
  zai: ZAI,
  zhipu: ZAI,
  thudm: ZAI,
  minimax: MINIMAX,
  minimaxai: MINIMAX,
  qwen: QWEN,
  alibaba: QWEN,
  google: GOOGLE,
  xai: XAI,
  'x-ai': XAI,
  stepfun: STEPFUN,
  'stepfun-ai': STEPFUN,
  meta: META,
  'meta-llama': META,
  xiaomi: XIAOMI,
  xiaomimimo: XIAOMI,
  tencent: TENCENT,
  mistral: MISTRAL,
  mistralai: MISTRAL,
  nvidia: NVIDIA,
  meituan: MEITUAN,
  'meituan-longcat': MEITUAN,
  microsoft: MICROSOFT,
  ibm: IBM,
  'ibm-granite': IBM,
  cohere: COHERE,
  inclusionai: vendor('inclusionai', 'InclusionAI'),
  thinkingmachines: vendor('thinkingmachines', 'Thinking Machines'),
  stealth: vendor('stealth', 'Stealth'),
  sakana: vendor('sakana', 'Sakana'),
  ornith: vendor('ornith', 'Ornith'),
  reflection: vendor('reflection', 'Reflection'),
  poolside: vendor('poolside', 'Poolside'),
}

/**
 * Model families recognised from a bare model name (lower-cased, prefix-free).
 * First match wins; anchored at the start so a family name inside another
 * vendor's id (a fine-tune called `foo-llama`) does not steal it.
 */
const FAMILY_RULES: ReadonlyArray<{ re: RegExp; vendor: VendorSpec }> = [
  { re: /^claude/, vendor: ANTHROPIC },
  { re: /^(gpt|chatgpt|codex|o[1-9](?![0-9])|davinci|text-embedding)/, vendor: OPENAI },
  { re: /^deepseek/, vendor: DEEPSEEK },
  { re: /^(kimi|moonshot|k[0-9])/, vendor: MOONSHOT },
  { re: /^(glm|chatglm|codegeex|cogview)/, vendor: ZAI },
  { re: /^(minimax|abab)/, vendor: MINIMAX },
  { re: /^(qwen|qwq|qvq|tongyi)/, vendor: QWEN },
  { re: /^(gemini|gemma|codegemma|palm)/, vendor: GOOGLE },
  { re: /^grok/, vendor: XAI },
  { re: /^step[-_0-9]/, vendor: STEPFUN },
  { re: /^(llama|codellama)/, vendor: META },
  { re: /^(mistral|mixtral|codestral|devstral|magistral|ministral|pixtral)/, vendor: MISTRAL },
  { re: /^(hunyuan|hy[0-9])/, vendor: TENCENT },
  { re: /^mimo/, vendor: XIAOMI },
  { re: /^(nemotron|nvidia)/, vendor: NVIDIA },
  { re: /^longcat/, vendor: MEITUAN },
  { re: /^phi[-0-9]/, vendor: MICROSOFT },
  { re: /^granite/, vendor: IBM },
  { re: /^(command-r|command-a|aya)/, vendor: COHERE },
]

function titleCasePrefix(raw: string): string {
  return raw
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(' ')
}

export interface ModelVendorOptions {
  /**
   * Leading path segments that name the line itself rather than a vendor
   * (`cline-pass/qwen3.8-max`); they are skipped before the vendor is read.
   */
  ignorePrefixes?: readonly string[]
}

/**
 * The display vendor of one model id.
 *
 * @param modelId - the model id as the line's catalog lists it.
 * @param otherLabel - label of the bucket for ids no rule claims.
 * @param options - line-specific prefixes to skip.
 */
export function modelVendorGroup(modelId: string, otherLabel: string, options: ModelVendorOptions = {}): ModelChecklistGroup {
  let segments = modelId.trim().split('/').filter(Boolean)
  const ignored = options.ignorePrefixes ?? []
  while (segments.length > 1 && ignored.includes(segments[0]!.toLowerCase())) segments = segments.slice(1)

  const prefix = segments.length > 1 ? segments[0]! : null
  if (prefix !== null) {
    const known = PREFIX_VENDORS[prefix.toLowerCase()]
    if (known !== undefined) return known
  }

  const name = (segments[segments.length - 1] ?? '').toLowerCase()
  for (const rule of FAMILY_RULES) {
    if (rule.re.test(name)) return rule.vendor
  }

  if (prefix !== null) return { key: prefix.toLowerCase(), label: titleCasePrefix(prefix), mark: null }
  return { key: 'other', label: otherLabel, mark: null }
}

/**
 * The enabled-id list after a whole vendor group is switched on or off,
 * keeping the caller's existing order and every id outside the group.
 */
export function nextGroupSelection(currentEnabled: readonly string[], groupIds: readonly string[], enabled: boolean): string[] {
  if (enabled) return [...new Set([...currentEnabled, ...groupIds])]
  const drop = new Set(groupIds)
  return currentEnabled.filter((id) => !drop.has(id))
}
