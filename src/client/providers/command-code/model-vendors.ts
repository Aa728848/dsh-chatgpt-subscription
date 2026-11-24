import type { CommandCodeModelOption } from '../../../shared/command-code-contracts.ts'
import type { ModelChecklistGroup } from '../../common/ModelChecklist.tsx'
import { modelBrandMark, type ProviderMarkKey } from '../../hub/brand-icons.tsx'

interface VendorSpec {
  key: string
  label: string
  mark: ProviderMarkKey | null
}

const PREFIX_VENDORS: Readonly<Record<string, VendorSpec>> = {
  anthropic: { key: 'anthropic', label: 'Anthropic', mark: 'claude' },
  openai: { key: 'openai', label: 'OpenAI', mark: 'openai' },
  deepseek: { key: 'deepseek', label: 'DeepSeek', mark: 'deepseek' },
  moonshotai: { key: 'moonshot', label: 'Moonshot', mark: 'kimi' },
  moonshot: { key: 'moonshot', label: 'Moonshot', mark: 'kimi' },
  kimi: { key: 'moonshot', label: 'Moonshot', mark: 'kimi' },
  'z-ai': { key: 'zai', label: 'Z.ai', mark: 'glm' },
  'zai-org': { key: 'zai', label: 'Z.ai', mark: 'glm' },
  zhipu: { key: 'zai', label: 'Z.ai', mark: 'glm' },
  minimax: { key: 'minimax', label: 'MiniMax', mark: 'minimax' },
  minimaxai: { key: 'minimax', label: 'MiniMax', mark: 'minimax' },
  qwen: { key: 'qwen', label: 'Qwen', mark: 'qwen' },
  google: { key: 'google', label: 'Google', mark: 'gemini' },
  xai: { key: 'xai', label: 'xAI', mark: 'grok' },
  'x-ai': { key: 'xai', label: 'xAI', mark: 'grok' },
  stepfun: { key: 'stepfun', label: 'StepFun', mark: 'step-code' },
  meta: { key: 'meta', label: 'Meta', mark: null },
  'meta-llama': { key: 'meta', label: 'Meta', mark: null },
  xiaomi: { key: 'xiaomi', label: 'Xiaomi', mark: null },
  tencent: { key: 'tencent', label: 'Tencent', mark: null },
  mistral: { key: 'mistral', label: 'Mistral', mark: null },
  mistralai: { key: 'mistral', label: 'Mistral', mark: null },
  nvidia: { key: 'nvidia', label: 'NVIDIA', mark: null },
  meituan: { key: 'meituan', label: 'Meituan', mark: null },
  inclusionai: { key: 'inclusionai', label: 'InclusionAI', mark: null },
  thinkingmachines: { key: 'thinkingmachines', label: 'Thinking Machines', mark: null },
  stealth: { key: 'stealth', label: 'Stealth', mark: null },
  sakana: { key: 'sakana', label: 'Sakana', mark: null },
  ornith: { key: 'ornith', label: 'Ornith', mark: null },
  reflection: { key: 'reflection', label: 'Reflection', mark: null },
  poolside: { key: 'poolside', label: 'Poolside', mark: null },
}

function titleCasePrefix(raw: string): string {
  return raw
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(' ')
}

/**
 * Resolves the display vendor for a Command Code model id.
 *
 * Uses the `vendor/model` prefix when present (merging aliases like `z-ai` and
 * `zai-org`, or `minimax` and `MiniMaxAI`), then falls back to bare model-id
 * families (`claude-*`, `gpt-*`, etc.) before grouping unknown entries under
 * `otherLabel`.
 */
export function commandCodeModelVendor(
  model: Pick<CommandCodeModelOption, 'id'>,
  otherLabel: string,
): ModelChecklistGroup {
  const id = model.id.trim()
  const lower = id.toLowerCase()
  const slash = lower.indexOf('/')
  if (slash > 0) {
    const prefix = lower.slice(0, slash)
    const known = PREFIX_VENDORS[prefix]
    if (known !== undefined) return known
    return {
      key: prefix,
      label: titleCasePrefix(id.slice(0, slash)),
      mark: modelBrandMark(id),
    }
  }

  if (/^claude\b/.test(lower)) return PREFIX_VENDORS.anthropic!
  if (/^(gpt|codex|o[1-9])\b/.test(lower) || /^gpt-/.test(lower)) return PREFIX_VENDORS.openai!
  if (/^deepseek\b/.test(lower)) return PREFIX_VENDORS.deepseek!
  if (/^(kimi|moonshot)\b/.test(lower)) return PREFIX_VENDORS.moonshot!
  if (/^glm\b/.test(lower)) return PREFIX_VENDORS['z-ai']!
  if (/^minimax\b/.test(lower)) return PREFIX_VENDORS.minimax!
  if (/^qwen\b/.test(lower)) return PREFIX_VENDORS.qwen!
  if (/^gemini\b/.test(lower)) return PREFIX_VENDORS.google!
  if (/^grok\b/.test(lower)) return PREFIX_VENDORS.xai!
  if (/^step\b/.test(lower)) return PREFIX_VENDORS.stepfun!

  return { key: 'other', label: otherLabel, mark: null }
}
